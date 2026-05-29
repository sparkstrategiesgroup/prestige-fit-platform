// Shared parser for the Master Schedule List XLSX.
// One row per (site, start_time, end_time, hours_type_id). Columns match the
// schedule_slot table 1:1 — see supabase/migrations/20260520010200_schedule_slot.sql.
//
// Usage:
//   const diff = await diffMasterSchedule(supabase, bytes, revisionId);
//   // diff = { rowsParsed, changes: [{change_type, site_id, natural_key, ...}], sitesCreated, errors }
//
// The function reads the workbook, normalizes each row into a "proposed slot"
// payload, fetches existing schedule_slot rows for the affected sites, and
// emits one change record per (add | modify | remove). The caller is
// responsible for inserting master_schedule_change rows.

import * as XLSX from "https://esm.sh/xlsx@0.18.5";

export type SlotPayload = {
  start_time: string;
  end_time: string;
  pre_arrival_adjustment: number | null;
  post_arrival_adjustment: number | null;
  pre_departure_adjustment: number | null;
  post_departure_adjustment: number | null;
  hours_type_id: number | null;
  days_of_week: boolean[];
  min_holiday: number | null;
  page_absence: boolean;
  flex_hours: number | null;
  pre_shift_tolerance: number | null;
  post_shift_tolerance: number | null;
  periodic_check: boolean;
  pc_tolerance: number | null;
  supervisor_id: string | null;
  notify_contact: string | null;
  page_no_show: boolean;
  no_show_pager: string | null;
  time_zone: string;
  role: string | null;
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
  unchanged: number;
  changes: Change[];
  errors: Array<{ row: number; message: string }>;
};

// Column header mapping. The user's file headers are the canonical names.
const COLS = [
  "JobNumber","StartTime","EndTime",
  "PreArrivalAdjustment","PostArrivalAdjustment",
  "PreDepartureAdjustment","PostDepartureAdjustment",
  "HoursTypeID","Sun","Mon","Tue","Wed","Thu","Fri","Sat",
  "MinHoliday","PageAbsence","FlexHours",
  "PreShiftTolerance","PostShiftTolerance",
  "PeriodicCheck","PCTolerance",
  "SupervisorID","NotifyContact",
  "PageNoShow","NoShowPager","TimeZone",
];

