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

type Recipient = {
  id: number;
  email: string;
  name: string | null;
  site_id: string | null;
  active: boolean;
};

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

export function ShiftChangeRequestCard({
  standalone = false,
}: {
  /** When true (e.g. /shift-form), the card opens with the form ready. */
  standalone?: boolean;
} = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState<Revision[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [showRecipients, setShowRecipients] = useState(false);
  const [newRecipientEmail, setNewRecipientEmail] = useState("");
  const [newRecipientName, setNewRecipientName] = useState("");
  const [open, setOpen] = useState(standalone);
  const [showAdd, setShowAdd] = useState(standalone);

  // Site identification
  const [regionDept, setRegionDept] = useState("");
  const [siteId, setSiteId] = useState("");
  const [siteName, setSiteName] = useState("");
  const [budgetWinteam, setBudgetWinteam] = useState<string>("");

  // The form mirrors the Excel SHIFT FORM: up to 15 shift rows per submission.
  type ShiftRow = {
    role: string;
    employee: string;
    start: string;
    end: string;
    meal: string;   // minutes, kept as string so the cell can be blank
    days: string[]; // length 7, blank or number-as-string
  };
  const blankRow = (): ShiftRow => ({
    role: "", employee: "", start: "", end: "", meal: "", days: ["", "", "", "", "", "", ""],
  });
  const [shiftRows, setShiftRows] = useState<ShiftRow[]>(() =>
    Array.from({ length: 15 }, blankRow),
  );

  const [effective, setEffective] = useState(today);
  const [lastChangeDate, setLastChangeDate] = useState<string | null>(null);
  const [allSites, setAllSites] = useState<{ site_id: string; site_name: string | null }[]>([]);

  // Operational metadata
  const [note, setNote] = useState("");
  const [reporter, setReporter] = useState("");
  const [source, setSource] = useState("fit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Site name lookup + preload current schedule from Schedule Report mappings.
  // We pull from job_site_schedules joined to shift_blocks (1 row per
  // shift this site runs) and fall back to schedule_slot rows if the
  // Schedule Report has been imported. Each row populates the
  // SHIFT FORM table with start/end/days so the operator only edits
  // what's changing.
  useEffect(() => {
    if (!siteId.trim()) {
      setSiteName("");
      setLastChangeDate(null);
      return;
    }
    const handle = setTimeout(async () => {
      const code = siteId.trim().toUpperCase();
      const { data: siteRow } = await supabase.from("site")
        .select("id, site_name, region_code")
        .eq("site_id", code).maybeSingle();
      if (!siteRow) {
        setSiteName("");
        setLastChangeDate(null);
        return;
      }
      setSiteName(siteRow.site_name ?? "");

      // Department number associated with the WinTeam budget for this site,
      // sourced from winteam_job_tier_parameters keyed by job_number.
      // Falls back to the site's region_code if WinTeam has no record.
      const { data: tierRow } = await supabase
        .from("winteam_job_tier_parameters")
        .select("dept_code, dept_description")
        .eq("job_number", code)
        .order("effective_date", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (tierRow?.dept_code) {
        setRegionDept(tierRow.dept_code);
      } else if (siteRow.region_code) {
        setRegionDept(siteRow.region_code);
      }

      // Last change date — most recent applied master_schedule_revision that
      // touched this site. Empty if no prior change has been logged for it.
      const { data: lastChange } = await supabase
        .from("master_schedule_change")
        .select("revision_id, master_schedule_revision!inner(applied_at, status)")
        .eq("site_id", code)
        .eq("master_schedule_revision.status", "applied")
        .order("revision_id", { ascending: false })
        .limit(1)
        .maybeSingle();
      const applied = (lastChange as unknown as
        { master_schedule_revision?: { applied_at?: string } | null } | null)
        ?.master_schedule_revision?.applied_at ?? null;
      setLastChangeDate(applied ? applied.slice(0, 10) : null);

      // Prefer schedule_slot rows when present (Schedule Report has
      // landed). Otherwise derive defaults from job_site_schedules + the
      // block end times.
      const { data: slots } = await supabase
        .from("schedule_slot")
        .select("start_time, end_time, flex_hours, role, days_of_week")
        .eq("site_id", code);

      let rowsForForm: ShiftRow[] = [];
      if (slots && slots.length > 0) {
        rowsForForm = slots.map((s: {
          start_time: string; end_time: string; flex_hours: number | null;
          role: string | null; days_of_week: boolean[] | null;
        }) => ({
          role: s.role ?? "",
          employee: "",
          start: (s.start_time ?? "").slice(0, 5),
          end: (s.end_time ?? "").slice(0, 5),
          meal: s.flex_hours != null ? String(s.flex_hours) : "",
          days: (s.days_of_week ?? [false,false,false,false,false,false,false])
            .map((b) => b ? "1" : ""),
        }));
      } else {
        const { data: jss } = await supabase
          .from("job_site_schedules")
          .select("shift_block_id, scheduled_out_local, scheduled_hours, people_per_shift, shift_blocks(end_time_local, days_of_week)")
          .eq("job_site_id", siteRow.id)
          .eq("active", true)
          .order("scheduled_out_local");
        if (jss && jss.length > 0) {
          rowsForForm = jss.map((r: {
            scheduled_out_local: string; scheduled_hours: number; people_per_shift: number;
            shift_blocks: Array<{ end_time_local: string; days_of_week: boolean[] | null }>
              | { end_time_local: string; days_of_week: boolean[] | null } | null;
          }) => {
            const sb = Array.isArray(r.shift_blocks) ? r.shift_blocks[0] : r.shift_blocks;
            const end = (r.scheduled_out_local ?? sb?.end_time_local ?? "").slice(0, 5);
            const [eh, em] = end.split(":").map(Number);
            const endMins = (eh ?? 0) * 60 + (em ?? 0);
            const startMins = Math.max(0, endMins - Math.round((r.scheduled_hours ?? 8) * 60));
            const start = `${String(Math.floor(startMins / 60)).padStart(2,"0")}:${String(startMins % 60).padStart(2,"0")}`;
            const days = (sb?.days_of_week ?? [false,true,true,true,true,true,false])
              .map((b) => b ? String(r.people_per_shift ?? 1) : "");
            return { role: "", employee: "", start, end, meal: "", days };
          });
        }
      }

      // Pad to 15 rows so the SHIFT FORM table stays visually consistent.
      while (rowsForForm.length < 15) rowsForForm.push(blankRow());
      setShiftRows(rowsForForm.slice(0, 15));
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

  const loadRecipients = async () => {
    const { data } = await supabase
      .from("shift_form_recipient")
      .select("id, email, name, site_id, active")
      .eq("active", true)
      .order("email");
    setRecipients((data ?? []) as Recipient[]);
  };

  useEffect(() => {
    load();
    loadRecipients();
    // Cache the full site list once so the Store # input can show a
    // native typeahead dropdown of every job site.
    (async () => {
      const { data } = await supabase
        .from("site")
        .select("site_id, site_name")
        .order("site_id");
      setAllSites((data ?? []) as { site_id: string; site_name: string | null }[]);
    })();
  }, []);

  const addRecipient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRecipientEmail.trim()) return;
    await supabase.from("shift_form_recipient").insert({
      email: newRecipientEmail.trim().toLowerCase(),
      name: newRecipientName.trim() || null,
      active: true,
    });
    setNewRecipientEmail("");
    setNewRecipientName("");
    loadRecipients();
  };

  const removeRecipient = async (r: Recipient) => {
    if (!confirm(`Remove ${r.email} from the reminder list?`)) return;
    await supabase.from("shift_form_recipient").update({ active: false }).eq("id", r.id);
    loadRecipients();
  };

  // Per-row computed shift total = (end - start - meal) / 60
  function rowShiftTotal(r: ShiftRow): number {
    if (!r.start || !r.end) return 0;
    const meal = parseInt(r.meal || "0", 10) || 0;
    const mins = timeToMinutes(r.end) - timeToMinutes(r.start) - meal;
    return Math.max(0, mins / 60);
  }
  // Per-row weekly total = sum of day counts × shift total
  function rowWeeklyTotal(r: ShiftRow): number {
    const dayTotal = r.days.reduce((s, d) => s + (parseInt(d || "0", 10) || 0), 0);
    return dayTotal * rowShiftTotal(r);
  }
  const totalWeeklyHours = shiftRows.reduce((s, r) => s + rowWeeklyTotal(r), 0);

  const reset = () => {
    setRegionDept("");
    setSiteId("");
    setSiteName("");
    setBudgetWinteam("");
    setShiftRows(Array.from({ length: 15 }, blankRow));
    setEffective(today);
    setNote("");
    setReporter("");
    setSource("fit");
    setError(null);
  };

  const updateRow = (i: number, patch: Partial<ShiftRow>) => {
    setShiftRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const updateRowDay = (i: number, dayIdx: number, raw: string) => {
    setShiftRows((rows) => rows.map((r, j) =>
      j === i ? { ...r, days: r.days.map((d, k) => (k === dayIdx ? raw : d)) } : r,
    ));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!siteId.trim()) return setError("Store # is required");
    const filledRows = shiftRows.filter(
      (r) => r.role.trim() && r.start && r.end && r.days.some((d) => parseInt(d || "0", 10) > 0),
    );
    if (filledRows.length === 0) return setError("Add at least one shift row with role, times, and a day count");

    setSaving(true);
    setError(null);

    const site = siteId.trim().toUpperCase();
    const tag = [
      MANUAL_TAG,
      regionDept.trim() ? `region/dept: ${regionDept.trim()}` : null,
      siteName.trim() ? `site: ${siteName.trim()}` : null,
      budgetWinteam.trim() ? `budget: ${budgetWinteam.trim()}` : null,
      reporter.trim() ? `reporter: ${reporter.trim()}` : null,
      `source: ${source}`,
      `eff: ${effective}`,
      `rows: ${filledRows.length}`,
      `weekly: ${totalWeeklyHours.toFixed(1)}`,
      note.trim() ? `note: ${note.trim()}` : null,
    ].filter(Boolean).join(" · ");

    const { data: rev, error: revErr } = await supabase
      .from("master_schedule_revision")
      .insert({
        source_filename: tag,
        status: "applied",
        slot_count: filledRows.length,
        slots_added: filledRows.length,
        slots_modified: 0,
        slots_removed: 0,
        notes: note.trim() || null,
        applied_at: new Date().toISOString(),
      })
      .select("id").single();

    if (revErr || !rev) {
      setError(revErr?.message ?? "Could not save");
      setSaving(false);
      return;
    }

    const changes = filledRows.map((r) => {
      const dayCounts = r.days.map((d) => parseInt(d || "0", 10) || 0);
      const meal = parseInt(r.meal || "0", 10) || 0;
      const shiftHours = rowShiftTotal(r);
      const weeklyTotal = rowWeeklyTotal(r);
      return {
        revision_id: rev.id,
        change_type: "add",
        site_id: site,
        slot_natural_key: `${site}|${r.start}:00|${r.end}:00|`,
        new_payload: {
          start_time: r.start + ":00",
          end_time: r.end + ":00",
          hours_type_id: "",
          days_of_week: dayCounts.map((c) => c > 0),
          day_counts: dayCounts,
          meal_minutes: meal,
          shift_total_hours: shiftHours,
          weekly_total_hours: weeklyTotal,
          flex_hours: meal ? String(meal) : "",
          time_zone: "America/Chicago",
          role: r.role,
          employee_name: r.employee || null,
        },
      };
    });
    const { error: changeErr } = await supabase.from("master_schedule_change").insert(changes);
    if (changeErr) {
      setError(changeErr.message);
      setSaving(false);
      return;
    }

    // Auto-apply: write the schedule_slot rows so fn_candidates_for_shift_block
    // picks them up immediately. Each ShiftRow → 1 schedule_slot tagged to the
    // new revision so we can roll back later.
    const slotRows = filledRows.map((r) => {
      const meal = parseInt(r.meal || "0", 10) || 0;
      const days = r.days.map((d) => (parseInt(d || "0", 10) || 0) > 0);
      return {
        site_id: site,
        start_time: r.start + ":00",
        end_time: r.end + ":00",
        days_of_week: days,
        flex_hours: meal,
        time_zone: "America/Chicago",
        role: r.role || null,
        master_schedule_revision_id: rev.id,
      };
    });
    const { error: slotErr } = await supabase.from("schedule_slot").insert(slotRows);
    if (slotErr) {
      setError("Saved revision but could not apply slots: " + slotErr.message);
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
  const deadlineLabel = deadline.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }) + " CT";
  const reminderLabel = reminderDay.toLocaleString("en-US", {
    timeZone: "America/Chicago",
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
            {rows.length > 0 && (
              <span className="ml-2 text-warning text-[11px] font-semibold">
                · applied to today's schedule
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
              Reminder sent <strong>{reminderLabel} 9 AM CT</strong> to{" "}
              <button
                type="button"
                onClick={() => setShowRecipients((v) => !v)}
                className="underline hover:text-text-primary"
              >
                {recipients.length} {recipients.length === 1 ? "person" : "people"}
              </button>
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

          {/* Recipient list editor */}
          {showRecipients && (
            <div className="border border-border rounded-lg p-3 bg-bg/40 space-y-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Reminder recipients
                <span className="ml-2 text-text-muted normal-case font-normal">
                  · these are the To: addresses Power Automate uses every Tuesday
                </span>
              </div>
              {recipients.length === 0 && (
                <div className="text-[12px] text-text-muted">No recipients yet.</div>
              )}
              {recipients.length > 0 && (
                <ul className="divide-y divide-border/60">
                  {recipients.map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-1.5 text-[12px]">
                      <div>
                        <span className="font-semibold text-text-primary">{r.email}</span>
                        {r.name && <span className="ml-2 text-text-secondary">{r.name}</span>}
                        {r.site_id && (
                          <span className="ml-2 text-[10px] uppercase font-semibold text-text-muted">
                            · {r.site_id}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => removeRecipient(r)}
                        className="text-[11px] text-danger hover:underline"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={addRecipient} className="flex gap-2 flex-wrap items-end pt-2 border-t border-border">
                <label className="text-[11px] font-medium text-text-secondary grow min-w-[200px]">
                  Email
                  <input
                    type="email"
                    value={newRecipientEmail}
                    onChange={(e) => setNewRecipientEmail(e.target.value)}
                    placeholder="someone@example.com"
                    className="mt-1 w-full border border-border rounded px-3 py-1.5 text-[12px]"
                  />
                </label>
                <label className="text-[11px] font-medium text-text-secondary grow min-w-[160px]">
                  Name (optional)
                  <input
                    type="text"
                    value={newRecipientName}
                    onChange={(e) => setNewRecipientName(e.target.value)}
                    placeholder="e.g. Site mgr Maria"
                    className="mt-1 w-full border border-border rounded px-3 py-1.5 text-[12px]"
                  />
                </label>
                <button
                  type="submit"
                  className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-blue-1 text-white hover:bg-blue-2"
                >
                  + Add
                </button>
              </form>
            </div>
          )}

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
              className="bg-white border border-border rounded-lg p-6 space-y-5"
            >
              <div className="text-center">
                <h3 className="text-[22px] font-bold tracking-wide text-text-primary">SHIFT FORM</h3>
                <p className="text-[12px] text-text-secondary mt-1 italic">
                  Please complete this form for each store any time there is a new shift or shift change
                  (the number of employees change or shift time changes).
                </p>
              </div>

              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                  <span className="text-[12px] font-semibold text-text-secondary text-right">Region/Dept #:</span>
                  <input type="text" value={regionDept}
                    onChange={(e) => setRegionDept(e.target.value)}
                    placeholder="4006"
                    className="border border-border rounded px-2 py-1 text-[13px] tabular bg-yellow-50" />
                </div>
                <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                  <span className="text-[12px] font-semibold text-text-secondary text-right">BUDGET IN WINTEAM:</span>
                  <input type="number" min={0} value={budgetWinteam}
                    onChange={(e) => setBudgetWinteam(e.target.value)}
                    placeholder="35"
                    className="border border-border rounded px-2 py-1 text-[13px] tabular bg-yellow-50" />
                </div>
                <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                  <span className="text-[12px] font-semibold text-text-secondary text-right">Store #:</span>
                  <input
                    type="text"
                    list="store-options"
                    value={siteId}
                    onChange={(e) => setSiteId(e.target.value)}
                    placeholder="H3014"
                    className="border border-border rounded px-2 py-1 text-[13px] tabular font-semibold uppercase bg-yellow-50"
                    autoFocus
                  />
                  <datalist id="store-options">
                    {allSites.map((s) => (
                      <option key={s.site_id} value={s.site_id}>{s.site_name ?? ""}</option>
                    ))}
                  </datalist>
                </div>
                <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                  <span className="text-[12px] font-semibold text-text-secondary text-right">Total Weekly Hours:</span>
                  <div className="border border-border rounded px-2 py-1 text-[13px] tabular bg-bg/40 font-semibold">
                    {totalWeeklyHours.toFixed(1)}
                  </div>
                </div>
                <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                  <span className="text-[12px] font-semibold text-text-secondary text-right">Effective Date:</span>
                  <input type="date" value={effective}
                    onChange={(e) => setEffective(e.target.value)}
                    className="border border-border rounded px-2 py-1 text-[13px] tabular bg-yellow-50" />
                </div>
                <div className="grid grid-cols-[160px_1fr] items-center gap-2">
                  <span className="text-[12px] font-semibold text-text-secondary text-right">Last Change Date:</span>
                  <div className="border border-border rounded px-2 py-1 text-[13px] tabular bg-bg/40 text-text-secondary">
                    {lastChangeDate ?? "—"}
                  </div>
                </div>
                {siteName && (
                  <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                    <span className="text-[12px] font-semibold text-text-secondary text-right">Store Name:</span>
                    <div className="text-[13px] text-text-secondary">{siteName}</div>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto border border-border rounded">
                <table className="w-full text-[12px] tabular border-collapse">
                  <thead className="bg-bg">
                    <tr>
                      <th rowSpan={2} className="border border-border px-2 py-1 font-semibold text-text-secondary w-[130px]">Role Type</th>
                      <th rowSpan={2} className="border border-border px-2 py-1 font-semibold text-text-secondary w-[160px]">Employee Name</th>
                      <th colSpan={3} className="border border-border px-2 py-1 font-semibold text-text-secondary">Shift Times</th>
                      <th rowSpan={2} className="border border-border px-2 py-1 font-semibold text-text-secondary w-[70px]">Shift Total</th>
                      <th colSpan={7} className="border border-border px-2 py-1 font-semibold text-text-secondary">Minimum Number of People Required</th>
                      <th rowSpan={2} className="border border-border px-2 py-1 font-semibold text-text-secondary w-[70px]">Weekly Total</th>
                    </tr>
                    <tr>
                      <th className="border border-border px-2 py-1 font-medium text-text-secondary w-[80px]">Start</th>
                      <th className="border border-border px-2 py-1 font-medium text-text-secondary w-[80px]">End</th>
                      <th className="border border-border px-2 py-1 font-medium text-text-secondary w-[60px]">Meal</th>
                      {DAYS.map((d) => (
                        <th key={d} className="border border-border px-2 py-1 font-medium text-text-secondary w-[50px]">{d}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shiftRows.map((row, i) => {
                      const total = rowShiftTotal(row);
                      const weekly = rowWeeklyTotal(row);
                      return (
                        <tr key={i} className="bg-yellow-50">
                          <td className="border border-border p-0">
                            <input list="role-options" value={row.role}
                              onChange={(e) => updateRow(i, { role: e.target.value })}
                              className="w-full px-2 py-1 text-[12px] bg-transparent" />
                          </td>
                          <td className="border border-border p-0">
                            <input type="text" value={row.employee}
                              onChange={(e) => updateRow(i, { employee: e.target.value })}
                              placeholder=""
                              className="w-full px-2 py-1 text-[12px] bg-transparent" />
                          </td>
                          <td className="border border-border p-0">
                            <input type="time" value={row.start}
                              onChange={(e) => updateRow(i, { start: e.target.value })}
                              className="w-full px-1 py-1 text-[12px] tabular bg-transparent" />
                          </td>
                          <td className="border border-border p-0">
                            <input type="time" value={row.end}
                              onChange={(e) => updateRow(i, { end: e.target.value })}
                              className="w-full px-1 py-1 text-[12px] tabular bg-transparent" />
                          </td>
                          <td className="border border-border p-0">
                            <input type="number" min={0} max={120} value={row.meal}
                              onChange={(e) => updateRow(i, { meal: e.target.value })}
                              className="w-full px-1 py-1 text-[12px] tabular bg-transparent text-center" />
                          </td>
                          <td className="border border-border px-2 py-1 text-center text-text-primary font-semibold bg-bg/40">
                            {total.toFixed(1)}
                          </td>
                          {row.days.map((d, k) => (
                            <td key={k} className="border border-border p-0">
                              <input type="number" min={0} max={99} value={d}
                                onChange={(e) => updateRowDay(i, k, e.target.value)}
                                className="w-full px-1 py-1 text-[12px] tabular bg-transparent text-center" />
                            </td>
                          ))}
                          <td className="border border-border px-2 py-1 text-center text-text-primary font-semibold bg-bg/40">
                            {weekly.toFixed(1)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <datalist id="role-options">
                  {LABOR_TYPES.map((t) => <option key={t} value={t} />)}
                </datalist>
              </div>

              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 pt-2">
                <label className="text-[12px] font-semibold text-text-secondary">
                  Requestor / CE Team Member
                  <input type="text" value={reporter}
                    onChange={(e) => setReporter(e.target.value)}
                    className="mt-1 w-full border border-border rounded px-3 py-1.5 text-[13px] bg-yellow-50" />
                </label>
                <label className="text-[12px] font-semibold text-text-secondary">
                  Date Completed
                  <div className="mt-1 w-full border border-border rounded px-3 py-1.5 text-[13px] tabular bg-yellow-50">
                    {today}
                  </div>
                </label>
                <label className="text-[12px] font-semibold text-text-secondary sm:col-span-2">
                  Note (optional)
                  <input type="text" value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder='Joe out Thu; Marcia covering. New shift starts 6/9.'
                    className="mt-1 w-full border border-border rounded px-3 py-1.5 text-[13px]" />
                </label>
                <label className="text-[12px] font-semibold text-text-secondary">
                  Source
                  <select value={source}
                    onChange={(e) => setSource(e.target.value)}
                    className="mt-1 w-full border border-border rounded px-3 py-1.5 text-[13px] bg-surface">
                    <option value="fit">FIT</option>
                    <option value="phone">Phone</option>
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="manual">Manual</option>
                  </select>
                </label>
              </div>

              <div className="bg-bg/60 border border-border rounded p-3 text-[12px] text-text-secondary">
                <div className="font-bold text-text-primary mb-1">Office Use Only:</div>
                <ul className="list-disc pl-5 space-y-0.5">
                  <li>Notify SDO for approval if requesting daily overtime on schedule.</li>
                  <li>SDO must approve any labor pattern change — INCREASE in number of hours per week.</li>
                </ul>
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
                          {new Date(r.uploaded_at).toLocaleTimeString("en-US", {
                            timeZone: "America/Chicago",
                            hour: "numeric", minute: "2-digit", hour12: true,
                          })}
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
