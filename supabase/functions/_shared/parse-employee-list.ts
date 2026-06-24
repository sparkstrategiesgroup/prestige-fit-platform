// Shared parser for the WinTeam "Employee List" report (the scheduled export
// whose file identifier is `113`, e.g. 113_20260622_1736.csv). Used by the
// email-driven webhook (employee-list-import-email). Extracting the parse +
// refresh logic here keeps it unit-testable and matches the pattern used by
// the Punches Report parser.
//
// The report is the authoritative employee roster, so each import REFRESHES
// mutable fields on the existing `employee` row matched by `employee_number`.
// It is update-only: an EmployeeID with no `employee` row is NOT inserted
// (employee.region_id / department_id are NOT NULL and the 113 report carries
// neither). Unmatched rows are returned in `errors` so an operator can onboard
// them, mirroring how the AWR refresh only touches existing employees.
//
// Columns (case/spacing tolerant): EmployeeID, FirstName, LastName, Phone1,
// Phone2, PrimaryJob (job/site code), PrimaryJobSite (site name), EEStatus.
//
// Usage:
//   const result = await ingestEmployeeListBytes(supabase, bytes, importId, filename);
//   // result = { rowCount, matched, updated, unmatched, errors, unmatchedNumbers }
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

export type ImportError = { row: number; field?: string; message: string };

export type EmployeeListResult = {
  rowCount: number;
  matched: number;
  updated: number;
  unmatched: number;
  errors: ImportError[];
  headerError?: "no_header_row";
  missingHeaders?: string[];
  unmatchedNumbers: number[];
};

const MAX_HEADER_SCAN = 12;

// Column name -> accepted header aliases (matched case-insensitively, trimmed).
const COL = {
  employeeId: ["EmployeeID", "Employee ID", "Employee Number", "EmployeeNumber", "EmpID", "EE Number"],
  firstName: ["FirstName", "First Name", "First"],
  lastName: ["LastName", "Last Name", "Last"],
  phone1: ["Phone1", "Phone 1", "Phone", "Cell Phone", "CellPhone", "Mobile"],
  phone2: ["Phone2", "Phone 2", "Alternate Phone", "AltPhone"],
  primaryJob: ["PrimaryJob", "Primary Job", "Primary Job Code", "JobCode"],
  primaryJobSite: ["PrimaryJobSite", "Primary Job Site", "Job Site", "JobSite", "Site"],
  eeStatus: ["EEStatus", "EE Status", "Status", "EmployeeStatus", "Employment Status"],
} as const;

function colIndex(headers: string[], names: readonly string[]): number {
  const norm = headers.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = norm.indexOf(n.toLowerCase());
    if (i !== -1) return i;
  }
  return -1;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

// EmployeeID parsed to a positive integer (employee.employee_number is INTEGER).
export function parseEmployeeNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  const s = String(v).trim().replace(/[^0-9]/g, "");
  if (s.length === 0) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Keep the report's phone string but cap at the column width (VARCHAR(20)).
export function normalizePhone(v: unknown): string | null {
  const s = toStr(v);
  if (!s) return null;
  return s.length > 20 ? s.slice(0, 20) : s;
}

// EEStatus -> employee.status CHECK ('active','inactive','terminated').
export function mapStatus(v: unknown): "active" | "inactive" | "terminated" | null {
  const s = toStr(v);
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.startsWith("active") || t === "a") return "active";
  if (t.startsWith("term") || t === "t") return "terminated";
  // Inactive, LOA, Leave, Suspended, etc. all collapse to inactive.
  return "inactive";
}

// Read the workbook from CSV (text, strip BOM) or XLSX (byte array). .xlsx is a
// ZIP (starts with "PK"); anything else is treated as CSV text. Mirrors the
// Schedule Report parser's detection so a .csv export is handled either way.
function readWorkbook(bytes: Uint8Array, filename?: string) {
  const looksXlsx = bytes.length > 1 && bytes[0] === 0x50 && bytes[1] === 0x4B;
  const isCsv = (filename?.toLowerCase().endsWith(".csv") ?? false) || !looksXlsx;
  return isCsv
    ? XLSX.read(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ""), { type: "string" })
    : XLSX.read(bytes, { type: "array" });
}

