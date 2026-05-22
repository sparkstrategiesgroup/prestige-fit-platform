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

function parseEpayDateTime(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    return new Date(Math.round((raw - 25569) * 86400 * 1000)).toISOString();
  }
  const m = String(raw).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, mm, dd, yyyy, hh, mi] = m;
  return `${yyyy}-${mm}-${dd}T${hh ?? "00"}:${mi ?? "00"}:00Z`;
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
): Promise<IngestResult> {
  const wb = XLSX.read(bytes, { type: "array" });
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
    const timeIn = parseEpayDateTime(row[idx["Time In"]]);
    const timeOut = parseEpayDateTime(row[idx["Time Out"]]);
    if (!workDate || !timeIn) {
      errors.push({ row: r + 1, message: "Date or Time In could not be parsed" });
      continue;
    }

    let shiftBlockId: number | null = null;
    const { data: schedRow } = await supabase.from("job_site_schedules")
      .select("shift_block_id").eq("job_site_id", site.id).eq("active", true).maybeSingle();
    if (schedRow) shiftBlockId = schedRow.shift_block_id;

    const { error } = await supabase.from("labor_control_tracking").upsert({
      job_site_id: site.id,
      job_site_name: siteName || epayCode,
      work_date: workDate,
      payroll_number: String(row[idx["Payroll No"]] ?? "").trim(),
      employee_name: String(row[idx["Employee Name"]] ?? "").trim(),
      rate_type: String(row[idx["Rate Type"]] ?? "").trim() || null,
      time_in: timeIn,
      time_out: timeOut,
      actual_hours: parseHoursToDecimal(row[idx["Actual Hours"]]),
      time_zone: site.time_zone,
      shift_block_id: shiftBlockId,
      epay_import_id: importId,
    }, { onConflict: "payroll_number,job_site_id,work_date,time_in" });

    if (error) errors.push({ row: r + 1, message: error.message });
    else imported++;
  }

  return {
    imported, skipped, sitesCreated, errors,
    rowCount: rows.length - dataStart,
  };
}
