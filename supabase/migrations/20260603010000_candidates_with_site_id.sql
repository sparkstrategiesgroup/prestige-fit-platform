-- =============================================================================
-- fn_candidates_for_shift_block: return site_id (the short code like H3007)
-- alongside job_site_name so the modal can show JOBSITE ID + JOBSITE NAME
-- as separate columns matching the rest of the platform's table conventions.
-- =============================================================================
-- DROP + CREATE since return shape changed.
-- =============================================================================

DROP FUNCTION public.fn_candidates_for_shift_block(integer, date);

CREATE OR REPLACE FUNCTION public.fn_candidates_for_shift_block(p_shift_block_id integer, p_work_date date)
 RETURNS TABLE(
   payroll_number character varying,
   employee_name character varying,
   cell_phone character varying,
   site_id character varying,
   job_site_name character varying,
   rate_type character varying,
   time_in timestamptz,
   time_out timestamptz,
   status character varying,
   reason character varying
 )
 LANGUAGE sql STABLE SECURITY DEFINER
AS $function$
    WITH excs AS (
      SELECT site_id, MAX(note) AS note, MAX(exception_type::text) AS exception_type
      FROM public.store_exception
      WHERE active = TRUE AND exception_date = p_work_date
      GROUP BY site_id
    )
    SELECT
        lct.payroll_number,
        lct.employee_name,
        e.cell_phone,
        s.site_id::VARCHAR,
        lct.job_site_name,
        lct.rate_type,
        lct.time_in,
        lct.time_out,
        CASE
            WHEN lct.time_out IS NOT NULL                              THEN 'EXCLUDED'
            WHEN lct.rate_type ILIKE 'lunch%'                          THEN 'EXCLUDED'
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
            WHEN COALESCE(lct.rate_type,'') ILIKE 'sub%'               THEN 'Substitute / SUB'
            WHEN lct.exceptions_in IS NOT NULL                         THEN 'Punch exception: ' || lct.exceptions_in
            WHEN e.is_manager = TRUE                                   THEN 'Manager / supervisor'
            WHEN e.status     <> 'active'                              THEN 'Employee not active'
            WHEN x.site_id IS NOT NULL                                 THEN 'Store exception: ' || COALESCE(x.note, x.exception_type)
            WHEN e.phone_valid IS DISTINCT FROM TRUE
              OR e.cell_phone IS NULL                                  THEN 'No valid phone on file'
            ELSE                                                            NULL
        END::VARCHAR AS reason
    FROM   public.labor_control_tracking lct
    LEFT JOIN public.employee e ON e.employee_number = lct.payroll_number::INTEGER
    LEFT JOIN public.site s ON s.id = lct.job_site_id
    LEFT JOIN excs x ON x.site_id = s.site_id
    WHERE  lct.work_date      = p_work_date
      AND  lct.shift_block_id = p_shift_block_id;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_candidates_for_shift_block(integer, date) TO anon, authenticated;
