// epay-import-email — Power Automate webhook for Punches Report attachments.
//
// Expected request:
//   POST /functions/v1/epay-import-email
//   Headers:
//     x-fit-shared-secret: <matches Deno env EMAIL_INGEST_SHARED_SECRET>
//     Content-Type: application/json
//   Body:
//     {
//       "from": "noreply@epayinc.com",
//       "subject": "Punches Report 2026-05-20",
//       "received_at": "2026-05-20T15:00:00Z",
//       "attachments": [{
//         "name": "PunchesReport.xlsx",
//         "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
//         "content_base64": "<base64>"
//       }]
//     }
//
// Validates the shared secret + sender allowlist, decodes the first .xlsx or
// .csv attachment, runs the shared parser, and writes audit rows to
// email_imports + epay_imports.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ingestWorkbookBytes } from "../_shared/parse-punches-report.ts";

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

  // Pick the first .xlsx or .csv attachment.
  const reportFile = (body.attachments ?? []).find((a) => {
    const name = (a?.name ?? "").toLowerCase();
    return (name.endsWith(".xlsx") || name.endsWith(".csv")) && !!a?.content_base64;
  });
  if (!reportFile?.content_base64) {
    await supabase.from("email_imports").insert({
      sender,
      subject: body.subject ?? null,
      received_at: body.received_at ?? null,
      status: "rejected",
      rejection_reason: "No .xlsx or .csv attachment found in payload",
      completed_at: new Date().toISOString(),
    });
    return json(400, { error: "no_report_attachment" });
  }

  const bytes = base64ToBytes(reportFile.content_base64);
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  const attachName = reportFile.name ?? "PunchesReport.xlsx";

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

  const { data: epayImport, error: epayErr } = await supabase
    .from("epay_imports")
    .insert({
      filename: attachName,
      file_sha256: sha,
      status: "pending",
    })
    .select("id").single();
  if (epayErr || !epayImport) {
    return json(500, { error: "could_not_open_epay_import", detail: epayErr?.message });
  }
  const epayImportId = epayImport.id;

  const result = await ingestWorkbookBytes(supabase, bytes, epayImportId, attachName);

  let epayStatus: string; let emailStatus: string;
  if (result.headerError) {
    epayStatus = "failed"; emailStatus = "failed";
  } else if (result.errors.length === 0) {
    epayStatus = "succeeded"; emailStatus = "succeeded";
  } else if (result.imported > 0) {
    epayStatus = "partial"; emailStatus = "partial";
  } else {
    epayStatus = "failed"; emailStatus = "failed";
  }

  await supabase.from("epay_imports").update({
    row_count: result.rowCount,
    imported_count: result.imported,
    skipped_count: result.skipped,
    error_count: result.errors.length,
    errors: result.errors.length ? result.errors : null,
    status: epayStatus,
    completed_at: new Date().toISOString(),
  }).eq("id", epayImportId);

  await supabase.from("email_imports").update({
    imported_count: result.imported,
    sites_created: result.sitesCreated,
    error_count: result.errors.length,
    errors: result.errors.length ? result.errors : null,
    status: emailStatus,
    epay_import_id: epayImportId,
    completed_at: new Date().toISOString(),
  }).eq("id", emailImportId);

  return json(200, {
    email_import_id: emailImportId,
    epay_import_id: epayImportId,
    sender,
    matched_rule: allow.matched,
    imported: result.imported,
    sites_created: result.sitesCreated,
    skipped: result.skipped,
    errors: result.errors,
  });
});
