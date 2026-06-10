/**
 * Standalone EXCEPTIONS FORM page (/exceptions-form). Field teams paste the
 * day's store list + reasons; each row becomes a store_exception that pulls
 * those sites out of end-of-shift texting for today.
 */
import { StoreExceptionsCard } from "../components/StoreExceptionsCard";

export default function ExceptionsFormPage() {
  return (
    <main className="max-w-page mx-auto px-5 py-6 space-y-4">
      <div>
        <h1 className="text-[20px] font-bold text-text-primary">Exceptions Form</h1>
        <p className="text-[13px] text-text-secondary mt-1">
          Stores listed here are ignored for today — no end-of-shift texts, no
          adjustments. Paste a list of store numbers to fill rows fast.
        </p>
      </div>
      <StoreExceptionsCard standalone onChange={() => {}} />
    </main>
  );
}
