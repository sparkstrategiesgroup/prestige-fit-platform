// shift-block-runner — runs the end-of-shift texting eligibility query and
// records the notifications that would be sent.
//
// MODE: stub (no real SMS). Every notification is written to the notifications
// table with provider='TEXT_REQUEST_STUB' and a synthetic provider_message_id.
// Swap the call inside `sendViaTextRequest` for the real API once credentials
// are available — nothing else needs to change.
//
// Invocation:
//   POST /functions/v1/shift-block-runner
//     body: { shift_block_id?: number, kind?: "warning" | "clocked_out" }
//
//   - If shift_block_id is omitted, the runner picks every active block whose
//     warning_offset or clocked_offset matches the current time (per the
//     block's end_timezone). This is the cron path.
//   - If kind is omitted, both warning and clocked_out are evaluated.
//
// Returns: { runs: [{ shift_block_id, kind, recipients, notifications }] }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

type Kind = "warning" | "clocked_out";

const TYPE_FOR_KIND: Record<Kind, string> = {
  warning: "END_OF_SHIFT_WARNING",
  clocked_out: "END_OF_SHIFT_CLOCKED_OUT",
};

type Recipient = {
  payroll_number: string;
  employee_id: number;
  employee_name: string;
  cell_phone: string;
  job_site_name: string;
  language: "en" | "es";
};

