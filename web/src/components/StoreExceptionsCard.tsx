/* -------------------------------------------------------------------------- */
/* StoreExceptionsCard — today's active store exceptions + bulk EXCEPTIONS    */
/* FORM. Field teams paste a list of store numbers + pick a reason; each row  */
/* becomes a store_exception honored by fn_candidates_for_shift_block.       */
/* Used inline on Labor Control Tracking and standalone at /exceptions-form. */
/* -------------------------------------------------------------------------- */
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

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

type EditDraft = {
  site_id: string;
  exception_date: string;
  note: string;
  source: string;
  reporter: string;
};

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

// Captured timestamp the operator sees, split into two narrow columns.
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "2-digit",
    day: "2-digit",
  });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

export function StoreExceptionsCard({
  onChange,
  standalone = false,
  fullHistory = false,
}: {
  onChange: () => void;
  /** When true (e.g. /exceptions-form), the card opens with the form ready. */
  standalone?: boolean;
  /** When true (e.g. /reports), load every record ever logged - drop the
   * today + active filters and hide the bulk-paste form. */
  fullHistory?: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState<StoreException[]>([]);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<"site_id" | "job_site_name" | "note" | "reporter" | "source" | "created_at">(fullHistory ? "created_at" : "site_id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(fullHistory ? "desc" : "asc");
  const toggleSort = (k: typeof sortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("asc"); }
  };
  const sortArrow = (k: typeof sortKey) => k === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  const [open, setOpen] = useState(standalone || fullHistory);
  const [showAdd, setShowAdd] = useState(standalone && !fullHistory);
  const [bulkRows, setBulkRows] = useState<BulkExceptionRow[]>(() =>
    Array.from({ length: 15 }, blankBulkRow),
  );
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [source, setSource] = useState("fit");
  const [reporter, setReporter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [siteNames, setSiteNames] = useState<Map<string, string>>(new Map());

  const siteNameFor = (raw: string): string | null => {
    const code = raw.trim().toUpperCase();
    if (!code) return null;
    return siteNames.get(code) ?? null;
  };

  // Default: today + upcoming active exceptions. With fullHistory the
  // /reports view loads every record ever logged (cap 1000, newest first).
  const load = async () => {
    const base = supabase.from("store_exception").select("*");
    const query = fullHistory
      ? base.order("created_at", { ascending: false }).limit(1000)
      : base
          .gte("exception_date", today)
          .eq("active", true)
          .order("exception_date", { ascending: true })
          .order("created_at", { ascending: false });
    const { data } = await query;
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
    // Cache every site's id → name once so the bulk form can auto-fill the
    // Job site name column as the operator types/pastes a code.
    (async () => {
      const { data } = await supabase.from("site").select("site_id, site_name");
      if (data) setSiteNames(new Map(data.map((s) => [s.site_id, s.site_name])));
    })();
  }, []);

  const reset = () => {
    setBulkRows(Array.from({ length: 15 }, blankBulkRow));
    setEffectiveDate(today);
    setSource("fit");
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
    if (!reporter.trim()) {
      setError("Reporter is required");
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
        exception_date: effectiveDate,
        exception_type: "other",
        note: reasonLabel,
        source,
        reporter: reporter.trim(),
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

  const beginEdit = (row: StoreException) => {
    setEditingId(row.id);
    setEditDraft({
      site_id: row.site_id,
      exception_date: row.exception_date,
      note: row.note ?? "",
      source: row.source,
      reporter: row.reporter ?? "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft(null);
  };

  const saveEdit = async (row: StoreException) => {
    if (!editDraft) return;
    const patch = {
      site_id: editDraft.site_id.trim().toUpperCase(),
      exception_date: editDraft.exception_date,
      note: editDraft.note.trim() || null,
      source: editDraft.source,
      reporter: editDraft.reporter.trim() || null,
    };
    await supabase.from("store_exception").update(patch).eq("id", row.id);
    cancelEdit();
    await load();
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
              {fullHistory ? "logged (all time)" : "active today"}
            </span>
          </h2>
          <p className="text-[13px] text-text-secondary mt-1">
            {fullHistory
              ? "Every exception ever logged. Sort, filter, edit, or delete from this view."
              : "Field-team notes that exclude a site from end-of-shift texting (closures, reduced staffing, \"do not text\")."}
          </p>
        </div>
        <span className="text-text-muted text-[12px]">{open ? "Hide ▴" : "Show ▾"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          {!fullHistory && (
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
          )}

          {showAdd && !fullHistory && (
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
                    <tr className="bg-yellow-100">
                      <th className="border border-border px-2 py-1 font-semibold text-text-primary text-left w-[140px]">Store #</th>
                      <th className="border border-border px-2 py-1 font-semibold text-text-primary text-left">Job site name</th>
                      <th className="border border-border px-2 py-1 font-semibold text-text-primary text-left w-[180px]">Reason</th>
                      <th className="border border-border px-2 py-1 font-semibold text-text-primary text-left w-[200px]">Other (if selected)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map((r, i) => {
                      const resolvedName = siteNameFor(r.store);
                      return (
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
                        <td className="border border-border px-2 py-1 text-[12px] text-text-secondary">
                          {resolvedName ?? (r.store.trim() ? <span className="text-danger">Unknown store</span> : "")}
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
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-3 pt-2">
                <label className="text-[12px] font-semibold text-text-secondary">
                  Effective date
                  <input
                    type="date"
                    value={effectiveDate}
                    min={today}
                    onChange={(e) => setEffectiveDate(e.target.value)}
                    className="mt-1 w-full border border-border rounded px-3 py-1.5 text-[13px] bg-surface"
                  />
                </label>
                <label className="text-[12px] font-semibold text-text-secondary">
                  Reporter <span className="text-danger">*</span>
                  <input
                    type="text"
                    value={reporter}
                    onChange={(e) => setReporter(e.target.value)}
                    placeholder="Who told us? e.g. 'Store mgr Maria'"
                    required
                    className="mt-1 w-full border border-border rounded px-3 py-1.5 text-[13px] bg-yellow-50"
                  />
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

          {rows.length > 0 && (() => {
            const q = filter.trim().toUpperCase();
            const filtered = q
              ? rows.filter((r) =>
                  r.site_id.toUpperCase().includes(q)
                  || (r.job_site_name ?? "").toUpperCase().includes(q))
              : rows;
            const sortVal = (r: StoreException) => {
              switch (sortKey) {
                case "site_id":        return r.site_id;
                case "job_site_name":  return (r.job_site_name ?? "").toLowerCase();
                case "note":           return (r.note ?? "").toLowerCase();
                case "reporter":       return (r.reporter ?? "").toLowerCase();
                case "source":         return r.source;
                case "created_at":     return r.created_at;
              }
            };
            const displayed = [...filtered].sort((a, b) => {
              const av = sortVal(a), bv = sortVal(b);
              if (av < bv) return sortDir === "asc" ? -1 : 1;
              if (av > bv) return sortDir === "asc" ? 1 : -1;
              return 0;
            });
            const headerCls = "text-left px-3 py-2 font-semibold cursor-pointer select-none hover:text-text-primary";
            return (
            <>
            <div className="flex items-center gap-2 pb-2">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by Job site ID or name…"
                className="w-full max-w-sm border border-border rounded px-3 py-1.5 text-[12px] bg-surface"
              />
              {filter && (
                <button onClick={() => setFilter("")} className="text-[11px] text-text-secondary hover:text-text-primary">
                  Clear
                </button>
              )}
              <span className="text-[11px] text-text-muted ml-auto">{displayed.length} of {rows.length}</span>
            </div>
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-[12px] tabular">
                <thead className="bg-bg text-text-muted uppercase text-[10px] tracking-[0.06em]">
                  <tr>
                    <th onClick={() => toggleSort("site_id")} className={headerCls + " w-[110px]"}>Job&nbsp;site&nbsp;ID{sortArrow("site_id")}</th>
                    <th onClick={() => toggleSort("job_site_name")} className={headerCls}>Job&nbsp;site&nbsp;name{sortArrow("job_site_name")}</th>
                    <th onClick={() => toggleSort("note")} className={headerCls + " w-[190px]"}>Reason{sortArrow("note")}</th>
                    <th onClick={() => toggleSort("reporter")} className={headerCls + " w-[190px]"}>Reporter{sortArrow("reporter")}</th>
                    <th onClick={() => toggleSort("created_at")} className={headerCls + " w-[80px]"}>Date{sortArrow("created_at")}</th>
                    <th onClick={() => toggleSort("created_at")} className={headerCls + " w-[100px]"}>Time{sortArrow("created_at")}</th>
                    <th className="px-3 py-2 w-[120px]"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {displayed.map((r) => {
                    const isEditing = editingId === r.id && editDraft;
                    if (isEditing) {
                      return (
                        <tr key={r.id} className="bg-yellow-50">
                          <td className="px-3 py-1.5">
                            <input
                              type="text"
                              value={editDraft.site_id}
                              onChange={(e) => setEditDraft({ ...editDraft, site_id: e.target.value })}
                              className="border border-border rounded px-2 py-0.5 text-[12px] tabular font-semibold uppercase bg-surface w-full"
                            />
                          </td>
                          <td className="px-3 py-1.5 text-text-secondary">
                            {siteNameFor(editDraft.site_id) ?? r.job_site_name ?? "—"}
                          </td>
                          <td className="px-3 py-1.5">
                            {EXCEPTION_REASONS.includes(editDraft.note) ? (
                              <select
                                value={editDraft.note}
                                onChange={(e) => setEditDraft({ ...editDraft, note: e.target.value })}
                                className="border border-border rounded px-2 py-0.5 text-[12px] bg-surface w-full"
                              >
                                {EXCEPTION_REASONS.map((t) => (
                                  <option key={t} value={t}>{t}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={editDraft.note}
                                onChange={(e) => setEditDraft({ ...editDraft, note: e.target.value })}
                                className="border border-border rounded px-2 py-0.5 text-[12px] bg-surface w-full"
                              />
                            )}
                          </td>
                          <td className="px-3 py-1.5">
                            <input
                              type="text"
                              value={editDraft.reporter}
                              onChange={(e) => setEditDraft({ ...editDraft, reporter: e.target.value })}
                              className="border border-border rounded px-2 py-0.5 text-[12px] bg-surface w-full"
                            />
                          </td>
                          <td className="px-3 py-1.5 text-text-secondary tabular whitespace-nowrap">{fmtDate(r.created_at)}</td>
                          <td className="px-3 py-1.5 text-text-secondary tabular whitespace-nowrap">{fmtTime(r.created_at)}</td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            <button
                              onClick={() => saveEdit(r)}
                              className="text-[11px] font-semibold text-blue-1 hover:underline mr-2"
                            >
                              Save
                            </button>
                            <button
                              onClick={cancelEdit}
                              className="text-[11px] text-text-secondary hover:underline"
                            >
                              Cancel
                            </button>
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={r.id}>
                        <td className="px-3 py-1.5 font-semibold text-text-primary">{r.site_id}</td>
                        <td className="px-3 py-1.5 text-text-secondary">{r.job_site_name ?? "—"}</td>
                        <td className="px-3 py-1.5 text-text-primary">{r.note ?? "—"}</td>
                        <td className="px-3 py-1.5 text-text-secondary">{r.reporter ?? "—"}</td>
                        <td className="px-3 py-1.5 text-text-secondary tabular whitespace-nowrap">{fmtDate(r.created_at)}</td>
                        <td className="px-3 py-1.5 text-text-secondary tabular whitespace-nowrap">{fmtTime(r.created_at)}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          <button
                            onClick={() => beginEdit(r)}
                            className="text-[11px] font-semibold text-blue-1 hover:underline mr-2"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => remove(r)}
                            className="text-[11px] text-danger hover:underline"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
            );
          })()}
        </div>
      )}
    </section>
  );
}
