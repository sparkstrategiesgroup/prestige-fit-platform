import { HeaderBar } from "../components/HeaderBar";

export default function ShiftCoverage() {
  return (
    <>
      <HeaderBar
        title="Shift Coverage"
        subtitle="Live headcount across all sites"
      />
      <main className="max-w-page mx-auto px-5 py-5">
        <p className="text-text-muted text-sm">
          Multi-slot site cards (addendum §1.3) land in FIT-019.
        </p>
      </main>
    </>
  );
}
