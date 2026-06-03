import { useEffect, useRef, useState } from "react";
import { HeaderBar } from "../components/HeaderBar";
import { supabase } from "../lib/supabase";

const FUNCTIONS_URL = `${
  import.meta.env.VITE_SUPABASE_URL ?? "https://sshhcpzleurztzksrlvr.supabase.co"
}/functions/v1`;

type SubTab = "schedule" | "awr" | "budget";

type Revision = {
  id: number;
  uploaded_at: string;
  source_filename: string | null;
  status: "pending" | "applied" | "rejected";
  slot_count: number;
  slots_added: number;
  slots_modified: number;
  slots_removed: number;
  slots_unchanged: number;
};

type Change = {
  id: number;
  change_type: "add" | "modify" | "remove";
  site_id: string;
  slot_natural_key: string;
  new_payload: Record<string, unknown> | null;
  old_payload: Record<string, unknown> | null;
};

type AwrImport = {
  id: number;
  wk_end: string | null;
  uploaded_at: string;
  source_filename: string | null;
  row_count: number;
  unique_employees: number;
  unique_sites: number;
  status: string;
};

type BudgetRow = {
  job_number: string;
  effective_date: string;
  description: string;
  hours_type_id: number | null;
  hours_sun: string;
  hours_mon: string;
  hours_tue: string;
  hours_wed: string;
  hours_thu: string;
  hours_fri: string;
  hours_sat: string;
  hours_holiday: string;
  pay_rate: string | null;
  bill_rate: string | null;
  for_salaried_employee: boolean;
};

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }) + " CT";
}

