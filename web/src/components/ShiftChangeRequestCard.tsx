/**
 * Shift Change Request card — mirrors the Excel SHIFT FORM layout.
 *
 * Fields: Region/Dept #, Job Site ID, Job Site Name (auto-fill from
 * Site ID), Effective Date, Supervisor/Role, Shift Times (Start, End,
 * Meal), Shift Total (computed), Minimum Number of People per day
 * (Sun..Sat numeric), Weekly Total (computed), Requestor, Source, Note.
 *
 * Each submission becomes a pending master_schedule_revision + one
 * master_schedule_change (type 'add'). Approval happens in the
 * Scheduling tab.
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

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function ShiftChangeRequestCard() {
  const today = new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState<Revision[]>([]);
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  // Site identification
  const [regionDept, setRegionDept] = useState("");
  const [siteId, setSiteId] = useState("");
  const [siteName, setSiteName] = useState("");

  // Shift definition
  const [role, setRole] = useState("Custodian");
  const [startTime, setStartTime] = useState("07:00");
  const [endTime, setEndTime] = useState("15:30");
  const [mealMinutes, setMealMinutes] = useState(30);
  const [effective, setEffective] = useState(today);

  // Per-day minimum number of people required (matches the Excel SHIFT FORM)
  const [dayCounts, setDayCounts] = useState<number[]>([0, 1, 1, 1, 1, 1, 0]);

  // Operational metadata
  const [note, setNote] = useState("");
  const [reporter, setReporter] = useState("");
  const [source, setSource] = useState("phone");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Site name lookup
  useEffect(() => {
    if (!siteId.trim()) { setSiteName(""); return; }
    const handle = setTimeout(async () => {
      const code = siteId.trim().toUpperCase();
      const { data } = await supabase.from("site")
        .select("site_name, region_code")
        .eq("site_id", code).maybeSingle();
      if (data) {
        setSiteName(data.site_name ?? "");
        if (data.region_code) setRegionDept(data.region_code);
      } else {
        setSiteName("");
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [siteId]);

  const load = async () => {
    const { data } = await supabase
      .from("master_schedule_revision")
      .select("*")
      .gte("uploaded_at", today + "T00:00:00")
      .ilike("source_filename", "%manual%")
      .order("uploaded_at", { ascending: false })
      .limit(20);
    setRows((data ?? []) as Revision[]);
  };

  useEffect(() => { load(); }, []);

  // Computed: shift length in hours = (end - start - meal) / 60
  const shiftHours = (() => {
    const mins = timeToMinutes(endTime) - timeToMinutes(startTime) - (mealMinutes || 0);
    return Math.max(0, mins / 60);
  })();

  // Computed: weekly total = sum of per-day counts × shift hours
  const weeklyTotal = dayCounts.reduce((sum, c) => sum + c, 0) * shiftHours;

  const reset = () => {
    setRegionDept("");
    setSiteId("");
    setSiteName("");
    setRole("Custodian");
    setStartTime("07:00");
    setEndTime("15:30");
    setMealMinutes(30);
    setEffective(today);
    setDayCounts([0, 1, 1, 1, 1, 1, 0]);
    setNote("");
    setReporter("");
    setSource("phone");
    setError(null);
  };

  const updateDayCount = (i: number, raw: string) => {
    const n = Math.max(0, Math.min(99, parseInt(raw || "0", 10) || 0));
    setDayCounts((d) => d.map((v, j) => (j === i ? n : v)));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!siteId.trim()) return setError("Job Site ID is required");
    if (dayCounts.every((n) => n === 0)) return setError("Set headcount on at least one day");

    setSaving(true);
    setError(null);

    const site = siteId.trim().toUpperCase();
    const newPayload = {
      start_time: startTime + ":00",
      end_time: endTime + ":00",
      pre_arrival_adjustment: "",
      post_arrival_adjustment: "",
      pre_departure_adjustment: "",
      post_departure_adjustment: "",
      hours_type_id: "",
      days_of_week: dayCounts.map((c) => c > 0),
      // Capture the per-day counts and meal too so the bulk apply has the source.
      day_counts: dayCounts,
      meal_minutes: mealMinutes,
      shift_total_hours: shiftHours,
      weekly_total_hours: weeklyTotal,
      min_holiday: "",
      page_absence: false,
      flex_hours: mealMinutes ? String(mealMinutes) : "",
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

    const tag = [
      MANUAL_TAG,
      regionDept.trim() ? `region/dept: ${regionDept.trim()}` : null,
      siteName.trim() ? `site: ${siteName.trim()}` : null,
      reporter.trim() ? `reporter: ${reporter.trim()}` : null,
      `source: ${source}`,
      `eff: ${effective}`,
      `hours: ${shiftHours.toFixed(1)}/${weeklyTotal.toFixed(1)}`,
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

  // Submission cycle: reminder Tue → due Thu 5:00 PM CT. Compute the next
  // upcoming Thursday 5 PM CT relative to now.
  const deadline = (() => {
    const now = new Date();
    const dow = now.getDay(); // 0=Sun..6=Sat
    // Days until next Thursday (4). If today is Thu before 5pm, use today.
    let daysAhead = (4 - dow + 7) % 7;
    if (daysAhead === 0 && now.getHours() >= 17) daysAhead = 7;
    const d = new Date(now);
    d.setDate(d.getDate() + daysAhead);
    d.setHours(17, 0, 0, 0);
    return d;
  })();
  const reminderDay = (() => {
    // Most recent Tuesday at or before now
    const now = new Date();
    const dow = now.getDay();
    const daysBack = (dow - 2 + 7) % 7;
    const d = new Date(now);
    d.setDate(d.getDate() - daysBack);
    d.setHours(9, 0, 0, 0);
    return d;
  })();
  const msToDeadline = deadline.getTime() - Date.now();
  const hrsToDeadline = Math.max(0, Math.floor(msToDeadline / 3_600_000));
  const daysToDeadline = Math.floor(hrsToDeadline / 24);
  const remainingHrs = hrsToDeadline % 24;
  const deadlineLabel = deadline.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  const reminderLabel = reminderDay.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
  const inWindow = Date.now() >= reminderDay.getTime();

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
            <span className="ml-1 text-text-secondary font-normal normal-case">today</span>
            {pendingCount > 0 && (
              <span className="ml-2 text-warning text-[11px] font-semibold">
                · {pendingCount} pending approval
              </span>
            )}
          </h2>
          <p className="text-[13px] text-text-secondary mt-1">
            New shifts or shift-time changes. Mirrors the Excel SHIFT FORM. Each
            submission becomes a pending revision — approve in the Scheduling tab.
          </p>
        </div>
        <span className="text-text-muted text-[12px]">{open ? "Hide ▴" : "Show ▾"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          {/* Tuesday reminder → Thursday COB deadline banner */}
          <div className={`flex items-center gap-3 flex-wrap px-3 py-2 rounded-lg border text-[12px] ${
            inWindow
              ? "bg-warning/10 border-warning text-warning"
              : "bg-bg/40 border-border text-text-secondary"
          }`}>
            <span className="font-semibold uppercase tracking-[0.06em] text-[10px]">
              Submission cycle
            </span>
            <span>
              Reminder sent <strong>{reminderLabel} 9 AM CT</strong>
            </span>
            <span>·</span>
            <span>
              Due <strong>{deadlineLabel}</strong>
              {hrsToDeadline > 0 && (
                <span className="ml-1 text-text-muted tabular">
                  ({daysToDeadline > 0 ? `${daysToDeadline}d ` : ""}{remainingHrs}h left)
                </span>
              )}
              {hrsToDeadline === 0 && (
                <span className="ml-1 font-semibold">closes today</span>
              )}
            </span>
          </div>

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
              className="bg-bg/50 border border-border rounded-lg p-4 space-y-4"
            >
              {/* Identification block */}
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-[12px] font-medium text-text-secondary">
                  Region / Dept #
                  <input
                    type="text"
                    value={regionDept}
                    onChange={(e) => setRegionDept(e.target.value)}
                    placeholder="e.g. 4006"
                    className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] tabular"
                  />
                </label>
                <label className="text-[12px] font-medium text-text-secondary">
                  Job Site ID *
                  <input
                    type="text"
                    value={siteId}
                    onChange={(e) => setSiteId(e.target.value)}
                    placeholder="H3014 / T0067 / KOH0130"
                    className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] tabular font-semibold uppercase"
                    autoFocus
                  />
                </label>
                <label className="text-[12px] font-medium text-text-secondary">
                  Job Site Name
                  <input
                    type="text"
                    value={siteName}
                    readOnly
                    placeholder="(auto-fills from Site ID)"
                    className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] bg-bg/40 text-text-secondary"
                  />
                </label>
                <label className="text-[12px] font-medium text-text-secondary">
                  Effective Date
                  <input
                    type="date"
                    value={effective}
                    onChange={(e) => setEffective(e.target.value)}
                    className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px]"
                  />
                </label>
                <label className="text-[12px] font-medium text-text-secondary sm:col-span-2">
                  Supervisor / Role
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] bg-surface"
                  >
                    {LABOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              </div>

              {/* Shift times block */}
              <div className="border-t border-border pt-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted mb-2">
                  Shift times
                </div>
                <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                  <label className="text-[12px] font-medium text-text-secondary">
                    Start
                    <input
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] tabular"
                    />
                  </label>
                  <label className="text-[12px] font-medium text-text-secondary">
                    End
                    <input
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] tabular"
                    />
                  </label>
                  <label className="text-[12px] font-medium text-text-secondary">
                    Meal (min)
                    <input
                      type="number"
                      min={0}
                      max={120}
                      value={mealMinutes}
                      onChange={(e) => setMealMinutes(Math.max(0, parseInt(e.target.value || "0", 10) || 0))}
                      className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] tabular"
                    />
                  </label>
                  <div className="text-[12px] font-medium text-text-secondary">
                    Shift Total
                    <div className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px] tabular bg-bg/40 font-semibold">
                      {shiftHours.toFixed(2)} hrs
                    </div>
                  </div>
                </div>
              </div>

              {/* Minimum people per day */}
              <div className="border-t border-border pt-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted mb-2">
                  Minimum number of people required
                </div>
                <div className="grid gap-2 grid-cols-7">
                  {DAYS.map((d, i) => (
                    <label key={d} className="text-[11px] font-medium text-text-secondary text-center">
                      {d}
                      <input
                        type="number"
                        min={0}
                        max={99}
                        value={dayCounts[i]}
                        onChange={(e) => updateDayCount(i, e.target.value)}
                        className="mt-1 w-full border border-border rounded px-2 py-2 text-[13px] tabular text-center"
                      />
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-end gap-2 text-[12px] tabular">
                  <span className="text-text-secondary">Weekly Total:</span>
                  <span className="font-semibold text-text-primary text-[14px]">
                    {weeklyTotal.toFixed(2)} hrs
                  </span>
                </div>
              </div>

              {/* Operational metadata */}
              <div className="border-t border-border pt-3 grid gap-3 sm:grid-cols-3">
                <label className="text-[12px] font-medium text-text-secondary sm:col-span-3">
                  Note
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder='"Joe out Thu; Marcia covering. New shift starts 6/9."'
                    className="mt-1 w-full border border-border rounded px-3 py-2 text-[13px]"
                  />
                </label>
                <label className="text-[12px] font-medium text-text-secondary sm:col-span-2">
                  Requestor / CE Team Member
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
              </div>

              {error && (
                <div className="text-[12px] text-danger">{error}</div>
              )}

              <div className="flex justify-end gap-2">
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
                    <th className="text-left px-3 py-2 font-semibold">Hours</th>
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
                        <td className="px-3 py-1.5 text-text-secondary tabular">{tag["hours"] ?? "—"}</td>
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
