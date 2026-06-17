// Shared parser for the WinTeam "Schedule Report" XLSX (labelled "Upload
// Schedule Report" in the UI; the source of truth for every store's schedule,
// department, and hours).
//
// The REAL WinTeam export columns are:
//   JobNumber, JobDescription, JobState, Dept, TimeZoneName, StartTime, EndTime,
//   Sun, Mon, Tues, Wed, Thur, Fri, Sat, Lunch,
//   SunTotal..SatTotal, TotalHours, HoursTypeDescription
// (The previous parser expected HoursTypeID / Tue / Thu / TimeZone / SupervisorID
//  / adjustment+tolerance columns that this export does not have, so every real
//  upload was rejected with "Missing required columns".)
//
// Behaviour:
//   * Reads the workbook, locates the header row, maps each column by name
//     (tolerant of Tue/Tues, Thu/Thur, TimeZone/TimeZoneName aliases).
//   * Upserts each site's report-sourced attributes (name, department, state,
//     time zone) onto `site` — these are corrections from the authoritative
//     report and apply at upload time, like the existing site auto-create.
//   * Emits a per-site REPLACE diff: for every site in the upload, one `remove`
//     per existing schedule_slot row + one `add` per report row. This is robust
//     to the dirty baseline (which has duplicate rows and no stable key) and
//     makes schedule_slot for each uploaded site exactly match the report. The
//     caller inserts the master_schedule_change rows; fn_apply applies them on
//     approval. Sites NOT in the upload are left untouched.
//
// Usage:
//   const diff = await diffMasterSchedule(supabase, bytes);

import * as XLSX from "https://esm.sh/xlsx@0.18.5";

// One schedule_slot row's worth of report data.
export type SlotPayload = {
  start_time: string;                    // "HH:MM:SS"
  end_time: string;                      // "HH:MM:SS"
  days_of_week: boolean[];               // length 7, index 0 = Sunday
  flex_hours: number | null;             // unpaid lunch in MINUTES (Lunch hrs × 60)
  total_hours: number | null;            // report "TotalHours"
  hours_type_description: string | null; // report "HoursTypeDescription"
  time_zone: string;                     // normalized IANA tz
  role: string | null;                   // not present in the report
};

// Site-level attributes the report carries on every row for a store.
export type SiteAttrs = {
  site_name: string | null;
  dept_code: string | null;
  dept_description: string | null;
  state: string | null;
  time_zone: string | null;
};

export type Change = {
  change_type: "add" | "modify" | "remove";
  site_id: string;
  slot_natural_key: string;
  target_slot_id: string | null;
  old_payload: SlotPayload | null;
  new_payload: SlotPayload | null;
};

export type DiffResult = {
  rowsParsed: number;
  sitesCreated: number;
  sitesUpdated: number;
  unchanged: number;
  changes: Change[];
  errors: Array<{ row: number; message: string }>;
};

const MAX_HEADER_SCAN = 12;

// Column name → accepted header aliases (matched case-insensitively, trimmed).
const COL = {
  jobNumber: ["JobNumber", "Job Number", "Job #"],
  jobDescription: ["JobDescription", "Job Description", "JobName"],
  jobState: ["JobState", "State"],
  dept: ["Dept", "Department"],
  timeZone: ["TimeZoneName", "TimeZone", "Time Zone"],
  startTime: ["StartTime", "Start Time", "Start"],
  endTime: ["EndTime", "End Time", "End"],
  lunch: ["Lunch", "LunchHours", "Meal"],
  totalHours: ["TotalHours", "Total Hours", "Total"],
  hoursType: ["HoursTypeDescription", "HoursType", "Hours Type", "HoursTypeID"],
} as const;

const DAY_ALIASES: string[][] = [
  ["Sun", "Sunday"],
  ["Mon", "Monday"],
  ["Tues", "Tue", "Tuesday", "Tu"],
  ["Wed", "Wednesday", "Weds"],
  ["Thur", "Thu", "Thurs", "Thursday", "Th"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
];

const TZ_MAP: Record<string, string> = {
  "US/EASTERN": "America/New_York",
  "US/CENTRAL": "America/Chicago",
  "US/MOUNTAIN": "America/Denver",
  "US/PACIFIC": "America/Los_Angeles",
  "US/ARIZONA": "America/Phoenix",
  "US/HAWAII": "Pacific/Honolulu",
  "US/ALASKA": "America/Anchorage",
  "US/MICHIGAN": "America/Detroit",
};

function colIndex(headers: string[], names: readonly string[]): number {
  const norm = headers.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = norm.indexOf(n.toLowerCase());
    if (i !== -1) return i;
  }
  return -1;
}

