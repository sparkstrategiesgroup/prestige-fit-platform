/**
 * Shift Change Request card — companion to StoreExceptionsCard.
 *
 * Captures supervisor-submitted shift changes ("Joe's Tuesday shift moves
 * from 7am to 8am at T0067") phoned/texted in throughout the day. Each
 * submission becomes a pending master_schedule_revision with one
 * master_schedule_change of type 'add'. Ops admin approves it from the
 * Scheduling tab and the SQL function applies it to schedule_slot.
 *
 * The form is intentionally minimal — Site ID, role, start/end, days,
 * effective date, note, reporter, source. Adjustments and tolerances
 * default to NULL and can be edited per-site later if needed.
 */
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Revision = {
  id: number;
  uploaded_at: string;
  source_filename: string | null;
  status: "pending" | "applied" | "rejected";
  slot_count: number;
  slots_added: number;
  slots_modified: number;
  slots_removed: number;
  notes: string | null;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const LABOR_TYPES = [
  "Custodian",
  "Lead Custodian",
  "Porter",
  "Floater",
  "Facilities Supervisor",
  "Project Tech",
];

const MANUAL_TAG = "manual: shift change";

export function ShiftChangeRequestCard() {
  const today = new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState<Revision[]>([]);
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [siteId, setSiteId] = useState("");
  const [role, setRole] = useState("Custodian");
  const [startTime, setStartTime] = useState("07:00");
  const [endTime, setEndTime] = useState("15:30");
  const [effective, setEffective] = useState(today);
  const [days, setDays] = useState<boolean[]>([false, true, true, true, true, true, false]);
  const [note, setNote] = useState("");
  const [reporter, setReporter] = useState("");
  const [source, setSource] = useState("phone");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    // Show today's manual-tagged shift change revisions
    const { data } = await supabase
      .from("master_schedule_revision")
      .select("*")
      .gte("uploaded_at", today + "T00:00:00")
      .ilike("source_filename", "%manual%")
      .order("uploaded_at", { ascending: false })
      .limit(20);
    setRows((data ?? []) as Revision[]);
  };

  useEffect(() => {
    load();
  }, []);

  const reset = () => {
    setSiteId("");
    setRole("Custodian");
    setStartTime("07:00");
    setEndTime("15:30");
    setEffective(today);
    setDays([false, true, true, true, true, true, false]);
    setNote("");
    setReporter("");
    setSource("phone");
    setError(null);
  };

  const toggleDay = (i: number) => {
    setDays((d) => d.map((v, j) => (i === j ? !v : v)));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!siteId.trim()) return setError("Site ID is required");
    if (!days.some(Boolean)) return setError("Pick at least one day");

    setSaving(true);
    setError(null);

    // Build the new_payload that the apply function expects (matches
    // fn_apply_master_schedule_revision's JSONB shape).
    const site = siteId.trim().toUpperCase();
    const newPayload = {
      start_time: startTime + ":00",
      end_time: endTime + ":00",
      pre_arrival_adjustment: "",
      post_arrival_adjustment: "",
      pre_departure_adjustment: "",
      post_departure_adjustment: "",
      hours_type_id: "",
      days_of_week: days,
      min_holiday: "",
      page_absence: false,
      flex_hours: "",
      pre_shift_tolerance: "",
      post_shift_tolerance: "",
      periodic_check: false,
      pc_tolerance: "",
      supervisor_id: "",
      notify_contact: "",
      page_no_show: false,
      no_show_pager: "",
      time_zone: "America/Chicago",
      role,
    };

    // 1. Create a pending revision tagged as manual
    const tag = [
      MANUAL_TAG,
      reporter.trim() ? `reporter: ${reporter.trim()}` : null,
      `source: ${source}`,
      `eff: ${effective}`,
      note.trim() ? `note: ${note.trim()}` : null,
    ].filter(Boolean).join(" · ");

    const { data: rev, error: revErr } = await supabase
      .from("master_schedule_revision")
      .insert({
        source_filename: tag,
        status: "pending",
        slot_count: 1,
        slots_added: 1,
        slots_modified: 0,
        slots_removed: 0,
        notes: note.trim() || null,
      })
      .select("id").single();

    if (revErr || !rev) {
      setError(revErr?.message ?? "Could not save");
      setSaving(false);
      return;
    }

    // 2. Insert the matching change row
    const natKey = `${site}|${startTime}:00|${endTime}:00|`;
    const { error: changeErr } = await supabase
      .from("master_schedule_change")
      .insert({
        revision_id: rev.id,
        change_type: "add",
        site_id: site,
        slot_natural_key: natKey,
        new_payload: newPayload,
      });

    if (changeErr) {
      setError(changeErr.message);
      setSaving(false);
      return;
    }

    reset();
    setShowAdd(false);
    setSaving(false);
    await load();
  };

  // Parse helper for displaying the tagged fields
  const parseTag = (s: string | null) => {
    const obj: Record<string, string> = {};
    if (!s) return obj;
    for (const part of s.split(" · ")) {
      const [k, ...rest] = part.split(": ");
      if (rest.length) obj[k.trim()] = rest.join(": ").trim();
    }
    return obj;
  };

  const pendingCount = rows.filter((r) => r.status === "pending").length;

  return (
    <section id="shift-changes" className="bg-surface border border-border rounded-xl">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between p-5 text-left"
      >
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            Shift change requests
            <span className="ml-2 text-text-primary">{rows.length}</span>
            <span className="ml-1 text-text-secondary font-normal normal-case">
              today
            </span>
            {pendingCount > 0 && (
              <span className="ml-2 text-warning text-[11px] font-semibold">
                · {pendingCount} pending approval
              </span>
            )}
          </h2>
          <p className="text-[13px] text-text-secondary mt-1">
            Supervisor-submitted changes phoned or texted in. Each becomes a
            pending revision — approve from the Scheduling tab.
          </p>
        </div>
        <span className="text-text-muted text-[12px]">{open ? "Hide ▴" : "Show ▾"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-text-secondary">
              {rows.length === 0
                ? "No shift change requests logged for today."
                : `${pendingCount} pending · ${rows.length} total today.`}
            </span>
            {!showAdd && (
              <button
                onClick={() => setShowAdd(true)}
                className="text-[13px] font-semibold px-3 py-1.5 rounded-md bg-blue-1 text-white hover:bg-blue-2"
              >
                + Add shift change
              </button>
            )}
          </div>

          {showAdd && (
            <form
              onSubmit={submit}
              className="bg-bg/50 border border-border rounded-lg p-4 grid gap-3 sm:grid-cols-3"
            >
              <label className="text-[12px] font-medium text-text-secondary">
                Site ID *
                <input
                  type="text"
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  placeholder="T0067, KOH0130, H3007"
                  className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] tabular font-semibold uppercase"
                  autoFocus
                />
              </label>
              <label className="text-[12px] font-medium text-text-secondary">
                Role
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] bg-surface"
                >
                  {LABOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-[12px] font-medium text-text-secondary">
                Effective date
                <input
                  type="date"
                  value={effective}
                  onChange={(e) => setEffective(e.target.value)}
                  className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px]"
                />
              </label>

              <label className="text-[12px] font-medium text-text-secondary">
                Start time
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] tabular"
                />
              </label>
              <label className="text-[12px] font-medium text-text-secondary">
                End time
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] tabular"
                />
              </label>
              <div className="text-[12px] font-medium text-text-secondary">
                Days of week
                <div className="mt-1 flex gap-1 flex-wrap">
                  {DAYS.map((d, i) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleDay(i)}
                      className={`w-9 h-9 rounded-md text-[12px] font-semibold border transition-colors ${
                        days[i]
                          ? "bg-blue-1 text-white border-blue-1"
                          : "bg-surface text-text-secondary border-border hover:border-blue-1"
                      }`}
                    >
                      {d[0]}
                    </button>
                  ))}
                </div>
              </div>

              <label className="text-[12px] font-medium text-text-secondary sm:col-span-2">
                Note
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder='"Joe out Thu; cover with Marcia"'
                  className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px]"
                />
              </label>
              <label className="text-[12px] font-medium text-text-secondary">
                Reporter
                <input
                  type="text"
                  value={reporter}
                  onChange={(e) => setReporter(e.target.value)}
                  placeholder="Site supervisor / your name"
                  className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px]"
                />
              </label>

              <label className="text-[12px] font-medium text-text-secondary">
                Source
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] bg-surface"
                >
                  <option value="phone">Phone</option>
                  <option value="sms">SMS / Text</option>
                  <option value="email">Email</option>
                  <option value="manual">Manual</option>
                </select>
              </label>

              {error && (
                <div className="sm:col-span-3 text-[12px] text-danger">{error}</div>
              )}

              <div className="sm:col-span-3 flex justify-end gap-2">
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
                  {saving ? "Saving…" : "Submit for approval"}
                </button>
              </div>
            </form>
          )}

          {rows.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-[12px] tabular">
                <thead className="bg-bg text-text-muted uppercase text-[10px] tracking-[0.06em]">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Submitted</th>
                    <th className="text-left px-3 py-2 font-semibold">Status</th>
                    <th className="text-left px-3 py-2 font-semibold">Reporter</th>
                    <th className="text-left px-3 py-2 font-semibold">Source</th>
                    <th className="text-left px-3 py-2 font-semibold">Effective</th>
                    <th className="text-left px-3 py-2 font-semibold">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {rows.map((r) => {
                    const tag = parseTag(r.source_filename);
                    return (
                      <tr key={r.id}>
                        <td className="px-3 py-1.5 text-text-secondary whitespace-nowrap">
                          {new Date(r.uploaded_at).toLocaleTimeString(undefined, { timeStyle: "short" })}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
                            r.status === "applied"
                              ? "bg-good/10 text-good"
                              : r.status === "rejected"
                                ? "bg-danger/10 text-danger"
                                : "bg-warning/15 text-warning"
                          }`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-text-secondary">{tag["reporter"] ?? "—"}</td>
                        <td className="px-3 py-1.5 text-text-muted uppercase text-[10px]">{tag["source"] ?? "—"}</td>
                        <td className="px-3 py-1.5 text-text-secondary">{tag["eff"] ?? "—"}</td>
                        <td className="px-3 py-1.5 text-text-secondary">{tag["note"] ?? r.notes ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
