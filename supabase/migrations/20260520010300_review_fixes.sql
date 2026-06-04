-- =============================================================================
-- Code-review fixes: data alignment, missing function, deduplication guard
-- =============================================================================

-- 1. Align shift_blocks.clients with the new site.chain enum.
--    Migration 20260520010100 renamed HOME_DEPOT → HARDLINES in site.chain
--    but never updated the seed data in shift_blocks.
UPDATE public.shift_blocks
SET    clients = array_replace(clients, 'HOME_DEPOT', 'HARDLINES');

-- 2. Create fn_candidates_for_shift_block — returns ALL candidates (eligible
--    + excluded) with a status and reason, so the UI can show why employees
--    were filtered out.
CREATE OR REPLACE FUNCTION public.fn_candidates_for_shift_block(
    p_shift_block_id INTEGER,
    p_work_date      DATE
)
RETURNS TABLE (
    payroll_number  VARCHAR,
    employee_name   VARCHAR,
    cell_phone      VARCHAR,
    job_site_name   VARCHAR,
    rate_type       VARCHAR,
    status          VARCHAR,
    reason          VARCHAR
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT
        lct.payroll_number,
        lct.employee_name,
        e.cell_phone,
        lct.job_site_name,
        lct.rate_type,
        CASE
            WHEN lct.time_out IS NOT NULL              THEN 'EXCLUDED'
            WHEN lct.rate_type ILIKE 'lunch'           THEN 'EXCLUDED'
            WHEN COALESCE(lct.rate_type,'') ILIKE 'sub%' THEN 'EXCLUDED'
            WHEN lct.exceptions_in IS NOT NULL         THEN 'EXCLUDED'
            WHEN e.id IS NULL                          THEN 'EXCLUDED'
            WHEN e.status <> 'active'                  THEN 'EXCLUDED'
            WHEN e.phone_valid = FALSE                 THEN 'EXCLUDED'
            WHEN e.is_manager = TRUE                   THEN 'EXCLUDED'
            ELSE 'ELIGIBLE'
        END AS status,
        CASE
            WHEN lct.time_out IS NOT NULL              THEN 'Already clocked out'
            WHEN lct.rate_type ILIKE 'lunch'           THEN 'Lunch row'
            WHEN COALESCE(lct.rate_type,'') ILIKE 'sub%' THEN 'Sub/substitute'
            WHEN lct.exceptions_in IS NOT NULL         THEN 'Has exception'
            WHEN e.id IS NULL                          THEN 'Employee not in system'
            WHEN e.status <> 'active'                  THEN 'Inactive employee'
            WHEN e.phone_valid = FALSE                 THEN 'No valid phone'
            WHEN e.is_manager = TRUE                   THEN 'Manager/supervisor'
            ELSE NULL
        END AS reason
    FROM   public.labor_control_tracking lct
    LEFT JOIN public.employee e ON e.employee_number = lct.payroll_number::INTEGER
    WHERE  lct.work_date      = p_work_date
      AND  lct.shift_block_id = p_shift_block_id;
$$;

-- 3. Deduplication guard: prevent the shift-block-runner from double-sending
--    within the same day for the same employee, block, and notification type.
CREATE UNIQUE INDEX idx_notifications_dedup
    ON public.notifications (employee_id, shift_block_id, notification_type, (scheduled_for::date))
    WHERE shift_block_id IS NOT NULL AND scheduled_for IS NOT NULL;
