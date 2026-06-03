// notify-summary-email — Power Automate webhook caller. After a checkpoint
// run, the dashboard POSTs { shift_block_id, sent_after } here. This function
// pulls the per-recipient summary (via fn_sent_summary_for_run), builds the
// CSV attachment + a tiny HTML body, and POSTs the whole envelope to the
// Power Automate flow at SUMMARY_EMAIL_WEBHOOK. That flow is responsible for
// the actual Outlook send.
//
// Env vars required on the Supabase project:
//   SUMMARY_EMAIL_WEBHOOK   — full HTTP POST URL of the PA flow trigger
//   SUMMARY_EMAIL_TO        — comma-separated recipient list
//                             (defaults to "claudia@prestigeusa.net")
//   EMAIL_INGEST_SHARED_SECRET — reused; PA passes it back so the flow can
//                               confirm the request came from us

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SummaryRow = {
  site_id: string;
  job_site_name: string;
  payroll_number: string;
  employee_name: string;
  recipient_phone: string;
  language: string;
  notification_type: string;
  sent_at: string;
  time_in: string | null;
  scheduled_in: string | null;
  scheduled_out: string | null;
  shift_hours: number | string | null;
};

function fmtCt(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows: SummaryRow[]): string {
  const header = [
    "JOBSITE ID","JOBSITE NAME","PAYROLL ID","EMPLOYEE NAME",
    "TIME IN (ACTUAL CT)","SCHEDULED IN CT","SCHEDULED OUT CT","SHIFT HOURS",
    "RECIPIENT PHONE","LANGUAGE","TYPE","SENT AT CT",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.site_id, r.job_site_name, r.payroll_number, r.employee_name,
      fmtCt(r.time_in),
      (r.scheduled_in ?? "").slice(0, 5),
      (r.scheduled_out ?? "").slice(0, 5),
      r.shift_hours ?? "",
      r.recipient_phone, r.language,
      r.notification_type === "END_OF_SHIFT_WARNING" ? "Warning"
        : r.notification_type === "END_OF_SHIFT_CLOCKED_OUT" ? "End shift"
        : r.notification_type,
      fmtCt(r.sent_at),
    ].map(csvEscape).join(","));
  }
  return lines.join("\n");
}

function base64Encode(s: string): string {
  // Deno's btoa only handles latin-1; the CSV is ASCII so this is fine.
  return btoa(unescape(encodeURIComponent(s)));
}

function buildSummaryHtml(blockLabel: string, rows: SummaryRow[]): string {
  const uniqueEmployees = new Set(rows.map((r) => r.payroll_number)).size;
  const uniqueSites     = new Set(rows.map((r) => r.site_id)).size;
  const typeBreakdown = rows.reduce<Record<string, number>>((acc, r) => {
    const t = r.notification_type === "END_OF_SHIFT_WARNING" ? "Warning"
            : r.notification_type === "END_OF_SHIFT_CLOCKED_OUT" ? "End shift"
            : r.notification_type;
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});
  const typeRows = Object.entries(typeBreakdown)
    .map(([t, n]) => `<li>${t}: <strong>${n}</strong></li>`).join("");
  return `
<p>FIT checkpoint just ran:</p>
<ul>
  <li>Shift: <strong>${blockLabel}</strong></li>
  <li>Messages sent: <strong>${rows.length}</strong></li>
  <li>Employees: <strong>${uniqueEmployees}</strong></li>
  <li>Sites: <strong>${uniqueSites}</strong></li>
</ul>
<p>By type:</p>
<ul>${typeRows}</ul>
<p>Full per-recipient detail is attached as CSV.</p>`.trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const webhook = Deno.env.get("SUMMARY_EMAIL_WEBHOOK");
  if (!webhook) {
    return new Response(JSON.stringify({
      error: "SUMMARY_EMAIL_WEBHOOK env var not set on this Supabase project",
    }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const to = (Deno.env.get("SUMMARY_EMAIL_TO") ?? "claudia@prestigeusa.net")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const secret = Deno.env.get("EMAIL_INGEST_SHARED_SECRET");

  let body: { shift_block_id?: number; sent_after?: string; block_label?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad_json" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (!body.shift_block_id || !body.sent_after) {
    return new Response(JSON.stringify({
      error: "missing_required_fields",
      need: ["shift_block_id", "sent_after"],
    }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data, error } = await supabase.rpc("fn_sent_summary_for_run", {
    p_shift_block_id: body.shift_block_id,
    p_sent_after: body.sent_after,
  });
  if (error) {
    return new Response(JSON.stringify({ error: "rpc_failed", detail: error.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const rows = (data ?? []) as SummaryRow[];
  if (rows.length === 0) {
    return new Response(JSON.stringify({
      skipped: true,
      reason: "No messages were sent for this run; nothing to email.",
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const blockLabel = body.block_label ?? `Block ${body.shift_block_id}`;
  const csv = buildCsv(rows);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const filename = `sent-${blockLabel.replace(/\s+/g, "")}-${stamp}.csv`;
  const html = buildSummaryHtml(blockLabel, rows);

  const payload = {
    to,
    subject: `FIT · ${blockLabel} · ${rows.length} messages sent`,
    summary_html: html,
    attachment_csv_base64: base64Encode(csv),
    attachment_filename: filename,
    metadata: {
      shift_block_id: body.shift_block_id,
      sent_after: body.sent_after,
      messages: rows.length,
      employees: new Set(rows.map((r) => r.payroll_number)).size,
      sites: new Set(rows.map((r) => r.site_id)).size,
    },
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["x-fit-shared-secret"] = secret;

  const res = await fetch(webhook, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const responseText = await res.text();

  if (!res.ok) {
    return new Response(JSON.stringify({
      error: "webhook_failed",
      webhook_status: res.status,
      detail: responseText.slice(0, 500),
    }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({
    ok: true,
    sent_to: to,
    messages_in_summary: rows.length,
    attachment_filename: filename,
  }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
});