function toTime(v: unknown): string | null {
  if (v == null || v === "") return null;
  // Excel time serial: fraction of a day
  if (typeof v === "number") {
    const total = Math.round(v * 86400);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }
  // String like "07:00:00" or "7:00 AM"
  const s = String(v).trim();
  const m24 = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m24) {
    return `${m24[1].padStart(2,"0")}:${m24[2]}:${(m24[3] ?? "00").padStart(2,"0")}`;
  }
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const ampm = m12[3].toUpperCase();
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2,"0")}:${m12[2]}:00`;
  }
  return null;
}

function toInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toBool(v: unknown, dflt = false): boolean {
  if (v == null || v === "") return dflt;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s === "yes" || s === "y" || s === "true" || s === "1";
}

function toStr(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function chainForSiteId(code: string): string | null {
  const up = code.toUpperCase();
  if (up.startsWith("KOH")) return "KOHLS";
  if (up.startsWith("SOL")) return "SOLO";
  if (up.startsWith("JJM")) return "JJM";
  if (up.startsWith("CAT")) return "CAT";
  if (up.startsWith("ADI")) return "ADI";
  if (up.startsWith("T"))   return "TARGET";
  if (up.startsWith("H"))   return "HARDLINES";
  return null;
}

function naturalKey(siteId: string, startTime: string, endTime: string, hoursTypeId: number | null): string {
  return `${siteId}|${startTime}|${endTime}|${hoursTypeId ?? ""}`;
}

function payloadsDiffer(a: SlotPayload, b: SlotPayload): boolean {
  // Compare all fields. days_of_week is an array — compare elementwise.
  const keys: (keyof SlotPayload)[] = [
    "start_time","end_time",
    "pre_arrival_adjustment","post_arrival_adjustment",
    "pre_departure_adjustment","post_departure_adjustment",
    "hours_type_id","min_holiday","page_absence","flex_hours",
    "pre_shift_tolerance","post_shift_tolerance",
    "periodic_check","pc_tolerance",
    "supervisor_id","notify_contact",
    "page_no_show","no_show_pager","time_zone","role",
  ];
  for (const k of keys) {
    if (a[k] !== b[k]) return true;
  }
  for (let i = 0; i < 7; i++) {
    if (a.days_of_week[i] !== b.days_of_week[i]) return true;
  }
  return false;
}

/**
 * Parse the Master Schedule List XLSX, compute the diff against the current
 * schedule_slot table, and return the change list. Does NOT write changes —
 * the Edge Function does that.
 */
export async function diffMasterSchedule(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  bytes: Uint8Array,
): Promise<DiffResult> {
  const wb = XLSX.read(bytes, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1, raw: true, blankrows: false,
  });

  if (rows.length < 2) {
    return { rowsParsed: 0, sitesCreated: 0, unchanged: 0, changes: [],
             errors: [{ row: 0, message: "Workbook is empty" }] };
  }

  // Map column index by header
  // deno-lint-ignore no-explicit-any
  const headerRow = (rows[0] ?? []).map((h: any) => String(h ?? "").trim());
  const idx: Record<string, number> = {};
  for (const col of COLS) idx[col] = headerRow.indexOf(col);
  const missing = COLS.filter((c) => idx[c] === -1);
  if (missing.length) {
    return { rowsParsed: 0, sitesCreated: 0, unchanged: 0, changes: [],
             errors: [{ row: 1, message: `Missing required columns: ${missing.join(", ")}` }] };
  }

  // First pass: parse rows, collect unique sites, build the proposed map.
  const errors: DiffResult["errors"] = [];
  const proposed: Map<string, { siteId: string; payload: SlotPayload }> = new Map();
  const siteIds = new Set<string>();
  let rowsParsed = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const siteIdRaw = toStr(row[idx["JobNumber"]]);
    if (!siteIdRaw) continue;
    const siteId = siteIdRaw.toUpperCase();

    const startTime = toTime(row[idx["StartTime"]]);
    const endTime = toTime(row[idx["EndTime"]]);
    if (!startTime || !endTime) {
      errors.push({ row: r + 1, message: `Row ${r+1}: missing or unparseable StartTime/EndTime` });
      continue;
    }
    const hoursTypeId = toInt(row[idx["HoursTypeID"]]);

    const days_of_week: boolean[] = [
      toBool(row[idx["Sun"]]),
      toBool(row[idx["Mon"]]),
      toBool(row[idx["Tue"]]),
      toBool(row[idx["Wed"]]),
      toBool(row[idx["Thu"]]),
      toBool(row[idx["Fri"]]),
      toBool(row[idx["Sat"]]),
    ];

    const payload: SlotPayload = {
      start_time: startTime,
      end_time: endTime,
      pre_arrival_adjustment: toInt(row[idx["PreArrivalAdjustment"]]),
      post_arrival_adjustment: toInt(row[idx["PostArrivalAdjustment"]]),
      pre_departure_adjustment: toInt(row[idx["PreDepartureAdjustment"]]),
      post_departure_adjustment: toInt(row[idx["PostDepartureAdjustment"]]),
      hours_type_id: hoursTypeId,
      days_of_week,
      min_holiday: toInt(row[idx["MinHoliday"]]),
      page_absence: toBool(row[idx["PageAbsence"]]),
      flex_hours: toInt(row[idx["FlexHours"]]),
      pre_shift_tolerance: toInt(row[idx["PreShiftTolerance"]]),
      post_shift_tolerance: toInt(row[idx["PostShiftTolerance"]]),
      periodic_check: toBool(row[idx["PeriodicCheck"]]),
      pc_tolerance: toInt(row[idx["PCTolerance"]]),
      supervisor_id: toStr(row[idx["SupervisorID"]]),
      notify_contact: toStr(row[idx["NotifyContact"]]),
      page_no_show: toBool(row[idx["PageNoShow"]]),
      no_show_pager: toStr(row[idx["NoShowPager"]]),
      time_zone: toStr(row[idx["TimeZone"]]) ?? "America/Chicago",
      role: null, // Role isn't in the Master Schedule List; managed separately.
    };

    const nk = naturalKey(siteId, startTime, endTime, hoursTypeId);
    if (proposed.has(nk)) {
      errors.push({ row: r + 1, message: `Row ${r+1}: duplicate natural key ${nk}` });
      continue;
    }
    proposed.set(nk, { siteId, payload });
    siteIds.add(siteId);
    rowsParsed++;
  }

  // Auto-create any missing sites (same approach as the punches importer).
  let sitesCreated = 0;
  const { data: existingSites } = await supabase
    .from("site")
    .select("site_id")
    .in("site_id", Array.from(siteIds));
  const existingSiteSet = new Set((existingSites ?? []).map((s: { site_id: string }) => s.site_id));

  for (const sid of siteIds) {
    if (existingSiteSet.has(sid)) continue;
    const chain = chainForSiteId(sid);
    const { error } = await supabase.from("site").insert({
      site_id: sid,
      site_name: sid,
      region_id: 1,
      epay_site_code: sid,
      chain,
      time_zone: "America/Chicago",
    });
    if (error) {
      errors.push({ row: 0, message: `Could not create site ${sid}: ${error.message}` });
    } else {
      sitesCreated++;
      existingSiteSet.add(sid);
    }
  }

  // Fetch the current schedule_slot rows for these sites.
  const { data: existingSlots } = await supabase
    .from("schedule_slot")
    .select("slot_id, site_id, start_time, end_time, hours_type_id, days_of_week, pre_arrival_adjustment, post_arrival_adjustment, pre_departure_adjustment, post_departure_adjustment, min_holiday, page_absence, flex_hours, pre_shift_tolerance, post_shift_tolerance, periodic_check, pc_tolerance, supervisor_id, notify_contact, page_no_show, no_show_pager, time_zone, role")
    .in("site_id", Array.from(siteIds));

  // Map existing by natural key
  const existingMap: Map<string, { slot_id: string; payload: SlotPayload }> = new Map();
  for (const row of (existingSlots ?? [])) {
    const nk = naturalKey(row.site_id, row.start_time, row.end_time, row.hours_type_id);
    existingMap.set(nk, {
      slot_id: row.slot_id,
      payload: {
        start_time: row.start_time,
        end_time: row.end_time,
        pre_arrival_adjustment: row.pre_arrival_adjustment,
        post_arrival_adjustment: row.post_arrival_adjustment,
        pre_departure_adjustment: row.pre_departure_adjustment,
        post_departure_adjustment: row.post_departure_adjustment,
        hours_type_id: row.hours_type_id,
        days_of_week: row.days_of_week,
        min_holiday: row.min_holiday,
        page_absence: row.page_absence,
        flex_hours: row.flex_hours,
        pre_shift_tolerance: row.pre_shift_tolerance,
        post_shift_tolerance: row.post_shift_tolerance,
        periodic_check: row.periodic_check,
        pc_tolerance: row.pc_tolerance,
        supervisor_id: row.supervisor_id,
        notify_contact: row.notify_contact,
        page_no_show: row.page_no_show,
        no_show_pager: row.no_show_pager,
        time_zone: row.time_zone,
        role: row.role,
      },
    });
  }

  // Diff
  const changes: Change[] = [];
  let unchanged = 0;
  for (const [nk, { siteId, payload }] of proposed) {
    const existing = existingMap.get(nk);
    if (!existing) {
      changes.push({
        change_type: "add",
        site_id: siteId,
        slot_natural_key: nk,
        target_slot_id: null,
        old_payload: null,
        new_payload: payload,
      });
    } else if (payloadsDiffer(existing.payload, payload)) {
      changes.push({
        change_type: "modify",
        site_id: siteId,
        slot_natural_key: nk,
        target_slot_id: existing.slot_id,
        old_payload: existing.payload,
        new_payload: payload,
      });
    } else {
      unchanged++;
    }
  }
  for (const [nk, { slot_id, payload }] of existingMap) {
    if (!proposed.has(nk)) {
      // Only emit removes for sites that ARE in this upload — otherwise we'd
      // wipe out slots for sites the user didn't touch.
      const sid = nk.split("|")[0];
      if (siteIds.has(sid)) {
        changes.push({
          change_type: "remove",
          site_id: sid,
          slot_natural_key: nk,
          target_slot_id: slot_id,
          old_payload: payload,
          new_payload: null,
        });
      }
    }
  }

  return { rowsParsed, sitesCreated, unchanged, changes, errors };
}
