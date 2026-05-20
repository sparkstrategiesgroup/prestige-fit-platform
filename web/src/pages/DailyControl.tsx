import { useEffect, useState } from "react";
import { HeaderBar } from "../components/HeaderBar";
import { KpiCard } from "../components/KpiCard";
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

export default function DailyControl() {
  const [blocks, setBlocks] = useState<ShiftBlock[]>([]);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [lct, setLct] = useState<LCT[]>([]);
  const [running, setRunning] = useState<number | null>(null);
  const [counts, setCounts] = useState({ total: 0, today: 0 });
  const [lastRun, setLastRun] = useState<string | null>(null);

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
          .limit(50),
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

  async function run(blockId: number) {
    setRunning(blockId);
    try {
      const res = await fetch(`${FUNCTIONS_URL}/shift-block-runner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shift_block_id: blockId }),
      });
      await res.json();
    } finally {
      setRunning(null);
      refresh();
    }
  }

  const missing = lct.filter((r) => !r.time_out).length;
  const resolved = lct.filter((r) => r.time_out).length;
  const responseRate = counts.today > 0
    ? Math.round((notifs.filter((n) => n.notification_type === "END_OF_SHIFT_CLOCKED_OUT").length / counts.today) * 100)
    : 0;

  return (
    <>
      <HeaderBar
        title="Daily Control"
        subtitle="Track punches and outreach in real time"
        right={lastRun && <span className="tabular">last run · {fmtTime(lastRun)}</span>}
      />

      <main className="max-w-page mx-auto px-5 py-5 space-y-5">
        {/* KPI strip (placeholder version of FIT-006) */}
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
          <KpiCard label="ACTIVE CHECKPOINT" value={blocks[0]?.label ?? "—"} />
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
            changeText={counts.total > counts.today ? `${counts.total} total · all time` : undefined}
          />
          <KpiCard
            label="RESPONSE RATE"
            value={`${responseRate}%`}
            progressPct={responseRate}
            progressTargetPct={85}
          />
        </div>

        {/* Checkpoint timeline (placeholder list version of FIT-007) */}
        <section className="bg-surface border border-border rounded-xl p-5">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted mb-3">
            Today's checkpoints
          </h2>
          <ul className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {blocks.map((b) => (
              <li key={b.id} className="flex flex-col gap-1">
                <button
                  onClick={() => run(b.id)}
                  disabled={running === b.id}
                  className="text-left bg-bg hover:bg-blue-3 border border-border rounded-lg p-3 transition-colors disabled:opacity-50"
                >
                  <div className="text-[13px] font-semibold text-text-primary">
                    {b.label}
                  </div>
                  <div className="text-[11px] text-text-muted">
                    {b.clients.join(" · ")}
                  </div>
                  <div className="text-[11px] text-blue-1 mt-1">
                    {running === b.id ? "Running…" : "Run this checkpoint →"}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Open punches (data behind the eligibility query) */}
        <section className="bg-surface border border-border rounded-xl p-5">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted mb-3">
            Today's punches ({lct.length})
          </h2>
          {lct.length === 0 ? (
            <p className="text-text-muted text-sm py-4">
              No labor_control_tracking rows for today. Use the Settings →
              Imports page to upload the Punches Report (lands in a later
              ticket).
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
                  {lct.map((r) => (
                    <tr
                      key={`${r.payroll_number}-${r.time_in}`}
                      className={!r.time_out ? "bg-warning/5" : ""}
                    >
                      <td className="py-2 pr-3 tabular">{r.payroll_number}</td>
                      <td className="py-2 pr-3">{r.employee_name}</td>
                      <td className="py-2 pr-3">{r.job_site_name}</td>
                      <td className="py-2 pr-3 text-text-muted">
                        {r.rate_type ?? "—"}
                      </td>
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
        </section>

        {/* Latest notifications */}
        <section className="bg-surface border border-border rounded-xl p-5">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted mb-3">
            Responses ({counts.total})
          </h2>
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
                        <span
                          className={
                            n.language === "en"
                              ? "text-blue-1"
                              : "text-warning"
                          }
                        >
                          {n.language}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-[11px] text-text-muted">
                        {n.provider}
                      </td>
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
      </main>
    </>
  );
}
