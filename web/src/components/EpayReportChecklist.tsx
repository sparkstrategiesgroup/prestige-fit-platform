/**
 * ePay reports checklist strip. One chip per expected report for today;
 * ✓ + arrival time when a matching epay_imports row landed in the window,
 * ☐ + expected time otherwise.
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

function fmtTime(t: string | null): string {
  if (!t) return "";
  // Accept "HH:MM:SS" or ISO.
  const d = t.length <= 8 ? new Date(`2000-01-01T${t}`) : new Date(t);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

type Props = { refreshKey?: number };

export function EpayReportChecklist({ refreshKey = 0 }: Props) {
  const [rows, setRows] = useState<Row[]>([]);

  const load = async () => {
    const { data } = await supabase.from("v_epay_reports_today").select("*");
    setRows((data ?? []) as Row[]);
  };

  useEffect(() => {
    load();
    const id = window.setInterval(load, 60_000);
    return () => window.clearInterval(id);
  }, [refreshKey]);

  if (rows.length === 0) return null;

  const received = rows.filter((r) => r.import_id !== null).length;

  return (
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
            const received = r.import_id !== null;
            return (
              <div
                key={r.id}
                title={
                  received
                    ? `${r.filename ?? ""}\n${r.row_count ?? 0} rows · arrived ${fmtTime(r.arrived_at)}`
                    : `Expected ${fmtTime(r.expected_at)} — not yet received`
                }
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[12px] tabular ${
                  received
                    ? "bg-good/10 border-good text-good"
                    : "bg-bg/60 border-border text-text-secondary"
                }`}
              >
                <span className="font-semibold">
                  {received ? "✓" : "☐"}
                </span>
                <span>{fmtTime(r.expected_at)}</span>
                {received && (
                  <span className="text-text-muted">· {fmtTime(r.arrived_at)}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
