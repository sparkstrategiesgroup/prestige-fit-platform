import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { TabNav, type TabDef } from "./components/TabNav";
import Overview from "./pages/Overview";
import DailyControl from "./pages/DailyControl";
import PunchPAM from "./pages/PunchPAM";
import ShiftCoverage from "./pages/ShiftCoverage";
import Compliance from "./pages/Compliance";

/**
 * Top-level tabs. Daily Control inserted between Overview and Punch & PAM
 * per addendum §3.1 / UX copy §1 (FIT-005).
 */
const TABS: TabDef[] = [
  { to: "/overview", label: "Overview" },
  { to: "/daily-control", label: "Daily Control" },
  { to: "/punch-pam", label: "Punch & PAM" },
  { to: "/shift-coverage", label: "Shift Coverage" },
  { to: "/compliance", label: "Compliance" },
];

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-bg text-text-primary font-sans">
        <TabNav tabs={TABS} />
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<Overview />} />
          <Route path="/daily-control" element={<DailyControl />} />
          <Route path="/punch-pam" element={<PunchPAM />} />
          <Route path="/shift-coverage" element={<ShiftCoverage />} />
          <Route path="/compliance" element={<Compliance />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