type ParsedRow = {
  row: number;             // 1-based source row for error messages
  employee_number: number;
  first_name: string | null;
  last_name: string | null;
  cell_phone: string | null;
  phone_2: string | null;
  primary_job_code: string | null;  // resolved to primary_job_id only if site exists
  status: "active" | "inactive" | "terminated" | null;
};

// Pure parse step: bytes -> typed rows + structural errors. Exported for tests.
export function parseEmployeeListRows(
  bytes: Uint8Array,
  filename?: string,
): { rows: ParsedRow[]; errors: ImportError[]; headerError?: "no_header_row"; missingHeaders?: string[] } {
  const wb = readWorkbook(bytes, filename);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], errors: [{ row: 0, message: "Workbook has no sheets" }], headerError: "no_header_row" };

  const grid: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false });
  if (grid.length < 2) return { rows: [], errors: [{ row: 0, message: "Workbook is empty" }], headerError: "no_header_row" };

  // Locate the header row (the export may carry title rows above it). Detect on
  // EmployeeID plus a name column so a malformed file missing LastName is still
  // recognized as a header and reported via missingHeaders below, rather than
  // looking like "no header row".
  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, MAX_HEADER_SCAN); i++) {
    const cells = (grid[i] ?? []).map((c) => String(c ?? "").trim());
    const hasName = colIndex(cells, COL.lastName) !== -1 || colIndex(cells, COL.firstName) !== -1;
    if (colIndex(cells, COL.employeeId) !== -1 && hasName) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { rows: [], errors: [{ row: 0, message: "Could not find a header row with EmployeeID and a name column" }], headerError: "no_header_row" };
  }

  const headers = (grid[headerIdx] ?? []).map((h) => String(h ?? "").trim());
  const idx = {
    employeeId: colIndex(headers, COL.employeeId),
    firstName: colIndex(headers, COL.firstName),
    lastName: colIndex(headers, COL.lastName),
    phone1: colIndex(headers, COL.phone1),
    phone2: colIndex(headers, COL.phone2),
    primaryJob: colIndex(headers, COL.primaryJob),
    eeStatus: colIndex(headers, COL.eeStatus),
  };

  const missing: string[] = [];
  if (idx.employeeId === -1) missing.push("EmployeeID");
  if (idx.lastName === -1) missing.push("LastName");
  if (missing.length) return { rows: [], errors: [{ row: headerIdx + 1, message: `Missing required columns: ${missing.join(", ")}` }], missingHeaders: missing };

  const rows: ParsedRow[] = [];
  const errors: ImportError[] = [];
  const seen = new Set<number>();
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const raw = grid[r];
    if (!raw) continue;
    const empNo = parseEmployeeNumber(raw[idx.employeeId]);
    if (empNo == null) {
      // Skip silently if the whole row is blank; flag if it had other content.
      const hasContent = raw.some((c) => String(c ?? "").trim().length > 0);
      if (hasContent) errors.push({ row: r + 1, field: "EmployeeID", message: `Row ${r + 1}: missing/invalid EmployeeID` });
      continue;
    }
    if (seen.has(empNo)) continue; // first occurrence wins within a file
    seen.add(empNo);

    rows.push({
      row: r + 1,
      employee_number: empNo,
      first_name: idx.firstName === -1 ? null : toStr(raw[idx.firstName]),
      last_name: idx.lastName === -1 ? null : toStr(raw[idx.lastName]),
      cell_phone: idx.phone1 === -1 ? null : normalizePhone(raw[idx.phone1]),
      phone_2: idx.phone2 === -1 ? null : normalizePhone(raw[idx.phone2]),
      primary_job_code: idx.primaryJob === -1 ? null : toStr(raw[idx.primaryJob]),
      status: idx.eeStatus === -1 ? null : mapStatus(raw[idx.eeStatus]),
    });
  }

  return { rows, errors };
}

/**
 * Parse the Employee List and refresh the matching `employee` rows. Update-only:
 * EmployeeIDs with no `employee` row are counted as unmatched (not inserted).
 */
