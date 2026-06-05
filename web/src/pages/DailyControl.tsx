import { useEffect, useState } from "react";
import { HeaderBar } from "../components/HeaderBar";
import { KpiCard } from "../components/KpiCard";
import { TimezoneClocks } from "../components/TimezoneClocks";
import { EpayReportChecklist } from "../components/EpayReportChecklist";
import { ShiftChangeRequestCard } from "../components/ShiftChangeRequestCard";
import { supabase } from "../lib/supabase";

type ShiftBlock = {
  id: number;
  label: string;
  end_time_local: string;
  clients: string[];
  days_of_week: boolean[] | null;
};
type Notification = {
  id: number;
  recipient_address: string;
  language: "en" | "es";
  notification_type: string;
  provider: string;
  message_body: string;
  sent_at: string;
  shift_block_id: number | null;
};
type LCT = {
  payroll_number: string;
  employee_name: string;
  job_site_name: string;
  job_site_id: number;
  rate_type: string | null;
  time_in: string | null;
  time_out: string | null;
  shift_block_id: number | null;
  work_date: string | null;
  actual_hours: number | null;
  site?: { site_id: string } | { site_id: string }[] | null;
};
type Recipient = {
  payroll_number: string;
  employee_id: number;
  employee_name: string;
  cell_phone: string;
  job_site_name: string;
  language: string;
};

type Candidate = {
  payroll_number: string;
  employee_name: string;
  cell_phone: string | null;
  site_id: string | null;
  job_site_name: string;
  rate_type: string | null;
  time_in: string | null;
  time_out: string | null;
  status: "ELIGIBLE" | "EXCLUDED";
  reason: string | null;
};

const FUNCTIONS_URL = `${
  import.meta.env.VITE_SUPABASE_URL ?? "https://sshhcpzleurztzksrlvr.supabase.co"
}/functions/v1`;

// All timestamps render in client (Central) time so a viewer in any browser
// timezone sees the same ops clock as Claudia in Texas. Suffix "CT" makes the
// reference frame explicit.
function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }) + " CT";
}

// Same as fmtTime but drops the date — for tables where every row is "today".
function fmtTimeOnly(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}


// Current minute-of-day in Central Time. Most shift_blocks are anchored to
// America/Chicago; this drives the "due now" highlight on the checkpoint grid.
function ctMinutesNow(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
  const m = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
  return h * 60 + m;
}

function blockMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

type BlockStatus = "due" | "upcoming" | "past" | "future";

function statusFor(block: ShiftBlock, ctNow: number): { status: BlockStatus; minsAway: number } {
  const end = blockMinutes(block.end_time_local);
  const warningStart = end - 20; // matches shift_blocks.warning_offset default
  const clockedEnd = end + 5;    // matches shift_blocks.clocked_offset default
  if (ctNow >= warningStart && ctNow <= clockedEnd) return { status: "due", minsAway: end - ctNow };
  if (ctNow > clockedEnd) return { status: "past", minsAway: ctNow - end };
  const minsAway = warningStart - ctNow;
  if (minsAway <= 60) return { status: "upcoming", minsAway };
  return { status: "future", minsAway };
}

const TZ_STRIP = [
  { label: "EASTERN",  iana: "America/New_York" },
  { label: "CENTRAL",  iana: "America/Chicago" },
  { label: "MOUNTAIN", iana: "America/Denver" },
  { label: "PACIFIC",  iana: "America/Los_Angeles" },
];

