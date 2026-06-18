// Unit tests for the Schedule Report parser (real WinTeam export columns).
// Run: deno test supabase/functions/_shared/parse-master-schedule.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { diffMasterSchedule } from "./parse-master-schedule.ts";

// Real export header order + a few representative rows (mirrors the fixture CSV).
const HEADERS = [
  "JobNumber", "JobDescription", "JobState", "Dept", "TimeZoneName",
  "StartTime", "EndTime", "Sun", "Mon", "Tues", "Wed", "Thur", "Fri", "Sat",
  "Lunch", "SunTotal", "MonTotal", "TuesTotal", "WedTotal", "ThurTotal",
  "FriTotal", "SatTotal", "TotalHours", "HoursTypeDescription",
];
const ROWS = [
  ["KOH0344", "Kohls # 0344 - Westminster CO", "CO", "3003 - West", "US/Mountain", "08:00:00", "16:30:00", 1, "", "", "", "", "", 1, 0.5, 8, 0, 0, 0, 0, 0, 8, 16, "Labor Direct - CO"],
  ["KOH0344", "Kohls # 0344 - Westminster CO", "CO", "3003 - West", "US/Mountain", "07:00:00", "14:30:00", "", 1, 1, 1, "", "", "", 0.5, 0, 7, 7, 7, 0, 0, 0, 21, "Labor Direct - CO"],
  ["H2101", "Home Depot # 2101 Waterloo", "IA", "4001 - Midwest", "US/Central", "05:00:00", "10:00:00", 1, 1, 1, 1, 1, 1, 1, 0.0, 5, 5, 5, 5, 5, 5, 5, 30, "Labor Direct - IA"],
];

