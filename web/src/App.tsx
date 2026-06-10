import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { TabNav, type TabDef } from "./components/TabNav";
import DailyControl from "./pages/DailyControl";
import Scheduling from "./pages/Scheduling";
import Reports from "./pages/Reports";
import ShiftFormPage from "./pages/ShiftFormPage";
import ExceptionsFormPage from "./pages/ExceptionsFormPage";

/**
 * 3 tabs. Overview / Punch & PAM / Shift Coverage / Compliance pages
 * stay in the repo but are unrouted — quick to re-enable.
 */
const TABS: TabDef[] = [
  { to: "/daily-control", label: "Labor Control Tracking" },
  { to: "/scheduling",    label: "Scheduling" },
  { to: "/reports",       label: "Reports" },
];

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-bg text-text-primary font-sans">
        <TabNav tabs={TABS} />
        <Routes>
          <Route path="/" element={<Navigate to="/daily-control" replace />} />
          <Route path="/daily-control" element={<DailyControl />} />
          <Route path="/scheduling" element={<Scheduling />} />
          <Route path="/reports" element={<Reports />} />
          {/* Standalone field-facing forms — shareable links, no tab in the nav. */}
          <Route path="/shift-form" element={<ShiftFormPage />} />
          <Route path="/exceptions-form" element={<ExceptionsFormPage />} />
          {/* Legacy routes redirect rather than 404 so any bookmarks land safely. */}
          <Route path="/overview" element={<Navigate to="/daily-control" replace />} />
          <Route path="/punch-pam" element={<Navigate to="/daily-control" replace />} />
          <Route path="/shift-coverage" element={<Navigate to="/daily-control" replace />} />
          <Route path="/compliance" element={<Navigate to="/daily-control" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