function DateClockBar({ ctNow: _ctNow }: { ctNow: number }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long", month: "long", day: "numeric",
  }).format(now).toUpperCase();
  // 12-hour clock for each zone — "5:07:20 PM" instead of "17:07:20"
  const fmt = (iana: string) => new Intl.DateTimeFormat("en-US", {
    timeZone: iana, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  }).format(now);
  // Match the viewer's local wall-clock minute to each zone's wall-clock minute.
  // Whichever matches (i.e. same UTC offset right now) gets highlighted as
  // "your" zone. We compare to-the-minute so two zones at the same offset
  // (e.g. Phoenix vs Denver in winter) still resolve correctly because the
  // viewer's tz is what matters, not the IANA name.
  const localHM = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  const matchTz = (iana: string) => new Intl.DateTimeFormat("en-US", {
    timeZone: iana, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  return (
    <section
      aria-label="Current operating date and time across regions"
      className="sticky top-0 z-20 bg-surface border border-border rounded-xl px-5 py-3 flex items-center justify-between gap-6 flex-wrap shadow-sm"
    >
      <div className="flex flex-col">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          Today · Central
        </span>
        <span className="text-[20px] font-bold text-text-primary leading-tight">
          {dateLabel}
        </span>
      </div>
      <div className="flex items-center gap-5 flex-wrap">
        {TZ_STRIP.map((z) => {
          const isLocal = matchTz(z.iana) === localHM;
          return (
            <div
              key={z.iana}
              className={`flex flex-col items-end px-2 py-1 rounded ${
                isLocal ? "bg-warning/15 border border-warning/40" : ""
              }`}
            >
              <span className={`text-[10px] font-semibold uppercase tracking-[0.06em] ${
                isLocal ? "text-warning" : "text-text-muted"
              }`}>
                {z.label}{isLocal ? " · YOU" : ""}
              </span>
              <span className={`text-[16px] font-bold tabular leading-none mt-0.5 ${
                isLocal ? "text-warning" : "text-text-primary"
              }`}>
                {fmt(z.iana)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function DailyControl() {
  const [blocks, setBlocks] = useState<ShiftBlock[]>([]);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [lct, setLct] = useState<LCT[]>([]);
  const [running, setRunning] = useState<number | null>(null);
  const [counts, setCounts] = useState({ total: 0, today: 0 });
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [latestImport, setLatestImport] = useState<{
    id: number; filename: string; row_count: number | null; completed_at: string;
  } | null>(null);
  const [ctNow, setCtNow] = useState(() => ctMinutesNow(new Date()));
  const [chainFilter, setChainFilter] = useState<string | null>(null);
  // The "next action" block + its eligible count, computed reactively as
  // ctNow ticks. Drives the hero card at the top of the page.
  const [, setNextEligible] = useState<{ blockId: number; count: number } | null>(null);
  const [showOps, setShowOps] = useState(false);
  const [confirm, setConfirm] = useState<{
    block: ShiftBlock;
    recipients: Recipient[];
    excluded: Candidate[];
    warnEn: string;
    warnEs: string;
    clockedEn: string;
    clockedEs: string;
    kinds: Array<"warning" | "clocked_out">;
    step: 1 | 2;
  } | null>(null);
  const [sentReceipt, setSentReceipt] = useState<{
    blockId: number;
    blockLabel: string;
    sentAfter: string;
    kinds: Array<"warning" | "clocked_out">;
    messages: Array<{
      id: number;
      recipient_address: string;
      language: string;
      notification_type: string;
      message_body: string;
      sent_at: string;
    }>;
    emailStatus: "pending" | "sent" | "failed" | "skipped";
    emailDetail?: string;
  } | null>(null);

  async function refresh() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [{ data: n, count: total }, { count: today_ct }, { data: l }] =
      await Promise.all([
        supabase
          .from("notifications")
          .select(
            "id,recipient_address,language,notification_type,provider,message_body,sent_at,shift_block_id",
            { count: "exact" },
          )
          .order("sent_at", { ascending: false })
          .limit(20),
        supabase
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .gte("sent_at", today.toISOString()),
        supabase
          .from("labor_control_tracking")
          .select(
            "payroll_number,employee_name,job_site_name,job_site_id,rate_type,time_in,time_out,shift_block_id,work_date,actual_hours,site:site!labor_control_tracking_job_site_id_fkey(site_id)",
          )
          .eq("work_date", new Date().toISOString().slice(0, 10))
          .order("time_in")
          .limit(1000),
      ]);
    setNotifs((n ?? []) as Notification[]);
    setLct((l ?? []) as LCT[]);
    setCounts({ total: total ?? 0, today: today_ct ?? 0 });
    setLastRun(n && n.length ? n[0].sent_at : null);

    // The "punches loaded" badge reflects the LAST ePay file the operator
    // received — not the cumulative LCT total — so it matches what Claudia
    // sees in the source workbook.
    const { data: imp } = await supabase
      .from("epay_imports")
      .select("id, filename, row_count, completed_at")
      .in("status", ["succeeded", "partial"])
      .gte("started_at", new Date().toISOString().slice(0, 10))
      .order("completed_at", { ascending: false })
      .limit(1);
    setLatestImport(imp && imp.length ? imp[0] : null);
  }

  useEffect(() => {
    supabase
      .from("shift_blocks")
      .select("id,label,end_time_local,clients,days_of_week")
      .eq("active", true)
      .order("end_time_local")
      .then(({ data }) => {
        const dow = new Date().getDay();
        setBlocks(((data ?? []) as ShiftBlock[]).filter(
          (b) => !b.days_of_week || b.days_of_week[dow],
        ));
      });
    refresh();
  }, []);

  // Update the "due now" badge every 30 seconds. No need to tick faster —
  // the warning/clocked windows are minute-level.
  useEffect(() => {
    const id = window.setInterval(() => setCtNow(ctMinutesNow(new Date())), 30000);
    return () => window.clearInterval(id);
  }, []);

  // Determine the "next action" block — DUE NOW if any, else the closest
  // upcoming block. Re-fetch its eligible count whenever it changes (or every
  // 30s with ctNow tick).
  const nextBlock = (() => {
    if (blocks.length === 0) return null;
    const due = blocks.find((b) => statusFor(b, ctNow).status === "due");
    if (due) return due;
    const upcoming = blocks
      .map((b) => ({ b, s: statusFor(b, ctNow) }))
      .filter((x) => x.s.status === "upcoming" || x.s.status === "future")
      .sort((a, c) => a.s.minsAway - c.s.minsAway)[0];
    return upcoming?.b ?? null;
  })();

  useEffect(() => {
    if (!nextBlock) {
      setNextEligible(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc("fn_candidates_for_shift_block", {
        p_shift_block_id: nextBlock.id,
        p_work_date: new Date().toISOString().slice(0, 10),
      });
      if (cancelled) return;
      const count = (data ?? []).filter((c: { status: string }) => c.status === "ELIGIBLE").length;
      setNextEligible({ blockId: nextBlock.id, count });
    })();
    return () => { cancelled = true; };
  }, [nextBlock?.id, ctNow, lct.length]);

  async function previewBlock(block: ShiftBlock) {
    // Fetch eligible recipients + candidate breakdown + BOTH templates so
    // the operator can toggle between the 15-minute warning and the
    // post-shift clocked-out notice in the modal.
    const [{ data: elig, error: eligErr }, { data: cands }, { data: tpls }] =
      await Promise.all([
        supabase.rpc("fn_eligible_for_shift_block", {
          p_shift_block_id: block.id,
          p_work_date: new Date().toISOString().slice(0, 10),
        }),
        supabase.rpc("fn_candidates_for_shift_block", {
          p_shift_block_id: block.id,
          p_work_date: new Date().toISOString().slice(0, 10),
        }),
        supabase
          .from("message_templates")
          .select("notification_type, language, body")
          .in("notification_type", ["END_OF_SHIFT_WARNING", "END_OF_SHIFT_CLOCKED_OUT"])
          .eq("active", true),
      ]);
    if (eligErr) {
      console.error("Eligibility query failed:", eligErr.message);
      return;
    }
    const find = (type: string, lang: string) =>
      tpls?.find((t: any) => t.notification_type === type && t.language === lang)?.body ?? "";
    const excluded = ((cands ?? []) as Candidate[]).filter(
      (c) => c.status === "EXCLUDED",
    );
    // Default to the kind that matches the block's current status: due-now
    // and past blocks should send the clocked-out notice; upcoming blocks
    // should send the 15-minute warning.
    const { status } = statusFor(block, ctNow);
    const defaultKind: "warning" | "clocked_out" =
      status === "due" || status === "past" ? "clocked_out" : "warning";
    setConfirm({
      block,
      recipients: (elig ?? []) as Recipient[],
      excluded,
      warnEn: find("END_OF_SHIFT_WARNING", "en"),
      warnEs: find("END_OF_SHIFT_WARNING", "es"),
      clockedEn: find("END_OF_SHIFT_CLOCKED_OUT", "en"),
      clockedEs: find("END_OF_SHIFT_CLOCKED_OUT", "es"),
      kinds: [defaultKind],
      step: 1,
    });
  }

  async function confirmSend() {
    if (!confirm) return;
    const blockId = confirm.block.id;
    const kinds = confirm.kinds;
    const blockLabel = confirm.block.label;
    const startedAt = new Date().toISOString();
    setRunning(blockId);
    setConfirm(null);
    try {
      // Fire one runner call per selected kind. Both can be picked at once,
      // in which case each recipient gets the warning AND the clocked-out
      // notice.
      await Promise.all(kinds.map((k) =>
        fetch(`${FUNCTIONS_URL}/shift-block-runner`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shift_block_id: blockId, kind: k }),
        }).then((r) => r.json())
      ));
      // Pull back the rows we just wrote so the operator can see exactly
      // which texts went out, to whom, in which language.
      const { data: sent } = await supabase
        .from("notifications")
        .select("id, recipient_address, language, notification_type, message_body, sent_at")
        .eq("shift_block_id", blockId)
        .gte("sent_at", startedAt)
        .order("sent_at", { ascending: true });
      setSentReceipt({
        blockId,
        blockLabel,
        sentAfter: startedAt,
        kinds,
        messages: (sent ?? []) as NonNullable<typeof sentReceipt>["messages"],
        emailStatus: "pending",
      });
      // Fire-and-forget summary email to Claudia. Result feeds the receipt
      // modal banner so the operator can see it land (or fail) without
      // blocking the rest of the UI.
      if (sent && sent.length > 0) {
        fetch(`${FUNCTIONS_URL}/notify-summary-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shift_block_id: blockId,
            sent_after: startedAt,
            block_label: blockLabel,
          }),
        })
          .then(async (r) => {
            const body = await r.json().catch(() => ({}));
            setSentReceipt((prev) =>
              prev && prev.blockId === blockId && prev.sentAfter === startedAt
                ? { ...prev, emailStatus: r.ok ? "sent" : "failed",
                    emailDetail: r.ok ? body.sent_to?.join(", ") : body.error ?? String(r.status) }
                : prev,
            );
          })
          .catch((err) => {
            setSentReceipt((prev) =>
              prev && prev.blockId === blockId && prev.sentAfter === startedAt
                ? { ...prev, emailStatus: "failed", emailDetail: String(err) }
                : prev,
            );
          });
      } else {
        setSentReceipt((prev) => prev ? { ...prev, emailStatus: "skipped" } : prev);
      }
    } finally {
      setRunning(null);
      refresh();
    }
  }

  // Manual trigger for the Power Automate summary-email flow. Same payload
  // the auto-fire after a checkpoint uses; updates the modal banner so the
  // operator sees the result.
  async function emailClaudia(receipt: NonNullable<typeof sentReceipt>) {
    setSentReceipt((prev) => prev ? { ...prev, emailStatus: "pending", emailDetail: undefined } : prev);
    try {
      const r = await fetch(`${FUNCTIONS_URL}/notify-summary-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shift_block_id: receipt.blockId,
          sent_after: receipt.sentAfter,
          block_label: receipt.blockLabel,
        }),
      });
      const body = await r.json().catch(() => ({}));
      setSentReceipt((prev) =>
        prev ? {
          ...prev,
          emailStatus: r.ok ? "sent" : "failed",
          emailDetail: r.ok ? body.sent_to?.join(", ") : body.error ?? String(r.status),
        } : prev,
      );
    } catch (err) {
      setSentReceipt((prev) =>
        prev ? { ...prev, emailStatus: "failed", emailDetail: String(err) } : prev,
      );
    }
  }

  // Build the post-send CSV: actual time_in vs scheduled in/out + shift hours
  // for every employee we just texted. Pulled from fn_sent_summary_for_run.
  async function downloadSentSummary(receipt: NonNullable<typeof sentReceipt>) {
    const { data, error } = await supabase.rpc("fn_sent_summary_for_run", {
      p_shift_block_id: receipt.blockId,
      p_sent_after: receipt.sentAfter,
    });
    if (error || !data) {
      alert(`Could not build CSV: ${error?.message ?? "no rows"}`);
      return;
    }
    type Row = {
      site_id: string; job_site_name: string;
      payroll_number: string; employee_name: string;
      recipient_phone: string; language: string;
      notification_type: string; sent_at: string;
      time_in: string | null; scheduled_in: string | null;
      scheduled_out: string | null; shift_hours: number | string | null;
      message_body: string;
    };
    const rows = data as Row[];
    const fmtCt = (iso: string | null) => iso
      ? new Date(iso).toLocaleString("en-US", {
          timeZone: "America/Chicago",
          hour: "2-digit", minute: "2-digit", hour12: false,
        })
      : "";
    const fmtSchedTime = (t: string | null) => t ? t.slice(0, 5) : "";
    const header = [
      "JOBSITE ID","JOBSITE NAME","PAYROLL ID","EMPLOYEE NAME",
      "TIME IN (ACTUAL CT)","SCHEDULED IN CT","SCHEDULED OUT CT","SHIFT HOURS",
      "RECIPIENT PHONE","LANGUAGE","TYPE","SENT AT CT",
    ];
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      header.join(","),
      ...rows.map((r) => [
        r.site_id, r.job_site_name, r.payroll_number, r.employee_name,
        fmtCt(r.time_in), fmtSchedTime(r.scheduled_in), fmtSchedTime(r.scheduled_out),
        r.shift_hours ?? "",
        r.recipient_phone, r.language,
        r.notification_type === "END_OF_SHIFT_WARNING" ? "Warning"
          : r.notification_type === "END_OF_SHIFT_CLOCKED_OUT" ? "End shift"
          : r.notification_type,
        fmtCt(r.sent_at),
      ].map(escape).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.download = `sent-${receipt.blockLabel.replace(/\s+/g, "")}-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Open-punch count per shift block, mapped via labor_control_tracking.
  // Used to size the badge on each checkpoint tile.
  const openByBlock: Record<number, number> = {};
  const totalByBlock: Record<number, number> = {};
  for (const r of lct) {
    if (r.shift_block_id) {
      totalByBlock[r.shift_block_id] = (totalByBlock[r.shift_block_id] ?? 0) + 1;
      if (!r.time_out) {
        openByBlock[r.shift_block_id] = (openByBlock[r.shift_block_id] ?? 0) + 1;
      }
    }
  }
  // Chain options for the filter row (only show chains that have a tile).
  const allChains = Array.from(new Set(blocks.flatMap((b) => b.clients))).sort();
  const visibleBlocks = chainFilter
    ? blocks.filter((b) => b.clients.includes(chainFilter))
    : blocks;

  const missing = lct.filter((r) => !r.time_out).length;
  const resolved = lct.filter((r) => r.time_out).length;
  const responseRate = counts.today > 0
    ? Math.round((notifs.filter((n) => n.notification_type === "END_OF_SHIFT_CLOCKED_OUT").length / counts.today) * 100)
    : 0;

  const sitesOpen = new Set(lct.map((r) => r.job_site_name)).size;
  const sitesWithOpen = new Set(lct.filter((r) => !r.time_out).map((r) => r.job_site_name)).size;
  const activeEmployees = new Set(lct.map((r) => r.payroll_number)).size;
  const employeesOnClock = new Set(lct.filter((r) => !r.time_out).map((r) => r.payroll_number)).size;
  const closedToday = lct.filter((r) => r.time_out).length;

  // Export today's punches as a CSV with the EXACT Epay Punches Report column
  // shape so the file is a drop-in replacement for the original export.
  // Headers must match 1:1 — used downstream by anything that consumes the
  // Epay format.
  function exportReport() {
    // MM/DD/YYYY
    const fmtDate = (d: string | null) => {
      if (!d) return "";
      const [y, m, day] = d.split("-");
      return `${m}/${day}/${y}`;
    };
    // MM/DD/YYYY HH:MM (matches Epay's "05/22/2026 14:55" format)
    const fmtEpayDateTime = (iso: string | null) => {
      if (!iso) return "";
      const dt = new Date(iso);
      const mm = String(dt.getMonth() + 1).padStart(2, "0");
      const dd = String(dt.getDate()).padStart(2, "0");
      const yyyy = dt.getFullYear();
      const hh = String(dt.getHours()).padStart(2, "0");
      const mi = String(dt.getMinutes()).padStart(2, "0");
      return `${mm}/${dd}/${yyyy} ${hh}:${mi}`;
    };
    // HH:MM (e.g. "5.03" hours -> "05:02")
    const fmtHours = (h: number | null) => {
      if (h == null) return "";
      const total = Math.round(h * 60);
      const hh = Math.floor(total / 60);
      const mm = total % 60;
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    };

    const headers = [
      "Job/Site ID", "Job/Site Name", "Date", "Payroll No", "Employee Name",
      "Rate Type", "Time In", "Time Out", "Actual Hours",
    ];
    const rows = lct.map((r) => {
      const siteCode = Array.isArray(r.site) ? r.site[0]?.site_id : r.site?.site_id;
      return [
      siteCode ?? "",
      r.job_site_name,
      fmtDate(r.work_date),
      r.payroll_number,
      r.employee_name,
      r.rate_type ?? "",
      fmtEpayDateTime(r.time_in),
      fmtEpayDateTime(r.time_out),
      fmtHours(r.actual_hours),
    ];
    });
    const csv = [headers, ...rows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `PunchesReport_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <HeaderBar
        title="Labor Control Tracking"
        subtitle={latestImport
          ? `${latestImport.row_count ?? 0} punches loaded · ${lct.length - closedToday} active · ${closedToday} closed`
          : lct.length > 0
            ? `${lct.length} punches loaded · ${lct.length - closedToday} active · ${closedToday} closed`
            : "Track punches and outreach in real time"}
        right={
          <div className="flex items-center gap-2">
            {lastRun && (
              <span className="tabular mr-2 hidden sm:inline">
                last run · {fmtTime(lastRun)}
              </span>
            )}
            <a
              href="/reports"
              className="text-[13px] font-semibold px-3 py-1.5 rounded-md border border-border bg-surface text-text-primary hover:bg-bg transition-colors"
            >
              Reports →
            </a>
            <button
              onClick={exportReport}
              disabled={lct.length === 0}
              className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-blue-1 text-white hover:bg-blue-2 disabled:opacity-50"
            >
              Export Report
            </button>
          </div>
        }
      />

      <main className="max-w-page mx-auto px-5 py-5 space-y-5">
        <DateClockBar ctNow={ctNow} />
        <EpayReportChecklist refreshKey={lct.length} />

        {/* ============================================================== */}
        {/* HERO — the one thing the operator should do next.              */}
        {/* ============================================================== */}
        {nextBlock && (() => {
          const status = statusFor(nextBlock, ctNow);
          const recommend: "warning" | "clocked_out" =
            status.status === "past" ? "clocked_out" : "warning";
          const due = status.status === "due";
          return (
            <section
              className={`rounded-xl shadow-sm border p-6 ${
                due
                  ? "bg-warning/10 border-warning"
                  : "bg-surface border-border"
              }`}
            >
              <div className="flex items-start justify-between flex-wrap gap-4">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                    {due ? "Due now" : "Next punch-out"}
                  </div>
                  <h2 className="text-[28px] font-bold text-warning leading-tight mt-1 tabular">
                    {nextBlock.label.toUpperCase()}
                  </h2>
                  <div className="text-[14px] text-text-secondary mt-1 tabular">
                    <strong className="text-text-primary">{latestImport?.row_count ?? lct.length}</strong> rows in latest file
                    {" · "}
                    <strong className="text-text-primary">{totalByBlock[nextBlock.id] ?? 0}</strong> punches in this shift
                  </div>
                </div>
                <button
                  onClick={() => previewBlock(nextBlock)}
                  disabled={!!running}
                  className="text-[15px] font-semibold px-6 py-3 rounded-lg transition-colors disabled:opacity-50 bg-warning text-white hover:opacity-90"
                >
                  Review and send →
                </button>
              </div>
              {/* Secondary actions inline */}
              <div className="flex items-center gap-4 mt-4 pt-4 border-t border-border/60 text-[12px] text-warning font-semibold">
                <span>
                  Recommended:{" "}
                  <strong>
                    {recommend === "warning" ? "15-minute reminder" : "END SHIFT"}
                  </strong>
                </span>
              </div>
            </section>
          );
        })()}

        {/* ============================================================== */}
        {/* OPERATIONS DETAILS — collapsed by default.                     */}
        {/* ============================================================== */}
        <details
          className="bg-surface border border-border rounded-xl"
          open={showOps}
          onToggle={(e) => setShowOps((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer p-5 flex items-center justify-between">
            <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
              Operations details
            </span>
            <span className="text-[12px] text-text-muted">
              {showOps ? "Hide ▴" : "Show ▾"}
            </span>
          </summary>
          <div className="px-5 pb-5 space-y-5">
            <TimezoneClocks />

        {/* Operational KPIs */}
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="SITES OPEN"
            value={sitesOpen}
            changeText={sitesWithOpen > 0 ? `${sitesWithOpen} with active punches` : undefined}
            changeDirection="neutral"
          />
          <KpiCard
            label="ACTIVE EMPLOYEES"
            value={activeEmployees}
            changeText={employeesOnClock > 0 ? `${employeesOnClock} on the clock` : undefined}
            changeDirection="neutral"
          />
          <KpiCard
            label="PUNCH EXCEPTIONS"
            value={lct.filter((r) => r.rate_type === "Lunch" || r.rate_type === "LUNCH").length}
            changeText="0 high severity"
            changeDirection="up"
          />
          <KpiCard
            label="EXCESS HOURS RISK"
            value={`${(lct.filter((r) => !r.time_out).length * 0.5).toFixed(1)}h`}
            changeText="≈ $0 labor leakage"
            changeDirection="neutral"
          />
        </div>

        {/* Checkpoint KPI strip */}
        {(() => {
          const dueNow = blocks
            .map((b) => ({ b, s: statusFor(b, ctNow) }))
            .find((x) => x.s.status === "due");
          const nextUp = blocks
            .map((b) => ({ b, s: statusFor(b, ctNow) }))
            .filter((x) => x.s.status === "upcoming" || x.s.status === "future")
            .sort((a, z) => a.s.minsAway - z.s.minsAway)[0];
          const activeLabel = dueNow
            ? dueNow.b.label
            : nextUp
              ? nextUp.b.label
              : "—";
          const activeChange = dueNow
            ? "DUE NOW"
            : nextUp
              ? `in ${nextUp.s.minsAway} min`
              : "no checkpoints left today";
          return (
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
              <KpiCard
                label="ACTIVE CHECKPOINT"
                value={activeLabel}
                changeText={activeChange}
                changeDirection={dueNow ? "down" : "neutral"}
              />
          <KpiCard
            label="PUNCHES RESOLVED"
            value={resolved}
            changeText={resolved > 0 ? `${resolved} today` : undefined}
            changeDirection="up"
          />
          <KpiCard
            label="STILL MISSING"
            value={missing}
            changeText={missing > 0 ? `${missing} open` : "all caught up"}
            changeDirection={missing > 0 ? "down" : "neutral"}
          />
          <KpiCard
            label="TEXTS SENT TODAY"
            value={counts.today}
            changeText={counts.total > counts.today ? `${counts.total} all time` : undefined}
          />
          <KpiCard
            label="RESPONSE RATE"
            value={`${responseRate}%`}
            progressPct={responseRate}
            progressTargetPct={85}
          />
            </div>
          );
        })()}
          </div>
        </details>

        {/* Upload Punches Report moved to the Reports tab. */}

        <StoreExceptionsCard onChange={refresh} />

        <ShiftChangeRequestCard />

        {/* ============================================================== */}
        {/* TODAY'S PUNCHES — consolidates the tile grid + detail table.   */}
        {/* ============================================================== */}
        <div className="space-y-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[16px] font-bold uppercase tracking-[0.06em] text-text-primary">
              Today's Punches
            </h2>
            <span className="text-[12px] text-text-secondary">
              {lct.length} loaded · {blocks.length} {blocks.length === 1 ? "shift" : "shifts"}
            </span>
          </div>

        {/* Checkpoint grid with real-time highlight */}
        <section className="bg-surface border border-border rounded-xl p-5">
          {/* Client filter chips */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted mr-1">
              Client
            </span>
            <button
              onClick={() => setChainFilter(null)}
              className={`text-[12px] px-3 py-1 rounded-full border ${
                chainFilter === null
                  ? "bg-blue-1 text-white border-blue-1"
                  : "bg-bg text-text-secondary border-border hover:border-blue-1"
              }`}
            >
              All
            </button>
            {allChains.map((c) => (
              <button
                key={c}
                onClick={() => setChainFilter(c === chainFilter ? null : c)}
                className={`text-[12px] px-3 py-1 rounded-full border ${
                  chainFilter === c
                    ? "bg-blue-1 text-white border-blue-1"
                    : "bg-bg text-text-secondary border-border hover:border-blue-1"
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
              Today's checkpoints
            </h2>
            {(() => {
              const due = blocks
                .map((b) => ({ b, s: statusFor(b, ctNow) }))
                .find((x) => x.s.status === "due");
              const next = blocks
                .map((b) => ({ b, s: statusFor(b, ctNow) }))
                .filter((x) => x.s.status === "upcoming")
                .sort((a, z) => a.s.minsAway - z.s.minsAway)[0];
              if (due) {
                return (
                  <span className="text-[12px] font-semibold text-critical tabular">
                    ● {due.b.label} is due now — send the text
                  </span>
                );
              }
              if (next) {
                return (
                  <span className="text-[12px] font-semibold text-blue-1 tabular">
                    Next up: {next.b.label} in {next.s.minsAway} min
                  </span>
                );
              }
              return (
                <span className="text-[12px] text-text-muted tabular">
                  No checkpoints in the next hour
                </span>
              );
            })()}
          </div>
          <ul className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {visibleBlocks.map((b) => {
              const { status, minsAway } = statusFor(b, ctNow);
              const openCount = openByBlock[b.id] ?? 0;
              const styles: Record<BlockStatus, string> = {
                due:      "bg-critical/10 border-critical ring-2 ring-critical/40 live-pulse",
                upcoming: "bg-blue-3 border-blue-1",
                past:     "bg-bg border-border opacity-60",
                future:   "bg-bg border-border",
              };
              const badge: Record<BlockStatus, string> = {
                due:      "DUE NOW",
                upcoming: `in ${minsAway} min`,
                past:     `${minsAway} min ago`,
                future:   "later today",
              };
              const badgeColor: Record<BlockStatus, string> = {
                due:      "text-critical",
                upcoming: "text-blue-1",
                past:     "text-text-muted",
                future:   "text-text-muted",
              };
              return (
                <li key={b.id}>
                  <button
                    onClick={() => previewBlock(b)}
                    disabled={running === b.id}
                    className={`w-full text-left border rounded-lg p-3 transition-colors hover:bg-blue-3 disabled:opacity-50 ${styles[status]}`}
                  >
                    <div className="flex items-baseline justify-between">
                      <div className="text-[13px] font-semibold text-text-primary">
                        {b.label}
                      </div>
                      <div className={`text-[10px] font-semibold uppercase tracking-wider tabular ${badgeColor[status]}`}>
                        {badge[status]}
                      </div>
                    </div>
                    <div className="text-[12px] text-text-secondary mt-0.5 tabular">
                      {openCount === 0
                        ? "no open punches"
                        : `${openCount} open punch${openCount === 1 ? "" : "es"}`}
                    </div>
                    <div className="text-[11px] text-blue-1 mt-1">
                      {running === b.id ? "Sending…" : "Run this checkpoint →"}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Today's punches — collapsed by default; driven by the upload above */}
        <details id="todays-punches" className="bg-surface border border-border rounded-xl" open={false}>
          <summary className="cursor-pointer p-5 text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted hover:text-text-primary list-none flex items-center justify-between">
            <span>Row detail ({lct.length}{chainFilter ? ` · filtered ${chainFilter}` : ""})</span>
            <span className="text-blue-1 text-[11px]">click to expand</span>
          </summary>
          <section className="px-5 pb-5">
          {(() => {
            const filtered = chainFilter
              ? lct.filter((r) => {
                  const code = r.job_site_name.split(" ")[0]?.toUpperCase() ?? "";
                  // Match by name prefix as a heuristic until we join to site.chain
                  if (chainFilter === "TARGET")    return code === "TARGET";
                  if (chainFilter === "KOHLS")     return code.startsWith("KOHL");
                  if (chainFilter === "HARDLINES") return code === "HOME";
                  return true;
                })
              : lct;
            return (
              <>
                <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
                  <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                    Today's punches ({filtered.length}
                    {chainFilter && lct.length !== filtered.length ? ` of ${lct.length}` : ""})
                  </h2>
                  {chainFilter && (
                    <span className="text-[12px] text-text-muted">
                      Filtered by <strong>{chainFilter}</strong> · click "All" above to clear
                    </span>
                  )}
                </div>
                {filtered.length === 0 ? (
                  <p className="text-text-muted text-sm py-4">
                    {lct.length === 0
                      ? "No labor_control_tracking rows for today. Drop a Punches Report in the upload zone above — rows will appear here grouped by site."
                      : `No punches matching ${chainFilter}.`}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px] tabular">
                      <thead className="bg-bg">
                        <tr className="text-left text-[10px] uppercase tracking-[0.06em] text-text-muted">
                          <th className="px-3 py-2 font-semibold w-[88px]">Payroll #</th>
                          <th className="px-3 py-2 font-semibold w-[200px]">Employee</th>
                          <th className="px-3 py-2 font-semibold w-[100px]">Jobsite&nbsp;ID</th>
                          <th className="px-3 py-2 font-semibold">Jobsite&nbsp;Name</th>
                          <th className="px-3 py-2 font-semibold w-[80px]">Rate</th>
                          <th className="px-3 py-2 font-semibold text-right w-[90px]">Time&nbsp;In</th>
                          <th className="px-3 py-2 font-semibold text-right w-[90px]">Time&nbsp;Out</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((r) => {
                          const siteCode = Array.isArray(r.site) ? r.site[0]?.site_id : r.site?.site_id;
                          return (
                          <tr
                            key={`${r.payroll_number}-${r.time_in}`}
                            className={!r.time_out ? "bg-warning/5" : ""}
                          >
                            <td className="px-3 py-1.5 text-text-secondary font-medium">{r.payroll_number}</td>
                            <td className="px-3 py-1.5">{r.employee_name}</td>
                            <td className="px-3 py-1.5 text-text-primary font-semibold">{siteCode ?? "—"}</td>
                            <td className="px-3 py-1.5 text-text-secondary">{r.job_site_name}</td>
                            <td className="px-3 py-1.5 text-text-muted">{r.rate_type ?? "—"}</td>
                            <td className="px-3 py-1.5 text-right text-text-secondary">{fmtTime(r.time_in)}</td>
                            <td className="px-3 py-1.5 text-right">
                              {r.time_out ? (
                                <span className="text-text-secondary">{fmtTime(r.time_out)}</span>
                              ) : (
                                <span className="text-warning font-semibold">OPEN</span>
                              )}
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            );
          })()}
          </section>
        </details>
        </div>
        {/* End TODAY'S PUNCHES section */}

        {/* Notifications — collapsed by default to keep the page tight */}
        <details className="bg-surface border border-border rounded-xl">
          <summary className="cursor-pointer p-5 text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted hover:text-text-primary list-none flex items-center justify-between">
            <span>Responses ({counts.total})</span>
            <span className="text-blue-1 text-[11px]">click to expand</span>
          </summary>
          <section className="px-5 pb-5">
          {notifs.length === 0 ? (
            <p className="text-text-muted text-sm py-4">
              No notifications yet — click a checkpoint above to run.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-text-muted">
                    <th className="py-2 pr-3 font-medium">Sent</th>
                    <th className="py-2 pr-3 font-medium">To</th>
                    <th className="py-2 pr-3 font-medium">Type</th>
                    <th className="py-2 pr-3 font-medium">Lang</th>
                    <th className="py-2 pr-3 font-medium">Provider</th>
                    <th className="py-2 pr-3 font-medium">Body</th>
                  </tr>
                </thead>
                <tbody>
                  {notifs.map((n) => (
                    <tr key={n.id}>
                      <td className="py-2 pr-3 tabular text-text-muted">
                        {fmtTime(n.sent_at)}
                      </td>
                      <td className="py-2 pr-3 tabular">{n.recipient_address}</td>
                      <td className="py-2 pr-3">
                        {n.notification_type === "END_OF_SHIFT_WARNING" ? (
                          <span className="text-warning font-semibold">warning</span>
                        ) : (
                          <span className="text-good font-semibold">clocked out</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <span className={n.language === "en" ? "text-blue-1" : "text-warning"}>
                          {n.language}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-[11px] text-text-muted">{n.provider}</td>
                      <td className="py-2 pr-3 text-text-secondary max-w-md truncate">
                        {n.message_body}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </section>
        </details>
      </main>

      {/* Confirmation modal */}
      {confirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(15, 23, 42, 0.5)" }}
          role="dialog"
          aria-modal="true"
        >
          {(() => {
            const hasWarning  = confirm.kinds.includes("warning");
            const hasClocked  = confirm.kinds.includes("clocked_out");
            const messagesPerPerson = confirm.kinds.length * 2;
            const totalTexts = confirm.recipients.length * messagesPerPerson;
            const toggleKind = (k: "warning" | "clocked_out") => {
              const next = confirm.kinds.includes(k)
                ? confirm.kinds.filter((x) => x !== k)
                : [...confirm.kinds, k];
              setConfirm({ ...confirm, kinds: next });
            };
            return (
              <div className="bg-surface rounded-xl shadow-xl border border-border max-w-3xl w-full max-h-[90vh] flex flex-col">
                <>
                    {/* Step indicator */}
                    <div className="px-5 pt-4 pb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.06em] font-semibold">
                      <span className={confirm.step === 1 ? "text-blue-1" : "text-text-muted"}>
                        1. Sort
                      </span>
                      <span className="text-text-muted">→</span>
                      <span className={confirm.step === 2 ? "text-blue-1" : "text-text-muted"}>
                        2. Review messages
                      </span>
                    </div>
                    <div className="p-5 border-b border-border">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                          Next punch-out
                        </div>
                        <div className="text-[28px] font-bold text-warning tabular leading-tight mt-0.5">
                          {confirm.block.label.toUpperCase()}
                        </div>
                        <div className="text-[14px] text-text-secondary mt-1 tabular">
                          <strong className="text-text-primary">{latestImport?.row_count ?? lct.length}</strong> rows in latest file
                          {" · "}
                          <strong className="text-text-primary">{totalByBlock[confirm.block.id] ?? 0}</strong> punches in this shift
                        </div>
                      </div>
                    </div>

                    {/* Reminder type toggle — multi-select */}
                    <div className="p-5 border-b border-border bg-bg/40 space-y-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                        Which reminder? <span className="text-text-secondary font-normal normal-case ml-2">(select one or both)</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => toggleKind("warning")}
                          aria-pressed={hasWarning}
                          className={`text-left border rounded-lg p-3 transition-colors ${
                            hasWarning
                              ? "bg-warning/10 border-warning ring-2 ring-warning/30"
                              : "bg-surface border-border hover:border-warning"
                          }`}
                        >
                          <div className="text-[13px] font-semibold text-text-primary flex items-center gap-1.5 uppercase">
                            <span className={`inline-block w-3 h-3 rounded border ${
                              hasWarning ? "bg-warning border-warning" : "border-border bg-surface"
                            }`} aria-hidden>
                              {hasWarning && (
                                <svg viewBox="0 0 12 12" className="w-full h-full text-white">
                                  <path d="M2.5 6 L5 8.5 L9.5 3.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              )}
                            </span>
                            15-MINUTE REMINDER
                          </div>
                          <div className="text-[11px] text-text-muted mt-0.5">
                            "Your shift will be ending soon"
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleKind("clocked_out")}
                          aria-pressed={hasClocked}
                          className={`text-left border rounded-lg p-3 transition-colors ${
                            hasClocked
                              ? "bg-warning/10 border-warning ring-2 ring-warning/30"
                              : "bg-surface border-border hover:border-warning"
                          }`}
                        >
                          <div className="text-[13px] font-semibold text-text-primary flex items-center gap-1.5 uppercase">
                            <span className={`inline-block w-3 h-3 rounded border ${
                              hasClocked ? "bg-warning border-warning" : "border-border bg-surface"
                            }`} aria-hidden>
                              {hasClocked && (
                                <svg viewBox="0 0 12 12" className="w-full h-full text-white">
                                  <path d="M2.5 6 L5 8.5 L9.5 3.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              )}
                            </span>
                            END SHIFT REMINDER
                          </div>
                          <div className="text-[11px] text-text-muted mt-0.5">
                            "Your shift has ended — please stop"
                          </div>
                        </button>
                      </div>
                    </div>

                    {/* Excluded + Exceptions — step 1 only */}
                    {confirm.step === 1 && (
                    <div className="overflow-y-auto p-5 flex-1 space-y-4">
                      {confirm.excluded.length === 0 ? (
                        <p className="text-[13px] text-text-muted">
                          No exclusions at this checkpoint.
                        </p>
                      ) : (() => {
                        // Classify each excluded candidate. Operational =
                        // automatic, expected; Exceptions = needs human attention
                        // (new hire, subcontractor, punch oddity, missing phone).
                        const isException = (reason: string): boolean => {
                          const r = reason.toLowerCase();
                          return r.includes("phone") ||      // new hire / missing phone
                            r.includes("subcontract") ||
                            r.startsWith("sub") ||           // "Substitute / SUB"
                            r.startsWith("substitute") ||
                            r.startsWith("punch exception") ||
                            r.startsWith("store exception") || // site-level note from field team
                            r === "employee not active" ||
                            r === "new employee";
                        };
                        const exclGroups: Record<string, Candidate[]> = {};
                        const exceptGroups: Record<string, Candidate[]> = {};
                        for (const c of confirm.excluded) {
                          const k = c.reason ?? "Other";
                          const bucket = isException(k) ? exceptGroups : exclGroups;
                          (bucket[k] ||= []).push(c);
                        }
                        const exclTotal = Object.values(exclGroups).reduce((n, l) => n + l.length, 0);
                        const exceptTotal = Object.values(exceptGroups).reduce((n, l) => n + l.length, 0);

                        const renderGroup = (
                          title: string,
                          subtitle: string,
                          total: number,
                          groups: Record<string, Candidate[]>,
                          accent: string,
                        ) => (
                          <div className="border border-border rounded-lg">
                            <div className={`px-4 py-2 border-b border-border rounded-t-lg ${accent}`}>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.06em]">
                                {title} · <span className="tabular">{total}</span>
                              </div>
                              <div className="text-[11px] opacity-75 mt-0.5">{subtitle}</div>
                            </div>
                            {total === 0 ? (
                              <div className="px-4 py-3 text-[12px] text-text-muted">None</div>
                            ) : (
                              <ul className="divide-y divide-border">
                                {Object.entries(groups)
                                  .sort((a, b) => b[1].length - a[1].length)
                                  .map(([reason, list]) => {
                                    // Which column drove the exclusion? Used to
                                    // highlight that cell in orange so the
                                    // operator can immediately see why each row
                                    // was filtered.
                                    const r = reason.toLowerCase();
                                    const highlight: "site" | "rate" | "time_in" | "time_out" | "employee" | "none" =
                                      r.startsWith("store exception") ? "site" :
                                      r === "already clocked out" ? "time_out" :
                                      r === "lunch punch" ? "rate" :
                                      r.startsWith("substitute") || r.startsWith("sub") ? "rate" :
                                      r.startsWith("punch exception") ? "time_in" :
                                      r === "manager / supervisor" || r === "employee not active" ? "employee" :
                                      "none";
                                    const hi = "bg-warning/15";
                                    return (
                                    <li key={reason} className="text-[13px]">
                                      <details>
                                        <summary className="cursor-pointer flex items-baseline gap-2 px-4 py-2 hover:bg-bg/40">
                                          <span className="font-semibold tabular text-text-primary">
                                            {list.length}
                                          </span>
                                          <span className="text-text-secondary">{reason}</span>
                                        </summary>
                                        <div className="mx-4 mb-3 rounded-md bg-bg/50 border border-border overflow-hidden">
                                          <div className="overflow-x-auto">
                                            <table className="w-full text-[12px] tabular border-collapse">
                                              <thead className="bg-bg">
                                                <tr className="text-left text-text-muted uppercase text-[10px] tracking-[0.06em]">
                                                  <th className={`px-3 py-2 font-semibold w-[100px] ${highlight === "site" ? "bg-warning/20 text-warning" : ""}`}>Jobsite&nbsp;ID</th>
                                                  <th className={`px-3 py-2 font-semibold ${highlight === "site" ? "bg-warning/20 text-warning" : ""}`}>Jobsite&nbsp;Name</th>
                                                  <th className="px-3 py-2 font-semibold w-[88px]">Payroll&nbsp;ID</th>
                                                  <th className={`px-3 py-2 font-semibold w-[200px] ${highlight === "employee" ? "bg-warning/20 text-warning" : ""}`}>Employee&nbsp;Name</th>
                                                  <th className={`px-3 py-2 font-semibold w-[80px] ${highlight === "rate" ? "bg-warning/20 text-warning" : ""}`}>Rate</th>
                                                  <th className={`px-3 py-2 font-semibold text-right w-[90px] ${highlight === "time_in" ? "bg-warning/20 text-warning" : ""}`}>Time&nbsp;In</th>
                                                  <th className={`px-3 py-2 font-semibold text-right w-[90px] ${highlight === "time_out" ? "bg-warning/20 text-warning" : ""}`}>Time&nbsp;Out</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {list.map((c, i) => {
                                                  return (
                                                    <tr
                                                      key={c.payroll_number + c.employee_name}
                                                      className={`${
                                                        highlight !== "none"
                                                          ? "bg-warning/15"
                                                          : i % 2 === 0 ? "bg-surface" : "bg-bg/40"
                                                      } border-t border-border/40`}
                                                    >
                                                      <td className={`px-3 py-1.5 text-text-primary font-semibold tabular ${highlight === "site" ? hi + " text-warning" : ""}`}>{c.site_id ?? "—"}</td>
                                                      <td className={`px-3 py-1.5 text-text-secondary ${highlight === "site" ? hi : ""}`}>{c.job_site_name}</td>
                                                      <td className="px-3 py-1.5 text-text-secondary font-medium">{c.payroll_number}</td>
                                                      <td className={`px-3 py-1.5 text-text-primary whitespace-nowrap ${highlight === "employee" ? hi + " text-warning font-semibold" : ""}`}>{c.employee_name}</td>
                                                      <td className={`px-3 py-1.5 ${highlight === "rate" ? hi : ""}`}>
                                                        {c.rate_type ? (
                                                          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${
                                                            highlight === "rate"
                                                              ? "bg-warning/20 text-warning border-warning/40"
                                                              : "bg-bg text-text-secondary border-border"
                                                          }`}>
                                                            {c.rate_type}
                                                          </span>
                                                        ) : (
                                                          <span className="text-text-muted">—</span>
                                                        )}
                                                      </td>
                                                      <td className={`px-3 py-1.5 text-right whitespace-nowrap ${highlight === "time_in" ? hi + " text-warning font-semibold" : "text-text-secondary"}`}>{fmtTimeOnly(c.time_in)}</td>
                                                      <td className={`px-3 py-1.5 text-right whitespace-nowrap ${highlight === "time_out" ? hi + " text-warning font-semibold" : "text-text-secondary"}`}>{fmtTimeOnly(c.time_out)}</td>
                                                    </tr>
                                                  );
                                                })}
                                              </tbody>
                                            </table>
                                          </div>
                                        </div>
                                      </details>
                                    </li>
                                    );
                                  })}
                              </ul>
                            )}
                          </div>
                        );

                        return (
                          <>
                            {renderGroup(
                              "Excluded",
                              "Already punched out, on lunch, manager — handled automatically",
                              exclTotal,
                              exclGroups,
                              "bg-bg/60 text-text-secondary",
                            )}
                            {renderGroup(
                              "Exceptions",
                              "New employees, subcontractors, store exceptions — review before sending",
                              exceptTotal,
                              exceptGroups,
                              "bg-warning/10 text-warning",
                            )}
                          </>
                        );
                      })()}
                    </div>
                    )}

                    {/* ===== STEP 1 footer: Next ===== */}
                    {confirm.step === 1 && (
                      <div className="p-5 border-t border-border flex items-center justify-between gap-2">
                        <button
                          onClick={() => setConfirm(null)}
                          className="px-4 py-2 text-[13px] font-semibold text-text-secondary hover:text-text-primary"
                        >
                          Cancel
                        </button>
                        <div className="flex items-center gap-3">
                          <span className="text-[12px] text-text-secondary tabular">
                            Step 1 of 2 · sort excluded + exceptions
                          </span>
                          <button
                            onClick={() => setConfirm({ ...confirm, step: 2 })}
                            disabled={confirm.recipients.length === 0 || confirm.kinds.length === 0}
                            className="px-4 py-2 text-[13px] font-semibold rounded-md bg-blue-1 hover:bg-blue-2 text-white disabled:opacity-50"
                          >
                            Next: review messages →
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ===== STEP 2: message preview + Send ===== */}
                    {confirm.step === 2 && (
                      <>
                        <div className="overflow-y-auto flex-1 p-5 space-y-4 bg-bg/40">
                          {hasWarning && (
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-blue-1 mb-2">
                                15-minute reminder
                              </div>
                              <div className="grid gap-3 sm:grid-cols-2">
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted flex items-baseline justify-between">
                                    <span>English</span>
                                    <span className="tabular">{confirm.warnEn.length} chars</span>
                                  </div>
                                  <div className="mt-1 bg-surface border border-border rounded-lg p-3 text-[13px] leading-relaxed whitespace-pre-line">
                                    {confirm.warnEn}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted flex items-baseline justify-between">
                                    <span>Spanish</span>
                                    <span className="tabular">{confirm.warnEs.length} chars</span>
                                  </div>
                                  <div className="mt-1 bg-surface border border-border rounded-lg p-3 text-[13px] leading-relaxed whitespace-pre-line">
                                    {confirm.warnEs}
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
                          {hasClocked && (
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-blue-1 mb-2">
                                END SHIFT
                              </div>
                              <div className="grid gap-3 sm:grid-cols-2">
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted flex items-baseline justify-between">
                                    <span>English</span>
                                    <span className="tabular">{confirm.clockedEn.length} chars</span>
                                  </div>
                                  <div className="mt-1 bg-surface border border-border rounded-lg p-3 text-[13px] leading-relaxed whitespace-pre-line">
                                    {confirm.clockedEn}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted flex items-baseline justify-between">
                                    <span>Spanish</span>
                                    <span className="tabular">{confirm.clockedEs.length} chars</span>
                                  </div>
                                  <div className="mt-1 bg-surface border border-border rounded-lg p-3 text-[13px] leading-relaxed whitespace-pre-line">
                                    {confirm.clockedEs}
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
                          {!hasWarning && !hasClocked && (
                            <div className="text-[12px] text-text-muted text-center">
                              Pick a reminder type on step 1 to preview the message.
                            </div>
                          )}
                        </div>

                        <div className="p-5 border-t border-border flex items-center justify-between gap-2">
                          <button
                            onClick={() => setConfirm({ ...confirm, step: 1 })}
                            className="px-4 py-2 text-[13px] font-semibold text-text-secondary hover:text-text-primary"
                          >
                            ← Back
                          </button>
                          <div className="flex items-center gap-3">
                            <span className="text-[12px] text-text-secondary tabular">
                              Step 2 of 2
                            </span>
                            <button
                              onClick={confirmSend}
                              disabled={confirm.recipients.length === 0 || confirm.kinds.length === 0}
                              className="px-4 py-2 text-[13px] font-semibold rounded-md bg-blue-1 hover:bg-blue-2 text-white disabled:opacity-50"
                            >
                              Send {totalTexts} text{totalTexts === 1 ? "" : "s"}
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                </>
              </div>
            );
          })()}
        </div>
      )}

      {sentReceipt && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          onClick={() => setSentReceipt(null)}
        >
          <div
            className="bg-surface border border-border rounded-xl shadow-card w-full max-w-3xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-border flex items-center justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-good">
                  Sent · {sentReceipt.messages.length} message{sentReceipt.messages.length === 1 ? "" : "s"}
                </div>
                <h2 className="text-[18px] font-bold text-text-primary mt-0.5">
                  {sentReceipt.blockLabel} ·{" "}
                  {sentReceipt.kinds.map((k) =>
                    k === "warning" ? "15-min reminder" : "End shift"
                  ).join(" + ")}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => emailClaudia(sentReceipt!)}
                  className="text-[13px] font-semibold px-3 py-1.5 rounded-md border border-border bg-surface text-text-primary hover:bg-bg"
                >
                  Email Claudia
                </button>
                <button
                  onClick={() => downloadSentSummary(sentReceipt!)}
                  className="text-[13px] font-semibold px-3 py-1.5 rounded-md border border-border bg-surface text-text-primary hover:bg-bg"
                >
                  Download CSV
                </button>
                <button
                  onClick={() => setSentReceipt(null)}
                  className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-blue-1 text-white hover:bg-blue-2"
                >
                  Done
                </button>
              </div>
            </div>
            {sentReceipt.emailStatus && sentReceipt.messages.length > 0 && (
              <div
                className={`px-5 py-2 text-[12px] tabular border-b border-border ${
                  sentReceipt.emailStatus === "sent"
                    ? "bg-good/10 text-good"
                    : sentReceipt.emailStatus === "failed"
                      ? "bg-danger/10 text-danger"
                      : "bg-bg text-text-secondary"
                }`}
              >
                {sentReceipt.emailStatus === "pending" && "Emailing summary to Claudia…"}
                {sentReceipt.emailStatus === "sent" &&
                  `Email summary sent to ${sentReceipt.emailDetail ?? "Claudia"}.`}
                {sentReceipt.emailStatus === "failed" &&
                  `Email failed: ${sentReceipt.emailDetail ?? "unknown"}. Use Email Claudia to retry.`}
                {sentReceipt.emailStatus === "skipped" && "Nothing to email — 0 messages sent."}
              </div>
            )}
            <div className="p-5">
              {sentReceipt.messages.length === 0 ? (
                <p className="text-[13px] text-text-secondary">
                  No messages were sent (no eligible recipients on this run).
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] tabular">
                    <thead className="bg-bg text-text-muted uppercase text-[10px] tracking-[0.06em]">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold">Sent</th>
                        <th className="text-left px-3 py-2 font-semibold">Recipient</th>
                        <th className="text-left px-3 py-2 font-semibold w-[50px]">Lang</th>
                        <th className="text-left px-3 py-2 font-semibold">Type</th>
                        <th className="text-left px-3 py-2 font-semibold">Message</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {sentReceipt.messages.map((m) => (
                        <tr key={m.id}>
                          <td className="px-3 py-1.5 text-text-secondary whitespace-nowrap">{fmtTimeOnly(m.sent_at)}</td>
                          <td className="px-3 py-1.5 text-text-primary font-semibold">{m.recipient_address}</td>
                          <td className="px-3 py-1.5">
                            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-bg text-text-secondary border border-border">
                              {m.language}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-text-secondary">
                            {m.notification_type === "END_OF_SHIFT_WARNING" ? "Warning"
                              : m.notification_type === "END_OF_SHIFT_CLOCKED_OUT" ? "End shift"
                              : m.notification_type}
                          </td>
                          <td className="px-3 py-1.5 text-text-primary">{m.message_body}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* StoreExceptionsCard                                                        */
/* -------------------------------------------------------------------------- */
/* Today's active store exceptions + a quick add form. Field teams call/text
   the ops lead with things like "T0067 closed today" — capturing them here
   immediately reflects in the checkpoint modal (rows excluded with reason
   'Store exception: ...').                                                   */

type StoreException = {
  id: number;
  site_id: string;
  exception_date: string;
  exception_type: string;
  note: string | null;
  source: string;
  reporter: string | null;
  active: boolean;
  created_at: string;
  job_site_name?: string | null;
};

const EXCEPTION_TYPES: { value: string; label: string }[] = [
  { value: "closed",            label: "Closed" },
  { value: "reduced_staffing",  label: "Reduced staffing" },
  { value: "do_not_text",       label: "Do not text" },
  { value: "holiday",           label: "Holiday" },
  { value: "other",             label: "Other" },
];

type BulkExceptionRow = { store: string; reason: string; other: string };
const blankBulkRow = (): BulkExceptionRow => ({ store: "", reason: "No reason provided", other: "" });

const EXCEPTION_REASONS = [
  "No reason provided",
  "Make-up hours",
  "No-show",
  "Short-staffed",
  "Late arrival",
  "Other",
];

function StoreExceptionsCard({ onChange }: { onChange: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState<StoreException[]>([]);
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [bulkRows, setBulkRows] = useState<BulkExceptionRow[]>(() =>
    Array.from({ length: 15 }, blankBulkRow),
  );
  const [source, setSource] = useState("phone");
  const [reporter, setReporter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase
      .from("store_exception")
      .select("*")
      .eq("exception_date", today)
      .eq("active", true)
      .order("created_at", { ascending: false });
    const exceptions = (data ?? []) as StoreException[];
    // Bulk-fetch site names for the listed site IDs and decorate the rows.
    const ids = Array.from(new Set(exceptions.map((r) => r.site_id))).filter(Boolean);
    if (ids.length > 0) {
      const { data: sites } = await supabase
        .from("site")
        .select("site_id, site_name")
        .in("site_id", ids);
      const nameById = new Map((sites ?? []).map((s) => [s.site_id, s.site_name]));
      for (const r of exceptions) r.job_site_name = nameById.get(r.site_id) ?? null;
    }
    setRows(exceptions);
  };

  useEffect(() => {
    load();
  }, []);

  const reset = () => {
    setBulkRows(Array.from({ length: 15 }, blankBulkRow));
    setSource("phone");
    setReporter("");
    setError(null);
  };

  const updateBulkRow = (i: number, patch: Partial<BulkExceptionRow>) => {
    setBulkRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  // Paste a newline/tab/comma/whitespace-separated list of store IDs into
  // Store # starting at row `i`, spreading across subsequent rows and
  // appending more if needed.
  const pasteStores = (i: number, text: string) => {
    const codes = text
      .split(/[\s,;]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (codes.length <= 1) return false;
    setBulkRows((rs) => {
      const next = [...rs];
      for (let k = 0; k < codes.length; k++) {
        const idx = i + k;
        if (idx >= next.length) next.push(blankBulkRow());
        next[idx] = { ...next[idx], store: codes[k] };
      }
      return next;
    });
    return true;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const filled = bulkRows.filter((r) => r.store.trim());
    if (filled.length === 0) {
      setError("Add at least one Store #");
      return;
    }
    setSaving(true);
    setError(null);
    const payload = filled.map((r) => {
      const reasonLabel = r.reason === "Other" && r.other.trim()
        ? r.other.trim()
        : r.reason;
      return {
        site_id: r.store.trim().toUpperCase(),
        exception_date: today,
        exception_type: "other",
        note: reasonLabel,
        source,
        reporter: reporter.trim() || null,
        active: true,
      };
    });
    const { error: insErr } = await supabase.from("store_exception").insert(payload);
    setSaving(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    reset();
    setShowAdd(false);
    await load();
    onChange();
  };

  const remove = async (row: StoreException) => {
    if (!confirm(`Remove exception for ${row.site_id}?`)) return;
    await supabase
      .from("store_exception")
      .update({ active: false })
      .eq("id", row.id);
    await load();
    onChange();
  };

  const updateSavedReason = async (row: StoreException, reason: string) => {
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, note: reason } : r)));
    await supabase.from("store_exception").update({ note: reason }).eq("id", row.id);
    onChange();
  };

  return (
    <section id="store-exceptions" className="bg-surface border border-border rounded-xl">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between p-5 text-left"
      >
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            Store exceptions
            <span className="ml-2 text-text-primary">{rows.length}</span>
            <span className="ml-1 text-text-secondary font-normal normal-case">
              active today
            </span>
          </h2>
          <p className="text-[13px] text-text-secondary mt-1">
            Field-team notes that exclude a site from end-of-shift texting
            (closures, reduced staffing, "do not text").
          </p>
        </div>
        <span className="text-text-muted text-[12px]">{open ? "Hide ▴" : "Show ▾"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-text-secondary">
              {rows.length === 0
                ? "No exceptions logged for today."
                : `${rows.length} active.`}
            </span>
            {!showAdd && (
              <button
                onClick={() => setShowAdd(true)}
                className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-blue-1 text-white hover:bg-blue-2"
              >
                + Add exception
              </button>
            )}
          </div>

          {showAdd && (
            <form
              onSubmit={submit}
              className="bg-white border border-border rounded-lg p-6 space-y-5"
            >
              <div className="text-center">
                <h3 className="text-[22px] font-bold tracking-wide text-text-primary">EXCEPTIONS FORM</h3>
                <p className="text-[12px] text-text-secondary mt-1 italic">
                  Stores listed below will be ignored — make no adjustments today.
                </p>
              </div>

              <div className="flex items-center gap-2 text-[12px]">
                <span className="font-semibold text-text-secondary">Set reason for all filled rows:</span>
                <select
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) return;
                    setBulkRows((rs) => rs.map((r) =>
                      r.store.trim() ? { ...r, reason: v } : r,
                    ));
                    e.currentTarget.selectedIndex = 0;
                  }}
                  defaultValue=""
                  className="border border-border rounded px-2 py-1 text-[12px] bg-surface"
                >
                  <option value="">— choose —</option>
                  {EXCEPTION_REASONS.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div className="overflow-x-auto border border-border rounded">
                <table className="w-full text-[12px] tabular border-collapse">
                  <thead>
                    <tr className="bg-yellow-200">
                      <th colSpan={3} className="border border-border px-2 py-1 text-center font-bold uppercase text-danger tracking-wide">
                        Below stores — ignore notes — make no adjustments
                      </th>
                    </tr>
                    <tr className="bg-yellow-100">
                      <th className="border border-border px-2 py-1 font-semibold text-text-primary text-left w-[160px]">Store #</th>
                      <th className="border border-border px-2 py-1 font-semibold text-text-primary text-left w-[180px]">Reason</th>
                      <th className="border border-border px-2 py-1 font-semibold text-text-primary text-left">Other (if selected)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map((r, i) => (
                      <tr key={i} className="bg-yellow-50">
                        <td className="border border-border p-0">
                          <input
                            type="text"
                            value={r.store}
                            onChange={(e) => updateBulkRow(i, { store: e.target.value })}
                            onPaste={(e) => {
                              const text = e.clipboardData.getData("text");
                              if (pasteStores(i, text)) e.preventDefault();
                            }}
                            placeholder="T1517"
                            className="w-full px-2 py-1 text-[13px] tabular font-semibold uppercase bg-transparent"
                          />
                        </td>
                        <td className="border border-border p-0">
                          <select
                            value={r.reason}
                            onChange={(e) => updateBulkRow(i, { reason: e.target.value })}
                            className="w-full px-2 py-1 text-[13px] bg-transparent"
                          >
                            {EXCEPTION_REASONS.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </td>
                        <td className="border border-border p-0">
                          <input
                            type="text"
                            value={r.other}
                            onChange={(e) => updateBulkRow(i, { other: e.target.value })}
                            disabled={r.reason !== "Other"}
                            placeholder={r.reason === "Other" ? "Describe…" : ""}
                            className="w-full px-2 py-1 text-[13px] bg-transparent disabled:bg-bg/30 disabled:text-text-muted"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 pt-2">
                <label className="text-[12px] font-semibold text-text-secondary">
                  Reporter (optional)
                  <input
                    type="text"
                    value={reporter}
                    onChange={(e) => setReporter(e.target.value)}
                    placeholder="Who told us? e.g. 'Store mgr Maria'"
                    className="mt-1 w-full border border-border rounded px-3 py-1.5 text-[13px] bg-yellow-50"
                  />
                </label>
                <label className="text-[12px] font-semibold text-text-secondary">
                  Source
                  <select
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    className="mt-1 w-full border border-border rounded px-3 py-1.5 text-[13px] bg-surface"
                  >
                    <option value="phone">Phone</option>
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="manual">Manual</option>
                  </select>
                </label>
              </div>

              {error && <div className="text-[12px] text-danger">{error}</div>}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowAdd(false); reset(); }}
                  className="text-[13px] font-semibold text-text-secondary hover:text-text-primary px-3 py-1.5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-blue-1 text-white hover:bg-blue-2 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save exceptions"}
                </button>
              </div>
            </form>
          )}

          {rows.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-[12px] tabular">
                <thead className="bg-bg text-text-muted uppercase text-[10px] tracking-[0.06em]">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold w-[100px]">Jobsite&nbsp;ID</th>
                    <th className="text-left px-3 py-2 font-semibold">Jobsite&nbsp;Name</th>
                    <th className="text-left px-3 py-2 font-semibold w-[140px]">Type</th>
                    <th className="text-left px-3 py-2 font-semibold">Note</th>
                    <th className="text-left px-3 py-2 font-semibold w-[80px]">Source</th>
                    <th className="text-left px-3 py-2 font-semibold w-[180px]">Dept</th>
                    <th className="px-3 py-2 w-[80px]"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-1.5 font-semibold text-text-primary">{r.site_id}</td>
                      <td className="px-3 py-1.5 text-text-secondary">{r.job_site_name ?? "—"}</td>
                      <td className="px-3 py-1.5">
                        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-warning/15 text-warning">
                          {EXCEPTION_TYPES.find((t) => t.value === r.exception_type)?.label ?? r.exception_type}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        {EXCEPTION_REASONS.includes(r.note ?? "") ? (
                          <select
                            value={r.note ?? ""}
                            onChange={(e) => updateSavedReason(r, e.target.value)}
                            className="border border-border rounded px-2 py-0.5 text-[12px] bg-surface"
                          >
                            {EXCEPTION_REASONS.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            defaultValue={r.note ?? ""}
                            onBlur={(e) => {
                              if (e.target.value !== (r.note ?? "")) {
                                updateSavedReason(r, e.target.value);
                              }
                            }}
                            className="border border-border rounded px-2 py-0.5 text-[12px] bg-surface w-full"
                          />
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-text-muted uppercase text-[10px]">{r.source}</td>
                      <td className="px-3 py-1.5 text-text-secondary">{r.reporter ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right">
                        <button
                          onClick={() => remove(r)}
                          className="text-[11px] text-danger hover:underline"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