function xlsxBytes(aoa: unknown[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

// Minimal chainable Supabase stub covering the calls the parser makes.
function mockSupabase(opts: { existingSites?: { site_id: string }[]; existingSlots?: Record<string, unknown>[] } = {}) {
  const inserts: { table: string; obj: Record<string, unknown> }[] = [];
  const updates: { table: string; patch: Record<string, unknown>; id: string }[] = [];
  const api = {
    from(table: string) {
      return {
        select(_cols: string) {
          const result = table === "schedule_slot"
            ? { data: opts.existingSlots ?? [], error: null }
            : { data: opts.existingSites ?? [], error: null };
          // Support both `await select(...)` (fetch-all) and `select(...).in(...)`.
          return {
            in(_col: string, _vals: string[]) {
              return Promise.resolve(result);
            },
            then(
              onFulfilled: (v: typeof result) => unknown,
              onRejected?: (e: unknown) => unknown,
            ) {
              return Promise.resolve(result).then(onFulfilled, onRejected);
            },
          };
        },
        insert(obj: Record<string, unknown>) {
          inserts.push({ table, obj });
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              updates.push({ table, patch, id });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
    _inserts: inserts,
    _updates: updates,
  };
  return api;
}

Deno.test("parses real export columns, captures department + report fields (net-new sites)", async () => {
  const supabase = mockSupabase();
  const diff = await diffMasterSchedule(supabase, xlsxBytes([HEADERS, ...ROWS]));

  assertEquals(diff.errors, []);
  assertEquals(diff.rowsParsed, 3);
  assertEquals(diff.sitesCreated, 2); // KOH0344, H2101
  assertEquals(diff.sitesUpdated, 0);
  // No existing slots → every change is an add.
  assertEquals(diff.changes.filter((c) => c.change_type === "add").length, 3);
  assertEquals(diff.changes.filter((c) => c.change_type === "remove").length, 0);

  // Department split + state + name + tz normalization land on the site insert.
  const koh = supabase._inserts.find((i) => i.obj.site_id === "KOH0344")!.obj;
  assertEquals(koh.dept_code, "3003");
  assertEquals(koh.dept_description, "West");
  assertEquals(koh.state, "CO");
  assertEquals(koh.site_name, "Kohls # 0344 - Westminster CO");
  assertEquals(koh.time_zone, "America/Denver"); // US/Mountain normalized

  // The 08:00–16:30 KOH0344 shift: lunch 0.5h → 30 min, Sun+Sat, total 16.
  const shift = diff.changes.find(
    (c) => c.change_type === "add" && c.site_id === "KOH0344" && c.new_payload?.start_time === "08:00:00",
  )!.new_payload!;
  assertEquals(shift.end_time, "16:30:00");
  assertEquals(shift.flex_hours, 30);
  assertEquals(shift.total_hours, 16);
  assertEquals(shift.hours_type_description, "Labor Direct - CO");
  assertEquals(shift.time_zone, "America/Denver");
  assertEquals(shift.days_of_week, [true, false, false, false, false, false, true]);

  // H2101: lunch 0.0 → 0 min, all 7 days, US/Central → America/Chicago.
  const hd = diff.changes.find((c) => c.change_type === "add" && c.site_id === "H2101")!.new_payload!;
  assertEquals(hd.flex_hours, 0);
  assertEquals(hd.total_hours, 30);
  assertEquals(hd.time_zone, "America/Chicago");
  assertEquals(hd.days_of_week, [true, true, true, true, true, true, true]);
});

Deno.test("per-site replace: existing slots become removes, existing site is updated", async () => {
  const supabase = mockSupabase({
    existingSites: [{ site_id: "KOH0344" }],
    existingSlots: [
      { slot_id: "11111111-1111-1111-1111-111111111111", site_id: "KOH0344", start_time: "09:00:00", end_time: "17:00:00", days_of_week: [false, true, true, true, true, true, false], flex_hours: 30, total_hours: null, hours_type_description: null, time_zone: "America/Chicago", role: null },
    ],
  });
  const diff = await diffMasterSchedule(supabase, xlsxBytes([HEADERS, ROWS[0], ROWS[1]]));

  // KOH0344 already exists → updated, not created; H2101 absent from this upload.
  assertEquals(diff.sitesCreated, 0);
  assertEquals(diff.sitesUpdated, 1);
  assertEquals(supabase._updates[0].patch.dept_code, "3003");

  // One existing slot → one remove; two report rows → two adds.
  const removes = diff.changes.filter((c) => c.change_type === "remove");
  assertEquals(removes.length, 1);
  assertEquals(removes[0].target_slot_id, "11111111-1111-1111-1111-111111111111");
  assert(removes[0].old_payload !== null);
  assertEquals(diff.changes.filter((c) => c.change_type === "add").length, 2);
});

Deno.test("rejects a workbook whose columns are not the Schedule Report", async () => {
  const diff = await diffMasterSchedule(mockSupabase(), xlsxBytes([["Foo", "Bar", "Baz"], ["a", "b", "c"]]));
  assertEquals(diff.rowsParsed, 0);
  assert(diff.errors.length > 0);
  assert(diff.errors[0].message.includes("header row") || diff.errors[0].message.includes("Missing required"));
});

Deno.test("reads the real CSV export (CRLF, quoted comma, 4-dp Lunch, trailing space)", async () => {
  // Mirrors the real WinTeam export: CRLF lines, Lunch as "0.5000", a trailing
  // space on HoursTypeDescription, and one store name quoted because it has a comma.
  const csv = [
    HEADERS.join(","),
    "KOH0344,Kohls # 0344 - Westminster CO,CO,3003 - West,US/Mountain,08:00:00,16:30:00,1,,,,,,1,0.5000,8,0,0,0,0,0,8,16,Labor Direct - CO ",
    'H299,"Home Depot, Waterloo",IA,4001 - Midwest,US/Central,05:00:00,10:00:00,1,1,1,1,1,1,1,0.0000,5,5,5,5,5,5,5,30,Labor Direct - IA',
  ].join("\r\n");
  const supabase = mockSupabase();
  const diff = await diffMasterSchedule(supabase, new TextEncoder().encode(csv), "SCHEDULE_REPORT_20260615.csv");

  assertEquals(diff.errors, []);
  assertEquals(diff.rowsParsed, 2);

  const koh = diff.changes.find((c) => c.site_id === "KOH0344" && c.change_type === "add")!.new_payload!;
  assertEquals(koh.flex_hours, 30);                          // 0.5000h -> 30 min
  assertEquals(koh.total_hours, 16);
  assertEquals(koh.hours_type_description, "Labor Direct - CO"); // trailing space trimmed
  assertEquals(koh.time_zone, "America/Denver");

  // The quoted field containing a comma is preserved as the site name.
  const h299 = supabase._inserts.find((i) => i.obj.site_id === "H299")!.obj;
  assertEquals(h299.site_name, "Home Depot, Waterloo");
  assertEquals(h299.dept_code, "4001");
  assertEquals(h299.dept_description, "Midwest");
});

Deno.test("matches an existing mixed-case site id case-insensitively (no upper-cased duplicate)", async () => {
  const supabase = mockSupabase({
    existingSites: [{ site_id: "ChPrestige" }],
    existingSlots: [
      { slot_id: "22222222-2222-2222-2222-222222222222", site_id: "ChPrestige", start_time: "12:00:00", end_time: "15:00:00", days_of_week: [false, false, false, true, false, true, false], flex_hours: 0, total_hours: 6, hours_type_description: null, time_zone: "America/Chicago", role: null },
    ],
  });
  // JobNumber "ChPrestige" upper-cases to "CHPRESTIGE" but must resolve to the
  // existing mixed-case row, not create an upper-cased duplicate site.
  const row = ["ChPrestige", "Chicago Prestige Office", "IL", "50000 - Great Lakes Region", "US/Central", "12:00:00", "15:00:00", "", "", "", 1, "", 1, "", 0, 0, 0, 0, 3, 0, 3, 0, 6, ""];
  const diff = await diffMasterSchedule(supabase, xlsxBytes([HEADERS, row]));

  assertEquals(diff.errors, []);
  // Existing site matched case-insensitively → updated by its existing casing, not created.
  assertEquals(diff.sitesCreated, 0);
  assertEquals(diff.sitesUpdated, 1);
  assertEquals(supabase._updates[0].id, "ChPrestige");

  // The add lands on the existing casing; the existing slot is removed (true replace).
  const adds = diff.changes.filter((c) => c.change_type === "add");
  assertEquals(adds.length, 1);
  assertEquals(adds[0].site_id, "ChPrestige");
  assertEquals(diff.changes.filter((c) => c.change_type === "remove").length, 1);
});
