-- =============================================================================
-- shift-block-runner: SQL helpers
-- =============================================================================
-- fn_eligible_for_shift_block: returns employees who should be texted for a
--   given shift_block on a given work_date. Encodes steps 2-7 of the PDF
--   "OPEN APPROPRIATE LABOR CONTROL FILE" filter chain as one SQL query.
--
-- fn_shift_blocks_due_now: returns the (id, kind) pairs whose warning or
--   clocked-out moment falls in the current minute, evaluated in each
--   block's own timezone.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_eligible_for_shift_block(
    p_shift_block_id INTEGER,
    p_work_date      DATE
)
RETURNS TABLE (
    payroll_number  VARCHAR,
    employee_id     INTEGER,
    employee_name   VARCHAR,
    cell_phone      VARCHAR,
    job_site_name   VARCHAR,
    language        VARCHAR
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT DISTINCT
        lct.payroll_number,
        e.id            AS employee_id,
        lct.employee_name,
        e.cell_phone,
        lct.job_site_name,
        -- Default to Spanish if we have no signal, since the workforce skews
        -- Hispanic — but the runner sends both languages anyway. Keep this
        -- column for future per-employee language preferences.
        'es'::VARCHAR   AS language
    FROM   public.labor_control_tracking lct
    JOIN   public.employees  e ON e.ee_number = lct.payroll_number
    JOIN   public.job_sites  j ON j.id        = lct.job_site_id
    WHERE  lct.work_date      = p_work_date
      AND  lct.shift_block_id = p_shift_block_id
      AND  lct.time_out       IS NULL                      -- open punch (step 4)
      AND  lct.rate_type IS DISTINCT FROM 'Lunch'          -- step 3
      AND  lct.rate_type IS DISTINCT FROM 'LUNCH'
      AND  COALESCE(lct.rate_type,'') NOT ILIKE 'sub%'     -- step 2
      AND  lct.exceptions_in IS NULL                       -- step 5
      AND  e.status         = 'active'
      AND  e.phone_valid    = TRUE
      AND  e.is_manager     = FALSE;                       -- step 7
$$;

COMMENT ON FUNCTION public.fn_eligible_for_shift_block IS
    'Steps 2-7 of the manual Labor Controls filter chain, as one query. Returns one row per eligible employee.';

CREATE OR REPLACE FUNCTION public.fn_shift_blocks_due_now()
RETURNS TABLE (id INTEGER, kind VARCHAR)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
    -- "now" in the block's local timezone, truncated to the minute
    WITH evaluated AS (
        SELECT
            sb.id,
            sb.end_time_local,
            sb.warning_offset,
            sb.clocked_offset,
            (NOW() AT TIME ZONE sb.end_timezone)::TIME AS local_now
        FROM public.shift_blocks sb
        WHERE sb.active = TRUE
    )
    SELECT id, 'warning'::VARCHAR
    FROM   evaluated
    WHERE  DATE_TRUNC('minute', local_now)
         = DATE_TRUNC('minute', (end_time_local - warning_offset)::TIME)
    UNION ALL
    SELECT id, 'clocked_out'::VARCHAR
    FROM   evaluated
    WHERE  DATE_TRUNC('minute', local_now)
         = DATE_TRUNC('minute', (end_time_local + clocked_offset)::TIME);
$$;

COMMENT ON FUNCTION public.fn_shift_blocks_due_now IS
    'Cron entry point. Returns shift_blocks whose warning or clocked-out moment falls in the current minute, evaluated per block timezone.';

-- pg_cron: invoke the Edge Function every minute. Disabled for the stub demo —
-- uncomment once the function is deployed and Text Request credentials land.
-- SELECT cron.schedule(
--     'shift-block-runner-every-minute',
--     '* * * * *',
--     $$ SELECT net.http_post(
--           url := current_setting('app.functions_url') || '/shift-block-runner',
--           headers := jsonb_build_object(
--               'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
--               'Content-Type', 'application/json'
--           ),
--           body := '{}'::jsonb
--        );
--     $$
-- );
