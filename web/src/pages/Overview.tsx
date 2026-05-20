import { HeaderBar } from "../components/HeaderBar";
import { KpiCard } from "../components/KpiCard";

export default function Overview() {
  return (
    <>
      <HeaderBar
        title="Overview"
        subtitle="Today's labor health at a glance"
      />
      <main className="max-w-page mx-auto px-5 py-5 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {/* Placeholder KPIs. FIT-017 swaps these for the live values. */}
        <KpiCard label="Sites Open" value="—" />
        <KpiCard label="Active Employees" value="—" />
        <KpiCard label="Punch Exceptions" value="—" />
        <KpiCard label="PAM Resolution Rate" value="—" />
        <KpiCard label="Excess Hours" value="—" />
      </main>
    </>
  );
}
