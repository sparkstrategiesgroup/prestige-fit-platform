// master-schedule-import — multipart upload of the Master Schedule List XLSX.
//
// Flow:
//   1. POST multipart with `file` field (XLSX).
//   2. Insert a master_schedule_revision row (status=pending).
//   3. Parse the XLSX and diff against the current schedule_slot rows.
//   4. Bulk-insert one master_schedule_change row per add/modify/remove.
//   5. Return the revision id + summary counts. UI shows the diff and the
//      user clicks Approve (calls fn_apply_master_schedule_revision).
//
// DEMO MODE: no auth on the function itself; admin RLS enforces who can write.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { diffMasterSchedule } from "../_shared/parse-master-schedule.ts";

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

  // Open the revision row first so failures still leave a trail.
  const { data: rev, error: revErr } = await supabase
    .from("master_schedule_revision")
    .insert({
      source_filename: file.name,
      file_sha256: sha,
      status: "pending",
    })
    .select("id").single();
  if (revErr || !rev) {
    return new Response(`Could not create revision: ${revErr?.message}`, { status: 500, headers: CORS });
  }
  const revisionId = rev.id;

  const diff = await diffMasterSchedule(supabase, buf, file.name);

  // Insert all change rows in chunks (Supabase has a payload size limit).
  const changeRows = diff.changes.map((c) => ({
    revision_id: revisionId,
    change_type: c.change_type,
    site_id: c.site_id,
    slot_natural_key: c.slot_natural_key,
    target_slot_id: c.target_slot_id,
    old_payload: c.old_payload,
    new_payload: c.new_payload,
  }));
  for (let i = 0; i < changeRows.length; i += 200) {
    const chunk = changeRows.slice(i, i + 200);
    const { error: insErr } = await supabase.from("master_schedule_change").insert(chunk);
    if (insErr) {
      diff.errors.push({ row: 0, message: `Change insert chunk ${i}: ${insErr.message}` });
    }
  }

  const added = diff.changes.filter((c) => c.change_type === "add").length;
  const modified = diff.changes.filter((c) => c.change_type === "modify").length;
  const removed = diff.changes.filter((c) => c.change_type === "remove").length;

  await supabase
    .from("master_schedule_revision")
    .update({
      slot_count: diff.rowsParsed,
      slots_added: added,
      slots_modified: modified,
      slots_removed: removed,
      slots_unchanged: diff.unchanged,
    })
    .eq("id", revisionId);

  return new Response(JSON.stringify({
    revision_id: revisionId,
    rows_parsed: diff.rowsParsed,
    sites_created: diff.sitesCreated,
    sites_updated: diff.sitesUpdated,
    unchanged: diff.unchanged,
    added,
    modified,
    removed,
    errors: diff.errors,
    status: "pending",
    note: `Review the diff, then POST /functions/v1/master-schedule-apply with revision_id=${revisionId} to apply.`,
  }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
