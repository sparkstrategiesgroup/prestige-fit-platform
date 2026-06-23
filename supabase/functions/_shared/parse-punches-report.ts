// Shared parser used by both the manual-upload Edge Function (epay-import)
// and the email-driven webhook (epay-import-email). Extracting the parsing
// + upsert logic here guarantees both paths produce identical labor_control
// _tracking rows for the same input file.
//
// Usage:
//   const result = await ingestWorkbookBytes(supabase, bytes, importId);
//   // result = { imported, skipped, sitesCreated, errors, rowCount }
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const EXPECTED_HEADERS = [
  "Job/Site ID","Job/Site Name","Date","Payroll No","Employee Name",
  "Rate Type","Time In","Time Out","Actual Hours",
];

export type ImportError = { row: number; field?: string; message: string };

export type IngestResult = {
  imported: number;
  skipped: number;
  sitesCreated: number;
  errors: ImportError[];
  rowCount: number;
  headerError?: "no_header_row" | "bad_headers";
  missingHeaders?: string[];
};

// ePay punch times are the store's *local wall-clock* (the export carries no
// timezone). time_in/time_out are timestamptz and fn_pick_shift_block reads them
// back with `AT TIME ZONE`, so they must be stored as the correct UTC instant.
// Convert the wall-clock to UTC using the site's IANA timezone instead of naively
// tagging it "Z" -- the old code stored e.g. a 2:30pm Central punch as 2:30pm UTC,
// corrupting the instant and shifting shift-block matching by the site's offset.
export function wallClockToUtcIso(
  y: number, mo: number, d: number, h: number, mi: number, s: number,
  timeZone: string,
): string {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(asUtc))) p[part.type] = part.value;
  // Intl can emit "24" for midnight in some runtimes; normalise to 0.
  const hh = p.hour === "24" ? 0 : Number(p.hour);
  const tzAsUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day), hh, Number(p.minute), Number(p.second),
  );
  // offset = tzAsUtc - asUtc; the correct instant is asUtc - offset.
  return new Date(asUtc - (tzAsUtc - asUtc)).toISOString();
}

function parseEpayDateTime(raw: unknown, timeZone: string): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const tz = timeZone || "America/Chicago";
  if (typeof raw === "number") {
    // Excel serial: a naive wall-clock with no zone. Read its components back
    // out (as UTC, the frame we projected them into) then convert via the tz.
    const naive = new Date(Math.round((raw - 25569) * 86400 * 1000));
    return wallClockToUtcIso(
      naive.getUTCFullYear(), naive.getUTCMonth() + 1, naive.getUTCDate(),
      naive.getUTCHours(), naive.getUTCMinutes(), naive.getUTCSeconds(), tz,
    );
  }
  const m = String(raw).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, mm, dd, yyyy, hh, mi] = m;
  return wallClockToUtcIso(Number(yyyy), Number(mm), Number(dd), Number(hh ?? "0"), Number(mi ?? "0"), 0, tz);
}

