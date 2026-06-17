-- =============================================================================
-- Schedule Report: capture the columns the real WinTeam export actually carries.
-- =============================================================================
-- The importer (parse-master-schedule.ts) was written against a column set the
-- real "Schedule Report" export does NOT have (it expected HoursTypeID, Tue/Thu,
-- TimeZone, SupervisorID, …; the real file has Dept, JobDescription, JobState,
-- TimeZoneName, Tues/Thur, Lunch, TotalHours, HoursTypeDescription). As a result
-- uploads failed and the 728-row baseline was loaded out-of-band (revision #1,
-- "…(WinTeam baseline)", has zero master_schedule_change rows).
--
-- This migration adds the fields the rewritten parser now populates:
--   * schedule_slot.total_hours            <- report "TotalHours"
--   * schedule_slot.hours_type_description <- report "HoursTypeDescription"
--   * site.dept_code / site.dept_description <- report "Dept" ("3003 - West")
--   * site.state                            <- report "JobState"
-- Unpaid lunch keeps using schedule_slot.flex_hours (in MINUTES = Lunch * 60),
-- matching the existing baseline rows and the Shift form's "meal" field.
-- =============================================================================

ALTER TABLE public.schedule_slot
    ADD COLUMN IF NOT EXISTS total_hours            NUMERIC(6,2),
    ADD COLUMN IF NOT EXISTS hours_type_description TEXT;

COMMENT ON COLUMN public.schedule_slot.total_hours IS
    'Weekly total hours from the Schedule Report "TotalHours" column.';
COMMENT ON COLUMN public.schedule_slot.hours_type_description IS
    'Schedule Report "HoursTypeDescription" (e.g. "Labor Direct - CO").';

ALTER TABLE public.site
    ADD COLUMN IF NOT EXISTS dept_code        VARCHAR(20),
    ADD COLUMN IF NOT EXISTS dept_description VARCHAR(80),
    ADD COLUMN IF NOT EXISTS state            VARCHAR(10);

COMMENT ON COLUMN public.site.dept_code IS
    'Department code from the Schedule Report "Dept" column (e.g. "3003" of "3003 - West"). Source of truth for the Shift form Region/Dept #.';
COMMENT ON COLUMN public.site.dept_description IS
    'Department / region label from the Schedule Report "Dept" column (e.g. "West" of "3003 - West").';
COMMENT ON COLUMN public.site.state IS
    'Store state from the Schedule Report "JobState" column (e.g. "CO").';

