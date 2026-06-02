/**
 * Day-of-week chip strip. Sun..Sat with today highlighted and a per-day count
 * of active shift blocks. Clicking a chip filters the tile grid to that day's
 * blocks (preview mode); today's data still drives all eligibility.
 *
 * Reuses shift_blocks.days_of_week BOOLEAN[7] passed in via blocks prop.
 */

type Block = {
  id: number;
  days_of_week: boolean[] | null;
};

type Props = {
  blocks: Block[];
  selectedDay: number; // 0..6, Sun..Sat
  onSelectDay: (d: number) => void;
};

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_FULL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function countForDay(blocks: Block[], d: number): number {
  return blocks.filter((b) => !b.days_of_week || b.days_of_week[d]).length;
}

export function DayOfWeekStrip({ blocks, selectedDay, onSelectDay }: Props) {
  const todayDow = new Date().getDay();
  const counts = Array.from({ length: 7 }, (_, d) => countForDay(blocks, d));

  return (
    <section className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted mr-2">
          Day
        </span>
        {DAY_LABELS.map((letter, d) => {
          const isToday = d === todayDow;
          const isSelected = d === selectedDay;
          const count = counts[d];
          const empty = count === 0;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onSelectDay(d)}
              aria-pressed={isSelected}
              className={`flex flex-col items-center justify-center w-12 h-12 rounded-lg border text-[12px] font-semibold transition-colors ${
                isSelected
                  ? "bg-blue-1 text-white border-blue-1 ring-2 ring-blue-1/30"
                  : isToday
                    ? "bg-blue-1/10 text-blue-1 border-blue-1"
                    : empty
                      ? "bg-bg/40 text-text-muted border-border"
                      : "bg-surface text-text-primary border-border hover:border-blue-1"
              }`}
              title={`${DAY_FULL[d]} · ${count} ${count === 1 ? "shift" : "shifts"}`}
            >
              <span className="leading-none">{letter}</span>
              <span className={`text-[10px] mt-0.5 leading-none ${
                isSelected ? "text-white/80" : "text-text-muted"
              }`}>
                {count}
              </span>
            </button>
          );
        })}
        <span className="text-[12px] text-text-secondary ml-4">
          {DAY_FULL[selectedDay]}: <strong>{counts[selectedDay]}</strong>{" "}
          {counts[selectedDay] === 1 ? "shift" : "shifts"}
          {selectedDay !== todayDow && (
            <span className="ml-2 text-text-muted">· preview only</span>
          )}
        </span>
      </div>
    </section>
  );
}
