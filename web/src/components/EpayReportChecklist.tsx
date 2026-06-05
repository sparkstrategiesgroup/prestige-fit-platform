/**
 * ePay reports checklist strip. One chip per expected report for today;
 * ✓ + arrival time when a matching epay_imports row landed in the window,
 * ☐ + expected time otherwise. Click a chip to see the report details.
 *
 * Data source: v_epay_reports_today view. Refreshes whenever the parent
 * calls refresh() (after a punches upload) plus every 60s passively.
 */
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Row = {
  id: number;
  label: string;
  expected_at: string;       // "09:00:00"
  import_id: number | null;
  arrived_at: string | null; // ISO
  filename: string | null;
  row_count: number | null;
};

type ImportPunch = {
  payroll_number: string;
  employee_name: string;
  job_site_name: string;
  rate_type: string | null;
  time_in: string | null;
  time_out: string | null;
};

function fmtTime(t: string | null): string {
  if (!t) return "";
  // expected_at is a local time-of-day ("HH:MM:SS"). Render it as-is, no TZ
  // conversion — it's already in Central. arrived_at is full ISO → convert to CT.
  if (t.length <= 8) {
    const [hh, mm] = t.split(":");
    const h = parseInt(hh, 10);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${mm} ${ampm}`;
  }
  return new Date(t).toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

type Props = { refreshKey?: number };

export function EpayReportChecklist({ refreshKey = 0 }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<Row | null>(null);
  const [punches, setPunches] = useState<ImportPunch[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    const { data } = await supabase.from("v_epay_reports_today").select("*");
    setRows((data ?? []) as Row[]);
  };

  useEffect(() => {
    load();
    const id = window.setInterval(load, 60_000);
    return () => window.clearInterval(id);
  }, [refreshKey]);

  useEffect(() => {
    if (!open || open.import_id === null) {
      setPunches(null);
      return;
    }
    setLoading(true);
    supabase
      .from("labor_control_tracking")
      .select("payroll_number, employee_name, job_site_name, rate_type, time_in, time_out")
      .eq("epay_import_id", open.import_id)
      .order("time_in")
      .limit(2000)
      .then(({ data }) => {
        setPunches((data ?? []) as ImportPunch[]);
        setLoading(false);
      });
  }, [open]);

  if (rows.length === 0) return null;

  const received = rows.filter((r) => r.import_id !== null).length;

  return (
    <>
      <section className="bg-surface border border-border rounded-xl p-4">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            ePay reports today
          </span>
          <span className="text-[12px] text-text-secondary tabular">
            <strong className="text-text-primary">{received}</strong> of {rows.length} received
          </span>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            {rows.map((r) => {
              const got = r.import_id !== null;
              return (
                <button
                  key={r.id}
                  onClick={() => setOpen(r)}
                  title={
                    got
                      ? `${r.filename ?? ""}\n${r.row_count ?? 0} rows · arrived ${fmtTime(r.arrived_at)} CT (ePay drops at ${fmtTime(r.expected_at)} CT)`
                      : `Expected ePay drop at ${fmtTime(r.expected_at)} CT — not yet received`
                  }
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[12px] tabular cursor-pointer hover:opacity-80 transition-opacity uppercase ${
                    got
                      ? "bg-warning/15 border-warning text-warning"
                      : "bg-bg/60 border-border text-text-secondary"
                  }`}
                >
                  <span className="font-semibold">{got ? "✓" : "☐"}</span>
                  <span>{r.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {open && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          onClick={() => setOpen(null)}
        >
          <div
            className="bg-surface border border-border rounded-xl shadow-card w-full max-w-5xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-border flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                  {open.label} · ePay drop expected {fmtTime(open.expected_at)} CT
                </div>
                <h2 className="text-[18px] font-bold text-text-primary mt-0.5">
                  {open.import_id === null
                    ? `Not yet received — expected at ${fmtTime(open.expected_at)} CT`
                    : open.filename ?? "(no filename)"}
                </h2>
                {open.import_id !== null && (
                  <div className="text-[12px] text-text-secondary mt-1 tabular">
                    Arrived {fmtTime(open.arrived_at)} CT ·{" "}
                    <strong className="text-text-primary">{open.row_count ?? 0}</strong> rows in file
                    {punches !== null && (
                      <>
                        {" · "}
                        <strong className="text-text-primary">{punches.length}</strong> punches
                      </>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={() => setOpen(null)}
                className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-bg border border-border hover:bg-surface"
              >
                Close
              </button>
            </div>
            <div className="p-5">
              {open.import_id === null ? (
                <p className="text-[13px] text-text-secondary">
                  ePay hasn't sent this report yet. The runner watches a ±90 min /
                  +120 min window around {fmtTime(open.expected_at)} and will flip
                  this chip to ✓ as soon as a matching email lands.
                </p>
              ) : loading ? (
                <p className="text-[13px] text-text-secondary">Loading punches…</p>
              ) : !punches || punches.length === 0 ? (
                <p className="text-[13px] text-text-secondary">
                  This import landed but no labor_control_tracking rows reference it.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] tabular">
                    <thead className="bg-bg text-text-muted uppercase text-[10px] tracking-[0.06em]">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold">Jobsite</th>
                        <th className="text-left px-3 py-2 font-semibold">Payroll ID</th>
                        <th className="text-left px-3 py-2 font-semibold">Employee</th>
                        <th className="text-left px-3 py-2 font-semibold">Rate</th>
                        <th className="text-right px-3 py-2 font-semibold">Time In</th>
                        <th className="text-right px-3 py-2 font-semibold">Time Out</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {punches.map((p, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5 text-text-primary">{p.job_site_name}</td>
                          <td className="px-3 py-1.5 text-text-secondary">{p.payroll_number}</td>
                          <td className="px-3 py-1.5 text-text-primary">{p.employee_name}</td>
                          <td className="px-3 py-1.5">
                            {p.rate_type ? (
                              <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-bg text-text-secondary border border-border">
                                {p.rate_type}
                              </span>
                            ) : (
                              <span className="text-text-muted">—</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right text-text-secondary">
                            {p.time_in
                              ? new Date(p.time_in).toLocaleTimeString("en-US", {
                                  timeZone: "America/Chicago",
                                  hour: "numeric", minute: "2-digit", hour12: true,
                                })
                              : "—"}
                          </td>
                          <td className="px-3 py-1.5 text-right text-text-secondary">
                            {p.time_out
                              ? new Date(p.time_out).toLocaleTimeString("en-US", {
                                  timeZone: "America/Chicago",
                                  hour: "numeric", minute: "2-digit", hour12: true,
                                })
                              : "—"}
                          </td>
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