function fmtMoney(v: string | null) {
  if (v == null) return "—";
  const n = parseFloat(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}

export default function Scheduling() {
  const [tab, setTab] = useState<SubTab>("schedule");
  return (
    <>
      <HeaderBar
        title="Scheduling"
        subtitle="Master Schedule, AWR imports, and the WinTeam Budget export"
      />
      <main className="max-w-page mx-auto px-5 py-5">
        <div role="tablist" className="flex gap-1 border-b border-border mb-4">
          {([
            { id: "schedule", label: "Master Schedule" },
            { id: "awr",      label: "AWR Imports" },
            { id: "budget",   label: "WinTeam Budget Export" },
          ] as { id: SubTab; label: string }[]).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors ${
                tab === t.id
                  ? "border-blue-1 text-blue-1"
                  : "border-transparent text-text-secondary hover:text-text-primary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "schedule" && <MasterScheduleTab />}
        {tab === "awr"      && <AwrTab />}
        {tab === "budget"   && <BudgetTab />}
      </main>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Master Schedule tab                                                        */
/* -------------------------------------------------------------------------- */

function MasterScheduleTab() {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selected, setSelected] = useState<Revision | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const { data } = await supabase
      .from("master_schedule_revision")
      .select("*")
      .order("id", { ascending: false })
      .limit(20);
    setRevisions((data ?? []) as Revision[]);
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!selected) {
      setChanges([]);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from("master_schedule_change")
        .select("id, change_type, site_id, slot_natural_key, new_payload, old_payload")
        .eq("revision_id", selected.id)
        .order("change_type", { ascending: true })
        .order("site_id", { ascending: true })
        .limit(500);
      setChanges((data ?? []) as Change[]);
    })();
  }, [selected]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setStatus(`Uploading ${file.name}…`);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${FUNCTIONS_URL}/master-schedule-import`, {
        method: "POST",
        body: fd,
      });
      const body = await res.json();
      if (!res.ok) {
        setStatus(`Failed: ${JSON.stringify(body)}`);
      } else {
        setStatus(
          `Revision ${body.revision_id}: ${body.added} added, ${body.modified} modified, ${body.removed} removed, ${body.unchanged} unchanged. Sites created: ${body.sites_created}.`,
        );
        load();
      }
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const applyRevision = async (rev: Revision) => {
    setStatus(`Applying revision ${rev.id}…`);
    try {
      const res = await fetch(`${FUNCTIONS_URL}/master-schedule-apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision_id: rev.id }),
      });
      const body = await res.json();
      if (!res.ok) {
        setStatus(`Apply failed: ${JSON.stringify(body)}`);
      } else {
        setStatus(`Applied: +${body.added} ~${body.modified} -${body.removed}`);
        setSelected(null);
        load();
      }
    } catch (err) {
      setStatus(`Apply failed: ${(err as Error).message}`);
    }
  };

  const rejectRevision = async (rev: Revision) => {
    if (!confirm(`Reject revision ${rev.id}? This deletes all pending changes for it.`)) return;
    await supabase.from("master_schedule_change").delete().eq("revision_id", rev.id);
    await supabase
      .from("master_schedule_revision")
      .update({ status: "rejected", rejected_at: new Date().toISOString() })
      .eq("id", rev.id);
    setSelected(null);
    load();
  };

  return (
    <section className="grid gap-4">
      <div className="bg-surface border border-border rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            Upload Master Schedule List
          </h2>
          <p className="text-[13px] text-text-secondary mt-1">
            Drop the .xlsx straight from Excel. We'll diff it against the current
            schedule and queue the changes for review.
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

      {status && (
        <div className="text-[13px] text-text-secondary px-2">{status}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,2fr] gap-4">
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="p-3 border-b border-border text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            Recent uploads
          </div>
          <ul className="divide-y divide-border max-h-[600px] overflow-auto">
            {revisions.length === 0 && (
              <li className="p-4 text-[13px] text-text-secondary">No uploads yet.</li>
            )}
            {revisions.map((r) => (
              <li
                key={r.id}
                className={`p-3 cursor-pointer hover:bg-bg ${
                  selected?.id === r.id ? "bg-bg" : ""
                }`}
                onClick={() => setSelected(r)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold tabular">#{r.id}</span>
                  <span
                    className={`text-[11px] uppercase font-semibold px-2 py-0.5 rounded ${
                      r.status === "applied"
                        ? "bg-green-100 text-green-800"
                        : r.status === "rejected"
                          ? "bg-red-100 text-red-800"
                          : "bg-yellow-100 text-yellow-800"
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
                <div className="text-[11px] text-text-muted mt-0.5 truncate">
                  {r.source_filename ?? "—"} · {fmtDateTime(r.uploaded_at)}
                </div>
                <div className="text-[12px] text-text-secondary tabular mt-1">
                  +{r.slots_added} ~{r.slots_modified} -{r.slots_removed} · {r.slots_unchanged} unchanged
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="p-3 border-b border-border flex items-center justify-between">
            <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
              {selected ? `Revision ${selected.id} diff` : "Select a revision"}
            </span>
            {selected?.status === "pending" && (
              <div className="flex gap-2">
                <button
                  onClick={() => rejectRevision(selected)}
                  className="text-[12px] font-semibold px-3 py-1 rounded border border-border hover:bg-bg"
                >
                  Reject
                </button>
                <button
                  onClick={() => applyRevision(selected)}
                  className="text-[12px] font-semibold px-3 py-1 rounded bg-blue-1 text-white hover:bg-blue-2"
                >
                  Approve & apply
                </button>
              </div>
            )}
          </div>

          {!selected && (
            <div className="p-6 text-[13px] text-text-secondary">
              Click an upload on the left to review what would change.
            </div>
          )}

          {selected && changes.length === 0 && (
            <div className="p-6 text-[13px] text-text-secondary">
              No change rows for this revision.
            </div>
          )}

          {selected && changes.length > 0 && (
            <div className="max-h-[600px] overflow-auto">
              <table className="w-full text-[12px] tabular">
                <thead className="bg-bg text-text-muted uppercase text-[10px] tracking-[0.06em]">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Action</th>
                    <th className="text-left px-3 py-2 font-semibold">Site</th>
                    <th className="text-left px-3 py-2 font-semibold">Slot</th>
                    <th className="text-left px-3 py-2 font-semibold">Days</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {changes.map((c) => {
                    const payload = c.new_payload ?? c.old_payload ?? {};
                    const dow = Array.isArray(payload.days_of_week)
                      ? (payload.days_of_week as boolean[])
                          .map((b, i) => (b ? "SMTWTFS"[i] : ""))
                          .join("")
                      : "—";
                    return (
                      <tr key={c.id}>
                        <td className="px-3 py-1.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] uppercase font-semibold ${
                              c.change_type === "add"
                                ? "bg-green-100 text-green-800"
                                : c.change_type === "modify"
                                  ? "bg-yellow-100 text-yellow-800"
                                  : "bg-red-100 text-red-800"
                            }`}
                          >
                            {c.change_type}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 font-semibold">{c.site_id}</td>
                        <td className="px-3 py-1.5 text-text-secondary">
                          {String(payload.start_time ?? "—")} → {String(payload.end_time ?? "—")}
                        </td>
                        <td className="px-3 py-1.5 text-text-secondary">{dow}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* AWR tab                                                                    */
/* -------------------------------------------------------------------------- */

function AwrTab() {
  const [imports, setImports] = useState<AwrImport[]>([]);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const { data } = await supabase
      .from("awr_import")
      .select("*")
      .order("id", { ascending: false })
      .limit(20);
    setImports((data ?? []) as AwrImport[]);
  };

  useEffect(() => {
    load();
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setStatus(`Uploading ${file.name} (this can take ~60s for a full AWR)…`);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${FUNCTIONS_URL}/awr-import`, {
        method: "POST",
        body: fd,
      });
      const body = await res.json();
      if (!res.ok) {
        setStatus(`Failed: ${JSON.stringify(body)}`);
      } else {
        setStatus(
          `Import ${body.import_id}: ${body.rows_inserted}/${body.rows_parsed} rows, ${body.unique_employees} employees, ${body.unique_sites} sites. ${body.employees_updated} employee payroll rows refreshed.`,
        );
        load();
      }
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <section className="grid gap-4">
      <div className="bg-surface border border-border rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            Upload AWR & OT Report
          </h2>
          <p className="text-[13px] text-text-secondary mt-1">
            Drop the weekly AWR .xlsx. We'll bulk-load the Data sheet and
            refresh employee.pay_rate + winteam_classification from the latest
            week's rows.
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

      {status && (
        <div className="text-[13px] text-text-secondary px-2">{status}</div>
      )}

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="p-3 border-b border-border text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
          Import history
        </div>
        {imports.length === 0 ? (
          <div className="p-6 text-[13px] text-text-secondary">No AWR imports yet.</div>
        ) : (
          <table className="w-full text-[13px] tabular">
            <thead className="bg-bg text-text-muted uppercase text-[10px] tracking-[0.06em]">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">#</th>
                <th className="text-left px-3 py-2 font-semibold">Wk End</th>
                <th className="text-left px-3 py-2 font-semibold">Uploaded</th>
                <th className="text-left px-3 py-2 font-semibold">File</th>
                <th className="text-right px-3 py-2 font-semibold">Rows</th>
                <th className="text-right px-3 py-2 font-semibold">Employees</th>
                <th className="text-right px-3 py-2 font-semibold">Sites</th>
                <th className="text-left px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {imports.map((i) => (
                <tr key={i.id}>
                  <td className="px-3 py-1.5 font-semibold">{i.id}</td>
                  <td className="px-3 py-1.5">{i.wk_end ?? "—"}</td>
                  <td className="px-3 py-1.5 text-text-secondary">{fmtDateTime(i.uploaded_at)}</td>
                  <td className="px-3 py-1.5 text-text-secondary truncate max-w-[300px]">
                    {i.source_filename ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right">{i.row_count}</td>
                  <td className="px-3 py-1.5 text-right">{i.unique_employees}</td>
                  <td className="px-3 py-1.5 text-right">{i.unique_sites}</td>
                  <td className="px-3 py-1.5">
                    <span
                      className={`text-[11px] uppercase font-semibold px-2 py-0.5 rounded ${
                        i.status === "succeeded"
                          ? "bg-green-100 text-green-800"
                          : i.status === "failed"
                            ? "bg-red-100 text-red-800"
                            : "bg-yellow-100 text-yellow-800"
                      }`}
                    >
                      {i.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Budget Export tab                                                          */
/* -------------------------------------------------------------------------- */

function BudgetTab() {
  const todayISO = new Date().toISOString().slice(0, 10);
  const [effDate, setEffDate] = useState<string>(todayISO);
  const [rows, setRows] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("");

  const preview = async () => {
    setLoading(true);
    setStatus("");
    try {
      const { data, error } = await supabase.rpc("fn_wt_budget_export", {
        p_effective_date: effDate,
      });
      if (error) throw error;
      setRows((data ?? []) as BudgetRow[]);
      setStatus(`${(data ?? []).length} budget rows.`);
    } catch (err) {
      setStatus(`Preview failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    preview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effDate]);

  return (
    <section className="grid gap-4">
      <div className="bg-surface border border-border rounded-lg p-4 flex items-center gap-4 flex-wrap">
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            WinTeam Budget Export
          </h2>
          <p className="text-[13px] text-text-secondary mt-1">
            Pivots the current Master Schedule into the WinTeam Budget Template
            shape. PayRate is the hours-weighted average from the latest AWR per
            (site, classification). BillRate from contract_bill_rate when populated.
            Subcontract Labor excluded.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-[13px] text-text-secondary">
            EffectiveDate
          </label>
          <input
            type="date"
            value={effDate}
            onChange={(e) => setEffDate(e.target.value)}
            className="border border-border rounded px-2 py-1 text-[13px] tabular"
          />
          <a
            href={`${FUNCTIONS_URL}/wt-budget-export?effective_date=${effDate}`}
            className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-blue-1 text-white hover:bg-blue-2"
            target="_blank"
            rel="noreferrer"
          >
            Download CSV
          </a>
        </div>
      </div>

      {status && (
        <div className="text-[13px] text-text-secondary px-2">{status}</div>
      )}

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="p-3 border-b border-border text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
          Preview ({rows.length})
        </div>
        {loading ? (
          <div className="p-6 text-[13px] text-text-secondary">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-[13px] text-text-secondary">
            No budget rows. Upload a Master Schedule and an AWR first.
          </div>
        ) : (
          <div className="max-h-[640px] overflow-auto">
            <table className="w-full text-[12px] tabular">
              <thead className="bg-bg text-text-muted uppercase text-[10px] tracking-[0.06em] sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">JobNumber</th>
                  <th className="text-left px-3 py-2 font-semibold">Description</th>
                  <th className="text-right px-2 py-2 font-semibold">HTID</th>
                  <th className="text-right px-2 py-2 font-semibold">Sun</th>
                  <th className="text-right px-2 py-2 font-semibold">Mon</th>
                  <th className="text-right px-2 py-2 font-semibold">Tue</th>
                  <th className="text-right px-2 py-2 font-semibold">Wed</th>
                  <th className="text-right px-2 py-2 font-semibold">Thu</th>
                  <th className="text-right px-2 py-2 font-semibold">Fri</th>
                  <th className="text-right px-2 py-2 font-semibold">Sat</th>
                  <th className="text-right px-2 py-2 font-semibold">Hol</th>
                  <th className="text-right px-3 py-2 font-semibold">PayRate</th>
                  <th className="text-right px-3 py-2 font-semibold">BillRate</th>
                  <th className="text-center px-2 py-2 font-semibold">Sal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r, i) => (
                  <tr key={`${r.job_number}-${r.description}-${i}`}>
                    <td className="px-3 py-1 font-semibold">{r.job_number}</td>
                    <td className="px-3 py-1">{r.description}</td>
                    <td className="px-2 py-1 text-right text-text-secondary">{r.hours_type_id ?? "—"}</td>
                    <td className="px-2 py-1 text-right">{parseFloat(r.hours_sun).toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{parseFloat(r.hours_mon).toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{parseFloat(r.hours_tue).toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{parseFloat(r.hours_wed).toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{parseFloat(r.hours_thu).toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{parseFloat(r.hours_fri).toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{parseFloat(r.hours_sat).toFixed(1)}</td>
                    <td className="px-2 py-1 text-right text-text-muted">{parseFloat(r.hours_holiday).toFixed(1)}</td>
                    <td className="px-3 py-1 text-right">{fmtMoney(r.pay_rate)}</td>
                    <td className="px-3 py-1 text-right">{fmtMoney(r.bill_rate)}</td>
                    <td className="px-2 py-1 text-center text-text-muted">
                      {r.for_salaried_employee ? "Yes" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
