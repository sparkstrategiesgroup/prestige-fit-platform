-- =============================================================================
-- Bugfix: fn_audit_log assumed every table has an `id` column.
-- =============================================================================
-- The original helper (initial_schema.sql) wrote `NEW.id` into audit_log.record_id
-- without checking whether the table had an `id` column. That broke INSERTs on
-- schedule_slot (PK=slot_id), labor_type (PK=code), email_allowed_senders (PK=email),
-- and contract_bill_rate (composite PK). The audit row itself still captures the
-- full body in new_data/old_data, so record_id being NULL is acceptable.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_record_id BIGINT := NULL;
    v_row       JSONB;
BEGIN
    v_row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;

    BEGIN
        v_record_id := COALESCE(
            (v_row->>'id')::BIGINT,
            (v_row->>'slot_id')::BIGINT
        );
    EXCEPTION WHEN OTHERS THEN
        v_record_id := NULL;
    END;

    IF TG_OP = 'DELETE' THEN
        INSERT INTO public.audit_log (table_name, record_id, action, old_data, changed_by)
        VALUES (TG_TABLE_NAME, v_record_id, 'DELETE', v_row, auth.uid());
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO public.audit_log (table_name, record_id, action, old_data, new_data, changed_by)
        VALUES (TG_TABLE_NAME, v_record_id, 'UPDATE', to_jsonb(OLD), v_row, auth.uid());
    ELSE
        INSERT INTO public.audit_log (table_name, record_id, action, new_data, changed_by)
        VALUES (TG_TABLE_NAME, v_record_id, 'INSERT', v_row, auth.uid());
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Re-attach the schedule_slot audit trigger that had to be dropped during
-- the manual end-to-end test.
DROP TRIGGER IF EXISTS trg_audit_schedule_slot ON public.schedule_slot;
CREATE TRIGGER trg_audit_schedule_slot
    AFTER INSERT OR UPDATE OR DELETE ON public.schedule_slot
    FOR EACH ROW EXECUTE FUNCTION public.fn_audit_log();
