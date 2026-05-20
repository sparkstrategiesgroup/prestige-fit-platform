import { cn } from "../lib/utils";

type Direction = "up" | "down" | "neutral";

type Props = {
  label: string;
  value: string | number;
  changeText?: string;
  changeDirection?: Direction;
  tooltip?: string;
  /** Optional progress bar (0–100). Used by Response Rate (FIT-006). */
  progressPct?: number;
  progressTargetPct?: number;
};

/**
 * Reusable KPI card. Label uppercased per UX copy §1. Value uses
 * tabular-nums per brief "Stack and conventions".
 */
export function KpiCard({
  label,
  value,
  changeText,
  changeDirection,
  tooltip,
  progressPct,
  progressTargetPct,
}: Props) {
  return (
    <article
      className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-1"
      title={tooltip}
    >
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
        {label}
      </span>
      <span className="text-[28px] font-bold text-text-primary tabular leading-none">
        {value}
      </span>
      {changeText && (
        <span
          className={cn(
            "text-[12px] tabular",
            changeDirection === "up" && "text-good",
            changeDirection === "down" && "text-critical",
            (!changeDirection || changeDirection === "neutral") &&
              "text-text-secondary",
          )}
        >
          {changeText}
        </span>
      )}
      {typeof progressPct === "number" && (
        <div className="mt-2">
          <div
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 bg-border rounded-full overflow-hidden"
          >
            <div
              className="h-full bg-blue-1"
              style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
            />
          </div>
          {typeof progressTargetPct === "number" && (
            <span className="text-[11px] text-text-muted tabular">
              Target {progressTargetPct}%
            </span>
          )}
        </div>
      )}
    </article>
  );
}
