-- Broaden the Subcontractor exclusion in fn_candidates_for_shift_block so
-- malformed placeholder names like "SubH2108, Sub H2108" (no space between
-- "Sub" and the site code) are caught the same way as "Sub H2108, Sub H2108".
--
-- Old rule: employee_name ILIKE 'Sub %' OR ILIKE 'Sub,%'
-- New rule: employee_name ILIKE 'Sub%'  (case-insensitive prefix only)
--
-- All-time scan against labor_control_tracking confirmed every name starting
-- with 'Sub' (case insensitive) is a placeholder subcontractor record - no
-- real surnames begin with "Sub", so the broader prefix is safe.

CREATE OR REPLACE FUNCTION public.fn_candidates_for_shift_block(p_shift_block_id integer, p_work_date date)
 RETURNS TABLE(payroll_number character varying, employee_name character varying, cell_phone character varying, site_id character varying, job_site_name character varying, rate_type character varying, time_in timestamp with time zone, time_out timestamp with time zone, status character varying, reason character varying)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
    WITH
    sb AS (
      SELECT end_time_local FROM public.shift_blocks WHERE id = p_shift_block_id
    ),
    dow AS (
      SELECT (EXTRACT(DOW FROM p_work_date)::INT + 1) AS idx
    ),
    excs AS (
      SELECT site_id, MAX(note) AS note, MAX(exception_type::text) AS exception_type
      FROM public.store_exception
      WHERE active = TRUE AND exception_date = p_work_date
      GROUP BY site_id
    ),
    scheduled_sites AS (
      SELECT DISTINCT ss.site_id
      FROM public.schedule_slot ss
      CROSS JOIN sb
      CROSS JOIN dow
      WHERE ss.end_time = sb.end_time_local
        AND ss.days_of_week[dow.idx] = TRUE
    )
    SELECT
        lct.payroll_number,
        lct.employee_name,
        e.cell_phone,
        s.site_id,
        lct.job_site_name,
        lct.rate_type,
        lct.time_in,
        lct.time_out,
        CASE
            WHEN lct.time_out IS NOT NULL                              THEN 'EXCLUDED'
            WHEN lct.rate_type ILIKE 'lunch%'                          THEN 'EXCLUDED'
            WHEN lct.employee_name ILIKE 'Sub%'                        THEN 'EXCLUDED'
            WHEN COALESCE(lct.rate_type,'') ILIKE 'sub%'               THEN 'EXCLUDED'
            WHEN lct.exceptions_in IS NOT NULL                         THEN 'EXCLUDED'
            WHEN e.is_manager = TRUE                                   THEN 'EXCLUDED'
            WHEN e.status     <> 'active'                              THEN 'EXCLUDED'
            WHEN x.site_id IS NOT NULL                                 THEN 'EXCLUDED'
            WHEN e.phone_valid IS DISTINCT FROM TRUE
              OR e.cell_phone IS NULL                                  THEN 'EXCLUDED'
            ELSE                                                            'ELIGIBLE'
        END::VARCHAR AS status,
        CASE
            WHEN lct.time_out IS NOT NULL                              THEN 'Already clocked out'
            WHEN lct.rate_type ILIKE 'lunch%'                          THEN 'Lunch punch'
            WHEN lct.employee_name ILIKE 'Sub%'                        THEN 'Subcontractor'
            WHEN COALESCE(lct.rate_type,'') ILIKE 'sub%'               THEN 'Subcontractor'
            WHEN lct.exceptions_in IS NOT NULL                         THEN 'Punch exception: ' || lct.exceptions_in
            WHEN e.is_manager = TRUE                                   THEN 'Manager / supervisor'
            WHEN e.status     <> 'active'                              THEN 'Employee not active'
            WHEN x.site_id IS NOT NULL                                 THEN 'Store exception: ' || COALESCE(x.note, x.exception_type)
            WHEN e.phone_valid IS DISTINCT FROM TRUE
              OR e.cell_phone IS NULL                                  THEN 'No valid phone on file'
            ELSE                                                            NULL
        END::VARCHAR AS reason
    FROM   public.labor_control_tracking lct
    JOIN   public.site s ON s.id = lct.job_site_id
    JOIN   scheduled_sites sch ON sch.site_id = s.site_id
    LEFT JOIN public.employee e ON e.employee_number = lct.payroll_number::INTEGER
    LEFT JOIN excs x ON x.site_id = s.site_id
    WHERE  lct.work_date = p_work_date;
$function$;
