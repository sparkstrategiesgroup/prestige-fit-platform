// blueforce-tracker-import — multipart upload of a chain's Blueforce
// Tracker XLSX. Reads the "Payroll Text Exceptions" sheet and inserts
// one store_exception row per data row.
//
// The XLSX is the daily source of truth for which sites should be
// excluded from end-of-shift texting. Notes in the source like
// "6/2 no show" / "6/2 short staff" are preserved verbatim and also
// classified into our exception_type enum via keyword matching.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { parseBlueforceTracker } from "../_shared/parse-blueforce-tracker.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return new Response("Missing 'file' field", { status: 400, headers: CORS });
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  const parsed = parseBlueforceTracker(buf);

  if (!parsed.sheetFound) {
    return new Response(JSON.stringify({
      error: "no_exceptions_sheet",
      errors: parsed.errors,
      filename: file.name,
    }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Look up site IDs that already exist; skip rows pointing at unknown sites
  // so we don't create accidental dupes by typo.
  const siteIds = Array.from(new Set(parsed.exceptions.map((e) => e.site_id)));
  const { data: existingSites } = await supabase
    .from("site")
    .select("site_id")
    .in("site_id", siteIds);
  const existingSet = new Set((existingSites ?? []).map((s) => s.site_id));

  const toInsert: Array<Record<string, unknown>> = [];
  const skipped: string[] = [];
  for (const e of parsed.exceptions) {
    if (!existingSet.has(e.site_id)) {
      skipped.push(e.site_id);
      continue;
    }
    toInsert.push({
      site_id: e.site_id,
      exception_date: e.exception_date,
      exception_type: e.exception_type,
      note: e.note,
      reporter: e.reporter,
      source: "email",            // landed via tracker (could be 'tracker' if we add the enum value)
      active: true,
    });
  }

  let inserted = 0;
  const errors: Array<{ message: string }> = [];
  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200);
    const { error } = await supabase.from("store_exception").insert(chunk);
    if (error) errors.push({ message: error.message });
    else inserted += chunk.length;
  }

  return new Response(JSON.stringify({
    filename: file.name,
    rows_parsed: parsed.rowsParsed,
    inserted,
    skipped_unknown_sites: skipped,
    errors,
    sample: parsed.exceptions.slice(0, 5),
  }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
