// wt-budget-export — GET /functions/v1/wt-budget-export?effective_date=YYYY-MM-DD
// Returns text/csv in the WinTeam Budget Template shape (Screenshot 3 columns):
//   JobNumber, EffectiveDate, Notes, Description, HoursTypeID,
//   HoursSun, HoursMon, HoursTue, HoursWed, HoursThu, HoursFri, HoursSat,
//   HoursHoliday, PayRate, BillRate, ForSalariedEmployee
//
// Derives from fn_wt_budget_export(date). Subcontract Labor excluded.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const url = new URL(req.url);
  const effDate = url.searchParams.get("effective_date");
  if (!effDate || !/^\d{4}-\d{2}-\d{2}$/.test(effDate)) {
    return new Response("effective_date=YYYY-MM-DD required", { status: 400, headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data, error } = await supabase.rpc("fn_wt_budget_export", {
    p_effective_date: effDate,
  });

  if (error) {
    return new Response(`export_failed: ${error.message}`, { status: 500, headers: CORS });
  }

  const header = [
    "JobNumber","EffectiveDate","Notes","Description","HoursTypeID",
    "HoursSun","HoursMon","HoursTue","HoursWed","HoursThu","HoursFri","HoursSat",
    "HoursHoliday","PayRate","BillRate","ForSalariedEmployee",
  ];
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      csvCell(r.job_number),
      csvCell(r.effective_date),
      csvCell(r.notes),
      csvCell(r.description),
      csvCell(r.hours_type_id),
      csvCell(r.hours_sun),
      csvCell(r.hours_mon),
      csvCell(r.hours_tue),
      csvCell(r.hours_wed),
      csvCell(r.hours_thu),
      csvCell(r.hours_fri),
      csvCell(r.hours_sat),
      csvCell(r.hours_holiday),
      csvCell(r.pay_rate),
      csvCell(r.bill_rate),
      csvCell(r.for_salaried_employee ? "Yes" : ""),
    ].join(","));
  }

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="wt-budget-${effDate}.csv"`,
    },
  });
});
