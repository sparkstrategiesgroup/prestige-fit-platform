type Props = { children?: React.ReactNode };

/**
 * Container for filter chips. Hidden in print per Definition of Done.
 * Tickets FIT-011 / FIT-018 add chips inside this bar.
 */
export function FiltersBar({ children }: Props) {
  if (!children) return null;
  return (
    <div
      data-print="hide"
      className="bg-surface border-b border-border"
    >
      <div className="max-w-page mx-auto px-5 py-3 flex flex-wrap items-center gap-2">
        {children}
      </div>
    </div>
  );
}
