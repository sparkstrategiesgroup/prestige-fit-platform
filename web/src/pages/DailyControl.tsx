import { useEffect, useRef, useState } from "react";
import { HeaderBar } from "../components/HeaderBar";
import { KpiCard } from "../components/KpiCard";
import { TimezoneClocks } from "../components/TimezoneClocks";
import { supabase } from "../lib/supabase";
import * as XLSX from "xlsx";

type ShiftBlock = {
  id: number;
  label: string;
  end_time_local: string;
  clients: string[];
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
  rate_type: string | null;
  time_in: string | null;
  time_out: string | null;
  shift_block_id: number | null;
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
  job_site_name: string;
  rate_type: string | null;
  status: "ELIGIBLE" | "EXCLUDED";
  reason: string | null;
};

type ShortStaff = {
  id: number;
  store_code: string;
  site_name: string | null;
  notes: string | null;
  department: string | null;
  exception_date: string;
};

const FUNCTIONS_URL = `${
  import.meta.env.VITE_SUPABASE_URL ?? "https://sshhcpzleurztzksrlvr.supabase.co"
}/functions/v1`;

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
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

export default function DailyControl() {
  const [blocks, setBlocks] = useState<ShiftBlock[]>([]);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [lct, setLct] = useState<LCT[]>([]);
  const [running, setRunning] = useState<number | null>(null);
  const [counts, setCounts] = useState({ total: 0, today: 0, clockedOutToday: 0 });
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [ctNow, setCtNow] = useState(() => ctMinutesNow(new Date()));
  const [chainFilter, setChainFilter] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    block: ShiftBlock;
    recipients: Recipient[];
    excluded: Candidate[];
    warnEn: string;
    warnEs: string;
    clockedEn: string;
    clockedEs: string;
    kind: "warning" | "clocked_out";
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ssFileRef = useRef<HTMLInputElement>(null);

  const [shortStaff, setShortStaff] = useState<ShortStaff[]>([]);
  const [ssUploading, setSsUploading] = useState(false);
  const [ssStatus, setSsStatus] = useState("");
  const [ssAdding, setSsAdding] = useState(false);
  const [ssForm, setSsForm] = useState({ store_code: "", site_name: "", notes: "", department: "" });

  async function refreshShortStaff() {
    const { data } = await supabase
      .from("short_staff_exception")
      .select("id,store_code,site_name,notes,department,exception_date")
      .eq("exception_date", new Date().toISOString().slice(0, 10))
      .order("store_code");
    setShortStaff((data ?? []) as ShortStaff[]);
  }

  async function handleSsUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSsUploading(true);
    setSsStatus(`Uploading ${file.name}…`);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: true,
        blankrows: false,
      });
      const headerRow = rows.findIndex((r) =>
        String(r[0] ?? "").trim().toLowerCase().startsWith("store")
      );
      if (headerRow === -1) {
        setSsStatus("Could not find header row with 'Store #'");
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const inserts: Record<string, unknown>[] = [];
      for (let i = headerRow + 1; i < rows.length; i++) {
        const row = rows[i];
        const code = String(row[0] ?? "").trim();
        if (!code) continue;
        inserts.push({
          store_code: code,
          notes: String(row[1] ?? "").trim() || null,
          site_name: String(row[2] ?? "").trim() || null,
          department: String(row[3] ?? "").trim() || null,
          exception_date: today,
        });
      }
      if (inserts.length === 0) {
        setSsStatus("No data rows found after header");
        return;
      }
      const { error } = await supabase
        .from("short_staff_exception")
        .upsert(inserts, { onConflict: "store_code,exception_date" });
      if (error) {
        setSsStatus(`Failed: ${error.message}`);
      } else {
        setSsStatus(`Imported ${inserts.length} exception${inserts.length === 1 ? "" : "s"}`);
      }
    } catch (err) {
      setSsStatus(`Failed: ${(err as Error).message}`);
    } finally {
      setSsUploading(false);
      if (ssFileRef.current) ssFileRef.current.value = "";
      await refreshShortStaff();
    }
  }

  async function addShortStaff() {
    if (!ssForm.store_code.trim()) return;
    const { error } = await supabase.from("short_staff_exception").upsert(
      {
        store_code: ssForm.store_code.trim(),
        site_name: ssForm.site_name.trim() || null,
        notes: ssForm.notes.trim() || null,
        department: ssForm.department.trim() || null,
        exception_date: new Date().toISOString().slice(0, 10),
      },
      { onConflict: "store_code,exception_date" },
    );
    if (error) {
      setSsStatus(`Failed: ${error.message}`);
    } else {
      setSsForm({ store_code: "", site_name: "", notes: "", department: "" });
      setSsAdding(false);
    }
    await refreshShortStaff();
  }

  async function deleteShortStaff(id: number) {
    await supabase.from("short_staff_exception").delete().eq("id", id);
    await refreshShortStaff();
  }

  async function refresh() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [
      { data: n, count: total },
      { count: today_ct },
      { count: clocked_out_ct },
      { data: l },
    ] = await Promise.all([
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
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .gte("sent_at", today.toISOString())
        .eq("notification_type", "END_OF_SHIFT_CLOCKED_OUT"),
      supabase
        .from("labor_control_tracking")
        .select(
          "payroll_number,employee_name,job_site_name,rate_type,time_in,time_out,shift_block_id",
        )
        .eq("work_date", new Date().toISOString().slice(0, 10))
        .order("time_in")
        .limit(2000),
    ]);
    setNotifs((n ?? []) as Notification[]);
    setLct((l ?? []) as LCT[]);
    setCounts({
      total: total ?? 0,
      today: today_ct ?? 0,
      clockedOutToday: clocked_out_ct ?? 0,
    });
    setLastRun(n && n.length ? n[0].sent_at : null);
  }

  useEffect(() => {
    supabase
      .from("shift_blocks")
      .select("id,label,end_time_local,clients")
      .order("end_time_local")
      .then(({ data }) => setBlocks((data ?? []) as ShiftBlock[]));
    refresh();
    refreshShortStaff();
  }, []);

  async function authHeaders(): Promise<Record<string, string>> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return {};
    return { Authorization: `Bearer ${session.access_token}` };
  }

  // Update the "due now" badge every 30 seconds. No need to tick faster —
  // the warning/clocked windows are minute-level.
  useEffect(() => {
    const id = window.setInterval(() => setCtNow(ctMinutesNow(new Date())), 30000);
    return () => window.clearInterval(id);
  }, []);

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
      setUploadStatus(`Eligibility query failed: ${eligErr.message}`);
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
      kind: defaultKind,
    });
  }

  async function confirmSend() {
    if (!confirm) return;
    setRunning(confirm.block.id);
    setConfirm(null);
    try {
      const auth = await authHeaders();
      const res = await fetch(`${FUNCTIONS_URL}/shift-block-runner`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ shift_block_id: confirm.block.id, kind: confirm.kind }),
      });
      const j = await res.json();
      if (!res.ok) {
        setUploadStatus(`Send failed: ${j.error ?? res.statusText}`);
      }
    } catch (err) {
      setUploadStatus(`Send failed: ${(err as Error).message}`);
    } finally {
      setRunning(null);
      refresh();
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadStatus(`Uploading ${file.name}…`);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const auth = await authHeaders();
      const res = await fetch(`${FUNCTIONS_URL}/epay-import`, {
        method: "POST",
        headers: auth,
        body: fd,
      });
      const j = await res.json();
      setUploadStatus(
        res.ok
          ? `Imported ${j.imported} row${j.imported === 1 ? "" : "s"}` +
            (j.sites_created ? `, created ${j.sites_created} new site${j.sites_created === 1 ? "" : "s"}` : "") +
            (j.errors?.length ? `, ${j.errors.length} error${j.errors.length === 1 ? "" : "s"}` : "")
          : `Failed: ${j.error ?? "unknown"}`,
      );
    } catch (err) {
      setUploadStatus(`Failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
      await refresh();
      // Auto-scroll to the punches table so the operator sees the
      // imported data immediately.
      requestAnimationFrame(() => {
        document.getElementById("todays-punches")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    }
  }

  // Open-punch count per shift block, mapped via labor_control_tracking.
  // Used to size the badge on each checkpoint tile.
  const openByBlock: Record<number, number> = {};
  for (const r of lct) {
    if (!r.time_out && r.shift_block_id) {
      openByBlock[r.shift_block_id] = (openByBlock[r.shift_block_id] ?? 0) + 1;
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
    ? Math.round((counts.clockedOutToday / counts.today) * 100)
    : 0;

  const sitesOpen = new Set(lct.map((r) => r.job_site_name)).size;
  const sitesWithOpen = new Set(lct.filter((r) => !r.time_out).map((r) => r.job_site_name)).size;
  const activeEmployees = new Set(lct.map((r) => r.payroll_number)).size;
  const employeesOnClock = new Set(lct.filter((r) => !r.time_out).map((r) => r.payroll_number)).size;

  function exportReport() {
    const headers = ["Payroll #","Employee","Site","Rate","Time In","Time Out","Status"];
    const rows = lct.map((r) => [
      r.payroll_number, r.employee_name, r.job_site_name, r.rate_type ?? "",
      fmtTime(r.time_in), r.time_out ? fmtTime(r.time_out) : "OPEN",
      r.time_out ? "Closed" : "Open",
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `labor-control-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <HeaderBar
        title="Labor Control Tracking"
        subtitle={lct.length > 0
          ? `${lct.length} punches loaded · ${lct.length - resolved} active · ${resolved} closed`
          : "Track punches and outreach in real time"}
        right={
          <div className="flex items-center gap-2">
            {lastRun && (
              <span className="tabular mr-2 hidden sm:inline">
                last run · {fmtTime(lastRun)}
              </span>
            )}
            <label className="cursor-pointer text-[13px] font-semibold px-3 py-1.5 rounded-md border border-border bg-surface text-text-primary hover:bg-bg transition-colors">
              {uploading ? "Uploading…" : lct.length > 0 ? "Re-upload" : "Upload"}
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx"
                onChange={handleUpload}
                disabled={uploading}
                className="hidden"
              />
            </label>
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
        <TimezoneClocks />

        {/* Operational KPIs */}
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
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
            label="PAM RESOLUTION"
            value={resolved + "/" + lct.length}
            changeText={lct.length > 0 ? `${Math.round((resolved/lct.length)*100)}% resolved` : undefined}
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

        {/* Upload Punches Report */}
        <section className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Upload Punches Report
              </h2>
              <p className="text-[13px] text-text-secondary mt-1">
                Drop the .xlsx export from Epay. We'll parse it, auto-create any
                new sites, and refresh the dashboard.
              </p>
            </div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="cursor-pointer bg-blue-1 hover:bg-blue-2 text-white text-[13px] font-semibold px-4 py-2 rounded-md transition-colors disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "Choose .xlsx file"}
            </button>
          </div>
          {uploadStatus && (
            <div className="mt-3 text-[13px] text-text-secondary tabular flex items-center gap-3 flex-wrap">
              <span>{uploadStatus}</span>
              <a
                href="#todays-punches"
                className="text-blue-1 hover:underline font-semibold"
              >
                View imported punches ↓
              </a>
            </div>
          )}
        </section>

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
            <span>Today's punches ({lct.length}{chainFilter ? ` · filtered ${chainFilter}` : ""})</span>
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
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-text-muted">
                          <th className="py-2 pr-3 font-medium">Payroll #</th>
                          <th className="py-2 pr-3 font-medium">Employee</th>
                          <th className="py-2 pr-3 font-medium">Site</th>
                          <th className="py-2 pr-3 font-medium">Rate</th>
                          <th className="py-2 pr-3 font-medium">In</th>
                          <th className="py-2 pr-3 font-medium">Out</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((r) => (
                          <tr
                            key={`${r.payroll_number}-${r.time_in}`}
                            className={!r.time_out ? "bg-warning/5" : ""}
                          >
                            <td className="py-2 pr-3 tabular">{r.payroll_number}</td>
                            <td className="py-2 pr-3">{r.employee_name}</td>
                            <td className="py-2 pr-3">{r.job_site_name}</td>
                            <td className="py-2 pr-3 text-text-muted">{r.rate_type ?? "—"}</td>
                            <td className="py-2 pr-3 tabular">{fmtTime(r.time_in)}</td>
                            <td className="py-2 pr-3 tabular">
                              {r.time_out ? (
                                fmtTime(r.time_out)
                              ) : (
                                <span className="text-warning font-semibold">OPEN</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            );
          })()}
          </section>
        </details>

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

        {/* Short Staff Exceptions */}
        <details className="bg-surface border border-border rounded-xl" open={shortStaff.length > 0}>
          <summary className="cursor-pointer p-5 text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted hover:text-text-primary list-none flex items-center justify-between">
            <span>Short Staff Exceptions ({shortStaff.length})</span>
            <span className="text-blue-1 text-[11px]">click to {shortStaff.length > 0 ? "collapse" : "expand"}</span>
          </summary>
          <section className="px-5 pb-5">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <p className="text-[13px] text-text-secondary">
                Stores flagged short-staffed today. Upload the .xlsx or add manually.
              </p>
              <div className="flex items-center gap-2">
                <label className="cursor-pointer text-[13px] font-semibold px-3 py-1.5 rounded-md border border-border bg-surface text-text-primary hover:bg-bg transition-colors">
                  {ssUploading ? "Uploading…" : "Upload .xlsx"}
                  <input
                    ref={ssFileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleSsUpload}
                    disabled={ssUploading}
                    className="hidden"
                  />
                </label>
                <button
                  onClick={() => setSsAdding(true)}
                  className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-blue-1 text-white hover:bg-blue-2"
                >
                  + Add
                </button>
              </div>
            </div>
            {ssStatus && (
              <div className="mb-3 text-[13px] text-text-secondary tabular">{ssStatus}</div>
            )}

            {ssAdding && (
              <div className="mb-4 bg-bg/50 border border-border rounded-lg p-4 flex flex-wrap gap-3 items-end">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted mb-1">
                    Store #
                  </label>
                  <input
                    type="text"
                    placeholder="T2882"
                    value={ssForm.store_code}
                    onChange={(e) => setSsForm({ ...ssForm, store_code: e.target.value })}
                    className="w-24 text-[13px] px-2 py-1.5 rounded-md border border-border bg-surface text-text-primary"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted mb-1">
                    Notes
                  </label>
                  <input
                    type="text"
                    placeholder="6/4 short staff"
                    value={ssForm.notes}
                    onChange={(e) => setSsForm({ ...ssForm, notes: e.target.value })}
                    className="w-40 text-[13px] px-2 py-1.5 rounded-md border border-border bg-surface text-text-primary"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted mb-1">
                    Name
                  </label>
                  <input
                    type="text"
                    placeholder="T2882 Katy Elyson"
                    value={ssForm.site_name}
                    onChange={(e) => setSsForm({ ...ssForm, site_name: e.target.value })}
                    className="w-48 text-[13px] px-2 py-1.5 rounded-md border border-border bg-surface text-text-primary"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted mb-1">
                    Dept
                  </label>
                  <input
                    type="text"
                    placeholder="1006 - Luis Diaz"
                    value={ssForm.department}
                    onChange={(e) => setSsForm({ ...ssForm, department: e.target.value })}
                    className="w-48 text-[13px] px-2 py-1.5 rounded-md border border-border bg-surface text-text-primary"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={addShortStaff}
                    disabled={!ssForm.store_code.trim()}
                    className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-blue-1 text-white hover:bg-blue-2 disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => { setSsAdding(false); setSsForm({ store_code: "", site_name: "", notes: "", department: "" }); }}
                    className="text-[13px] font-semibold px-3 py-1.5 text-text-secondary hover:text-text-primary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {shortStaff.length === 0 ? (
              <p className="text-text-muted text-sm py-4">
                No short-staff exceptions for today. Upload the .xlsx or click + Add.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-text-muted">
                      <th className="py-2 pr-3 font-medium">Store #</th>
                      <th className="py-2 pr-3 font-medium">Notes</th>
                      <th className="py-2 pr-3 font-medium">Name</th>
                      <th className="py-2 pr-3 font-medium">Dept</th>
                      <th className="py-2 pr-3 font-medium w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortStaff.map((s) => (
                      <tr key={s.id} className="bg-warning/5">
                        <td className="py-2 pr-3 tabular font-semibold">{s.store_code}</td>
                        <td className="py-2 pr-3 text-text-secondary">{s.notes ?? "—"}</td>
                        <td className="py-2 pr-3">{s.site_name ?? "—"}</td>
                        <td className="py-2 pr-3 text-text-muted">{s.department ?? "—"}</td>
                        <td className="py-2 pr-3">
                          <button
                            onClick={() => deleteShortStaff(s.id)}
                            className="text-[11px] text-critical hover:underline"
                            title="Remove"
                          >
                            ×
                          </button>
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
          <div className="bg-surface rounded-xl shadow-xl border border-border max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="p-5 border-b border-border">
              <h3 className="text-[16px] font-bold text-text-primary">
                Send to {confirm.recipients.length}{" "}
                {confirm.recipients.length === 1 ? "person" : "people"}?
              </h3>
              <p className="text-[13px] text-text-secondary mt-1">
                <strong>{confirm.block.label}</strong> checkpoint · suppressed
                rows excluded automatically.
              </p>
            </div>

            {/* Which notification? */}
            <div className="p-5 border-b border-border bg-bg/40 space-y-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Which message?
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setConfirm({ ...confirm, kind: "warning" })}
                  className={`text-left border rounded-lg p-3 transition-colors ${
                    confirm.kind === "warning"
                      ? "bg-warning/10 border-warning ring-2 ring-warning/30"
                      : "bg-surface border-border hover:border-warning"
                  }`}
                >
                  <div className="text-[12px] font-semibold text-text-primary">
                    15-minute reminder
                  </div>
                  <div className="text-[11px] text-text-muted mt-0.5">
                    "Your shift will be ending soon"
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirm({ ...confirm, kind: "clocked_out" })}
                  className={`text-left border rounded-lg p-3 transition-colors ${
                    confirm.kind === "clocked_out"
                      ? "bg-good/10 border-good ring-2 ring-good/30"
                      : "bg-surface border-border hover:border-good"
                  }`}
                >
                  <div className="text-[12px] font-semibold text-text-primary">
                    Clocked-out notice
                  </div>
                  <div className="text-[11px] text-text-muted mt-0.5">
                    "Your shift has ended — please stop"
                  </div>
                </button>
              </div>

              {(() => {
                const en = confirm.kind === "warning" ? confirm.warnEn : confirm.clockedEn;
                const es = confirm.kind === "warning" ? confirm.warnEs : confirm.clockedEs;
                return (
                  <>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted flex items-baseline justify-between">
                      <span>Message preview</span>
                      <span className="tabular text-text-secondary">
                        {confirm.recipients.length * 2} messages · {(en.length + es.length)} characters
                      </span>
                    </div>
                    <div className="bg-surface border border-border rounded-lg p-3 text-[13px] leading-relaxed text-text-primary whitespace-pre-line">
                      {en}
                      {"\n\n"}
                      {es}
                    </div>
                  </>
                );
              })()}
            </div>
            <div className="overflow-y-auto p-5 flex-1 space-y-5">
              {/* Excluded breakdown — transparency / trust builder */}
              {confirm.excluded.length > 0 && (() => {
                const groups: Record<string, Candidate[]> = {};
                for (const c of confirm.excluded) {
                  const k = c.reason ?? "Other";
                  (groups[k] ||= []).push(c);
                }
                return (
                  <div className="bg-bg/50 border border-border rounded-lg p-4">
                    <div className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-muted mb-2">
                      {confirm.excluded.length} excluded · {confirm.recipients.length + confirm.excluded.length} total candidates
                    </div>
                    <ul className="space-y-2">
                      {Object.entries(groups)
                        .sort((a, b) => b[1].length - a[1].length)
                        .map(([reason, list]) => (
                          <li key={reason} className="text-[13px]">
                            <details>
                              <summary className="cursor-pointer flex items-baseline gap-2 hover:text-blue-1">
                                <span className="font-semibold tabular text-text-primary">{list.length}</span>
                                <span className="text-text-secondary">{reason}</span>
                              </summary>
                              <ul className="mt-1 ml-4 pl-3 border-l border-border space-y-0.5 text-[12px] text-text-secondary">
                                {list.map((c) => (
                                  <li key={c.payroll_number + c.employee_name}>
                                    {c.employee_name} <span className="text-text-muted">· {c.job_site_name}</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          </li>
                        ))}
                    </ul>
                  </div>
                );
              })()}

              {confirm.recipients.length === 0 ? (
                <p className="text-text-muted text-sm">
                  No one to text for the {confirm.block.label} checkpoint.
                </p>
              ) : (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-text-muted">
                      <th className="py-2 pr-3 font-medium">Employee</th>
                      <th className="py-2 pr-3 font-medium">Site</th>
                      <th className="py-2 pr-3 font-medium">Phone</th>
                      <th className="py-2 pr-3 font-medium">Lang</th>
                    </tr>
                  </thead>
                  <tbody>
                    {confirm.recipients.map((r) => (
                      <tr key={r.payroll_number}>
                        <td className="py-2 pr-3">{r.employee_name}</td>
                        <td className="py-2 pr-3">{r.job_site_name}</td>
                        <td className="py-2 pr-3 tabular">{r.cell_phone}</td>
                        <td className="py-2 pr-3 text-text-muted">{r.language}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="p-5 border-t border-border flex justify-end gap-2">
              <button
                onClick={() => setConfirm(null)}
                className="px-4 py-2 text-[13px] font-semibold text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={confirmSend}
                disabled={confirm.recipients.length === 0}
                className="px-4 py-2 text-[13px] font-semibold rounded-md bg-blue-1 hover:bg-blue-2 text-white disabled:opacity-50"
              >
                Send {confirm.recipients.length * 2} text{confirm.recipients.length * 2 === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
