-- =============================================================================
-- Scheduling views: site/classification rate, current master schedule, WinTeam budget export.
-- =============================================================================
-- v_site_classification_rate — for each (site, winteam_classification), the
--   hours-weighted average pay rate from the latest AWR import. The budget
--   export joins to this to populate PayRate.
-- v_master_schedule_current — flat join of the current schedule_slot rows
--   with labor_type + site + the rate view. One row per slot.
-- v_wt_budget_export — pivots into the WinTeam Budget import shape. Hours
--   computed per slot per day-of-week from min_people * shift_length.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_site_classification_rate AS
WITH latest_import AS (
    SELECT MAX(id) AS id
    FROM public.awr_import
    WHERE status = 'succeeded' OR status = 'partial'
),
weighted AS (
    SELECT
        d.job_no                    AS site_id,
        d.winteam_classification,
        SUM(d.hours * d.pay_rate)   AS weighted_wage,
        SUM(d.hours)                AS total_hours
    FROM public.awr_data d
    JOIN latest_import li ON li.id = d.awr_import_id
    WHERE d.job_no IS NOT NULL
      AND d.winteam_classification IS NOT NULL
      AND d.pay_rate IS NOT NULL
      AND d.hours IS NOT NULL
      AND d.hours > 0
    GROUP BY d.job_no, d.winteam_classification
)
SELECT
    site_id,
    winteam_classification,
    CASE WHEN total_hours > 0 THEN ROUND((weighted_wage / total_hours)::NUMERIC, 4) ELSE NULL END AS pay_rate,
    total_hours
FROM weighted;

COMMENT ON VIEW public.v_site_classification_rate IS
    'Hours-weighted average pay rate per (site, winteam_classification) from the latest AWR import. Fuels PayRate in v_wt_budget_export.';

-- -----------------------------------------------------------------------------
-- v_master_schedule_current
-- One row per slot in the current schedule_slot table, with the daily hours
-- pre-computed for the budget pivot. shift_length_hours derives from
-- (end_time - start_time) minus flex_hours (treated as a meal/flex deduction
-- in minutes — adjust later if the user clarifies the FlexHours semantic).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_master_schedule_current AS
SELECT
    s.slot_id,
    s.site_id,
    site.site_name,
    site.chain,
    s.start_time,
    s.end_time,
    s.hours_type_id,
    lt.code        AS labor_type_code,
    lt.name        AS labor_type_name,
    lt.wt_hours_type_id,
    s.days_of_week,
    s.flex_hours,
    -- Shift length in hours: (end - start) minutes / 60, minus flex_hours (assumed minutes)
    GREATEST(0,
        (EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 3600.0)
        - COALESCE(s.flex_hours, 0) / 60.0
    )::NUMERIC(10, 4) AS shift_length_hours,
    s.supervisor_id,
    s.notify_contact,
    s.time_zone,
    s.role,
    s.master_schedule_revision_id
FROM public.schedule_slot s
JOIN public.site site ON site.site_id = s.site_id
LEFT JOIN public.labor_type lt
    ON lt.wt_hours_type_id = s.hours_type_id;

COMMENT ON VIEW public.v_master_schedule_current IS
    'Current schedule_slot rows joined with site + labor_type and shift_length_hours pre-computed.';

