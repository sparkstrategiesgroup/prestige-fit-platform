/**
 * Data Freshness panel — surfaces the two operational reference files the
 * candidate logic depends on (Schedule Report + Employee Master List) so the
 * ops team can establish a refresh cadence.
 *
 *  ✓ green chip   = last upload within 7 days (FRESH_WINDOW_DAYS)
 *  ⚠ orange chip  = stale, refresh due
 *
 * Click a chip to see the recent upload history for that source.
 *
 * Data sources:
 *   - master_schedule_revision   (Schedule Report uploads)
 *   - employee_master_revision   (Employee Master List uploads)
 *   - schedule_slot / employee   (current row counts)
 */
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const FRESH_WINDOW_DAYS = 7;

type Revision = {
  id: number;
  uploaded_at: string;
  applied_at?: string | null;
  source_filename: string | null;
  notes: string | null;
  // Schedule-report-specific
  slot_count?: number | null;
  status?: string | null;
  // Employee-master-specific
  row_count?: number | null;
};

type SourceState = {
  latest: Revision | null;
  liveCount: number;
  extraCount?: number; // sites OR phone-valid employees
  daysOld: number | null;
  fresh: boolean;
};

function daysBetween(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    month: "numeric", day: "numeric", year: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }) + " CT";
}

export function DataFreshnessPanel() {
  const [schedule, setSchedule] = useState<SourceState | null>(null);
  const [employee, setEmployee] = useState<SourceState | null>(null);
  const [open, setOpen] = useState<"schedule" | "employee" | null>(null);
  const [history, setHistory] = useState<Revision[]>([]);

  useEffect(() => {
    (async () => {
      // Schedule Report — applied revisions only, latest first
      const { data: sched } = await supabase
        .from("master_schedule_revision")
        .select("id, uploaded_at, applied_at, source_filename, notes, slot_count, status")
        .eq("status", "applied")
        .order("applied_at", { ascending: false })
        .limit(1);
      const { count: slotCount } = await supabase
        .from("schedule_slot")
        .select("*", { count: "exact", head: true });
      const { data: siteRows } = await supabase
        .from("schedule_slot")
        .select("site_id");
      const distinctSites = new Set((siteRows ?? []).map((r) => r.site_id)).size;
      const latestSched = (sched ?? [])[0] ?? null;
      const ts = latestSched?.applied_at ?? latestSched?.uploaded_at ?? null;
      const days = ts ? daysBetween(ts) : null;
      setSchedule({
        latest: latestSched,
        liveCount: slotCount ?? 0,
        extraCount: distinctSites,
        daysOld: days,
        fresh: days !== null && days <= FRESH_WINDOW_DAYS,
      });

      // Employee Master List
      const { data: emp } = await supabase
        .from("employee_master_revision")
        .select("id, uploaded_at, source_filename, notes, row_count")
        .order("uploaded_at", { ascending: false })
        .limit(1);
      const { count: empCount } = await supabase
        .from("employee")
        .select("*", { count: "exact", head: true });
      const { count: phoneValid } = await supabase
        .from("employee")
        .select("*", { count: "exact", head: true })
        .eq("phone_valid", true);
      const latestEmp = (emp ?? [])[0] ?? null;
      const empTs = latestEmp?.uploaded_at ?? null;
      const empDays = empTs ? daysBetween(empTs) : null;
      setEmployee({
        latest: latestEmp,
        liveCount: empCount ?? 0,
        extraCount: phoneValid ?? 0,
        daysOld: empDays,
        fresh: empDays !== null && empDays <= FRESH_WINDOW_DAYS,
      });
    })();
  }, []);

  useEffect(() => {
    if (!open) { setHistory([]); return; }
    const table = open === "schedule" ? "master_schedule_revision" : "employee_master_revision";
    const cols = open === "schedule"
      ? "id, uploaded_at, applied_at, source_filename, notes, slot_count, status"
      : "id, uploaded_at, source_filename, notes, row_count";
    supabase
      .from(table)
      .select(cols)
      .order("uploaded_at", { ascending: false })
      .limit(10)
      .then(({ data }) => setHistory((data ?? []) as unknown as Revision[]));
  }, [open]);

  if (!schedule && !employee) return null;

  const Chip = ({
    state, kind, label,
  }: {
    state: SourceState | null;
    kind: "schedule" | "employee";
    label: string;
  }) => {
    if (!state) return null;
    const fresh = state.fresh;
    const className = fresh
      ? "bg-good/10 border-good text-text-primary"
      : "bg-warning/10 border-warning text-warning";
    return (
      <button
        type="button"
        onClick={() => setOpen(kind)}
        title={
          state.latest
            ? `${state.latest.source_filename ?? "(unknown file)"}\nUploaded ${fmtDateTime(state.latest.applied_at ?? state.latest.uploaded_at)}\n${state.latest.notes ?? ""}`
            : "No upload history found"
        }
        className={`flex-1 min-w-[260px] text-left p-3 rounded-lg border transition-colors hover:opacity-90 cursor-pointer ${className}`}
      >
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em]">
          <span className="text-[14px] leading-none">{fresh ? "✓" : "⚠"}</span>
          {label}
        </div>
        <div className="text-[13px] tabular mt-1">
          {state.latest ? (
            <>
              Uploaded {fmtDate(state.latest.applied_at ?? state.latest.uploaded_at)}
              {state.daysOld !== null && (
                <span className="text-text-muted ml-1">
                  ({state.daysOld === 0 ? "today" : `${state.daysOld}d ago`})
                </span>
              )}
            </>
          ) : (
            "No upload recorded"
          )}
        </div>
        <div className="text-[12px] text-text-secondary mt-0.5 tabular">
          <strong className="text-text-primary">{state.liveCount.toLocaleString()}</strong>
          {kind === "schedule" ? " slots" : " employees"}
          {state.extraCount !== undefined && (
            <>
              {" · "}
              <strong className="text-text-primary">{state.extraCount.toLocaleString()}</strong>
              {kind === "schedule" ? " sites" : " with valid phone"}
            </>
          )}
        </div>
        {!fresh && state.latest && (
          <div className="text-[11px] font-semibold mt-1">Refresh due</div>
        )}
      </button>
    );
  };

  return (
    <>
      <section className="bg-surface border border-border rounded-xl p-4">
        <div className="flex items-baseline gap-3 mb-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            Data sources
          </span>
          <span className="text-[11px] text-text-muted">
            refresh window: {FRESH_WINDOW_DAYS} days
          </span>
        </div>
        <div className="flex flex-wrap gap-3">
          <Chip state={schedule} kind="schedule" label="Schedule Report" />
          <Chip state={employee} kind="employee" label="Employee Master List" />
        </div>
      </section>

      {open && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          onClick={() => setOpen(null)}
        >
          <div
            className="bg-surface border border-border rounded-xl shadow-card w-full max-w-3xl max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-border flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                  {open === "schedule" ? "Schedule Report" : "Employee Master List"} — recent uploads
                </div>
                <h2 className="text-[18px] font-bold text-text-primary mt-0.5">
                  Last 10 revisions
                </h2>
              </div>
              <button
                onClick={() => setOpen(null)}
                className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-bg border border-border hover:bg-surface"
              >
                Close
              </button>
            </div>
            <div className="p-5">
              {history.length === 0 ? (
                <p className="text-[13px] text-text-secondary">No upload history found.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] tabular">
                    <thead className="bg-bg text-text-muted uppercase text-[10px] tracking-[0.06em]">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold">Uploaded</th>
                        <th className="text-left px-3 py-2 font-semibold">Filename</th>
                        <th className="text-right px-3 py-2 font-semibold">
                          {open === "schedule" ? "Slots" : "Rows"}
                        </th>
                        {open === "schedule" && (
                          <th className="text-left px-3 py-2 font-semibold">Status</th>
                        )}
                        <th className="text-left px-3 py-2 font-semibold">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {history.map((r) => (
                        <tr key={r.id}>
                          <td className="px-3 py-1.5 text-text-secondary whitespace-nowrap">
                            {fmtDateTime(r.applied_at ?? r.uploaded_at)}
                          </td>
                          <td className="px-3 py-1.5 text-text-primary">
                            {r.source_filename ?? "—"}
                          </td>
                          <td className="px-3 py-1.5 text-right text-text-secondary tabular">
                            {(r.slot_count ?? r.row_count ?? 0).toLocaleString()}
                          </td>
                          {open === "schedule" && (
                            <td className="px-3 py-1.5">
                              <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-good/10 text-good">
                                {r.status ?? "—"}
                              </span>
                            </td>
                          )}
                          <td className="px-3 py-1.5 text-text-secondary">{r.notes ?? "—"}</td>
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
