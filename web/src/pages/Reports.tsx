import { useEffect, useRef, useState } from "react";
import { HeaderBar } from "../components/HeaderBar";
import { supabase } from "../lib/supabase";

const FUNCTIONS_URL = `${
  import.meta.env.VITE_SUPABASE_URL ?? "https://sshhcpzleurztzksrlvr.supabase.co"
}/functions/v1`;

type Import = {
  id: number;
  filename: string;
  status: string;
  row_count: number | null;
  imported_count: number | null;
  skipped_count: number | null;
  error_count: number | null;
  errors: unknown;
  completed_at: string | null;
  created_at: string;
};

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }) + " CT";
}

export default function Reports() {
  const [imports, setImports] = useState<Import[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);
  // Blueforce Tracker upload state — separate so a punches upload doesn't
  // clobber the tracker progress message and vice versa.
  const [bfUploading, setBfUploading] = useState(false);
  const [bfStatus, setBfStatus] = useState<string>("");
  const bfFileRef = useRef<HTMLInputElement>(null);

  const handleBlueforceUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBfUploading(true);
    setBfStatus(`Uploading ${file.name}…`);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${FUNCTIONS_URL}/blueforce-tracker-import`, {
        method: "POST", body: fd,
      });
      const body = await res.json();
      if (!res.ok) {
        setBfStatus(`Failed: ${body.error ?? JSON.stringify(body)}`);
      } else {
        const skipped = body.skipped_unknown_sites?.length ?? 0;
        setBfStatus(
          `Parsed ${body.rows_parsed} rows · inserted ${body.inserted} store exceptions${
            skipped > 0 ? ` · skipped ${skipped} unknown site${skipped === 1 ? "" : "s"}` : ""
          }.`,
        );
      }
    } catch (err) {
      setBfStatus(`Failed: ${(err as Error).message}`);
    } finally {
      setBfUploading(false);
      if (bfFileRef.current) bfFileRef.current.value = "";
    }
  };

  const load = async () => {
    const { data } = await supabase
      .from("epay_imports")
      .select("id, filename, status, row_count, imported_count, skipped_count, error_count, errors, completed_at, created_at")
      .order("id", { ascending: false })
      .limit(50);
    setImports((data ?? []) as Import[]);
  };

  useEffect(() => { load(); }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadStatus(`Uploading ${file.name}…`);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${FUNCTIONS_URL}/epay-import`, { method: "POST", body: fd });
      const body = await res.json();
      if (!res.ok) {
        setUploadStatus(`Failed: ${JSON.stringify(body)}`);
      } else {
        setUploadStatus(
          `Imported ${body.imported} of ${body.imported + body.skipped + (body.errors?.length ?? 0)} rows · ${body.sites_created} sites created · ${body.errors?.length ?? 0} errors.`,
        );
        load();
      }
    } catch (err) {
      setUploadStatus(`Failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const receivedToday = imports.filter(
    (i) => i.completed_at && new Date(i.completed_at).toDateString() === new Date().toDateString(),
  ).length;

  return (
    <>
      <HeaderBar
        title="Reports"
        subtitle="ePay Punches Report uploads and history"
      />
      <main className="max-w-page mx-auto px-5 py-5 space-y-5">
        {/* Upload card */}
        <section className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Upload Punches Report
              </h2>
              <p className="text-[13px] text-text-secondary mt-1">
                Drop the .xlsx or .csv export from Epay. We'll parse it,
                auto-create any new sites, and refresh the Labor Control
                Tracking dashboard.
              </p>
            </div>
            <label className="cursor-pointer bg-blue-1 hover:bg-blue-2 text-white text-[13px] font-semibold px-4 py-2 rounded-md transition-colors disabled:opacity-50">
              {uploading ? "Uploading…" : "Choose file (.xlsx or .csv)"}
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.csv"
                onChange={handleUpload}
                disabled={uploading}
                className="hidden"
              />
            </label>
          </div>
          {uploadStatus && (
            <div className="mt-3 text-[13px] text-text-secondary tabular">
              {uploadStatus}
            </div>
          )}
        </section>

        {/* Blueforce Tracker upload — store exceptions source of truth */}
        <section className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Upload Blueforce Tracker
              </h2>
              <p className="text-[13px] text-text-secondary mt-1">
                Drop a chain's Blueforce Tracker .xlsx. We'll read the
                "Payroll Text Exceptions" sheet and create one Store
                Exception per row (Notes → exception type, Dept → reporter).
                Land on the Labor Control Tracking page to see them.
              </p>
            </div>
            <label className="cursor-pointer bg-blue-1 hover:bg-blue-2 text-white text-[13px] font-semibold px-4 py-2 rounded-md transition-colors disabled:opacity-50">
              {bfUploading ? "Uploading…" : "Choose .xlsx file"}
              <input
                ref={bfFileRef}
                type="file"
                accept=".xlsx"
                onChange={handleBlueforceUpload}
                disabled={bfUploading}
                className="hidden"
              />
            </label>
          </div>
          {bfStatus && (
            <div className="mt-3 text-[13px] text-text-secondary tabular">
              {bfStatus}
            </div>
          )}
        </section>

        {/* Import history */}
        <section className="bg-surface border border-border rounded-xl">
          <div className="p-5 border-b border-border flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Import history
              </h2>
              <p className="text-[13px] text-text-secondary mt-1">
                Every Punches Report that landed via manual upload or the
                Power Automate email webhook.
              </p>
            </div>
            <span className="text-[12px] text-text-secondary tabular">
              <strong className="text-text-primary">{receivedToday}</strong> today · {imports.length} total
            </span>
          </div>
          {imports.length === 0 ? (
            <div className="p-6 text-[13px] text-text-secondary">
              No imports yet. Upload a Punches Report above to get started.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] tabular">
                <thead className="bg-bg text-text-muted uppercase text-[10px] tracking-[0.06em]">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">#</th>
                    <th className="text-left px-3 py-2 font-semibold">Filename</th>
                    <th className="text-left px-3 py-2 font-semibold">Completed</th>
                    <th className="text-right px-3 py-2 font-semibold">Rows</th>
                    <th className="text-right px-3 py-2 font-semibold">Imported</th>
                    <th className="text-right px-3 py-2 font-semibold">Errors</th>
                    <th className="text-left px-3 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {imports.map((i) => (
                    <tr key={i.id}>
                      <td className="px-3 py-1.5 text-text-secondary font-semibold">{i.id}</td>
                      <td className="px-3 py-1.5 text-text-primary whitespace-nowrap max-w-[400px] truncate">
                        {i.filename}
                      </td>
                      <td className="px-3 py-1.5 text-text-secondary whitespace-nowrap">{fmtTime(i.completed_at ?? i.created_at)}</td>
                      <td className="px-3 py-1.5 text-right text-text-secondary">{i.row_count ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right text-text-primary font-semibold">{i.imported_count ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right">
                        {(i.error_count ?? 0) > 0 ? (
                          <span className="text-warning font-semibold">{i.error_count}</span>
                        ) : (
                          <span className="text-text-muted">0</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded ${
                          i.status === "succeeded"
                            ? "bg-good/10 text-good"
                            : i.status === "partial"
                              ? "bg-warning/15 text-warning"
                              : i.status === "failed"
                                ? "bg-danger/10 text-danger"
                                : "bg-bg text-text-muted"
                        }`}>
                          {i.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
