// Shared parser for the AWR & OT Report XLSX.
// Reads the `Data` sheet (~14K rows/week) and returns row objects ready for
// bulk-insert into awr_data. Caller writes the awr_import row and runs
// fn_refresh_employee_payroll_from_awr() afterward.

import * as XLSX from "https://esm.sh/xlsx@0.18.5";

export type AwrRow = {
  wk_end: string | null;
  dept: string | null;
  job_site_number: string | null;
  job_no: string | null;
  store: string | null;
  region: string | null;
  state: string | null;
  job_site_name: string | null;
  employee_number: number | null;
  employee_name: string | null;
  work_date: string | null;
  task: string | null;
  hours: number | null;
  rate_type: string | null;
  pay_rate: number | null;
  winteam_classification: string | null;
  wages: number | null;
  no_ot_wages: number | null;
  no_ot_hrs: number | null;
  no_ot_rate: number | null;
  ot_wages: number | null;
  ot_hrs: number | null;
  ot_half_cost: number | null;
  fully_staffed: boolean | null;
  bud_hrs: number | null;
  bud_awr: number | null;
};

export type AwrParseResult = {
  wk_end: string | null;
  rows: AwrRow[];
  errors: Array<{ row: number; message: string }>;
  uniqueEmployees: number;
  uniqueSites: number;
};

// Map "Custodian" -> "CUSTODIAN", etc. Matches labor_type.name values.
const CLASSIFICATION_TO_CODE: Record<string, string> = {
  "Custodian": "CUSTODIAN",
  "Lead Custodian": "LEAD_CUSTODIAN",
  "Porter": "PORTER",
  "Floater": "FLOATER",
  "Floater ": "FLOATER",
  "Facilities Supervisor": "FACILITIES_SUPERVISOR",
  "Project Tech": "PROJECT_TECH",
  "Subcontract Labor": "SUBCONTRACT_LABOR",
};

const COLS = [
  "Wk End","Dept","Job/Site Number","Job #","Store","Region","State",
  "Job/Site Name","Employee No.","Employee Name","Date","Task","Hours",
  "Rate Type","Pay Rate","WinTeam Classification","Wages","NO OT Wages",
  "NO OT Hrs","NO OT Rate","OT Wages","OT Hrs","OT 1/2 Cost",
  "Fully Staffed","Bud Hrs","Bud AWR",
];

function toStr(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function toInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function toBool(v: unknown): boolean | null {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["yes","y","true","1"].includes(s)) return true;
  if (["no","n","false","0"].includes(s)) return false;
  return null;
}

function toDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    // Excel date serial
    return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  // ISO already?
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // MM/DD/YYYY
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    return `${us[3]}-${us[1].padStart(2,"0")}-${us[2].padStart(2,"0")}`;
  }
  return null;
}

export function parseAwr(bytes: Uint8Array): AwrParseResult {
  const wb = XLSX.read(bytes, { type: "array" });
  const sheet = wb.Sheets["Data"];
  if (!sheet) {
    return { wk_end: null, rows: [], errors: [{ row: 0, message: "Sheet 'Data' not found" }], uniqueEmployees: 0, uniqueSites: 0 };
  }
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1, raw: true, blankrows: false,
  });
  if (rows.length < 2) {
    return { wk_end: null, rows: [], errors: [{ row: 0, message: "Data sheet is empty" }], uniqueEmployees: 0, uniqueSites: 0 };
  }
  // deno-lint-ignore no-explicit-any
  const headerRow = (rows[0] ?? []).map((h: any) => String(h ?? "").trim());
  const idx: Record<string, number> = {};
  for (const c of COLS) idx[c] = headerRow.indexOf(c);
  const missing = COLS.filter((c) => idx[c] === -1);
  if (missing.length) {
    return { wk_end: null, rows: [], errors: [{ row: 1, message: `Missing required columns: ${missing.join(", ")}` }], uniqueEmployees: 0, uniqueSites: 0 };
  }

  const errors: AwrParseResult["errors"] = [];
  const out: AwrRow[] = [];
  const employees = new Set<number>();
  const sites = new Set<string>();
  let latestWkEnd: string | null = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;

    const wkEnd = toDate(row[idx["Wk End"]]);
    if (wkEnd && (!latestWkEnd || wkEnd > latestWkEnd)) latestWkEnd = wkEnd;

    const classRaw = toStr(row[idx["WinTeam Classification"]]);
    const winteam_classification = classRaw ? (CLASSIFICATION_TO_CODE[classRaw] ?? null) : null;

    const empNo = toInt(row[idx["Employee No."]]);
    const jobNo = toStr(row[idx["Job #"]]);
    if (empNo) employees.add(empNo);
    if (jobNo) sites.add(jobNo);

    out.push({
      wk_end: wkEnd,
      dept: toStr(row[idx["Dept"]]),
      job_site_number: toStr(row[idx["Job/Site Number"]]),
      job_no: jobNo,
      store: toStr(row[idx["Store"]]),
      region: toStr(row[idx["Region"]]),
      state: toStr(row[idx["State"]]),
      job_site_name: toStr(row[idx["Job/Site Name"]]),
      employee_number: empNo,
      employee_name: toStr(row[idx["Employee Name"]]),
      work_date: toDate(row[idx["Date"]]),
      task: toStr(row[idx["Task"]]),
      hours: toNum(row[idx["Hours"]]),
      rate_type: toStr(row[idx["Rate Type"]]),
      pay_rate: toNum(row[idx["Pay Rate"]]),
      winteam_classification,
      wages: toNum(row[idx["Wages"]]),
      no_ot_wages: toNum(row[idx["NO OT Wages"]]),
      no_ot_hrs: toNum(row[idx["NO OT Hrs"]]),
      no_ot_rate: toNum(row[idx["NO OT Rate"]]),
      ot_wages: toNum(row[idx["OT Wages"]]),
      ot_hrs: toNum(row[idx["OT Hrs"]]),
      ot_half_cost: toNum(row[idx["OT 1/2 Cost"]]),
      fully_staffed: toBool(row[idx["Fully Staffed"]]),
      bud_hrs: toNum(row[idx["Bud Hrs"]]),
      bud_awr: toNum(row[idx["Bud AWR"]]),
    });
  }

  return { wk_end: latestWkEnd, rows: out, errors, uniqueEmployees: employees.size, uniqueSites: sites.size };
}
