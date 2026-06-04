import { useCallback, useEffect, useState } from "react";
import { TimezoneClocks } from "../components/TimezoneClocks";
import { supabase } from "../lib/supabase";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const EMPTY_DAYS = [0, 0, 0, 0, 0, 0, 0] as const;
const ROW_COUNT = 16;

type SlotRow = {
  role: string;
  employeeName: string;
  start: string;
  end: string;
  meal: string;
  minPeople: number[];
};

function emptyRow(): SlotRow {
  return {
    role: "",
    employeeName: "",
    start: "",
    end: "",
    meal: "",
    minPeople: [...EMPTY_DAYS],
  };
}

function timeDiffHours(start: string, end: string): number {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return +(mins / 60).toFixed(1);
}

function formatDbTime(t: string): string {
  if (!t) return "";
  return t.slice(0, 5);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatHeaderDate(): string {
  const d = new Date();
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).toUpperCase();
}

export default function ShiftForm() {
  const [storeCode, setStoreCode] = useState("");
  const [regionDept, setRegionDept] = useState("");
  const [budgetWinteam, setBudgetWinteam] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayStr());
  const [siteName, setSiteName] = useState("");
  const [requestor, setRequestor] = useState("");
  const [dateCompleted, setDateCompleted] = useState(todayStr());
  const [rows, setRows] = useState<SlotRow[]>(() =>
    Array.from({ length: ROW_COUNT }, emptyRow)
  );
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const totalWeeklyHours = rows.reduce((sum, r) => {
    const shiftHrs = timeDiffHours(r.start, r.end);
    const mealHrs = r.meal ? parseFloat(r.meal) || 0 : 0;
    const netHrs = Math.max(0, shiftHrs - mealHrs);
    const daysActive = r.minPeople.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
    return sum + netHrs * daysActive;
  }, 0);

  const lookupStore = useCallback(async (code: string) => {
    if (!code.trim()) return;
    setLoading(true);
    setStatus("");

    const { data: site } = await supabase
      .from("site")
      .select("site_id,site_name,region_code")
      .eq("site_id", code.trim().toUpperCase())
      .maybeSingle();

    if (!site) {
      setStatus(`No site found for "${code}"`);
      setLoading(false);
      return;
    }

    setSiteName(site.site_name ?? "");
    if (site.region_code) setRegionDept(site.region_code);

    const { data: slots } = await supabase
      .from("schedule_slot")
      .select("role,start_time,end_time,days_of_week")
      .eq("site_id", site.site_id)
      .order("start_time");

    const newRows = Array.from({ length: ROW_COUNT }, emptyRow);

    if (slots && slots.length > 0) {
      slots.forEach((slot, i) => {
        if (i >= ROW_COUNT) return;
        newRows[i] = {
          role: slot.role ?? "",
          employeeName: "",
          start: formatDbTime(slot.start_time),
          end: formatDbTime(slot.end_time),
          meal: "",
          minPeople: (slot.days_of_week as boolean[]).map((active: boolean) =>
            active ? 1 : 0
          ),
        };
      });
      setStatus(`Loaded ${slots.length} schedule slot${slots.length === 1 ? "" : "s"} for ${site.site_name}`);
    } else {
      setStatus(`No schedule slots found for ${site.site_name}`);
    }

    setRows(newRows);
    setLoading(false);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("store");
    if (code) {
      setStoreCode(code);
      lookupStore(code);
    }
  }, [lookupStore]);

  const updateRow = (idx: number, field: keyof SlotRow, value: unknown) => {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const updateMinPeople = (rowIdx: number, dayIdx: number, val: number) => {
    setRows((prev) => {
      const next = [...prev];
      const mp = [...next[rowIdx].minPeople];
      mp[dayIdx] = val;
      next[rowIdx] = { ...next[rowIdx], minPeople: mp };
      return next;
    });
  };

  const rowShiftTotal = (r: SlotRow) => {
    const hrs = timeDiffHours(r.start, r.end);
    const meal = r.meal ? parseFloat(r.meal) || 0 : 0;
    return Math.max(0, hrs - meal);
  };

  const rowWeeklyTotal = (r: SlotRow) => {
    const net = rowShiftTotal(r);
    const days = r.minPeople.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
    return +(net * days).toFixed(1);
  };

  const inputCls =
    "w-full text-[13px] px-2 py-1.5 rounded border border-border bg-surface text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-1";
  const cellInput =
    "w-full text-[12px] px-1 py-1 border-0 bg-transparent text-text-primary text-center focus:outline-none focus:bg-surface-alt";
  const miniInput =
    "w-8 text-[12px] px-0.5 py-0.5 border-0 bg-transparent text-text-primary text-center focus:outline-none focus:bg-surface-alt tabular";

  return (
    <div className="min-h-screen bg-bg text-text-primary font-sans">
      <header className="bg-surface border-b border-border">
        <div className="max-w-page mx-auto px-5 py-4">
          <h1 className="text-[22px] font-bold">{formatHeaderDate()}</h1>
        </div>
      </header>

      <main className="max-w-page mx-auto px-5 py-5 space-y-5">
        <TimezoneClocks />

        <section className="bg-surface border border-border rounded-xl p-6">
          <h2 className="text-xl font-bold text-center mb-1">SHIFT FORM</h2>
          <p className="text-[13px] text-text-muted text-center mb-6">
            Please complete this form for each store any time there is a new
            shift or shift change (the number of employees change or shift time
            changes).
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3 mb-6">
            <div className="flex items-center gap-3">
              <label className="text-[13px] font-semibold text-text-primary whitespace-nowrap w-32 text-right">
                Region/Dept #:
              </label>
              <input
                value={regionDept}
                onChange={(e) => setRegionDept(e.target.value)}
                className={inputCls}
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-[13px] font-semibold text-text-primary whitespace-nowrap w-40 text-right">
                BUDGET IN WINTEAM:
              </label>
              <input
                value={budgetWinteam}
                onChange={(e) => setBudgetWinteam(e.target.value)}
                className={inputCls}
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-[13px] font-semibold text-text-primary whitespace-nowrap w-32 text-right">
                Store #:
              </label>
              <input
                value={storeCode}
                onChange={(e) => setStoreCode(e.target.value)}
                onBlur={() => lookupStore(storeCode)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") lookupStore(storeCode);
                }}
                placeholder="e.g. H3014"
                className={inputCls}
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-[13px] font-semibold text-text-primary whitespace-nowrap w-40 text-right">
                Total Weekly Hours:
              </label>
              <span className="text-[14px] font-bold tabular">
                {totalWeeklyHours.toFixed(1)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-[13px] font-semibold text-text-primary whitespace-nowrap w-32 text-right">
                Effective Date:
              </label>
              <input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          {siteName && (
            <div className="mb-4 text-[13px] text-text-secondary">
              Site: <span className="font-semibold text-text-primary">{siteName}</span>
            </div>
          )}

          {loading && (
            <div className="mb-4 text-[13px] text-blue-1">Loading schedule...</div>
          )}
          {status && !loading && (
            <div className="mb-4 text-[13px] text-text-secondary">{status}</div>
          )}

          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="bg-[#FFF8DC] text-text-primary">
                  <th className="border border-border px-2 py-2 text-left font-semibold w-28">
                    Role Type
                  </th>
                  <th className="border border-border px-2 py-2 text-left font-semibold w-40">
                    Employee Name
                  </th>
                  <th colSpan={2} className="border border-border px-2 py-2 text-center font-semibold">
                    Shift Times
                  </th>
                  <th className="border border-border px-2 py-2 text-center font-semibold w-16">
                    Meal
                  </th>
                  <th className="border border-border px-2 py-2 text-center font-semibold w-16">
                    Shift Total
                  </th>
                  {DAYS.map((d) => (
                    <th
                      key={d}
                      className="border border-border px-1 py-2 text-center font-semibold w-10"
                    >
                      {d}
                    </th>
                  ))}
                  <th className="border border-border px-2 py-2 text-center font-semibold w-16">
                    Weekly Total
                  </th>
                </tr>
                <tr className="bg-[#FFF8DC] text-[11px] text-text-muted">
                  <th className="border border-border px-2 py-1"></th>
                  <th className="border border-border px-2 py-1"></th>
                  <th className="border border-border px-2 py-1 text-center">Start</th>
                  <th className="border border-border px-2 py-1 text-center">End</th>
                  <th className="border border-border px-2 py-1"></th>
                  <th className="border border-border px-2 py-1"></th>
                  {DAYS.map((d) => (
                    <th key={d} className="border border-border px-1 py-1 text-center text-[10px]">
                      Min
                    </th>
                  ))}
                  <th className="border border-border px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => {
                  const filled = row.start || row.end || row.role || row.employeeName;
                  return (
                    <tr
                      key={ri}
                      className={
                        filled
                          ? "bg-[#FFFDE7] hover:bg-[#FFF9C4]"
                          : "bg-surface hover:bg-bg/50"
                      }
                    >
                      <td className="border border-border px-1 py-0.5">
                        <input
                          value={row.role}
                          onChange={(e) => updateRow(ri, "role", e.target.value)}
                          className={cellInput + " text-left"}
                          placeholder=""
                        />
                      </td>
                      <td className="border border-border px-1 py-0.5">
                        <input
                          value={row.employeeName}
                          onChange={(e) =>
                            updateRow(ri, "employeeName", e.target.value)
                          }
                          className={cellInput + " text-left"}
                        />
                      </td>
                      <td className="border border-border px-1 py-0.5">
                        <input
                          type="time"
                          value={row.start}
                          onChange={(e) => updateRow(ri, "start", e.target.value)}
                          className={cellInput}
                        />
                      </td>
                      <td className="border border-border px-1 py-0.5">
                        <input
                          type="time"
                          value={row.end}
                          onChange={(e) => updateRow(ri, "end", e.target.value)}
                          className={cellInput}
                        />
                      </td>
                      <td className="border border-border px-1 py-0.5">
                        <input
                          value={row.meal}
                          onChange={(e) => updateRow(ri, "meal", e.target.value)}
                          className={cellInput}
                          placeholder=""
                        />
                      </td>
                      <td className="border border-border px-1 py-0.5 text-center text-[12px] tabular font-medium">
                        {rowShiftTotal(row).toFixed(1)}
                      </td>
                      {DAYS.map((_, di) => (
                        <td
                          key={di}
                          className="border border-border px-0 py-0.5"
                        >
                          <input
                            type="number"
                            min={0}
                            max={99}
                            value={row.minPeople[di] || ""}
                            onChange={(e) =>
                              updateMinPeople(
                                ri,
                                di,
                                parseInt(e.target.value) || 0
                              )
                            }
                            className={miniInput}
                          />
                        </td>
                      ))}
                      <td className="border border-border px-1 py-0.5 text-center text-[12px] tabular font-medium">
                        {rowWeeklyTotal(row).toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3 mt-6">
            <div>
              <label className="block text-[13px] font-semibold text-text-primary mb-1">
                Requestor / CE Team Member
              </label>
              <input
                value={requestor}
                onChange={(e) => setRequestor(e.target.value)}
                className={inputCls + " bg-[#FFF8DC]"}
              />
            </div>
            <div>
              <label className="block text-[13px] font-semibold text-text-primary mb-1">
                Date Completed
              </label>
              <input
                type="date"
                value={dateCompleted}
                onChange={(e) => setDateCompleted(e.target.value)}
                className={inputCls + " bg-[#FFF8DC]"}
              />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
