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

// Stub for the real Text Request send. Swap the body of this function with
// an authenticated fetch() to Text Request's API once we have credentials.
async function sendViaTextRequest(
  _phone: string,
  _body: string,
): Promise<{ provider: string; provider_message_id: string }> {
  return {
    provider: "TEXT_REQUEST_STUB",
    provider_message_id: `STUB-${crypto.randomUUID()}`,
  };
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
      const send = await sendViaTextRequest(r.cell_phone, bodyFor[lang]);
      rows.push({
        employee_id: r.employee_id,
        channel: "SMS",
        notification_type: TYPE_FOR_KIND[kind],
        recipient_type: "EMPLOYEE",
        recipient_address: r.cell_phone,
        message_body: bodyFor[lang],
        language: lang,
        provider: send.provider,
        provider_message_id: send.provider_message_id,
        shift_block_id: shiftBlockId,
        scheduled_for: new Date().toISOString(),
        delivery_status: "sent",
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

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
    headers: { "Content-Type": "application/json" },
  });
});
