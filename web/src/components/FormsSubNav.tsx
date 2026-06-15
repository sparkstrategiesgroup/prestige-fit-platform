import { NavLink } from "react-router-dom";
import { cn } from "../lib/utils";

const PILLS = [
  { to: "/shift-form",      label: "Shift Form" },
  { to: "/exceptions-form", label: "Exceptions Form" },
];

/**
 * Secondary pill row shown above the Shift Form and Exceptions Form pages.
 * The top-level "Forms" tab in App.tsx routes to /shift-form by default;
 * this strip lets the user flip between the two forms without bouncing back
 * to the dashboard.
 */
export function FormsSubNav() {
  return (
    <div className="bg-surface border-b border-border">
      <div className="max-w-page mx-auto px-5 py-2 flex gap-2">
        {PILLS.map((p) => (
          <NavLink
            key={p.to}
            to={p.to}
            className={({ isActive }) =>
              cn(
                "px-3 py-1.5 rounded-md text-[13px] font-semibold transition-colors",
                isActive
                  ? "bg-blue-1 text-white"
                  : "text-text-secondary hover:bg-bg",
              )
            }
          >
            {p.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
