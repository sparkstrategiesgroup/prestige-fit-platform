import { useEffect, useState } from "react";

type Zone = { label: string; abbr: string; iana: string };

// Order west-to-east-equivalent display: ET / CT / MT / PT matches the
// Kohl's spread called out in addendum §1 NOTES.
const ZONES: Zone[] = [
  { label: "Eastern",  abbr: "ET", iana: "America/New_York" },
  { label: "Central",  abbr: "CT", iana: "America/Chicago" },
  { label: "Mountain", abbr: "MT", iana: "America/Denver" },
  { label: "Pacific",  abbr: "PT", iana: "America/Los_Angeles" },
];

function formatTime(now: Date, iana: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: iana,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
}

function formatWeekdayDate(now: Date, iana: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: iana,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(now);
}

/**
 * Row of live wall clocks across the four US zones the workbook tracks.
 * Updates every second. Tabular-nums for stable digit width.
 */
export function TimezoneClocks() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section
      aria-label="Current time across operating regions"
      className="bg-surface border border-border rounded-xl px-5 py-4"
    >
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
        {ZONES.map((z) => (
          <div key={z.iana} className="flex flex-col">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
              {z.label} · {z.abbr}
            </span>
            <span className="text-[24px] font-bold text-text-primary tabular leading-none mt-0.5">
              {formatTime(now, z.iana)}
            </span>
            <span className="text-[11px] text-text-muted tabular mt-0.5">
              {formatWeekdayDate(now, z.iana)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
