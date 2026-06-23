// shift-block-runner — Text Request via api.textrequest.com/api/v3/messages.
// Dashboard is implied by the API key — no {dashboard_id} in the path.
// Body field is "body" (not "message"). Auth header is "x-api-key".
//
// Env vars:
//   TEXT_REQUEST_API_KEY        — required to enable real sending
//   TEXT_REQUEST_FROM_NUMBER    — verified TR sending number (digits only)
//   TEXT_REQUEST_SENDER_NAME    — appears in the dashboard timeline
//   TEXT_REQUEST_BASE_URL       — override if TR's API surface changes
//   TEXT_REQUEST_SEND_PATH      — override the send path (default /messages)
//   TEST_RECIPIENT_PHONE        — reroute every text here for staging
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
  const { data, error } = await supabase.rpc("fn_eligible_for_shift_block", {
    p_shift_block_id: shiftBlockId,
    p_work_date: new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(`eligibility query failed: ${error.message}`);
  return (data ?? []) as Recipient[];
}

function digitsOnly(p: string): string {
  return (p ?? "").replace(/\D/g, "");
}

async function sendViaTextRequest(
  phone: string,
  body: string,
  recipientName: string,
) {
  const apiKey     = Deno.env.get("TEXT_REQUEST_API_KEY");
  const fromNum    = Deno.env.get("TEXT_REQUEST_FROM_NUMBER");
  const senderName = Deno.env.get("TEXT_REQUEST_SENDER_NAME") ?? "Prestige Timekeeping";
  const baseUrl    = Deno.env.get("TEXT_REQUEST_BASE_URL") ?? "https://api.textrequest.com/api/v3";
  const sendPath   = Deno.env.get("TEXT_REQUEST_SEND_PATH") ?? "/messages";
  const testTo     = Deno.env.get("TEST_RECIPIENT_PHONE");

  if (!apiKey || !fromNum) {
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

  const url = `${baseUrl}${sendPath}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        from: digitsOnly(fromNum),
        to: finalTo,
        body: finalBody,
        sender_name: senderName,
      }),
    });
    const respText = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(respText); } catch { /* ignore */ }
    if (!res.ok) {
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
      (parsed.message_id as string | undefined) ??
      (parsed.id as string | undefined) ??
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

  const rows: Record<string, unknown>[] = [];
  for (const r of recipients) {
    for (const lang of ["en", "es"] as const) {
      const send = await sendViaTextRequest(r.cell_phone, bodyFor[lang], r.employee_name);
      rows.push({
        employee_id: r.employee_id,
        channel: "SMS",
        notification_type: TYPE_FOR_KIND[kind],
        recipient_type: "EMPLOYEE",
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
  if (insErr) {
    // idx_notifications_dedup makes (employee, block, type, language, day) unique
    // for new rows, so a cron double-fire re-inserts an identical batch that
    // fails atomically with 23505 -- treat that as an already-sent no-op rather
    // than a hard error (prevents duplicate SMS).
    if (insErr.code === "23505") {
      return { recipients: recipients.length, notifications: 0 };
    }
    throw new Error(`notifications insert failed: ${insErr.message}`);
  }

  return { recipients: recipients.length, notifications: rows.length };
}

async function blocksDueNow(
  supabase: ReturnType<typeof createClient>,
): Promise<{ id: number; kind: Kind }[]> {
  const { data, error } = await supabase.rpc("fn_shift_blocks_due_now");
  if (error) throw new Error(`due-now query failed: ${error.message}`);
  return (data ?? []) as { id: number; kind: Kind }[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: { shift_block_id?: number; kind?: Kind } = {};
  try { body = await req.json(); } catch { /* cron path */ }

  const targets: { id: number; kind: Kind }[] = [];
  if (body.shift_block_id != null) {
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
