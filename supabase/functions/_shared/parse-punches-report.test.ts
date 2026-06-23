// Unit tests for the Punches Report parser's timezone handling.
// Run: deno test supabase/functions/_shared/parse-punches-report.test.ts
//
// ePay exports a store's local wall-clock punch times with no timezone. They are
// stored in the timestamptz columns time_in/time_out and read back by
// fn_pick_shift_block via `AT TIME ZONE`, so they must be the correct UTC
// instant. wallClockToUtcIso performs that conversion using the site timezone.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseHoursToDecimal, wallClockToUtcIso } from "./parse-punches-report.ts";

Deno.test("Central, summer (CDT, UTC-5): 2:30pm -> 19:30Z", () => {
  assertEquals(
    wallClockToUtcIso(2026, 6, 22, 14, 30, 0, "America/Chicago"),
    "2026-06-22T19:30:00.000Z",
  );
});

Deno.test("Central, winter (CST, UTC-6): 2:30pm -> 20:30Z", () => {
  assertEquals(
    wallClockToUtcIso(2026, 1, 15, 14, 30, 0, "America/Chicago"),
    "2026-01-15T20:30:00.000Z",
  );
});

Deno.test("Eastern, summer (EDT, UTC-4): 2:30pm -> 18:30Z", () => {
  assertEquals(
    wallClockToUtcIso(2026, 6, 22, 14, 30, 0, "America/New_York"),
    "2026-06-22T18:30:00.000Z",
  );
});

Deno.test("Arizona (no DST, UTC-7): 9:00am -> 16:00Z", () => {
  assertEquals(
    wallClockToUtcIso(2026, 6, 22, 9, 0, 0, "America/Phoenix"),
    "2026-06-22T16:00:00.000Z",
  );
});

Deno.test("late-night punch crosses the UTC date boundary", () => {
  assertEquals(
    wallClockToUtcIso(2026, 12, 15, 23, 45, 0, "America/Denver"),
    "2026-12-16T06:45:00.000Z",
  );
});

Deno.test("midnight maps to the correct instant (no '24' artifact)", () => {
  assertEquals(
    wallClockToUtcIso(2026, 6, 22, 0, 0, 0, "America/Chicago"),
    "2026-06-22T05:00:00.000Z",
  );
});

Deno.test("parseHoursToDecimal: '0:00' -> 0 (not null)", () => {
  assertEquals(parseHoursToDecimal("0:00"), 0);
});

Deno.test("parseHoursToDecimal: numeric 0 -> 0 (not dropped to null)", () => {
  assertEquals(parseHoursToDecimal(0), 0);
});

Deno.test("parseHoursToDecimal: '8:30' -> 8.5", () => {
  assertEquals(parseHoursToDecimal("8:30"), 8.5);
});

Deno.test("parseHoursToDecimal: numeric 7.5 passes through", () => {
  assertEquals(parseHoursToDecimal(7.5), 7.5);
});

Deno.test("parseHoursToDecimal: empty / null -> null", () => {
  assertEquals(parseHoursToDecimal(""), null);
  assertEquals(parseHoursToDecimal(null), null);
  assertEquals(parseHoursToDecimal(undefined), null);
});

Deno.test("parseHoursToDecimal: garbage -> null", () => {
  assertEquals(parseHoursToDecimal("n/a"), null);
});
