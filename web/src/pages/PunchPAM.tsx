import { HeaderBar } from "../components/HeaderBar";

export default function PunchPAM() {
  return (
    <>
      <HeaderBar title="Punch & PAM" subtitle="Exceptions and audit trail" />
      <main className="max-w-page mx-auto px-5 py-5">
        <p className="text-text-muted text-sm">
          Active Punch Exceptions table lands in FIT-018 once the
          checkpoint_snapshot and outreach_attempt tables ship.
        </p>
      </main>
    </>
  );
}