async function eligibleRecipients(
  supabase: ReturnType<typeof createClient>,
  shiftBlockId: number,
): Promise<Recipient[]> {
  // The eligibility query: open punches on this shift block, excluding subs,
  // lunch rows, manager/supervisor employees, rows with an exception, and
  // anyone without a valid phone.
  const { data, error } = await supabase.rpc("fn_eligible_for_shift_block", {
    p_shift_block_id: shiftBlockId,
    p_work_date: new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(`eligibility query failed: ${error.message}`);
  return (data ?? []) as Recipient[];
}

// Real Text Request send. Driven by Supabase env vars so the API key never
// touches code/version control:
//   TEXT_REQUEST_API_KEY     — required to enable real sending; if absent
//                              the function falls back to the stub mode
//                              (kept around for demos / offline dev).
//   TEXT_REQUEST_ACCOUNT_ID  — TR account ID (e.g. "20349")
//   TEXT_REQUEST_FROM_NUMBER — verified TR sending number (digits only)
//   TEXT_REQUEST_BASE_URL    — defaults to https://api.textrequest.com.
//                              Override if TR's API surface changes.
//   TEST_RECIPIENT_PHONE     — when set, every send is rerouted to this
//                              number (the real recipient is mentioned in
//                              the message body so we can verify the loop
//                              before flipping it to production).
function digitsOnly(p: string): string {
  return (p ?? "").replace(/\D/g, "");
}

async function sendViaTextRequest(
  phone: string,
  body: string,
  recipientName: string,
): Promise<{
  provider: string;
  provider_message_id: string;
  recipient_address: string;
  message_body: string;
  delivery_status: string;
  error?: string;
}> {
  const apiKey    = Deno.env.get("TEXT_REQUEST_API_KEY");
  const accountId = Deno.env.get("TEXT_REQUEST_ACCOUNT_ID");
  const fromNum   = Deno.env.get("TEXT_REQUEST_FROM_NUMBER");
  const baseUrl   = Deno.env.get("TEXT_REQUEST_BASE_URL") ?? "https://api.textrequest.com/api/v3";
  const sendPath  = Deno.env.get("TEXT_REQUEST_SEND_PATH") ?? "/dashboards/{accountId}/messages";
  const testTo    = Deno.env.get("TEST_RECIPIENT_PHONE");

  // No credentials → keep the historical stub behavior so demos still work.
  if (!apiKey || !accountId || !fromNum) {
    return {
      provider: "TEXT_REQUEST_STUB",
      provider_message_id: `STUB-${crypto.randomUUID()}`,
      recipient_address: phone,
      message_body: body,
      delivery_status: "sent",
    };
  }

  const finalTo = testTo ? digitsOnly(testTo) : digitsOnly(phone);
  const finalBody = testTo
    ? `[TEST → would have gone to ${recipientName} ${phone}]\n${body}`
    : body;

  const url = `${baseUrl}${sendPath.replace("{accountId}", accountId)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        // Send all common field-name variants; TR will use the ones it expects
        // and ignore the rest. Refine after first successful call.
        from: digitsOnly(fromNum),
        to: finalTo,
        message: finalBody,
        body: finalBody,
        phone_number: finalTo,
        text: finalBody,
      }),
    });
    const respText = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(respText); } catch { /* ignore */ }
    if (!res.ok) {
      // Capture URL + status + raw body so we can diagnose endpoint/auth issues.
      return {
        provider: "TEXT_REQUEST",
        provider_message_id: `ERR-${crypto.randomUUID()}`,
        recipient_address: finalTo,
        message_body: finalBody,
        delivery_status: "failed",
        error: `${res.status} url=${url} body=${respText.slice(0, 400)}`,
      };
    }
    const idCandidate =
      (parsed.id as string | undefined) ??
      (parsed.message_id as string | undefined) ??
      (parsed.uuid as string | undefined) ??
      `TR-${crypto.randomUUID()}`;
    return {
      provider: "TEXT_REQUEST",
      provider_message_id: idCandidate,
      recipient_address: finalTo,
      message_body: finalBody,
      delivery_status: "sent",
    };
  } catch (err) {
    return {
      provider: "TEXT_REQUEST",
      provider_message_id: `ERR-${crypto.randomUUID()}`,
      recipient_address: finalTo,
      message_body: finalBody,
      delivery_status: "failed",
      error: (err as Error).message,
    };
  }
}

async function runOne(
  supabase: ReturnType<typeof createClient>,
  shiftBlockId: number,
  kind: Kind,
): Promise<{ recipients: number; notifications: number }> {
  const recipients = await eligibleRecipients(supabase, shiftBlockId);
  if (recipients.length === 0) return { recipients: 0, notifications: 0 };

  // Fetch templates (en + es) for this notification type
  const { data: tpls, error: tplErr } = await supabase
    .from("message_templates")
    .select("language, body")
    .eq("notification_type", TYPE_FOR_KIND[kind])
    .eq("active", true);
  if (tplErr) throw new Error(`templates fetch failed: ${tplErr.message}`);
  const bodyFor: Record<string, string> = Object.fromEntries(
    (tpls ?? []).map((t) => [t.language, t.body]),
  );
  if (!bodyFor.en || !bodyFor.es) {
    throw new Error("Both en and es templates required");
  }

  // Send English + Spanish for each recipient (matching the manual procedure)
  const rows: Record<string, unknown>[] = [];
  for (const r of recipients) {
    for (const lang of ["en", "es"] as const) {
      const send = await sendViaTextRequest(r.cell_phone, bodyFor[lang], r.employee_name);
      rows.push({
        employee_id: r.employee_id,
        channel: "SMS",
        notification_type: TYPE_FOR_KIND[kind],
        recipient_type: "EMPLOYEE",
        // TEST_RECIPIENT_PHONE rerouting (if any) is reflected on the row so
        // the receipt + CSV show exactly where the SMS actually went.
        recipient_address: send.recipient_address,
        message_body: send.message_body,
        language: lang,
        provider: send.provider,
        provider_message_id: send.provider_message_id,
        shift_block_id: shiftBlockId,
        scheduled_for: new Date().toISOString(),
        delivery_status: send.delivery_status,
        delivery_error: send.error ?? null,
      });
    }
  }

  const { error: insErr } = await supabase.from("notifications").insert(rows);
  if (insErr) throw new Error(`notifications insert failed: ${insErr.message}`);

  return { recipients: recipients.length, notifications: rows.length };
}

async function blocksDueNow(
  supabase: ReturnType<typeof createClient>,
): Promise<{ id: number; kind: Kind }[]> {
  // Cron path: select blocks whose warning or clocked-out moment falls inside
  // the current minute, evaluated in the block's timezone.
  const { data, error } = await supabase.rpc("fn_shift_blocks_due_now");
  if (error) throw new Error(`due-now query failed: ${error.message}`);
  return (data ?? []) as { id: number; kind: Kind }[];
}

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

  let body: { shift_block_id?: number; kind?: Kind } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is allowed for the cron path
  }

  const targets: { id: number; kind: Kind }[] = [];
  if (body.shift_block_id) {
    const kinds: Kind[] = body.kind ? [body.kind] : ["warning", "clocked_out"];
    for (const k of kinds) targets.push({ id: body.shift_block_id, kind: k });
  } else {
    targets.push(...(await blocksDueNow(supabase)));
  }

  const runs: unknown[] = [];
  for (const t of targets) {
    try {
      const result = await runOne(supabase, t.id, t.kind);
      runs.push({ shift_block_id: t.id, kind: t.kind, ...result });
    } catch (e) {
      runs.push({
        shift_block_id: t.id,
        kind: t.kind,
        error: (e as Error).message,
      });
    }
  }

  return new Response(JSON.stringify({ runs }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