export async function ingestEmployeeListBytes(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  bytes: Uint8Array,
  _importId: number,
  filename?: string,
): Promise<EmployeeListResult> {
  const parsed = parseEmployeeListRows(bytes, filename);
  const errors = [...parsed.errors];
  if (parsed.headerError || parsed.missingHeaders) {
    return {
      rowCount: 0, matched: 0, updated: 0, unmatched: 0,
      errors, headerError: parsed.headerError, missingHeaders: parsed.missingHeaders,
      unmatchedNumbers: [],
    };
  }

  const rows = parsed.rows;
  if (rows.length === 0) {
    return { rowCount: 0, matched: 0, updated: 0, unmatched: 0, errors, unmatchedNumbers: [] };
  }

  // Existing employees, keyed by employee_number. The table is small (~760
  // rows), so fetch all relevant columns once and diff in memory to avoid a
  // needless UPDATE (and audit_log row) when nothing changed.
  const { data: existing, error: exErr } = await supabase
    .from("employee")
    .select("id, employee_number, first_name, last_name, cell_phone, phone_2, primary_job_id, status");
  if (exErr) {
    errors.push({ row: 0, message: `Could not load employees: ${exErr.message}` });
    return { rowCount: rows.length, matched: 0, updated: 0, unmatched: 0, errors, unmatchedNumbers: [] };
  }
  const byNumber = new Map<number, Record<string, unknown>>();
  for (const e of (existing ?? []) as Record<string, unknown>[]) {
    byNumber.set(Number(e.employee_number), e);
  }

  // Resolve PrimaryJob codes to a canonical site_id (case-insensitive). Only
  // set primary_job_id to a value that exists, or the FK to site(site_id)
  // would reject the update.
  const { data: allSites } = await supabase.from("site").select("site_id");
  const upperToSite = new Map<string, string>();
  for (const s of (allSites ?? []) as { site_id: string }[]) {
    upperToSite.set(String(s.site_id).toUpperCase(), s.site_id);
  }
  const resolveSite = (code: string | null): string | null =>
    code ? (upperToSite.get(code.toUpperCase()) ?? null) : null;

  let matched = 0;
  let updated = 0;
  const unmatchedNumbers: number[] = [];

  // Build the patch for each matched row, skipping unchanged rows.
  const updates: Array<{ id: number; patch: Record<string, unknown>; empNo: number }> = [];
  for (const row of rows) {
    const cur = byNumber.get(row.employee_number);
    if (!cur) {
      unmatchedNumbers.push(row.employee_number);
      continue;
    }
    matched++;

    const patch: Record<string, unknown> = {};
    if (row.first_name && row.first_name !== cur.first_name) patch.first_name = row.first_name;
    if (row.last_name && row.last_name !== cur.last_name) patch.last_name = row.last_name;
    if (row.cell_phone && row.cell_phone !== cur.cell_phone) patch.cell_phone = row.cell_phone;
    if (row.phone_2 && row.phone_2 !== cur.phone_2) patch.phone_2 = row.phone_2;
    if (row.status && row.status !== cur.status) patch.status = row.status;
    const siteId = resolveSite(row.primary_job_code);
    if (siteId && siteId !== cur.primary_job_id) patch.primary_job_id = siteId;

    if (Object.keys(patch).length > 0) {
      updates.push({ id: Number(cur.id), patch, empNo: row.employee_number });
    }
  }

  // Apply updates in bounded-concurrency batches to keep round-trips fast
  // without overwhelming the connection pool.
  const CHUNK = 25;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK);
    const results = await Promise.all(batch.map(async (u) => {
      const { error } = await supabase.from("employee").update(u.patch).eq("id", u.id);
      return { ok: !error, empNo: u.empNo, message: error?.message };
    }));
    for (const res of results) {
      if (res.ok) updated++;
      else errors.push({ row: 0, message: `Employee ${res.empNo}: update failed: ${res.message}` });
    }
  }

  // Record unmatched EmployeeIDs (likely new hires) for operator follow-up.
  if (unmatchedNumbers.length > 0) {
    errors.push({
      row: 0,
      field: "EmployeeID",
      message: `${unmatchedNumbers.length} EmployeeID(s) had no matching employee and were not onboarded (region/department unknown): ${unmatchedNumbers.slice(0, 50).join(", ")}${unmatchedNumbers.length > 50 ? ", ..." : ""}`,
    });
  }

  return {
    rowCount: rows.length,
    matched,
    updated,
    unmatched: unmatchedNumbers.length,
    errors,
    unmatchedNumbers,
  };
}
