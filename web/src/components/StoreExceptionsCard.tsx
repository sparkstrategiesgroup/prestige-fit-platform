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

export function StoreExceptionsCard({
  onChange,
  standalone = false,
}: {
  onChange: () => void;
  /** When true (e.g. /exceptions-form), the card opens with the form ready. */
  standalone?: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState<StoreException[]>([]);
  const [open, setOpen] = useState(standalone);
  const [showAdd, setShowAdd] = useState(standalone);
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
