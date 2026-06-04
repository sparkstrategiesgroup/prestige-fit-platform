import { useEffect, useRef, useState } from "react";
import { HeaderBar } from "../components/HeaderBar";
import { KpiCard } from "../components/KpiCard";
import { TimezoneClocks } from "../components/TimezoneClocks";
import { supabase } from "../lib/supabase";

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
  const [counts, setCounts] = useState({ total: 0, today: 0 });
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [ctNow, setCtNow] = useState(() => ctMinutesNow(new Date()));
  const [chainFilter, setChainFilter] = useState<string | null>(null);
  // Shift selection / expansion / action modal for the ePay reports row
  const [selectedBlockId, setSelectedBlockId] = useState<number | null>(null);
  const [expandedBlockId, setExpandedBlockId] = useState<number | null>(null);
  const [actionModal, setActionModal] =
    useState<{ block: ShiftBlock; punchCount: number } | null>(null);
  const [modalChoice, setModalChoice] = useState<"end_shift" | "reminder" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastFocusRef = useRef<HTMLButtonElement | null>(null);

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
            "payroll_number,employee_name,job_site_name,rate_type,time_in,time_out,shift_block_id",
          )
          .eq("work_date", new Date().toISOString().slice(0, 10))
          .order("time_in")
          .limit(100),
      ]);
    setNotifs((n ?? []) as Notification[]);
    setLct((l ?? []) as LCT[]);
    setCounts({ total: total ?? 0, today: today_ct ?? 0 });
    setLastRun(n && n.length ? n[0].sent_at : null);
  }

  useEffect(() => {
    supabase
      .from("shift_blocks")
      .select("id,label,end_time_local,clients")
      .order("end_time_local")
      .then(({ data }) => setBlocks((data ?? []) as ShiftBlock[]));
    refresh();
  }, []);

  // Update the "due now" badge every 30 seconds. No need to tick faster —
  // the warning/clocked windows are minute-level.
  useEffect(() => {
    const id = window.setInterval(() => setCtNow(ctMinutesNow(new Date())), 30000);
    return () => window.clearInterval(id);
  }, []);

  function handleShiftClick(id: number) {
    if (selectedBlockId !== id) {
      setSelectedBlockId(id);
      setExpandedBlockId(null);
    } else if (expandedBlockId !== id) {
      setExpandedBlockId(id);
    } else {
      setExpandedBlockId(null);
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
      const res = await fetch(`${FUNCTIONS_URL}/epay-import`, {
        method: "POST",
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
  const openByBlock: Record<number, number> = {};
  // Total rows-in-file per shift block — drives the detail panel's "X rows" line.
  const rowsByBlock: Record<number, number> = {};
  for (const r of lct) {
    if (r.shift_block_id) {
      rowsByBlock[r.shift_block_id] = (rowsByBlock[r.shift_block_id] ?? 0) + 1;
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
          ? `${lct.length} punches loaded · ${lct.length - closedToday} active · ${closedToday} closed`
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
            value={closedToday + "/" + lct.length}
            changeText={lct.length > 0 ? `${Math.round((closedToday/lct.length)*100)}% resolved` : undefined}
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
            <label className="cursor-pointer bg-blue-1 hover:bg-blue-2 text-white text-[13px] font-semibold px-4 py-2 rounded-md transition-colors disabled:opacity-50">
              {uploading ? "Uploading…" : "Choose .xlsx file"}
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx"
                onChange={handleUpload}
                disabled={uploading}
                className="hidden"
              />
            </label>
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

        {/* ePay reports — shift selection row */}
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
              ePay reports — pick a shift
            </h2>
            <span className="text-[12px] text-text-muted">
              Click once to select · twice to expand
            </span>
          </div>

          <ul className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {visibleBlocks.map((b) => {
              const state: ShiftBoxState =
                expandedBlockId === b.id
                  ? "expanded"
                  : selectedBlockId === b.id
                    ? "selected"
                    : "inactive";
              return (
                <li key={b.id}>
                  <ShiftBox
                    block={b}
                    state={state}
                    onClick={() => handleShiftClick(b.id)}
                  />
                </li>
              );
            })}
          </ul>

          {expandedBlockId !== null &&
            (() => {
              const block = visibleBlocks.find((b) => b.id === expandedBlockId);
              if (!block) return null;
              const rows = rowsByBlock[block.id] ?? 0;
              const punches = openByBlock[block.id] ?? 0;
              return (
                <div className="mt-4">
                  <ShiftDetailPanel
                    block={block}
                    rowsInFile={rows > 0 ? rows : null}
                    punchCount={punches}
                    onOpenActions={(originBtn) => {
                      lastFocusRef.current = originBtn;
                      setActionModal({ block, punchCount: punches });
                    }}
                  />
                </div>
              );
            })()}
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
              No notifications yet.
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

      {actionModal && (
        <ShiftActionModal
          block={actionModal.block}
          punchCount={actionModal.punchCount}
          choice={modalChoice}
          onChoose={setModalChoice}
          onClose={() => {
            setActionModal(null);
            setModalChoice(null);
            lastFocusRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

type ShiftBoxState = "inactive" | "selected" | "expanded";

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M3 7.5L5.5 10L11 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShiftBox({
  block,
  state,
  onClick,
}: {
  block: ShiftBlock;
  state: ShiftBoxState;
  onClick: () => void;
}) {
  const active = state !== "inactive";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-expanded={state === "expanded"}
      className={`w-full text-left border rounded-lg p-3 transition-colors duration-150 ${
        active
          ? "bg-orange-bg border-orange-1 ring-2 ring-orange-1/30 text-text-primary"
          : "bg-bg border-border text-text-muted hover:border-text-muted"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[14px] ${active ? "font-semibold" : "font-medium"}`}>
          {block.label} shift
        </span>
        {active && <CheckIcon className="text-orange-1 shrink-0" />}
      </div>
    </button>
  );
}

function ShiftDetailPanel({
  block,
  rowsInFile,
  punchCount,
  onOpenActions,
}: {
  block: ShiftBlock;
  rowsInFile: number | null;
  punchCount: number;
  onOpenActions: (originBtn: HTMLButtonElement) => void;
}) {
  const hasFile = rowsInFile !== null;
  return (
    <section className="bg-surface border border-orange-1 rounded-xl p-5 space-y-2">
      <div className="text-[16px] font-semibold text-text-primary">
        {block.label} shift e-pay drop expected time
        {/* TODO(epay-drop-time): real expected-time source pending — using end_time_local */}
        <span className="ml-2 tabular text-text-secondary font-normal">
          {block.end_time_local}
        </span>
      </div>
      {hasFile ? (
        <>
          <div className="text-[13px] text-text-secondary">
            Punch report {block.label} shift
          </div>
          <div className="text-[13px] text-text-secondary tabular">
            {rowsInFile} {rowsInFile === 1 ? "row" : "rows"}
          </div>
          <div className="text-[13px] text-text-secondary tabular">
            {punchCount} {punchCount === 1 ? "punch" : "punches"}
          </div>
        </>
      ) : (
        <div className="text-[13px] text-text-muted italic">No file dropped yet</div>
      )}
      <div className="pt-2">
        <button
          type="button"
          onClick={(e) => onOpenActions(e.currentTarget)}
          className="text-[13px] font-semibold px-3 py-1.5 rounded-md border border-orange-1 text-orange-1 hover:bg-orange-bg transition-colors"
        >
          Open actions
        </button>
      </div>
    </section>
  );
}

function ShiftActionModal({
  block,
  punchCount,
  choice,
  onChoose,
  onClose,
}: {
  block: ShiftBlock;
  punchCount: number;
  choice: "end_shift" | "reminder" | null;
  onChoose: (c: "end_shift" | "reminder") => void;
  onClose: () => void;
}) {
  const firstOptionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstOptionRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(15, 23, 42, 0.5)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shift-action-heading"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface rounded-xl shadow-xl border border-border max-w-md w-full">
        <div className="p-5 border-b border-border">
          <h3
            id="shift-action-heading"
            className="text-[16px] font-bold text-text-primary"
          >
            End {block.label} shift
          </h3>
          <p className="text-[13px] text-text-secondary mt-1 tabular">
            You will have {punchCount} {punchCount === 1 ? "punch" : "punches"}.
          </p>
        </div>
        <div className="p-5 grid grid-cols-2 gap-3">
          <button
            ref={firstOptionRef}
            type="button"
            onClick={() => onChoose("end_shift")}
            aria-pressed={choice === "end_shift"}
            className={`text-left border rounded-lg p-3 transition-colors ${
              choice === "end_shift"
                ? "bg-orange-bg border-orange-1 ring-2 ring-orange-1/30"
                : "bg-surface border-border hover:border-orange-1"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-text-primary">
                End shift
              </span>
              {choice === "end_shift" && (
                <CheckIcon className="text-orange-1 shrink-0" />
              )}
            </div>
          </button>
          <button
            type="button"
            onClick={() => onChoose("reminder")}
            aria-pressed={choice === "reminder"}
            className={`text-left border rounded-lg p-3 transition-colors ${
              choice === "reminder"
                ? "bg-orange-bg border-orange-1 ring-2 ring-orange-1/30"
                : "bg-surface border-border hover:border-orange-1"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-text-primary uppercase">
                15-minute reminder
              </span>
              {choice === "reminder" && (
                <CheckIcon className="text-orange-1 shrink-0" />
              )}
            </div>
          </button>
        </div>
        <div className="p-5 border-t border-border flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[13px] font-semibold text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={onClose}
            disabled={!choice}
            className="px-4 py-2 text-[13px] font-semibold rounded-md bg-orange-1 hover:opacity-90 text-white disabled:opacity-50"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
