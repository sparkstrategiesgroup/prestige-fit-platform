-- =============================================================================
-- Master Schedule upload audit + diff/approve workflow.
-- =============================================================================
-- Each XLSX upload becomes a `master_schedule_revision` row in status=pending.
-- The importer writes one `master_schedule_change` row per affected slot
-- (add | modify | remove). Ops admin reviews, clicks Approve -> a function
-- applies the changes transactionally and flips the revision to applied.
-- Rejecting deletes the pending change rows. Applied revisions are immutable.
-- =============================================================================

CREATE TYPE public.master_schedule_revision_status AS ENUM
    ('pending', 'applied', 'rejected');

CREATE TYPE public.master_schedule_change_type AS ENUM
    ('add', 'modify', 'remove');

CREATE TABLE public.master_schedule_revision (
    id                  BIGSERIAL PRIMARY KEY,
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploaded_by         UUID REFERENCES auth.users(id),
    source_filename     TEXT,
    file_sha256         VARCHAR(64),
    status              public.master_schedule_revision_status NOT NULL DEFAULT 'pending',
    applied_at          TIMESTAMPTZ,
    applied_by          UUID REFERENCES auth.users(id),
    rejected_at         TIMESTAMPTZ,
    rejected_by         UUID REFERENCES auth.users(id),
    rejection_reason    TEXT,
    slot_count          INTEGER NOT NULL DEFAULT 0,
    slots_added         INTEGER NOT NULL DEFAULT 0,
    slots_modified      INTEGER NOT NULL DEFAULT 0,
    slots_removed       INTEGER NOT NULL DEFAULT 0,
    slots_unchanged     INTEGER NOT NULL DEFAULT 0,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_msr_status ON public.master_schedule_revision(status);
CREATE INDEX idx_msr_uploaded_at ON public.master_schedule_revision(uploaded_at);

COMMENT ON TABLE public.master_schedule_revision IS
    'One row per Master Schedule List upload. Pending until ops admin reviews the diff and approves.';

CREATE TRIGGER trg_updated_master_schedule_revision
    BEFORE UPDATE ON public.master_schedule_revision
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

ALTER TABLE public.master_schedule_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY msr_read_authed ON public.master_schedule_revision FOR SELECT
    USING (auth.uid() IS NOT NULL);
CREATE POLICY msr_admin ON public.master_schedule_revision FOR ALL
    USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- master_schedule_change: one row per slot affected by a pending revision.
-- old_payload and new_payload mirror the schedule_slot column shape.
-- -----------------------------------------------------------------------------
CREATE TABLE public.master_schedule_change (
    id                  BIGSERIAL PRIMARY KEY,
    revision_id         BIGINT NOT NULL REFERENCES public.master_schedule_revision(id) ON DELETE CASCADE,
    change_type         public.master_schedule_change_type NOT NULL,
    site_id             VARCHAR(20) NOT NULL REFERENCES public.site(site_id),
    slot_natural_key    TEXT NOT NULL,
    target_slot_id      UUID REFERENCES public.schedule_slot(slot_id),
    old_payload         JSONB,
    new_payload         JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (change_type = 'add'    AND old_payload IS NULL     AND new_payload IS NOT NULL) OR
        (change_type = 'modify' AND old_payload IS NOT NULL AND new_payload IS NOT NULL) OR
        (change_type = 'remove' AND old_payload IS NOT NULL AND new_payload IS NULL)
    )
);

CREATE INDEX idx_msc_revision ON public.master_schedule_change(revision_id);
CREATE INDEX idx_msc_site ON public.master_schedule_change(site_id);
CREATE INDEX idx_msc_target_slot ON public.master_schedule_change(target_slot_id)
    WHERE target_slot_id IS NOT NULL;

COMMENT ON TABLE public.master_schedule_change IS
    'Proposed changes from one Master Schedule upload. Natural key is JobNumber|StartTime|EndTime|HoursTypeID — composite values in slot_natural_key.';

ALTER TABLE public.master_schedule_change ENABLE ROW LEVEL SECURITY;
CREATE POLICY msc_read_authed ON public.master_schedule_change FOR SELECT
    USING (auth.uid() IS NOT NULL);
CREATE POLICY msc_admin ON public.master_schedule_change FOR ALL
    USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Link applied changes to the slot's history.
-- -----------------------------------------------------------------------------
ALTER TABLE public.schedule_slot
    ADD COLUMN master_schedule_revision_id BIGINT
        REFERENCES public.master_schedule_revision(id);

COMMENT ON COLUMN public.schedule_slot.master_schedule_revision_id IS
    'The applied revision that last inserted or modified this slot. NULL for slots created before the diff/approve workflow.';

CREATE INDEX idx_schedule_slot_revision
    ON public.schedule_slot(master_schedule_revision_id)
    WHERE master_schedule_revision_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- fn_apply_master_schedule_revision(revision_id)
-- Atomically applies all pending changes for a revision. Flips status to
-- 'applied'. Called from the UI Approve button (with admin RLS) or from
-- the master-schedule-import Edge Function when auto-apply is enabled.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_apply_master_schedule_revision(p_revision_id BIGINT)
RETURNS TABLE (
    added INTEGER,
    modified INTEGER,
    removed INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
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
$$;

COMMENT ON FUNCTION public.fn_apply_master_schedule_revision IS
    'Apply all pending changes for a Master Schedule revision in a single transaction. Flips revision to applied.';

GRANT EXECUTE ON FUNCTION public.fn_apply_master_schedule_revision TO authenticated;
