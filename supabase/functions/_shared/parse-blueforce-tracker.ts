// Shared parser for the Blueforce Tracker XLSX (per-chain workbook).
// Reads the "Payroll Text Exceptions" sheet — columns: Store # | Notes |
// Name | Dept — and converts each row to a store_exception payload.
//
// Notes-to-type mapping is keyword-based:
//   "no show", "noshow", "closed"               -> "closed"
//   "short staff", "no porter"                  -> "reduced_staffing"
//   "do not text", "dnt"                        -> "do_not_text"
//   "holiday"                                   -> "holiday"
//   anything else                               -> "other"
//
// Exception date is parsed from the Notes prefix when present
// (e.g. "6/2 short staff" or "06/02 no show"); falls back to today.

import * as XLSX from "https://esm.sh/xlsx@0.18.5";

export type ParsedException = {
  site_id: string;
  exception_date: string;        // YYYY-MM-DD
  exception_type: "closed" | "reduced_staffing" | "do_not_text" | "holiday" | "other";
  note: string;
  reporter: string | null;
  job_site_name: string | null;
};

export type ParseResult = {
  sheetFound: boolean;
  rowsParsed: number;
  exceptions: ParsedException[];
  errors: Array<{ row: number; message: string }>;
};

// Find a sheet whose name resembles "Payroll Text Exceptions" — tolerant of
// capitalization / spacing.
function findExceptionsSheetName(wb: XLSX.WorkBook): string | null {
  for (const sn of wb.SheetNames) {
    const norm = sn.toLowerCase().replace(/\s+/g, " ").trim();
    if (norm.includes("payroll text exception") ||
        norm.includes("payroll exception") ||
        norm === "exceptions") {
      return sn;
    }
  }
  return null;
}

function toStr(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function classifyType(notes: string): ParsedException["exception_type"] {
  const n = notes.toLowerCase();
  if (n.includes("no show") || n.includes("noshow") || n.includes("closed")) return "closed";
  if (n.includes("short staff") || n.includes("no porter") || n.includes("reduced")) return "reduced_staffing";
  if (n.includes("do not text") || n.includes("dnt") || n.includes("don't text")) return "do_not_text";
  if (n.includes("holiday")) return "holiday";
  return "other";
}

// Pull MM/DD or M/D from the start of the notes ("6/2 short staff",
// "06/02 no show", "6/2/26 closed"). Year defaults to current.
function parseDate(notes: string, fallback: string): string {
  const m = notes.match(/^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!m) return fallback;
  const mm = m[1].padStart(2, "0");
  const dd = m[2].padStart(2, "0");
  let yyyy = m[3] ? m[3] : String(new Date().getFullYear());
  if (yyyy.length === 2) yyyy = "20" + yyyy;
  return `${yyyy}-${mm}-${dd}`;
}

export function parseBlueforceTracker(bytes: Uint8Array): ParseResult {
  const today = new Date().toISOString().slice(0, 10);
  const wb = XLSX.read(bytes, { type: "array" });
  const sheetName = findExceptionsSheetName(wb);
  if (!sheetName) {
    return { sheetFound: false, rowsParsed: 0, exceptions: [],
      errors: [{ row: 0, message: "No 'Payroll Text Exceptions' sheet found" }] };
  }
  const sheet = wb.Sheets[sheetName];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1, raw: true, blankrows: false,
  });

  // Scan first ~10 rows for the header — "Store #" | "Notes" | "Name" | "Dept"
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? "").toLowerCase().trim());
    if (cells.includes("store #") || cells.includes("store#") || cells.includes("store id")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { sheetFound: true, rowsParsed: 0, exceptions: [],
      errors: [{ row: 0, message: "Could not find header row with 'Store #' in the first 15 rows" }] };
  }

  // deno-lint-ignore no-explicit-any
  const headers = (rows[headerIdx] ?? []).map((h: any) => String(h ?? "").toLowerCase().trim());
  const idxStore = headers.findIndex((h) => h === "store #" || h === "store#" || h === "store id");
  const idxNotes = headers.findIndex((h) => h === "notes" || h === "note");
  const idxName  = headers.findIndex((h) => h === "name" || h === "store name" || h === "job site name");
  const idxDept  = headers.findIndex((h) => h === "dept" || h === "department" || h === "team");

  if (idxStore === -1) {
    return { sheetFound: true, rowsParsed: 0, exceptions: [],
      errors: [{ row: headerIdx + 1, message: "Header row found but no Store # column" }] };
  }

  const exceptions: ParsedException[] = [];
  const errors: ParseResult["errors"] = [];

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const storeRaw = toStr(row[idxStore]);
    if (!storeRaw) continue; // Skip blank rows or footer banner rows
    // Filter out obvious header-banner rows that may repeat
    if (storeRaw.toLowerCase().startsWith("below stores")) continue;

    const notes = (idxNotes >= 0 ? toStr(row[idxNotes]) : null) ?? "";
    const name  = idxName  >= 0 ? toStr(row[idxName])  : null;
    const dept  = idxDept  >= 0 ? toStr(row[idxDept])  : null;

    exceptions.push({
      site_id: storeRaw.toUpperCase(),
      exception_date: parseDate(notes, today),
      exception_type: classifyType(notes),
      note: notes || "(no notes)",
      reporter: dept,
      job_site_name: name,
    });
  }

  return { sheetFound: true, rowsParsed: exceptions.length, exceptions, errors };
}