-- -----------------------------------------------------------------------------
-- Extend fn_apply_master_schedule_revision to persist total_hours +
-- hours_type_description. Body is otherwise identical to the live definition.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_apply_master_schedule_revision(p_revision_id bigint)
 RETURNS TABLE(added integer, modified integer, removed integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    v_status public.master_schedule_revision_status;
    v_added INTEGER := 0;
    v_modified INTEGER := 0;
    v_removed INTEGER := 0;
    rec RECORD;
BEGIN
    SELECT status INTO v_status
    FROM public.master_schedule_revision
    WHERE id = p_revision_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'master_schedule_revision % not found', p_revision_id;
    END IF;

    IF v_status <> 'pending' THEN
        RAISE EXCEPTION 'revision % is %, cannot apply', p_revision_id, v_status;
    END IF;

    FOR rec IN
        SELECT * FROM public.master_schedule_change
        WHERE revision_id = p_revision_id
        ORDER BY id
    LOOP
        IF rec.change_type = 'add' THEN
            INSERT INTO public.schedule_slot (
                site_id, start_time, end_time,
                pre_arrival_adjustment, post_arrival_adjustment,
                pre_departure_adjustment, post_departure_adjustment,
                hours_type_id, days_of_week, min_holiday,
                page_absence, flex_hours,
                pre_shift_tolerance, post_shift_tolerance,
                periodic_check, pc_tolerance,
                supervisor_id, notify_contact,
                page_no_show, no_show_pager,
                time_zone, role,
                total_hours, hours_type_description,
                master_schedule_revision_id
            )
            SELECT
                rec.site_id,
                (rec.new_payload->>'start_time')::TIME,
                (rec.new_payload->>'end_time')::TIME,
                NULLIF(rec.new_payload->>'pre_arrival_adjustment','')::INTEGER,
                NULLIF(rec.new_payload->>'post_arrival_adjustment','')::INTEGER,
                NULLIF(rec.new_payload->>'pre_departure_adjustment','')::INTEGER,
                NULLIF(rec.new_payload->>'post_departure_adjustment','')::INTEGER,
                NULLIF(rec.new_payload->>'hours_type_id','')::INTEGER,
                ARRAY(SELECT (value::TEXT)::BOOLEAN
                      FROM jsonb_array_elements_text(rec.new_payload->'days_of_week')),
                NULLIF(rec.new_payload->>'min_holiday','')::INTEGER,
                COALESCE((rec.new_payload->>'page_absence')::BOOLEAN, FALSE),
                NULLIF(rec.new_payload->>'flex_hours','')::INTEGER,
                NULLIF(rec.new_payload->>'pre_shift_tolerance','')::INTEGER,
                NULLIF(rec.new_payload->>'post_shift_tolerance','')::INTEGER,
                COALESCE((rec.new_payload->>'periodic_check')::BOOLEAN, FALSE),
                NULLIF(rec.new_payload->>'pc_tolerance','')::INTEGER,
                rec.new_payload->>'supervisor_id',
                rec.new_payload->>'notify_contact',
                COALESCE((rec.new_payload->>'page_no_show')::BOOLEAN, FALSE),
                rec.new_payload->>'no_show_pager',
                COALESCE(rec.new_payload->>'time_zone', 'America/Chicago'),
                rec.new_payload->>'role',
                NULLIF(rec.new_payload->>'total_hours','')::NUMERIC,
                rec.new_payload->>'hours_type_description',
                p_revision_id;
            v_added := v_added + 1;

        ELSIF rec.change_type = 'modify' THEN
            UPDATE public.schedule_slot SET
                start_time                 = (rec.new_payload->>'start_time')::TIME,
                end_time                   = (rec.new_payload->>'end_time')::TIME,
                pre_arrival_adjustment     = NULLIF(rec.new_payload->>'pre_arrival_adjustment','')::INTEGER,
                post_arrival_adjustment    = NULLIF(rec.new_payload->>'post_arrival_adjustment','')::INTEGER,
                pre_departure_adjustment   = NULLIF(rec.new_payload->>'pre_departure_adjustment','')::INTEGER,
                post_departure_adjustment  = NULLIF(rec.new_payload->>'post_departure_adjustment','')::INTEGER,
                hours_type_id              = NULLIF(rec.new_payload->>'hours_type_id','')::INTEGER,
                days_of_week               = ARRAY(SELECT (value::TEXT)::BOOLEAN
                                                   FROM jsonb_array_elements_text(rec.new_payload->'days_of_week')),
                min_holiday                = NULLIF(rec.new_payload->>'min_holiday','')::INTEGER,
                page_absence               = COALESCE((rec.new_payload->>'page_absence')::BOOLEAN, FALSE),
                flex_hours                 = NULLIF(rec.new_payload->>'flex_hours','')::INTEGER,
                pre_shift_tolerance        = NULLIF(rec.new_payload->>'pre_shift_tolerance','')::INTEGER,
                post_shift_tolerance       = NULLIF(rec.new_payload->>'post_shift_tolerance','')::INTEGER,
                periodic_check             = COALESCE((rec.new_payload->>'periodic_check')::BOOLEAN, FALSE),
                pc_tolerance               = NULLIF(rec.new_payload->>'pc_tolerance','')::INTEGER,
                supervisor_id              = rec.new_payload->>'supervisor_id',
                notify_contact             = rec.new_payload->>'notify_contact',
                page_no_show               = COALESCE((rec.new_payload->>'page_no_show')::BOOLEAN, FALSE),
                no_show_pager              = rec.new_payload->>'no_show_pager',
                time_zone                  = COALESCE(rec.new_payload->>'time_zone', 'America/Chicago'),
                role                       = rec.new_payload->>'role',
                total_hours                = NULLIF(rec.new_payload->>'total_hours','')::NUMERIC,
                hours_type_description     = rec.new_payload->>'hours_type_description',
                master_schedule_revision_id = p_revision_id
            WHERE slot_id = rec.target_slot_id;
            v_modified := v_modified + 1;

        ELSIF rec.change_type = 'remove' THEN
            DELETE FROM public.schedule_slot
            WHERE slot_id = rec.target_slot_id;
            v_removed := v_removed + 1;
        END IF;
    END LOOP;

    UPDATE public.master_schedule_revision
    SET status = 'applied',
        applied_at = NOW(),
        applied_by = auth.uid(),
        slots_added = v_added,
        slots_modified = v_modified,
        slots_removed = v_removed
    WHERE id = p_revision_id;

    RETURN QUERY SELECT v_added, v_modified, v_removed;
END;
$function$;
