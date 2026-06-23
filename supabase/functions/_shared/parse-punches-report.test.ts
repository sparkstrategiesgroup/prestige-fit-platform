// Unit tests for the Punches Report parser.
// Run: deno test supabase/functions/_shared/parse-punches-report.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseHoursToDecimal } from "./parse-punches-report.ts";

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