function toTime(v: unknown): string | null {
  if (v == null || v === "") return null;
  // Excel time serial: a fraction of a day.
  if (typeof v === "number") {
    const total = Math.round(v * 86400);
    const h = Math.floor(total / 3600) % 24;
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  const m24 = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m24) return `${m24[1].padStart(2, "0")}:${m24[2]}:${(m24[3] ?? "00").padStart(2, "0")}`;
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const ampm = m12[3].toUpperCase();
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m12[2]}:00`;
  }
  return null;
}

function toBool(v: unknown): boolean {
  if (v == null || v === "") return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "yes" || s === "y" || s === "true" || s === "x";
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function normalizeTz(v: string | null): string | null {
  if (!v) return null;
  return TZ_MAP[v.trim().toUpperCase()] ?? v.trim();
}

// "3003 - West" → { code: "3003", description: "West" }
function splitDept(v: string | null): { code: string | null; description: string | null } {
  if (!v) return { code: null, description: null };
  const m = v.trim().match(/^(.+?)\s+-\s+(.+)$/);
  if (m) return { code: m[1].trim(), description: m[2].trim() };
  return { code: v.trim(), description: null };
}

function chainForSiteId(code: string): string | null {
  const up = code.toUpperCase();
  if (up.startsWith("KOH")) return "KOHLS";
  if (up.startsWith("SOL")) return "SOLO";
  if (up.startsWith("JJM")) return "JJM";
  if (up.startsWith("CAT")) return "CAT";
  if (up.startsWith("ADI")) return "ADI";
  if (up.startsWith("T")) return "TARGET";
  if (up.startsWith("H")) return "HARDLINES";
  return null;
}

const daysBits = (days: boolean[]): string => days.map((b) => (b ? "1" : "0")).join("");
const naturalKey = (site: string, p: { start_time: string; end_time: string; days_of_week: boolean[] }): string =>
  `${site}|${p.start_time}|${p.end_time}|${daysBits(p.days_of_week)}`;

/**
 * Parse the Schedule Report XLSX, upsert each site's report attributes, and
 * return a per-site REPLACE diff (remove existing slots + add report slots for
 * every site present in the upload). Does NOT write schedule_slot — the Edge
 * Function inserts the change rows and fn_apply applies them on approval.
 */
export async function diffMasterSchedule(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  bytes: Uint8Array,
  filename?: string,
): Promise<DiffResult> {
  const empty = (msg: string): DiffResult => ({
    rowsParsed: 0, sitesCreated: 0, sitesUpdated: 0, unchanged: 0, changes: [],
    errors: [{ row: 0, message: msg }],
  });

  // The Schedule Report is exported as either .csv or .xlsx. CSV must be read
  // as text (strip a leading BOM); xlsx as a byte array. CRLF + quoted fields
  // (e.g. a store name containing a comma) are handled by the XLSX CSV reader.
  // .xlsx is a ZIP (starts with "PK"); anything without that signature is text
  // (CSV). Trust the .csv extension too, in case a name is given without bytes.
  const looksXlsx = bytes.length > 1 && bytes[0] === 0x50 && bytes[1] === 0x4B;
  const isCsv = (filename?.toLowerCase().endsWith(".csv") ?? false) || !looksXlsx;
  const wb = isCsv
    ? XLSX.read(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ""), { type: "string" })
    : XLSX.read(bytes, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return empty("Workbook has no sheets");
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false });
  if (rows.length < 2) return empty("Workbook is empty");

  // Locate the header row (the export sometimes carries title rows above it).
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, MAX_HEADER_SCAN); i++) {
    // deno-lint-ignore no-explicit-any
    const cells = (rows[i] ?? []).map((c: any) => String(c ?? "").trim());
    if (colIndex(cells, COL.jobNumber) !== -1 && colIndex(cells, COL.startTime) !== -1) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return empty("Could not find a header row with 'JobNumber' and 'StartTime'");

  // deno-lint-ignore no-explicit-any
  const headers = (rows[headerIdx] ?? []).map((h: any) => String(h ?? "").trim());
  const idx = {
    jobNumber: colIndex(headers, COL.jobNumber),
    jobDescription: colIndex(headers, COL.jobDescription),
    jobState: colIndex(headers, COL.jobState),
    dept: colIndex(headers, COL.dept),
    timeZone: colIndex(headers, COL.timeZone),
    startTime: colIndex(headers, COL.startTime),
    endTime: colIndex(headers, COL.endTime),
    lunch: colIndex(headers, COL.lunch),
    totalHours: colIndex(headers, COL.totalHours),
    hoursType: colIndex(headers, COL.hoursType),
    days: DAY_ALIASES.map((a) => colIndex(headers, a)),
  };

  // Required: JobNumber, StartTime, EndTime, and all seven day columns.
  const missing: string[] = [];
  if (idx.jobNumber === -1) missing.push("JobNumber");
  if (idx.startTime === -1) missing.push("StartTime");
  if (idx.endTime === -1) missing.push("EndTime");
  const DAY_NAMES = ["Sun", "Mon", "Tues", "Wed", "Thur", "Fri", "Sat"];
  idx.days.forEach((d, i) => { if (d === -1) missing.push(DAY_NAMES[i]); });
  if (missing.length) return empty(`Missing required columns: ${missing.join(", ")}`);

  const errors: DiffResult["errors"] = [];
  const proposed: Array<{ siteId: string; payload: SlotPayload }> = [];
  const seen = new Set<string>();
  const siteAttrs = new Map<string, SiteAttrs>();

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const siteIdRaw = toStr(row[idx.jobNumber]);
    if (!siteIdRaw) continue;
    const siteId = siteIdRaw.toUpperCase();

    const start_time = toTime(row[idx.startTime]);
    const end_time = toTime(row[idx.endTime]);
    if (!start_time || !end_time) {
      errors.push({ row: r + 1, message: `Row ${r + 1} (${siteId}): unparseable StartTime/EndTime` });
      continue;
    }

    const days_of_week = idx.days.map((d) => (d === -1 ? false : toBool(row[d])));
    const lunch = idx.lunch === -1 ? null : toNum(row[idx.lunch]);
    const payload: SlotPayload = {
      start_time,
      end_time,
      days_of_week,
      flex_hours: lunch == null ? null : Math.round(lunch * 60),
      total_hours: idx.totalHours === -1 ? null : toNum(row[idx.totalHours]),
      hours_type_description: idx.hoursType === -1 ? null : toStr(row[idx.hoursType]),
      time_zone: normalizeTz(idx.timeZone === -1 ? null : toStr(row[idx.timeZone])) ?? "America/Chicago",
      role: null,
    };

    // Capture site-level attributes (consistent across a site's rows).
    if (!siteAttrs.has(siteId)) {
      const dept = splitDept(idx.dept === -1 ? null : toStr(row[idx.dept]));
      siteAttrs.set(siteId, {
        site_name: idx.jobDescription === -1 ? null : toStr(row[idx.jobDescription]),
        dept_code: dept.code,
        dept_description: dept.description,
        state: idx.jobState === -1 ? null : toStr(row[idx.jobState]),
        time_zone: payload.time_zone,
      });
    }

    // Skip exact-duplicate rows within the upload.
    const sig = `${naturalKey(siteId, payload)}|${payload.flex_hours}|${payload.total_hours}|${payload.hours_type_description ?? ""}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    proposed.push({ siteId, payload });
  }

  const siteIds = Array.from(siteAttrs.keys());
  if (siteIds.length === 0) {
    return { rowsParsed: 0, sitesCreated: 0, sitesUpdated: 0, unchanged: 0, changes: [], errors };
  }

  // ---- Upsert site attributes from the report (insert missing, update rest) --
  const { data: existingSites } = await supabase.from("site").select("site_id").in("site_id", siteIds);
  const existingSiteSet = new Set((existingSites ?? []).map((s: { site_id: string }) => s.site_id));

  let sitesCreated = 0;
  let sitesUpdated = 0;
  for (const sid of siteIds) {
    const a = siteAttrs.get(sid)!;
    if (existingSiteSet.has(sid)) {
      const patch: Record<string, unknown> = {};
      if (a.site_name) patch.site_name = a.site_name;
      if (a.dept_code) patch.dept_code = a.dept_code;
      if (a.dept_description) patch.dept_description = a.dept_description;
      if (a.state) patch.state = a.state;
      if (a.time_zone) patch.time_zone = a.time_zone;
      if (Object.keys(patch).length > 0) {
        const { error } = await supabase.from("site").update(patch).eq("site_id", sid);
        if (error) errors.push({ row: 0, message: `Could not update site ${sid}: ${error.message}` });
        else sitesUpdated++;
      }
    } else {
      const { error } = await supabase.from("site").insert({
        site_id: sid,
        site_name: a.site_name ?? sid,
        region_id: 1,
        epay_site_code: sid,
        chain: chainForSiteId(sid),
        time_zone: a.time_zone ?? "America/Chicago",
        dept_code: a.dept_code,
        dept_description: a.dept_description,
        state: a.state,
      });
      if (error) errors.push({ row: 0, message: `Could not create site ${sid}: ${error.message}` });
      else sitesCreated++;
    }
  }

  // ---- Per-site REPLACE: remove existing slots, add report slots ------------
  const { data: existingSlots } = await supabase
    .from("schedule_slot")
    .select("slot_id, site_id, start_time, end_time, days_of_week, flex_hours, total_hours, hours_type_description, time_zone, role")
    .in("site_id", siteIds);

  const changes: Change[] = [];
  for (const s of (existingSlots ?? [])) {
    const old_payload: SlotPayload = {
      start_time: s.start_time,
      end_time: s.end_time,
      days_of_week: s.days_of_week ?? [false, false, false, false, false, false, false],
      flex_hours: s.flex_hours,
      total_hours: s.total_hours ?? null,
      hours_type_description: s.hours_type_description ?? null,
      time_zone: s.time_zone ?? "America/Chicago",
      role: s.role ?? null,
    };
    changes.push({
      change_type: "remove",
      site_id: s.site_id,
      slot_natural_key: naturalKey(s.site_id, old_payload),
      target_slot_id: s.slot_id,
      old_payload,
      new_payload: null,
    });
  }
  for (const { siteId, payload } of proposed) {
    changes.push({
      change_type: "add",
      site_id: siteId,
      slot_natural_key: naturalKey(siteId, payload),
      target_slot_id: null,
      old_payload: null,
      new_payload: payload,
    });
  }

  return { rowsParsed: proposed.length, sitesCreated, sitesUpdated, unchanged: 0, changes, errors };
}
