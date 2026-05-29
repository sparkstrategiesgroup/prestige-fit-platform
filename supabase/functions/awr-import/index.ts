// awr-import — multipart upload of the AWR & OT Report XLSX.
//
// Parses the `Data` sheet (~14K rows/week), bulk-inserts into awr_data,
// then refreshes employee.pay_rate + winteam_classification from the
// latest week observed.
//
// DEMO MODE: no auth on the function; admin RLS enforces who can write.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { parseAwr } from "../_shared/parse-awr.ts";

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

  const parsed = parseAwr(buf);

  // Open the import row.
  const { data: imp, error: impErr } = await supabase
    .from("awr_import")
    .insert({
      wk_end: parsed.wk_end,
      source_filename: file.name,
      file_sha256: sha,
      row_count: parsed.rows.length,
      unique_employees: parsed.uniqueEmployees,
      unique_sites: parsed.uniqueSites,
      status: "pending",
    })
    .select("id").single();
  if (impErr || !imp) {
    return new Response(`Could not create awr_import: ${impErr?.message}`, { status: 500, headers: CORS });
  }
  const importId = imp.id;

  if (parsed.errors.length > 0 && parsed.rows.length === 0) {
    await supabase.from("awr_import").update({
      status: "failed",
      error_count: parsed.errors.length,
      errors: parsed.errors,
      completed_at: new Date().toISOString(),
    }).eq("id", importId);
    return new Response(JSON.stringify({ import_id: importId, status: "failed", errors: parsed.errors }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Bulk insert in chunks of 500. Attach awr_import_id to each row.
  const chunkSize = 500;
  let inserted = 0;
  const insertErrors: Array<{ row: number; message: string }> = [];
  for (let i = 0; i < parsed.rows.length; i += chunkSize) {
    const chunk = parsed.rows.slice(i, i + chunkSize).map((r) => ({ ...r, awr_import_id: importId }));
    const { error } = await supabase.from("awr_data").insert(chunk);
    if (error) {
      insertErrors.push({ row: i, message: `Chunk starting at row ${i}: ${error.message}` });
    } else {
      inserted += chunk.length;
    }
  }

  // Refresh employee payroll columns.
  let employeesUpdated = 0;
  if (inserted > 0) {
    const { data: refreshData, error: refreshErr } = await supabase.rpc("fn_refresh_employee_payroll_from_awr", {
      p_awr_import_id: importId,
    });
    if (refreshErr) {
      insertErrors.push({ row: 0, message: `Payroll refresh failed: ${refreshErr.message}` });
    } else {
      employeesUpdated = refreshData ?? 0;
    }
  }

  const finalStatus =
    insertErrors.length === 0 ? "succeeded" :
    inserted > 0 ? "partial" : "failed";

  await supabase.from("awr_import").update({
    status: finalStatus,
    error_count: insertErrors.length,
    errors: insertErrors.length ? insertErrors : null,
    completed_at: new Date().toISOString(),
  }).eq("id", importId);

  return new Response(JSON.stringify({
    import_id: importId,
    wk_end: parsed.wk_end,
    rows_parsed: parsed.rows.length,
    rows_inserted: inserted,
    unique_employees: parsed.uniqueEmployees,
    unique_sites: parsed.uniqueSites,
    employees_updated: employeesUpdated,
    errors: insertErrors,
    status: finalStatus,
  }), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
});