-- -----------------------------------------------------------------------------
-- v_wt_budget_export
-- Pivots the master schedule into the WinTeam Budget import shape.
-- One row per (site, classification, hours_type_id) for an effective date.
-- Hours per day = shift_length_hours * min_people_for_that_day, summed across
-- all slots at that site for that classification.
-- BillRate joins contract_bill_rate where the effective date is within range.
-- Subcontract Labor excluded.
-- The effective_date is parameterized via a function call (see fn_wt_budget_export).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_wt_budget_export(p_effective_date DATE)
RETURNS TABLE (
    job_number              VARCHAR(20),
    effective_date          DATE,
    notes                   TEXT,
    description             VARCHAR(80),
    hours_type_id           INTEGER,
    hours_sun               NUMERIC,
    hours_mon               NUMERIC,
    hours_tue               NUMERIC,
    hours_wed               NUMERIC,
    hours_thu               NUMERIC,
    hours_fri               NUMERIC,
    hours_sat               NUMERIC,
    hours_holiday           NUMERIC,
    pay_rate                NUMERIC,
    bill_rate               NUMERIC,
    for_salaried_employee   BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
    WITH per_slot AS (
        SELECT
            v.site_id,
            v.labor_type_code,
            v.labor_type_name,
            v.wt_hours_type_id,
            v.shift_length_hours,
            v.days_of_week
        FROM public.v_master_schedule_current v
        JOIN public.labor_type lt
            ON lt.code = v.labor_type_code
           AND lt.include_in_budget = TRUE
           AND lt.active = TRUE
    ),
    expanded AS (
        SELECT
            site_id,
            labor_type_code,
            labor_type_name,
            wt_hours_type_id,
            SUM(CASE WHEN days_of_week[1] THEN shift_length_hours ELSE 0 END) AS hours_sun,
            SUM(CASE WHEN days_of_week[2] THEN shift_length_hours ELSE 0 END) AS hours_mon,
            SUM(CASE WHEN days_of_week[3] THEN shift_length_hours ELSE 0 END) AS hours_tue,
            SUM(CASE WHEN days_of_week[4] THEN shift_length_hours ELSE 0 END) AS hours_wed,
            SUM(CASE WHEN days_of_week[5] THEN shift_length_hours ELSE 0 END) AS hours_thu,
            SUM(CASE WHEN days_of_week[6] THEN shift_length_hours ELSE 0 END) AS hours_fri,
            SUM(CASE WHEN days_of_week[7] THEN shift_length_hours ELSE 0 END) AS hours_sat
        FROM per_slot
        GROUP BY site_id, labor_type_code, labor_type_name, wt_hours_type_id
    )
    SELECT
        e.site_id::VARCHAR(20)                AS job_number,
        p_effective_date                      AS effective_date,
        NULL::TEXT                            AS notes,
        e.labor_type_name::VARCHAR(80)        AS description,
        e.wt_hours_type_id                    AS hours_type_id,
        ROUND(e.hours_sun, 4) AS hours_sun,
        ROUND(e.hours_mon, 4) AS hours_mon,
        ROUND(e.hours_tue, 4) AS hours_tue,
        ROUND(e.hours_wed, 4) AS hours_wed,
        ROUND(e.hours_thu, 4) AS hours_thu,
        ROUND(e.hours_fri, 4) AS hours_fri,
        ROUND(e.hours_sat, 4) AS hours_sat,
        0::NUMERIC                            AS hours_holiday,
        rate.pay_rate                         AS pay_rate,
        cbr.bill_rate                         AS bill_rate,
        (e.labor_type_code IN ('FACILITIES_SUPERVISOR','PROJECT_TECH')) AS for_salaried_employee
    FROM expanded e
    LEFT JOIN public.v_site_classification_rate rate
        ON rate.site_id = e.site_id
       AND rate.winteam_classification = e.labor_type_code
    LEFT JOIN public.contract_bill_rate cbr
        ON cbr.site_id = e.site_id
       AND cbr.winteam_classification = e.labor_type_code
       AND cbr.effective_from <= p_effective_date
       AND (cbr.effective_to IS NULL OR cbr.effective_to >= p_effective_date)
    WHERE (e.hours_sun + e.hours_mon + e.hours_tue + e.hours_wed +
           e.hours_thu + e.hours_fri + e.hours_sat) > 0
    ORDER BY e.site_id, e.labor_type_name;
$$;

COMMENT ON FUNCTION public.fn_wt_budget_export IS
    'Returns the WinTeam Budget import rows for a given effective_date. Subcontract Labor excluded. Salaried defaults set for Facilities Supervisor and Project Tech.';

GRANT EXECUTE ON FUNCTION public.fn_wt_budget_export TO authenticated, anon;
