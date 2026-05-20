-- =============================================================================
-- Backfill employees.is_manager from winteam_employees.classification
-- =============================================================================
-- Source of truth: winteam_employees.classification (text). Anyone whose
-- classification is a manager/supervisor role, President, or VP of Operations
-- is flagged is_manager = TRUE and therefore excluded from end-of-shift
-- texting (PDF p.3 step 7).
--
-- Linkage: employees.ee_number = winteam_employees.employee_number::text
-- =============================================================================

UPDATE public.employees e
SET    is_manager = TRUE
FROM   public.winteam_employees w
WHERE  e.ee_number = w.employee_number::text
  AND  (
        w.classification ILIKE '%manager%'
        OR w.classification ILIKE '%supervisor%'
        OR w.classification IN ('President', 'VP of Operations')
       );

-- Keep is_manager in sync going forward via a trigger on winteam_employees.
-- This fires whenever a winteam_employees row is inserted or its classification
-- changes; pure inserts to employees default to FALSE which is correct.
CREATE OR REPLACE FUNCTION public.fn_sync_is_manager()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.employees
    SET    is_manager = (
              NEW.classification ILIKE '%manager%'
           OR NEW.classification ILIKE '%supervisor%'
           OR NEW.classification IN ('President', 'VP of Operations')
           )
    WHERE  ee_number = NEW.employee_number::text;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_sync_is_manager
    AFTER INSERT OR UPDATE OF classification ON public.winteam_employees
    FOR EACH ROW EXECUTE FUNCTION public.fn_sync_is_manager();
