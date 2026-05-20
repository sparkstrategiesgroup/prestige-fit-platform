// Epay Punches Report import — Edge Function
//
// POST /functions/v1/epay-import
//   Content-Type: multipart/form-data
//   Field: file=<the .xlsx>
//
// Auth: requires a logged-in user (verify_jwt is on by default).
//
// Behavior:
//   1. Parse the xlsx (sheet "PunchesReport", header on row 5).
//   2. For each data row:
//        - Resolve site.id from site.epay_site_code = row['Job/Site ID'].
//        - Upsert into labor_control_tracking keyed by
//          (payroll_number, job_site_id, work_date, time_in).
//        - Join job_site_schedules to fill per_schedule_out / per_schedule_hours /
//          people_per_shift / shift_block_id.
//        - Inherit time_zone from site.
//   3. Record the run in epay_imports.
//
// Returns: { import_id, imported, skipped, errors: [...] }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const EXPECTED_HEADERS = [
  "Job/Site ID",
  "Job/Site Name",
  "Date",
  "Payroll No",
  "Employee Name",
  "Rate Type",
  "Time In",
  "Time Out",
  "Actual Hours",
];

type ImportError = { row: number; field?: string; message: string };

function parseEpayDateTime(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  // Epay format: "MM/DD/YYYY HH:MM" (24h). xlsx may give us a number (serial) or string.
  if (typeof raw === "number") {
    // Excel serial → ms
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    return new Date(ms).toISOString();
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, mm, dd, yyyy, hh, mi] = m;
  // We store TIMESTAMPTZ; treat naive Epay times as the site's local time later.
  // For now, build a Z-suffixed string in the row's local wall clock; the
  // shift-block-runner re-interprets it via site.time_zone.
  return `${yyyy}-${mm}-${dd}T${hh ?? "00"}:${mi ?? "00"}:00Z`;
}

function parseEpayDate(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "number") {
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function parseHoursToDecimal(raw: unknown): number | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d+):(\d{2})$/);
  if (!m) return null;
  return parseFloat(m[1]) + parseInt(m[2], 10) / 60;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      global: {
        headers: { Authorization: req.headers.get("Authorization") ?? "" },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return new Response("Missing 'file' field", { status: 400 });
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  const sha = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buf)),
  ).map((b) => b.toString(16).padStart(2, "0")).join("");

  // 1. Open the import audit row
  const { data: importRow, error: insertErr } = await supabase
    .from("epay_imports")
    .insert({
      filename: file.name,
      uploaded_by: user.id,
      file_sha256: sha,
      status: "pending",
    })
    .select("id")
    .single();
  if (insertErr || !importRow) {
    return new Response(`Could not create import row: ${insertErr?.message}`, {
      status: 500,
    });
  }
  const importId = importRow.id;

  // 2. Parse xlsx
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets["PunchesReport"] ?? wb.Sheets[wb.SheetNames[0]];
  // Header is on row 5 (index 4); data starts at row 6 (index 5)
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    blankrows: false,
  });
  const headers = (rows[4] ?? []).map((h) => String(h ?? "").trim());
  const missing = EXPECTED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) {
    await supabase.from("epay_imports").update({
      status: "failed",
      errors: [{ row: 5, message: `Missing headers: ${missing.join(", ")}` }],
      completed_at: new Date().toISOString(),
    }).eq("id", importId);
    return new Response(
      JSON.stringify({ import_id: importId, error: "bad_headers", missing }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const idx = Object.fromEntries(
    EXPECTED_HEADERS.map((h) => [h, headers.indexOf(h)]),
  );

  // 3. Walk data rows
  const errors: ImportError[] = [];
  let imported = 0;
  let skipped = 0;

  for (let r = 5; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[idx["Job/Site ID"]]) {
      skipped++;
      continue;
    }
    const epayCode = String(row[idx["Job/Site ID"]]).trim();

    const { data: site } = await supabase
      .from("site")
      .select("id, time_zone")
      .eq("epay_site_code", epayCode)
      .maybeSingle();

    if (!site) {
      errors.push({
        row: r + 1,
        field: "Job/Site ID",
        message: `Unknown epay_site_code: ${epayCode}`,
      });
      continue;
    }

    const workDate = parseEpayDate(row[idx["Date"]]);
    const timeIn = parseEpayDateTime(row[idx["Time In"]]);
    const timeOut = parseEpayDateTime(row[idx["Time Out"]]);
    if (!workDate || !timeIn) {
      errors.push({
        row: r + 1,
        message: "Date or Time In could not be parsed",
      });
      continue;
    }

    // Match a shift_block from the row's time_out (or per_schedule fallback)
    // by hour-of-day. The runner does the real eligibility; here we just
    // attach the most likely block so the row is easy to query later.
    let shiftBlockId: number | null = null;
    let perScheduleOut: string | null = null;
    let perScheduleHours: number | null = null;
    let peoplePerShift: number | null = null;

    const { data: sched } = await supabase
      .from("job_site_schedules")
      .select(
        "shift_block_id, scheduled_out_local, scheduled_hours, people_per_shift",
      )
      .eq("job_site_id", site.id)
      .eq("active", true)
      .maybeSingle();
    if (sched) {
      shiftBlockId = sched.shift_block_id;
      perScheduleOut = `${workDate}T${sched.scheduled_out_local}Z`;
      perScheduleHours = sched.scheduled_hours;
      peoplePerShift = sched.people_per_shift;
    }

    const upsert = {
      job_site_id: site.id,
      job_site_name: String(row[idx["Job/Site Name"]] ?? "").trim(),
      work_date: workDate,
      payroll_number: String(row[idx["Payroll No"]] ?? "").trim(),
      employee_name: String(row[idx["Employee Name"]] ?? "").trim(),
      rate_type: String(row[idx["Rate Type"]] ?? "").trim() || null,
      time_in: timeIn,
      time_out: timeOut,
      actual_hours: parseHoursToDecimal(row[idx["Actual Hours"]]),
      time_zone: site.time_zone,
      shift_block_id: shiftBlockId,
      per_schedule_out: perScheduleOut,
      per_schedule_hours: perScheduleHours,
      people_per_shift: peoplePerShift,
      epay_import_id: importId,
    };

    const { error } = await supabase
      .from("labor_control_tracking")
      .upsert(upsert, {
        onConflict: "payroll_number,job_site_id,work_date,time_in",
      });
    if (error) {
      errors.push({ row: r + 1, message: error.message });
    } else {
      imported++;
    }
  }

  const status = errors.length === 0
    ? "succeeded"
    : imported > 0
    ? "partial"
    : "failed";

  await supabase.from("epay_imports").update({
    row_count: rows.length - 5,
    imported_count: imported,
    skipped_count: skipped,
    error_count: errors.length,
    errors: errors.length ? errors : null,
    status,
    completed_at: new Date().toISOString(),
  }).eq("id", importId);

  return new Response(
    JSON.stringify({ import_id: importId, imported, skipped, errors }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
