import { NavLink, useLocation } from "react-router-dom";
import { cn } from "../lib/utils";

export type TabDef = { to: string; label: string };

type Props = { tabs: TabDef[] };

/**
 * Tab navigation with ARIA tablist semantics. Brief Definition of Done:
 * full keyboard order; Tab key reaches every interactive element in the
 * order defined in original handoff §8.3.
 *
 * Per UX copy §1, the Daily Control tab is inserted between Overview and
 * Punch & PAM. That ordering is enforced by whoever builds the `tabs` array
 * — this component does not opine.
 */
export function TabNav({ tabs }: Props) {
  const { pathname } = useLocation();
  return (
    <nav
      role="tablist"
      aria-label="Primary"
      data-print="hide"
      className="bg-surface border-b border-border"
    >
      <div className="max-w-page mx-auto px-5">
        <ul className="flex gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const active = pathname === t.to ||
              (t.to !== "/" && pathname.startsWith(t.to));
            return (
              <li key={t.to} role="presentation" className="shrink-0">
                <NavLink
                  to={t.to}
                  role="tab"
                  aria-selected={active}
                  className={cn(
                    "block px-4 py-3 text-[13px] font-semibold",
                    "border-b-2 -mb-px transition-colors",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-1",
                    active
                      ? "text-blue-1 border-blue-1"
                      : "text-text-secondary border-transparent hover:text-text-primary",
                  )}
                >
                  {t.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
