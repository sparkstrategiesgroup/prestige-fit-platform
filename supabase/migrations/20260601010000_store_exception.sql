-- =============================================================================
-- Store exceptions: per-site, per-date operational notes from field teams.
-- =============================================================================
-- Field teams (store managers, ops leads) text/email things like
-- "T0067 closed today" or "KOH0130 reduced staffing". These need to
-- flow into the candidate-filtering logic so we don't text employees
-- at affected sites.
--
-- Surfaces in the UI under the "Exceptions" group on the checkpoint modal
-- (the same group that holds new-employee + subcontractor exclusions).
-- =============================================================================

CREATE TABLE public.store_exception (
  id              BIGSERIAL PRIMARY KEY,
  site_id         VARCHAR(20) NOT NULL REFERENCES public.site(site_id),
  exception_date  DATE        NOT NULL,
  exception_type  VARCHAR(40) NOT NULL
                  CHECK (exception_type IN ('closed','reduced_staffing','do_not_text','holiday','other')),
  note            TEXT,
  source          VARCHAR(20) NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','email','phone','sms')),
  reporter        TEXT,
  created_by      UUID REFERENCES auth.users(id),
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_store_exception_lookup
  ON public.store_exception(site_id, exception_date) WHERE active;

COMMENT ON TABLE public.store_exception IS
  'Per-(site, date) exclusion from end-of-shift texting. Honored by fn_candidates_for_shift_block.';

CREATE TRIGGER trg_updated_store_exception
    BEFORE UPDATE ON public.store_exception
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

ALTER TABLE public.store_exception ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_exception_read_all ON public.store_exception FOR SELECT USING (TRUE);
CREATE POLICY store_exception_admin    ON public.store_exception FOR ALL    USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Update fn_candidates_for_shift_block to honor active store exceptions.
-- Added a CTE `excs` and a LEFT JOIN on (site_id, today). When a candidate's
-- site has an active exception for the work date, the row is EXCLUDED with
-- reason 'Store exception: <note>'.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_candidates_for_shift_block(p_shift_block_id integer, p_work_date date)
 RETURNS TABLE(payroll_number character varying, employee_name character varying, cell_phone character varying, job_site_name character varying, rate_type character varying, status character varying, reason character varying)
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
        lct.job_site_name,
        lct.rate_type,
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
