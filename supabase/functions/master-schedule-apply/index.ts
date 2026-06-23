// master-schedule-apply — apply a pending Master Schedule revision.
// Wraps the SQL fn_apply_master_schedule_revision so the UI Approve button
// has a single endpoint to call.
//
// POST body: { revision_id: number }
// DEMO MODE: no auth on the function; SQL function is SECURITY DEFINER.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

  let body: { revision_id?: number };
  try { body = await req.json(); } catch { return json(400, { error: "bad_json" }); }
  if (!body.revision_id) return json(400, { error: "missing_revision_id" });

  const { data, error } = await supabase.rpc("fn_apply_master_schedule_revision", {
    p_revision_id: body.revision_id,
  });

  if (error) {
    return json(500, { error: "apply_failed", detail: error.message });
  }
  const row = Array.isArray(data) ? data[0] : data;
  return json(200, {
    revision_id: body.revision_id,
    added: row?.added ?? 0,
    modified: row?.modified ?? 0,
    removed: row?.removed ?? 0,
    status: "applied",
  });

  function json(status: number, b: unknown) {
    return new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
