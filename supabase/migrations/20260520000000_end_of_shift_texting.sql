-- =============================================================================
-- End of Shift Employee Texting — schema additions
-- Generated: 2026-05-20
-- Source procedure: PROCEDURE_Labor_Controls_Employee_End_of_Shift_Texting (rev 4.10.26)
-- Plan: docs/plans/end-of-shift-texting.md
-- =============================================================================
-- Adds:
--   1. labor_control_tracking  (denormalized shift rows, source for eligibility)
--   2. shift_blocks             (13 daily end-of-shift time blocks)
--   3. message_templates        (en/es bodies for the two notifications)
--   4. job_sites.client         (TARGET | HOME_DEPOT | KOHLS)
--   5. employees.is_manager     (filter manager/supervisor punches)
--   6. notifications extensions (new types, shift_block_id, scheduled_for)
--   7. RLS + audit + updated_at triggers on the new tables
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. SHIFT BLOCKS
-- -----------------------------------------------------------------------------
CREATE TABLE public.shift_blocks (
    id              SERIAL PRIMARY KEY,
    label           VARCHAR(50)  NOT NULL UNIQUE,
    end_time_local  TIME         NOT NULL,
    end_timezone    VARCHAR(40)  NOT NULL DEFAULT 'America/Chicago',
    clients         TEXT[]       NOT NULL,
    warning_offset  INTERVAL     NOT NULL DEFAULT INTERVAL '20 minutes',
    clocked_offset  INTERVAL     NOT NULL DEFAULT INTERVAL '5 minutes',
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.shift_blocks IS
    'End-of-shift time blocks from Labor Controls procedure p.2. Driven by the shift-block-runner cron job.';

INSERT INTO public.shift_blocks (label, end_time_local, clients) VALUES
    ('8:00am End',  '08:00', ARRAY['TARGET']),
    ('8:30am End',  '08:30', ARRAY['TARGET']),
    ('9:00am End',  '09:00', ARRAY['TARGET']),
    ('9:30am End',  '09:30', ARRAY['TARGET']),
    ('10:00am End', '10:00', ARRAY['TARGET','HOME_DEPOT']),
    ('10:30am End', '10:30', ARRAY['TARGET','HOME_DEPOT']),
    ('11:00am End', '11:00', ARRAY['TARGET','HOME_DEPOT']),
    ('11:30am End', '11:30', ARRAY['TARGET','HOME_DEPOT']),
    ('12:00pm End', '12:00', ARRAY['TARGET','HOME_DEPOT','KOHLS']),
    ('1:30pm End',  '13:30', ARRAY['HOME_DEPOT','KOHLS']),
    ('2:00pm End',  '14:00', ARRAY['TARGET','KOHLS']),
    ('2:30pm End',  '14:30', ARRAY['HOME_DEPOT','KOHLS']),
    ('3:30pm End',  '15:30', ARRAY['HOME_DEPOT','KOHLS']),
    ('4:30pm End',  '16:30', ARRAY['KOHLS']);

-- -----------------------------------------------------------------------------
-- 2. LABOR CONTROL TRACKING
-- One row per employee/site/shift/day. Mirrors the Excel workbook columns
-- so Epay import is column-for-column.
-- -----------------------------------------------------------------------------
CREATE TABLE public.labor_control_tracking (
    id                  BIGSERIAL PRIMARY KEY,
    job_site_id         INTEGER       NOT NULL REFERENCES public.job_sites(id),
    job_site_name       VARCHAR(200)  NOT NULL,
    work_date           DATE          NOT NULL,
    payroll_number      VARCHAR(10)   NOT NULL,
    employee_name       VARCHAR(200)  NOT NULL,
    rate_type           VARCHAR(80),
    time_in             TIMESTAMPTZ,
    time_out            TIMESTAMPTZ,
    actual_hours        DECIMAL(5,2),
    exceptions_in       VARCHAR(100),
    per_schedule_out    TIMESTAMPTZ,
    per_schedule_hours  DECIMAL(5,2),
    people_per_shift    INTEGER,
    time_zone           VARCHAR(40)   NOT NULL DEFAULT 'America/Chicago',
    shift_block_id      INTEGER       REFERENCES public.shift_blocks(id),
    imported_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    UNIQUE (payroll_number, job_site_id, work_date, time_in)
);

CREATE INDEX idx_lct_work_date    ON public.labor_control_tracking(work_date);
CREATE INDEX idx_lct_open_punches ON public.labor_control_tracking(work_date)
    WHERE time_out IS NULL;
CREATE INDEX idx_lct_shift_block  ON public.labor_control_tracking(shift_block_id, work_date);
CREATE INDEX idx_lct_payroll      ON public.labor_control_tracking(payroll_number);

COMMENT ON TABLE public.labor_control_tracking IS
    'Denormalized shift rows from Epay punches report. Drives end-of-shift texting eligibility. One row per employee/site/date/time_in.';

-- -----------------------------------------------------------------------------
-- 3. MESSAGE TEMPLATES (en + es)
-- -----------------------------------------------------------------------------
CREATE TABLE public.message_templates (
    id                SERIAL PRIMARY KEY,
    notification_type VARCHAR(30)  NOT NULL,
    language          VARCHAR(5)   NOT NULL CHECK (language IN ('en','es')),
    body              TEXT         NOT NULL,
    active            BOOLEAN      NOT NULL DEFAULT TRUE,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Only one active template per (type, language) at a time
CREATE UNIQUE INDEX idx_message_templates_active
    ON public.message_templates (notification_type, language)
    WHERE active = TRUE;

COMMENT ON TABLE public.message_templates IS
    'Versioned SMS bodies. Source the current text from Text Request''s "End of Shift Warning" and "End of Shift CLOCKED OUT" saved messages before populating.';

-- -----------------------------------------------------------------------------
-- 4. JOB_SITES.CLIENT  (additive)
-- -----------------------------------------------------------------------------
ALTER TABLE public.job_sites
    ADD COLUMN client VARCHAR(20)
        CHECK (client IS NULL OR client IN ('TARGET','HOME_DEPOT','KOHLS'));

CREATE INDEX idx_job_sites_client ON public.job_sites(client) WHERE client IS NOT NULL;

COMMENT ON COLUMN public.job_sites.client IS
    'Client brand for end-of-shift texting matching. Backfill from site_name in a follow-up data migration.';

-- -----------------------------------------------------------------------------
-- 5. EMPLOYEES.IS_MANAGER  (additive)
-- -----------------------------------------------------------------------------
ALTER TABLE public.employees
    ADD COLUMN is_manager BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.employees.is_manager IS
    'Excludes employee from end-of-shift texting (PDF p.3 step 7).';

-- -----------------------------------------------------------------------------
-- 6. NOTIFICATIONS extensions
-- -----------------------------------------------------------------------------
ALTER TABLE public.notifications
    DROP CONSTRAINT notifications_notification_type_check;
ALTER TABLE public.notifications
    ADD CONSTRAINT notifications_notification_type_check
    CHECK (notification_type IN (
        'MISSING_PUNCH', 'EXCESS_HOURS', 'STOP_WORK_ORDER', 'PUNCH_CORRECTION',
        'END_OF_SHIFT_WARNING', 'END_OF_SHIFT_CLOCKED_OUT'
    ));

ALTER TABLE public.notifications
    ADD COLUMN shift_block_id INTEGER REFERENCES public.shift_blocks(id),
    ADD COLUMN scheduled_for  TIMESTAMPTZ,
    ADD COLUMN provider       VARCHAR(20) NOT NULL DEFAULT 'TEXT_REQUEST'
        CHECK (provider IN ('TEXT_REQUEST','TWILIO','EMAIL_SMTP')),
    ADD COLUMN provider_message_id VARCHAR(100);

CREATE INDEX idx_notifications_shift_block ON public.notifications(shift_block_id);
CREATE INDEX idx_notifications_scheduled
    ON public.notifications(scheduled_for)
    WHERE delivery_status = 'sent' AND scheduled_for IS NOT NULL;

COMMENT ON COLUMN public.notifications.provider IS
    'Send channel. TEXT_REQUEST is the default for end-of-shift texting (confirmed 2026-05-20).';

-- -----------------------------------------------------------------------------
-- 7. updated_at triggers
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_updated_shift_blocks
    BEFORE UPDATE ON public.shift_blocks
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

CREATE TRIGGER trg_updated_labor_control_tracking
    BEFORE UPDATE ON public.labor_control_tracking
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

CREATE TRIGGER trg_updated_message_templates
    BEFORE UPDATE ON public.message_templates
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

-- -----------------------------------------------------------------------------
-- 8. RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.shift_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY shift_blocks_select ON public.shift_blocks FOR SELECT USING (TRUE);
CREATE POLICY shift_blocks_admin  ON public.shift_blocks FOR ALL    USING (public.is_admin());

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_templates_select ON public.message_templates FOR SELECT USING (TRUE);
CREATE POLICY message_templates_admin  ON public.message_templates FOR ALL    USING (public.is_admin());

ALTER TABLE public.labor_control_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY lct_select ON public.labor_control_tracking FOR SELECT
    USING (
        public.is_admin()
        OR job_site_id IN (
            SELECT id FROM public.job_sites WHERE region_id = public.user_region_id()
        )
    );
CREATE POLICY lct_admin ON public.labor_control_tracking FOR ALL USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- 9. Audit triggers
-- -----------------------------------------------------------------------------
-- shift_blocks and message_templates are low-volume config; audit them.
-- labor_control_tracking is high-volume import data; skip audit to avoid bloat.
CREATE TRIGGER trg_audit_shift_blocks
    AFTER INSERT OR UPDATE OR DELETE ON public.shift_blocks
    FOR EACH ROW EXECUTE FUNCTION public.fn_audit_log();

CREATE TRIGGER trg_audit_message_templates
    AFTER INSERT OR UPDATE OR DELETE ON public.message_templates
    FOR EACH ROW EXECUTE FUNCTION public.fn_audit_log();

-- =============================================================================
-- DONE
-- =============================================================================
-- Follow-ups (not in this migration):
--   - Backfill job_sites.client from site_name regex.
--   - Set employees.is_manager from winteam_employee_job_assignments role mapping.
--   - Seed message_templates rows with current Text Request copy (en + es).
--   - Build shift-block-runner Edge Function (PR C).
-- =============================================================================
