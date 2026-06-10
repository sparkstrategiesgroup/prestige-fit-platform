/**
 * Standalone SHIFT FORM page (/shift-form). Field supervisors get this link
 * directly — no dashboard context needed. Submissions auto-apply to
 * schedule_slot and surface on Labor Control Tracking via the shift-change
 * banner.
 */
import { ShiftChangeRequestCard } from "../components/ShiftChangeRequestCard";

export default function ShiftFormPage() {
  return (
    <main className="max-w-page mx-auto px-5 py-6 space-y-4">
      <div>
        <h1 className="text-[20px] font-bold text-text-primary">Shift Form</h1>
        <p className="text-[13px] text-text-secondary mt-1">
          Submit a new shift or a shift-time change for your store. Changes
          apply to today's schedule immediately and are flagged on the Labor
          Control Tracking dashboard.
        </p>
      </div>
      <ShiftChangeRequestCard standalone />
    </main>
  );
}
