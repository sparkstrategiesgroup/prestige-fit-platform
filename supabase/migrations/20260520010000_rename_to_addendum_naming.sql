-- =============================================================================
-- FIT-001 (part 1/3): Rename tables and natural-key columns to addendum naming.
-- =============================================================================
-- Per Labor Cost Tracking Addendum §2.1 / §2.2, the canonical entities are
-- `site`, `employee`, and `schedule_slot`. The base schema named them
-- `job_sites` and `employees` with `site_number` / `ee_number` natural keys.
-- This migration:
--   1. Renames the tables.
--   2. Renames `site_number` -> `site_id`, `ee_number` -> `employee_number`
--      (and converts the latter from VARCHAR to INTEGER per addendum spec).
--   3. Re-points plpgsql functions and indexes that referenced the old names.
--   4. Renames the audit/updated_at trigger names for hygiene.
--
-- FK constraints, RLS policies and SQL-language functions track the rename
-- automatically via OID resolution, so they need no explicit rewrite.
-- =============================================================================

-- 1. Rename tables
ALTER TABLE public.job_sites RENAME TO site;
ALTER TABLE public.employees RENAME TO employee;

-- 2. Rename natural-key columns
ALTER TABLE public.site     RENAME COLUMN site_number TO site_id;
ALTER TABLE public.employee RENAME COLUMN ee_number   TO employee_number;

-- 3. Change employee_number type VARCHAR(10) -> INTEGER (addendum §2.2)
--    All existing values verified numeric before merge.
ALTER TABLE public.employee
    ALTER COLUMN employee_number TYPE INTEGER USING (employee_number::INTEGER);

-- 4. Rename indexes to match
ALTER INDEX public.idx_employees_region     RENAME TO idx_employee_region;
ALTER INDEX public.idx_employees_department RENAME TO idx_employee_department;
ALTER INDEX public.idx_employees_status     RENAME TO idx_employee_status;
ALTER INDEX public.idx_employees_auth_user  RENAME TO idx_employee_auth_user;
ALTER INDEX public.idx_job_sites_region     RENAME TO idx_site_region;
ALTER INDEX public.idx_job_sites_client     RENAME TO idx_site_client;
ALTER INDEX public.idx_job_sites_epay_code  RENAME TO idx_site_epay_code;

-- 5. Rename triggers
ALTER TRIGGER trg_updated_employees   ON public.employee RENAME TO trg_updated_employee;
ALTER TRIGGER trg_audit_employees     ON public.employee RENAME TO trg_audit_employee;
ALTER TRIGGER trg_updated_job_sites   ON public.site     RENAME TO trg_updated_site;

-- 6. Rewrite the winteam -> is_manager sync function: was referencing public.employees
--    and casting ee_number::text. Both targets have changed.
CREATE OR REPLACE FUNCTION public.fn_sync_is_manager()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.employee
    SET    is_manager = (
              NEW.classification ILIKE '%manager%'
           OR NEW.classification ILIKE '%supervisor%'
           OR NEW.classification IN ('President', 'VP of Operations')
           )
    WHERE  employee_number = NEW.employee_number;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Recreate the eligibility query so its body reads the new names. The SQL-
--    language function tracks renames via OID, but explicit rewrite keeps
--    pg_dump output honest and lets us update the cross-table join from
--    `e.ee_number = lct.payroll_number` to `e.employee_number = lct.payroll_number::INTEGER`.
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
        'es'::VARCHAR   AS language
    FROM   public.labor_control_tracking lct
    JOIN   public.employee  e ON e.employee_number = lct.payroll_number::INTEGER
    JOIN   public.site      j ON j.id              = lct.job_site_id
    WHERE  lct.work_date      = p_work_date
      AND  lct.shift_block_id = p_shift_block_id
      AND  lct.time_out       IS NULL
      AND  lct.rate_type IS DISTINCT FROM 'Lunch'
      AND  lct.rate_type IS DISTINCT FROM 'LUNCH'
      AND  COALESCE(lct.rate_type,'') NOT ILIKE 'sub%'
      AND  lct.exceptions_in IS NULL
      AND  e.status         = 'active'
      AND  e.phone_valid    = TRUE
      AND  e.is_manager     = FALSE;
$$;
