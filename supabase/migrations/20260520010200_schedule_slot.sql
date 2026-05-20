-- =============================================================================
-- FIT-001 (part 3/3): schedule_slot table per Addendum §2.3.
-- =============================================================================
-- Each row of "Complete Sched_Target & Kohls" becomes one schedule_slot.
-- One site can have many slots per day, distinguished by role and start_time.
-- This is a different grain from the existing job_site_schedules table (which
-- ties schedules to shift_blocks, not to individual scheduled employees).
-- Both tables coexist until addendum §8 phase 3 cutover.
-- =============================================================================

CREATE TABLE public.schedule_slot (
    slot_id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id                    VARCHAR(20)  NOT NULL REFERENCES public.site(site_id),
    start_time                 TIME         NOT NULL,
    end_time                   TIME         NOT NULL,
    pre_arrival_adjustment     INTEGER,
    post_arrival_adjustment    INTEGER,
    pre_departure_adjustment   INTEGER,
    post_departure_adjustment  INTEGER,
    hours_type_id              INTEGER,
    days_of_week               BOOLEAN[7]   NOT NULL
                                            CHECK (array_length(days_of_week, 1) = 7),
    min_holiday                INTEGER,
    page_absence               BOOLEAN      NOT NULL DEFAULT FALSE,
    flex_hours                 INTEGER,
    pre_shift_tolerance        INTEGER,
    post_shift_tolerance       INTEGER,
    periodic_check             BOOLEAN      NOT NULL DEFAULT FALSE,
    pc_tolerance               INTEGER,
    supervisor_id              VARCHAR(50),
    notify_contact             VARCHAR(200),
    page_no_show               BOOLEAN      NOT NULL DEFAULT FALSE,
    no_show_pager              VARCHAR(200),
    time_zone                  VARCHAR(40)  NOT NULL DEFAULT 'America/Chicago',
    role                       VARCHAR(80),
    created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_schedule_slot_site ON public.schedule_slot(site_id);
CREATE INDEX idx_schedule_slot_role ON public.schedule_slot(role);

COMMENT ON TABLE public.schedule_slot IS
    'One scheduled shift slot per (site, day-of-week, role, start_time). Addendum §2.3. Many slots per site per day for multi-shift Target/Kohl''s/Hardlines locations (see §1.3).';
COMMENT ON COLUMN public.schedule_slot.days_of_week IS
    'Sun..Sat flags. Index 0 = Sunday. Addendum §2.3 cols I–O.';
COMMENT ON COLUMN public.schedule_slot.role IS
    'Lead Custodian / Custodian / Porter / Floater. Addendum §2.3 col AB.';

-- Triggers: reuse the existing helpers.
CREATE TRIGGER trg_updated_schedule_slot
    BEFORE UPDATE ON public.schedule_slot
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

CREATE TRIGGER trg_audit_schedule_slot
    AFTER INSERT OR UPDATE OR DELETE ON public.schedule_slot
    FOR EACH ROW EXECUTE FUNCTION public.fn_audit_log();

-- RLS: region-based, following the same pattern as labor_control_tracking.
ALTER TABLE public.schedule_slot ENABLE ROW LEVEL SECURITY;

CREATE POLICY schedule_slot_select ON public.schedule_slot FOR SELECT
    USING (
        public.is_admin()
        OR site_id IN (
            SELECT site_id FROM public.site WHERE region_id = public.user_region_id()
        )
    );

CREATE POLICY schedule_slot_admin ON public.schedule_slot FOR ALL
    USING (public.is_admin());
