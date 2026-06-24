// employee-list-import-email — Power Automate webhook for the WinTeam Employee
// List (113) report. Parallels epay-import-email, but routes the attachment to
// the Employee List parser, which refreshes the `employee` roster.
//
// Power Automate watches the FIT intake mailbox and POSTs 113_* attachments
// here (routing by the file-name prefix, per the WinTeam scheduled-export
// naming convention). The ePay punches flow keeps POSTing to epay-import-email.
//
// Expected request:
//   POST /functions/v1/employee-list-import-email
//   Headers:
//     x-fit-shared-secret: <matches Deno env EMAIL_INGEST_SHARED_SECRET>
//     Content-Type: application/json
//   Body:
//     {
//       "from": "kneff@sparkstrategiesgroup.com",
//       "subject": "Employee List 2026-06-22",
//       "received_at": "2026-06-22T22:00:00Z",
//       "attachments": [{
//         "name": "113_20260622_1736.csv",
//         "content_type": "text/csv",
//         "content_base64": "<base64>"
//       }]
//     }
//
// Validates the shared secret + sender allowlist, decodes the first .csv or
// .xlsx attachment, refreshes `employee`, and writes audit rows to
// email_imports + employee_list_imports.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ingestEmployeeListBytes } from "../_shared/parse-employee-list.ts";

type EmailPayload = {
  from?: string;
  subject?: string;
  received_at?: string;
  attachments?: Array<{
    name?: string;
    content_type?: string;
    content_base64?: string;
  }>;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-fit-shared-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function isSenderAllowed(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  sender: string,
): Promise<{ allowed: boolean; matched?: string }> {
  const s = sender.toLowerCase().trim();
  const domain = s.includes("@") ? s.slice(s.lastIndexOf("@")) : "";
  const candidates = [s, `*${domain}`];
  const { data } = await supabase
    .from("email_allowed_senders")
    .select("email")
    .eq("active", true)
    .in("email", candidates);
  if (data && data.length > 0) return { allowed: true, matched: data[0].email };
  return { allowed: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const expectedSecret = Deno.env.get("EMAIL_INGEST_SHARED_SECRET");
  const providedSecret = req.headers.get("x-fit-shared-secret");
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    return json(401, { error: "unauthorized", detail: "shared secret missing or mismatched" });
  }

  let body: EmailPayload;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad_json" });
  }

  const sender = (body.from ?? "").trim();
  if (!sender) return json(400, { error: "missing_from" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const allow = await isSenderAllowed(supabase, sender);
  if (!allow.allowed) {
    await supabase.from("email_imports").insert({
      sender,
      subject: body.subject ?? null,
      received_at: body.received_at ?? null,
      status: "rejected",
      rejection_reason: "Sender not in email_allowed_senders",
      completed_at: new Date().toISOString(),
    });
    return json(403, { error: "sender_not_allowed", sender });
  }

  // Pick the first .csv or .xlsx attachment.
  const reportFile = (body.attachments ?? []).find((a) => {
    const name = (a?.name ?? "").toLowerCase();
    return (name.endsWith(".csv") || name.endsWith(".xlsx")) && !!a?.content_base64;
  });
  if (!reportFile?.content_base64) {
    await supabase.from("email_imports").insert({
      sender,
      subject: body.subject ?? null,
      received_at: body.received_at ?? null,
      status: "rejected",
      rejection_reason: "No .csv or .xlsx attachment found in payload",
      completed_at: new Date().toISOString(),
    });
    return json(400, { error: "no_report_attachment" });
  }

  const bytes = base64ToBytes(reportFile.content_base64);
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  const attachName = reportFile.name ?? "EmployeeList.csv";

  // Dedup: Power Automate retries the same email up to 3 times within 10
  // minutes. Short-circuit so a retry of an already-applied roster refresh
  // doesn't run again.
  const { data: dupe } = await supabase
    .from("employee_list_imports")
    .select("id, completed_at")
    .eq("file_sha256", sha)
    .in("status", ["succeeded", "partial"])
    .order("id", { ascending: false })
    .limit(1);
  if (dupe && dupe.length > 0) {
    const firstImportId = dupe[0].id;
    await supabase.from("email_imports").insert({
      sender,
      subject: body.subject ?? null,
      received_at: body.received_at ?? null,
      attachment_filename: attachName,
      attachment_sha256: sha,
      attachment_bytes: bytes.length,
      status: "rejected",
      rejection_reason: `Duplicate of employee_list_imports id ${firstImportId} (same file SHA-256)`,
      employee_list_import_id: firstImportId,
      completed_at: new Date().toISOString(),
    });
    return json(200, { skipped: "duplicate", existing_employee_list_import_id: firstImportId, sha });
  }

  const { data: emailImport, error: emailErr } = await supabase
    .from("email_imports")
    .insert({
      sender,
      subject: body.subject ?? null,
      received_at: body.received_at ?? null,
      attachment_filename: attachName,
      attachment_sha256: sha,
      attachment_bytes: bytes.length,
      status: "pending",
    })
    .select("id").single();
  if (emailErr || !emailImport) {
    return json(500, { error: "could_not_log", detail: emailErr?.message });
  }
  const emailImportId = emailImport.id;

  const { data: listImport, error: listErr } = await supabase
    .from("employee_list_imports")
    .insert({
      filename: attachName,
      file_sha256: sha,
      status: "pending",
    })
    .select("id").single();
  if (listErr || !listImport) {
    return json(500, { error: "could_not_open_employee_list_import", detail: listErr?.message });
  }
  const listImportId = listImport.id;

  const result = await ingestEmployeeListBytes(supabase, bytes, listImportId, attachName);

  let listStatus: string; let emailStatus: string;
  if (result.headerError || result.missingHeaders) {
    listStatus = "failed"; emailStatus = "failed";
  } else if (result.errors.length === 0) {
    listStatus = "succeeded"; emailStatus = "succeeded";
  } else if (result.updated > 0 || result.matched > 0) {
    // Roster refreshed but some rows were unmatched/failed -> partial.
    listStatus = "partial"; emailStatus = "partial";
  } else {
    listStatus = "failed"; emailStatus = "failed";
  }

  await supabase.from("employee_list_imports").update({
    row_count: result.rowCount,
    matched_count: result.matched,
    updated_count: result.updated,
    unmatched_count: result.unmatched,
    error_count: result.errors.length,
    errors: result.errors.length ? result.errors : null,
    status: listStatus,
    completed_at: new Date().toISOString(),
  }).eq("id", listImportId);

  await supabase.from("email_imports").update({
    imported_count: result.updated,
    error_count: result.errors.length,
    errors: result.errors.length ? result.errors : null,
    status: emailStatus,
    employee_list_import_id: listImportId,
    completed_at: new Date().toISOString(),
  }).eq("id", emailImportId);

  return json(200, {
    email_import_id: emailImportId,
    employee_list_import_id: listImportId,
    sender,
    matched_rule: allow.matched,
    rows: result.rowCount,
    matched: result.matched,
    updated: result.updated,
    unmatched: result.unmatched,
    errors: result.errors,
  });
});
