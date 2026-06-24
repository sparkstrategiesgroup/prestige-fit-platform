// Unit tests for the WinTeam Employee List (113) parser.
// Run: deno test supabase/functions/_shared/parse-employee-list.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mapStatus,
  normalizePhone,
  parseEmployeeListRows,
  parseEmployeeNumber,
} from "./parse-employee-list.ts";

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("parseEmployeeNumber: digits, numeric, and dirty values", () => {
  assertEquals(parseEmployeeNumber("12345"), 12345);
  assertEquals(parseEmployeeNumber(6789), 6789);
  assertEquals(parseEmployeeNumber(" 00042 "), 42);
  assertEquals(parseEmployeeNumber("EE-1001"), 1001);
  assertEquals(parseEmployeeNumber(""), null);
  assertEquals(parseEmployeeNumber(null), null);
  assertEquals(parseEmployeeNumber("abc"), null);
  assertEquals(parseEmployeeNumber(0), null);
});

Deno.test("mapStatus: WinTeam EEStatus -> employee.status enum", () => {
  assertEquals(mapStatus("Active"), "active");
  assertEquals(mapStatus("ACTIVE"), "active");
  assertEquals(mapStatus("Terminated"), "terminated");
  assertEquals(mapStatus("Term"), "terminated");
  assertEquals(mapStatus("Inactive"), "inactive");
  assertEquals(mapStatus("LOA"), "inactive");
  assertEquals(mapStatus("Leave of Absence"), "inactive");
  assertEquals(mapStatus(""), null);
  assertEquals(mapStatus(null), null);
});

Deno.test("normalizePhone: trims and caps at 20 chars", () => {
  assertEquals(normalizePhone("(555) 123-4567"), "(555) 123-4567");
  assertEquals(normalizePhone("  555-1234  "), "555-1234");
  assertEquals(normalizePhone(""), null);
  assertEquals(normalizePhone(null), null);
  assertEquals(normalizePhone("123456789012345678901234"), "12345678901234567890");
});

Deno.test("parseEmployeeListRows: maps a clean CSV", () => {
  const csv = [
    "EmployeeID,FirstName,LastName,Phone1,Phone2,PrimaryJob,PrimaryJobSite,EEStatus",
    "1001,Ana,Reyes,555-1111,555-2222,T3447,Target Cedar Hill,Active",
    "1002,Bob,Smith,,,K1234,Kohls Plano,Terminated",
  ].join("\n");
  const { rows, errors } = parseEmployeeListRows(enc(csv), "113_20260622_1736.csv");
  assertEquals(errors.length, 0);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].employee_number, 1001);
  assertEquals(rows[0].first_name, "Ana");
  assertEquals(rows[0].cell_phone, "555-1111");
  assertEquals(rows[0].phone_2, "555-2222");
  assertEquals(rows[0].primary_job_code, "T3447");
  assertEquals(rows[0].status, "active");
  assertEquals(rows[1].cell_phone, null);
  assertEquals(rows[1].status, "terminated");
});

Deno.test("parseEmployeeListRows: tolerates header aliases and spacing", () => {
  const csv = [
    "Employee ID,First Name,Last Name,Phone,Alternate Phone,Primary Job,Job Site,EE Status",
    "7,Cy,Jones,555-0000,,H9,Home Depot 9,Inactive",
  ].join("\n");
  const { rows, errors } = parseEmployeeListRows(enc(csv));
  assertEquals(errors.length, 0);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].employee_number, 7);
  assertEquals(rows[0].last_name, "Jones");
  assertEquals(rows[0].status, "inactive");
});

Deno.test("parseEmployeeListRows: de-dupes EmployeeID within a file (first wins)", () => {
  const csv = [
    "EmployeeID,FirstName,LastName,EEStatus",
    "1001,Ana,Reyes,Active",
    "1001,Ana,Reyes-Garcia,Active",
  ].join("\n");
  const { rows } = parseEmployeeListRows(enc(csv));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].last_name, "Reyes");
});

Deno.test("parseEmployeeListRows: flags rows with content but no EmployeeID", () => {
  const csv = [
    "EmployeeID,FirstName,LastName,EEStatus",
    ",Ghost,Row,Active",
    "2002,Real,Person,Active",
  ].join("\n");
  const { rows, errors } = parseEmployeeListRows(enc(csv));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].employee_number, 2002);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].field, "EmployeeID");
});

Deno.test("parseEmployeeListRows: header detected but LastName missing -> missingHeaders", () => {
  // EmployeeID + FirstName makes this a detected header row; LastName is then
  // a missing required column.
  const csv = ["EmployeeID,FirstName,EEStatus", "1001,Ana,Active"].join("\n");
  const { rows, missingHeaders } = parseEmployeeListRows(enc(csv));
  assertEquals(rows.length, 0);
  assertEquals(missingHeaders, ["LastName"]);
});

Deno.test("parseEmployeeListRows: no EmployeeID column -> headerError (no header row)", () => {
  const csv = ["FirstName,LastName,EEStatus", "Ana,Reyes,Active"].join("\n");
  const { rows, headerError } = parseEmployeeListRows(enc(csv));
  assertEquals(rows.length, 0);
  assertEquals(headerError, "no_header_row");
});

Deno.test("parseEmployeeListRows: random data -> headerError", () => {
  const csv = ["just,some,random,data", "1,2,3,4"].join("\n");
  const { rows, headerError } = parseEmployeeListRows(enc(csv));
  assertEquals(rows.length, 0);
  assertEquals(headerError, "no_header_row");
});

Deno.test("parseEmployeeListRows: skips title rows above the header", () => {
  const csv = [
    "Employee List",
    "Generated 2026-06-22",
    "EmployeeID,FirstName,LastName,EEStatus",
    "1001,Ana,Reyes,Active",
  ].join("\n");
  const { rows, errors } = parseEmployeeListRows(enc(csv));
  assertEquals(errors.length, 0);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].employee_number, 1001);
});
