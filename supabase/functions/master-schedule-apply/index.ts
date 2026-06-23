// master-schedule-apply — apply a pending Master Schedule revision.
// Wraps the SQL fn_apply_master_schedule_revision so the UI Approve button
// has a single endpoint to call. After the revision lands in schedule_slot it
// also runs fn_sync_shift_blocks_from_schedule to refresh the punch->shift
// matcher inputs (shift_blocks + job_site_schedules) from the approved report.
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

  // The revision is now written to schedule_slot. Refresh the punch->shift
  // matcher inputs (shift_blocks + job_site_schedules) so classification reflects
  // the newly approved Master Schedule Report. Idempotent and safe to re-run.
  const { data: syncData, error: syncError } = await supabase.rpc(
    "fn_sync_shift_blocks_from_schedule",
  );
  const sync = Array.isArray(syncData) ? syncData[0] : syncData;

  return json(200, {
    revision_id: body.revision_id,
    added: row?.added ?? 0,
    modified: row?.modified ?? 0,
    removed: row?.removed ?? 0,
    status: "applied",
    // Surface sync result without failing the apply: the revision is already
    // committed, so a sync hiccup is recoverable by re-running the function.
    schedule_sync: syncError
      ? { ok: false, detail: syncError.message }
      : {
          ok: true,
          blocks_created: sync?.blocks_created ?? 0,
          schedules_upserted: sync?.schedules_upserted ?? 0,
          schedules_deactivated: sync?.schedules_deactivated ?? 0,
        },
  });

  function json(status: number, b: unknown) {
    return new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
