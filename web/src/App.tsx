import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { TabNav, type TabDef } from "./components/TabNav";
import DailyControl from "./pages/DailyControl";
import Reports from "./pages/Reports";
import ShiftFormPage from "./pages/ShiftFormPage";
import ExceptionsFormPage from "./pages/ExceptionsFormPage";

/**
 * 3 top-level tabs. "Forms" is a parent that routes to /shift-form by default;
 * inside Forms, a secondary pill row (FormsSubNav) lets the user flip between
 * Shift Form and Exceptions Form.
 *
 * Scheduling tab was removed — Schedule Report data still flows in via the
 * existing Edge Function. Uploads are admin-only now (no public UI).
 */
const TABS: TabDef[] = [
  { to: "/daily-control", label: "Labor Control" },
  { to: "/shift-form",    label: "Forms" },
  { to: "/reports",       label: "Reports" },
];

/** Highlight the "Forms" tab whenever the user is on either form page. */
function NavWithFormsHighlight() {
  const { pathname } = useLocation();
  const onFormsPage = pathname === "/shift-form" || pathname === "/exceptions-form";
  const tabs = onFormsPage
    ? TABS.map((t) => (t.label === "Forms" ? { ...t, to: pathname } : t))
    : TABS;
  return <TabNav tabs={tabs} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-bg text-text-primary font-sans">
        <NavWithFormsHighlight />
        <Routes>
          <Route path="/" element={<Navigate to="/daily-control" replace />} />
          <Route path="/daily-control" element={<DailyControl />} />
          <Route path="/reports" element={<Reports />} />
          {/* Forms group — both routes are tabbed via the top "Forms" entry and
              also work as standalone shareable URLs. */}
          <Route path="/shift-form" element={<ShiftFormPage />} />
          <Route path="/exceptions-form" element={<ExceptionsFormPage />} />
          {/* Legacy routes redirect rather than 404 so any bookmarks land safely. */}
          <Route path="/scheduling" element={<Navigate to="/daily-control" replace />} />
          <Route path="/overview" element={<Navigate to="/daily-control" replace />} />
          <Route path="/punch-pam" element={<Navigate to="/daily-control" replace />} />
          <Route path="/shift-coverage" element={<Navigate to="/daily-control" replace />} />
          <Route path="/compliance" element={<Navigate to="/daily-control" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