function parseEpayDate(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "number") {
    return new Date(Math.round((raw - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  const m = String(raw).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function parseHoursToDecimal(raw: unknown): number | null {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d+):(\d{2})$/);
  return m ? parseFloat(m[1]) + parseInt(m[2], 10) / 60 : null;
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

/**
 * Parse a Punches Report xlsx and upsert every row into labor_control_tracking.
 * Auto-creates any site whose epay_site_code isn't already in `site`.
 */
export async function ingestWorkbookBytes(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  bytes: Uint8Array,
  importId: number,
  filename?: string,
): Promise<IngestResult> {
  const isCsv = filename?.toLowerCase().endsWith(".csv");
  const wb = isCsv
    ? XLSX.read(new TextDecoder().decode(bytes), { type: "string" })
    : XLSX.read(bytes, { type: "array" });
  const sheet = wb.Sheets["PunchesReport"] ?? wb.Sheets[wb.SheetNames[0]];
  // Keep blank rows so absolute indexes stay stable; scan for the header
  // row so Epay can rearrange the top matter without breaking us.
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1, raw: true, blankrows: true,
  });

  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    // deno-lint-ignore no-explicit-any
    const cells = (rows[i] ?? []).map((c: any) => String(c ?? "").trim());
    if (cells.includes("Job/Site ID") && cells.includes("Payroll No")) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    return {
      imported: 0, skipped: 0, sitesCreated: 0, rowCount: 0,
      errors: [{ row: 0, message: "Could not find a header row containing 'Job/Site ID' and 'Payroll No' in the first 15 rows." }],
      headerError: "no_header_row",
    };
  }
  // deno-lint-ignore no-explicit-any
  const headers = (rows[headerRowIdx] ?? []).map((h: any) => String(h ?? "").trim());
  const missing = EXPECTED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) {
    return {
      imported: 0, skipped: 0, sitesCreated: 0, rowCount: 0, errors: [],
      headerError: "bad_headers",
      missingHeaders: missing,
    };
  }
  const idx = Object.fromEntries(EXPECTED_HEADERS.map((h) => [h, headers.indexOf(h)]));
  const dataStart = headerRowIdx + 1;

  const errors: ImportError[] = [];
  let imported = 0; let skipped = 0; let sitesCreated = 0;

  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[idx["Job/Site ID"]]) { skipped++; continue; }
    const epayCode = String(row[idx["Job/Site ID"]]).trim();
    const siteName = String(row[idx["Job/Site Name"]] ?? "").trim();

    let { data: site } = await supabase.from("site")
      .select("id, time_zone").eq("epay_site_code", epayCode).maybeSingle();

    if (!site) {
      const chain = chainForSiteId(epayCode);
      const { data: created, error: createErr } = await supabase.from("site").insert({
        site_id: epayCode,
        site_name: siteName || epayCode,
        region_id: 1,
        epay_site_code: epayCode,
        chain,
        time_zone: "America/Chicago",
      }).select("id, time_zone").single();
      if (createErr || !created) {
        errors.push({ row: r + 1, field: "Job/Site ID", message: `Could not create site ${epayCode}: ${createErr?.message}` });
        continue;
      }
      site = created;
      sitesCreated++;
    }

    const workDate = parseEpayDate(row[idx["Date"]]);
    const timeIn = parseEpayDateTime(row[idx["Time In"]], site.time_zone);
    const timeOut = parseEpayDateTime(row[idx["Time Out"]], site.time_zone);
    if (!workDate || !timeIn) {
      errors.push({ row: r + 1, message: "Date or Time In could not be parsed" });
      continue;
    }

    let shiftBlockId: number | null = null;
    const { data: pickedBlock } = await supabase.rpc("fn_pick_shift_block", {
      p_job_site_id: site.id,
      p_time_in: timeIn,
    });
    if (typeof pickedBlock === "number") shiftBlockId = pickedBlock;

    // fn_ingest_lct_row preserves the *first* import_id that introduced each
    // punch — otherwise every subsequent hourly file would overwrite the
    // pointer and orphan the prior file's chip drill-in. See
    // supabase/migrations/*_lct_ingest_keep_first_import_id.sql.
    const { error } = await supabase.rpc("fn_ingest_lct_row", {
      p_job_site_id: site.id,
      p_job_site_name: siteName || epayCode,
      p_work_date: workDate,
      p_payroll_number: String(row[idx["Payroll No"]] ?? "").trim(),
      p_employee_name: String(row[idx["Employee Name"]] ?? "").trim(),
      p_rate_type: String(row[idx["Rate Type"]] ?? "").trim() || null,
      p_time_in: timeIn,
      p_time_out: timeOut,
      p_actual_hours: parseHoursToDecimal(row[idx["Actual Hours"]]),
      p_time_zone: site.time_zone,
      p_shift_block_id: shiftBlockId,
      p_epay_import_id: importId,
    });

    if (error) errors.push({ row: r + 1, message: error.message });
    else imported++;
  }

  return {
    imported, skipped, sitesCreated, errors,
    rowCount: rows.length - dataStart,
  };
}
