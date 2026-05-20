import { HeaderBar } from "../components/HeaderBar";

export default function Compliance() {
  return (
    <>
      <HeaderBar
        title="Compliance"
        subtitle="Risk register and audit reports"
      />
      <main className="max-w-page mx-auto px-5 py-5">
        <p className="text-text-muted text-sm">
          Compliance Risk Register lands in FIT-020 with the
          &ldquo;Outreach suppression abuse&rdquo; and &ldquo;Stale outreach
          rules&rdquo; categories.
        </p>
      </main>
    </>
  );
}
