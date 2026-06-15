import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { TabNav, type TabDef } from "./components/TabNav";
import DailyControl from "./pages/DailyControl";
import Reports from "./pages/Reports";
import ShiftFormPage from "./pages/ShiftFormPage";
import ExceptionsFormPage from "./pages/ExceptionsFormPage";

const TABS: TabDef[] = [
  { to: "/labor-control", label: "Labor Control" },
  { to: "/shift-form",    label: "Forms" },
  { to: "/reports",       label: "Reports" },
];

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
          <Route path="/" element={<Navigate to="/labor-control" replace />} />
          <Route path="/labor-control" element={<DailyControl />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/shift-form" element={<ShiftFormPage />} />
          <Route path="/exceptions-form" element={<ExceptionsFormPage />} />
          {/* Legacy redirects */}
          <Route path="/daily-control" element={<Navigate to="/labor-control" replace />} />
          <Route path="/scheduling" element={<Navigate to="/labor-control" replace />} />
          <Route path="/overview" element={<Navigate to="/labor-control" replace />} />
          <Route path="/punch-pam" element={<Navigate to="/labor-control" replace />} />
          <Route path="/shift-coverage" element={<Navigate to="/labor-control" replace />} />
          <Route path="/compliance" element={<Navigate to="/labor-control" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
