// Epay Punches Report import — manual-upload Edge Function (DEMO MODE: no auth).
// All parsing + upsert logic lives in _shared/parse-punches-report.ts so the
// email-driven webhook (epay-import-email) produces identical rows.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ingestWorkbookBytes } from "../_shared/parse-punches-report.ts";

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
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  const { data: importRow, error: insertErr } = await supabase.from("epay_imports")
    .insert({ filename: file.name, file_sha256: sha, status: "pending" })
    .select("id").single();
  if (insertErr || !importRow) {
    return new Response(`Could not create import row: ${insertErr?.message}`, {
      status: 500, headers: CORS,
    });
  }
  const importId = importRow.id;

  const result = await ingestWorkbookBytes(supabase, buf, importId, file.name);

  if (result.headerError === "no_header_row") {
    await supabase.from("epay_imports").update({
      status: "failed",
      errors: result.errors,
      completed_at: new Date().toISOString(),
    }).eq("id", importId);
    return new Response(JSON.stringify({ import_id: importId, error: "no_header_row" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (result.headerError === "bad_headers") {
    await supabase.from("epay_imports").update({
      status: "failed",
      errors: [{ row: 5, message: `Missing headers: ${result.missingHeaders?.join(", ")}` }],
      completed_at: new Date().toISOString(),
    }).eq("id", importId);
    return new Response(
      JSON.stringify({ import_id: importId, error: "bad_headers", missing: result.missingHeaders }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  const status = result.errors.length === 0
    ? "succeeded"
    : result.imported > 0 ? "partial" : "failed";

  await supabase.from("epay_imports").update({
    row_count: result.rowCount,
    imported_count: result.imported,
    skipped_count: result.skipped,
    error_count: result.errors.length,
    errors: result.errors.length ? result.errors : null,
    status,
    completed_at: new Date().toISOString(),
  }).eq("id", importId);

  return new Response(JSON.stringify({
    import_id: importId,
    imported: result.imported,
    skipped: result.skipped,
    sites_created: result.sitesCreated,
    errors: result.errors,
  }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
});
