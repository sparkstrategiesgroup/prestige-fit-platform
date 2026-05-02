-- =============================================================================
-- Prestige FIT Platform â Initial Schema Migration
-- Generated: 2026-05-01
-- Target: Supabase (PostgreSQL 15+)
-- =============================================================================
-- This migration creates all core tables for the FIT (Frontline Investment Tool)
-- platform: workforce management, timekeeping, punch exceptions, notifications,
-- overtime monitoring, and audit logging.
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- =============================================================================
-- 1. REGIONS
-- Geographic operating zones. Not 1:1 with states â one state can have
-- multiple regions (e.g., Texas has 10 regions in the 1000-series).
-- =============================================================================
CREATE TABLE public.regions (
    id            SERIAL PRIMARY KEY,
    region_code   VARCHAR(10)  NOT NULL UNIQUE,
    region_name   VARCHAR(100) NOT NULL,
    manager_name  VARCHAR(100),
    manager_email VARCHAR(255),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.regions IS 'Geographic operating regions. Region codes: 1000-series=TX, 2000=MO/KS, 3000=CO/IA/NE, 4000=IL/IN/WI, 5000=IL/OK/Multi.';

-- =============================================================================
-- 2. DEPARTMENTS
-- PAM notification groups. Each department has an Outlook distribution list
-- email that receives daily missing punch reports.
-- =============================================================================
CREATE TABLE public.departments (
    id          SERIAL PRIMARY KEY,
    dept_code   VARCHAR(10)  NOT NULL UNIQUE,
    dept_email  VARCHAR(255),
    description VARCHAR(255),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.departments IS 'PAM notification groups. dept_email format: Dept[CODE]@prestigeusa.net';

-- =============================================================================
-- 3. EMPLOYEES
-- Central employee record linking all operational data. ee_number is the
-- universal identifier across Epay, PAM, Twilio, and payroll systems.
-- =============================================================================
CREATE TABLE public.employees (
    id                SERIAL PRIMARY KEY,
    auth_user_id      UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
    ee_number         VARCHAR(10)  NOT NULL UNIQUE,
    first_name        VARCHAR(100) NOT NULL,
    last_name         VARCHAR(100) NOT NULL,
    cell_phone        VARCHAR(20),
    phone_valid       BOOLEAN      NOT NULL DEFAULT FALSE,
    email             VARCHAR(255),
    region_id         INTEGER      NOT NULL REFERENCES public.regions(id),
    department_id     INTEGER      NOT NULL REFERENCES public.departments(id),
    pay_rate          DECIMAL(8,2) NOT NULL DEFAULT 0.00,
    rate_type         VARCHAR(80),
    epay_app_auth     BOOLEAN      NOT NULL DEFAULT FALSE,
    daily_pay_enrolled BOOLEAN     NOT NULL DEFAULT FALSE,
    wisely_card       BOOLEAN      NOT NULL DEFAULT FALSE,
    wisely_activated  BOOLEAN      NOT NULL DEFAULT FALSE,
    status            VARCHAR(20)  NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'inactive', 'terminated')),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employees_region     ON public.employees(region_id);
CREATE INDEX idx_employees_department ON public.employees(department_id);
CREATE INDEX idx_employees_status     ON public.employees(status);
CREATE INDEX idx_employees_auth_user  ON public.employees(auth_user_id);

COMMENT ON TABLE public.employees IS 'Central employee record. ee_number is the universal business key across Epay, PAM, Twilio, and payroll. 629 employees as of Feb 2026.';

-- =============================================================================
-- 4. JOB SITES
-- Customer locations where employees work. Each site has a validated phone
-- number for IVR and optional geofence coordinates for Epay app.
-- =============================================================================
CREATE TABLE public.job_sites (
    id               SERIAL PRIMARY KEY,
    site_number      VARCHAR(20)    NOT NULL UNIQUE,
    site_name        VARCHAR(200)   NOT NULL,
    region_id        INTEGER        NOT NULL REFERENCES public.regions(id),
    store_phone      VARCHAR(20),
    ivr_enabled      BOOLEAN        NOT NULL DEFAULT TRUE,
    geofence_lat     DECIMAL(10,7),
    geofence_lon     DECIMAL(10,7),
    geofence_radius  INTEGER        NOT NULL DEFAULT 500,
    created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_sites_region ON public.job_sites(region_id);

COMMENT ON TABLE public.job_sites IS 'Customer locations. site_name format: "[Client] # [Number] [City]". Target=8-digit site numbers, others=10-digit.';

-- =============================================================================
-- 5. PUNCHES
-- Individual clock-in and clock-out events from IVR or Epay App.
-- Each complete shift generates an IN and an OUT linked by paired_punch_id.
-- =============================================================================
CREATE TABLE public.punches (
    id               SERIAL PRIMARY KEY,
    employee_id      INTEGER      NOT NULL REFERENCES public.employees(id),
    job_site_id      INTEGER      NOT NULL REFERENCES public.job_sites(id),
    punch_date       DATE         NOT NULL,
    punch_time       TIMESTAMPTZ  NOT NULL,
    punch_type       VARCHAR(10)  NOT NULL CHECK (punch_type IN ('IN', 'OUT')),
    punch_source     VARCHAR(20)  NOT NULL DEFAULT 'IVR'
                     CHECK (punch_source IN ('IVR', 'EPAY_APP', 'MANUAL', 'HOTLINE')),
    task             VARCHAR(50),
    source_phone     VARCHAR(20),
    phone_authorized BOOLEAN      NOT NULL DEFAULT TRUE,
    approval_status  VARCHAR(20)  NOT NULL DEFAULT 'approved'
                     CHECK (approval_status IN ('approved', 'pending', 'rejected')),
    location_lat     DECIMAL(10,7),
    location_lon     DECIMAL(10,7),
    location_valid   BOOLEAN,
    hours            DECIMAL(5,2),
    paired_punch_id  INTEGER      REFERENCES public.punches(id),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_punches_employee     ON public.punches(employee_id);
CREATE INDEX idx_punches_job_site     ON public.punches(job_site_id);
CREATE INDEX idx_punches_date         ON public.punches(punch_date);
CREATE INDEX idx_punches_employee_date ON public.punches(employee_id, punch_date);
CREATE INDEX idx_punches_approval     ON public.punches(approval_status) WHERE approval_status != 'approved';
CREATE INDEX idx_punches_unpaired     ON public.punches(employee_id, punch_date) WHERE paired_punch_id IS NULL;

COMMENT ON TABLE public.punches IS 'Individual clock events. IVR=store phone, HOTLINE=1-800-321-4773 backup. hours populated on OUT punch only.';

-- =============================================================================
-- 6. HOURS LOG
-- Daily aggregated hours by employee, job site, task, and rate type.
-- Sourced from Epay HoursByRateType export. PRIMARY table for hours analysis.
-- =============================================================================
CREATE TABLE public.hours_log (
    id           SERIAL PRIMARY KEY,
    employee_id  INTEGER      NOT NULL REFERENCES public.employees(id),
    job_site_id  INTEGER      NOT NULL REFERENCES public.job_sites(id),
    work_date    DATE         NOT NULL,
    task         VARCHAR(50),
    rate_type    VARCHAR(80),
    hours        DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    pay_rate     DECIMAL(8,2) NOT NULL DEFAULT 0.00,
    gross_pay    DECIMAL(10,2) GENERATED ALWAYS AS (hours * pay_rate) STORED,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (employee_id, job_site_id, work_date, task)
);

CREATE INDEX idx_hours_log_employee   ON public.hours_log(employee_id);
CREATE INDEX idx_hours_log_work_date  ON public.hours_log(work_date);
CREATE INDEX idx_hours_log_emp_date   ON public.hours_log(employee_id, work_date);
CREATE INDEX idx_hours_log_site       ON public.hours_log(job_site_id);

COMMENT ON TABLE public.hours_log IS 'Daily aggregated hours. Grain: one row per employee/site/date/task. Updated ~10AM next day. Use this for reporting, not punches.';

-- =============================================================================
-- 7. PUNCH EXCEPTIONS
-- Exception records generated by PAM when punches are missing, incomplete,
-- or flagged. Each record = one employee issue on one date.
-- =============================================================================
CREATE TABLE public.punch_exceptions (
    id                   SERIAL PRIMARY KEY,
    employee_id          INTEGER      NOT NULL REFERENCES public.employees(id),
    punch_id             INTEGER      REFERENCES public.punches(id),
    exception_date       DATE         NOT NULL,
    exception_type       VARCHAR(30)  NOT NULL
                         CHECK (exception_type IN (
                             'MISSING_IN', 'MISSING_OUT', 'MISSING_BOTH',
                             'MULTIPLE_PUNCHES', 'UNAUTHORIZED_PHONE',
                             'OUTSIDE_GEOFENCE', 'INCOMPLETE_PUNCH'
                         )),
    notification_method  VARCHAR(20)  NOT NULL
                         CHECK (notification_method IN ('SURVEY', 'MGR_MAIL')),
    notification_reason  VARCHAR(100),
    resolution_status    VARCHAR(20)  NOT NULL DEFAULT 'open'
                         CHECK (resolution_status IN ('open', 'resolved', 'deleted')),
    resolved_by          VARCHAR(100),
    resolution_source    VARCHAR(30)
                         CHECK (resolution_source IS NULL OR resolution_source IN (
                             'SMS_SURVEY', 'MANUAL_FORM', 'MANAGER'
                         )),
    resolution_notes     TEXT,
    resolved_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_punch_exceptions_employee ON public.punch_exceptions(employee_id);
CREATE INDEX idx_punch_exceptions_date     ON public.punch_exceptions(exception_date);
CREATE INDEX idx_punch_exceptions_status   ON public.punch_exceptions(resolution_status) WHERE resolution_status = 'open';

COMMENT ON TABLE public.punch_exceptions IS 'PAM-detected issues. exception_date is detection date (usually day AFTER actual missing punch). ~2PM daily run.';

-- =============================================================================
-- 8. NOTIFICATIONS
-- All outbound SMS and email communications. Tracks delivery status,
-- survey response, and message content.
-- =============================================================================
CREATE TABLE public.notifications (
    id                 SERIAL PRIMARY KEY,
    employee_id        INTEGER      NOT NULL REFERENCES public.employees(id),
    exception_id       INTEGER      REFERENCES public.punch_exceptions(id),
    channel            VARCHAR(10)  NOT NULL CHECK (channel IN ('SMS', 'EMAIL')),
    notification_type  VARCHAR(30)  NOT NULL
                       CHECK (notification_type IN (
                           'MISSING_PUNCH', 'EXCESS_HOURS',
                           'STOP_WORK_ORDER', 'PUNCH_CORRECTION'
                       )),
    recipient_type     VARCHAR(20)  NOT NULL
                       CHECK (recipient_type IN ('EMPLOYEE', 'MANAGER', 'DEPT_LIST')),
    recipient_address  VARCHAR(255) NOT NULL,
    message_body       TEXT         NOT NULL,
    survey_url         VARCHAR(500),
    survey_params      JSONB,
    language           VARCHAR(5)   NOT NULL DEFAULT 'en'
                       CHECK (language IN ('en', 'es')),
    delivery_status    VARCHAR(20)  NOT NULL DEFAULT 'sent'
                       CHECK (delivery_status IN ('sent', 'delivered', 'failed', 'responded')),
    response_status    VARCHAR(20)
                       CHECK (response_status IS NULL OR response_status IN (
                           'complete', 'incomplete', 'no_response'
                       )),
    twilio_sid         VARCHAR(50),
    sent_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    responded_at       TIMESTAMPTZ
);

CREATE INDEX idx_notifications_employee  ON public.notifications(employee_id);
CREATE INDEX idx_notifications_exception ON public.notifications(exception_id);
CREATE INDEX idx_notifications_type      ON public.notifications(notification_type);
CREATE INDEX idx_notifications_sent      ON public.notifications(sent_at);

COMMENT ON TABLE public.notifications IS 'Outbound SMS/email. survey_params JSONB: {PI, EF, EL, EI, JN, JD, PD, MP, GP}. SMS must be â¤160 chars.';

-- =============================================================================
-- 9. EXCESS HOURS ALERTS
-- Pre-computed weekly OT tracking. Updated daily with running totals,
-- daily averages, and FRI/SAT projections. Replaces the manual Excel report.
-- =============================================================================
CREATE TABLE public.excess_hours_alerts (
    id                  SERIAL PRIMARY KEY,
    employee_id         INTEGER      NOT NULL REFERENCES public.employees(id),
    week_start          DATE         NOT NULL,
    hours_through_today DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    daily_average       DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    fri_forecast        DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    sat_forecast        DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    threshold           DECIMAL(5,2) NOT NULL DEFAULT 45.00,
    alert_status        VARCHAR(20)  NOT NULL DEFAULT 'cleared'
                        CHECK (alert_status IN ('warning', 'ineligible', 'cleared')),
    stop_work_date      DATE,
    notification_sent   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (employee_id, week_start)
);

CREATE INDEX idx_excess_hours_week   ON public.excess_hours_alerts(week_start);
CREATE INDEX idx_excess_hours_status ON public.excess_hours_alerts(alert_status) WHERE alert_status != 'cleared';

COMMENT ON TABLE public.excess_hours_alerts IS 'Weekly OT tracking. 45hr cap. alert_status: warning=sat_forecast>=45, ineligible=actual>=45. Updated ~4PM daily.';

-- =============================================================================
-- 10. AUDIT LOG
-- Tracks all significant changes across the platform for compliance.
-- =============================================================================
CREATE TABLE public.audit_log (
    id          BIGSERIAL PRIMARY KEY,
    table_name  VARCHAR(50)  NOT NULL,
    record_id   INTEGER      NOT NULL,
    action      VARCHAR(10)  NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_data    JSONB,
    new_data    JSONB,
    changed_by  UUID         REFERENCES auth.users(id),
    changed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_table   ON public.audit_log(table_name, record_id);
CREATE INDEX idx_audit_log_changed ON public.audit_log(changed_at);

COMMENT ON TABLE public.audit_log IS 'Compliance audit trail for all significant data changes.';

-- =============================================================================
-- AUDIT LOG TRIGGER FUNCTION
-- ================================================================================
CREATE OR REPLACE FUNCTION public.fn_audit_log()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.audit_log (table_name, record_id, action, new_data, changed_by)
        VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', to_jsonb(NEW), auth.uid());
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO public.audit_log (table_name, record_id, action, old_data, new_data, changed_by)
        VALUES (TG_TABLE_NAME, NEW.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), auth.uid());
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO public.audit_log (table_name, record_id, action, old_data, changed_by)
        VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', to_jsonb(OLD), auth.uid());
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach audit triggers to key tables
CREATE TRIGGER trg_audit_employees
    AFTER INSERT OR UPDATE OR DELETE ON public.employees
    FOR EACH ROW EXECUTE FUNCTION public.fn_audit_log();

CREATE TRIGGER trg_audit_punch_exceptions
    AFTER INSERT OR UPDATE OR DELETE ON public.punch_exceptions
    FOR EACH ROW EXECUTE FUNCTION public.fn_audit_log();

CREATE TRIGGER trg_audit_notifications
    AFTER INSERT OR UPDATE OR DELETE ON public.notifications
    FOR EACH ROW EXECUTE FUNCTION public.fn_audit_log();

CREATE TRIGGER trg_audit_excess_hours_alerts
    AFTER INSERT OR UPDATE OR DELETE ON public.excess_hours_alerts
    FOR EACH ROW EXECUTE FUNCTION public.fn_audit_log();

-- =============================================================================
-- UPDATED_AT TRIGGER FUNCTION
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach to tables with updated_at
CREATE TRIGGER trg_updated_regions
    BEFORE UPDATE ON public.regions
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

CREATE TRIGGER trg_updated_departments
    BEFORE UPDATE ON public.departments
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

CREATE TRIGGER trg_updated_employees
    BEFORE UPDATE ON public.employees
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

CREATE TRIGGER trg_updated_job_sites
    BEFORE UPDATE ON public.job_sites
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

CREATE TRIGGER trg_updated_excess_hours
    BEFORE UPDATE ON public.excess_hours_alerts
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================
-- Strategy:
--   - Admins (role='admin' in user metadata) see everything
--   - Area managers see their region's data
--   - The match is: auth.users -> employees.auth_user_id -> employees.region_id

-- Helper function: check if current user is admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN COALESCE(
        (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin',
        FALSE
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Helper function: get current user's region_id
CREATE OR REPLACE FUNCTION public.user_region_id()
RETURNS INTEGER AS $$
BEGIN
    RETURN (
        SELECT region_id FROM public.employees
        WHERE auth_user_id = auth.uid()
        LIMIT 1
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- REGIONS: everyone can read, admins can write
ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;
CREATE POLICY regions_select ON public.regions FOR SELECT USING (TRUE);
CREATE POLICY regions_admin  ON public.regions FOR ALL USING (public.is_admin());

-- DEPARTMENTS: everyone can read, admins can write
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY departments_select ON public.departments FOR SELECT USING (TRUE);
CREATE POLICY departments_admin  ON public.departments FOR ALL USING (public.is_admin());

-- EMPLOYEES: managers see their region, admins see all
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY employees_select ON public.employees FOR SELECT
    USING (public.is_admin() OR region_id = public.user_region_id());
CREATE POLICY employees_admin ON public.employees FOR ALL
    USING (public.is_admin());

-- JOB SITES: managers see their region, admins see all
ALTER TABLE public.job_sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_sites_select ON public.job_sites FOR SELECT
    USING (public.is_admin() OR region_id = public.user_region_id());
CREATE POLICY job_sites_admin ON public.job_sites FOR ALL
    USING (public.is_admin());

-- PUNCHES: managers see their region's employees' punches, admins see all
ALTER TABLE public.punches ENABLE ROW LEVEL SECURITY;
CREATE POLICY punches_select ON public.punches FOR SELECT
    USING (
        public.is_admin()
        OR employee_id IN (
            SELECT id FROM public.employees WHERE region_id = public.user_region_id()
        )
    );
CREATE POLICY punches_admin ON public.punches FOR ALL USING (public.is_admin());

-- HOURS LOG: same pattern as punches
ALTER TABLE public.hours_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY hours_log_select ON public.hours_log FOR SELECT
    USING (
        public.is_admin()
        OR employee_id IN (
            SELECT id FROM public.employees WHERE region_id = public.user_region_id()
        )
    );
CREATE POLICY hours_log_admin ON public.hours_log FOR ALL USING (public.is_admin());

-- PUNCH EXCEPTIONS: same pattern
ALTER TABLE public.punch_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY punch_exceptions_select ON public.punch_exceptions FOR SELECT
    USING (
        public.is_admin()
        OR employee_id IN (
            SELECT id FROM public.employees WHERE region_id = public.user_region_id()
        )
    );
CREATE POLICY punch_exceptions_admin ON public.punch_exceptions FOR ALL USING (public.is_admin());

-- NOTIFICATIONS: same pattern
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_select ON public.notifications FOR SELECT
    USING (
        public.is_admin()
        OR employee_id IN (
            SELECT id FROM public.employees WHERE region_id = public.user_region_id()
        )
    );
CREATE POLICY notifications_admin ON public.notifications FOR ALL USING (public.is_admin());

-- EXCESS HOURS ALERTS: same pattern
ALTER TABLE public.excess_hours_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY excess_hours_select ON public.excess_hours_alerts FOR SELECT
    USING (
        public.is_admin()
        OR employee_id IN (
            SELECT id FROM public.employees WHERE region_id = public.user_region_id()
        )
    );
CREATE POLICY excess_hours_admin ON public.excess_hours_alerts FOR ALL USING (public.is_admin());

-- AUDIT LOG: admins only
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_admin ON public.audit_log FOR ALL USING (public.is_admin());

-- =============================================================================
-- PG_CRON SCHEDULED JOBS
-- =============================================================================

-- Daily OT computation at 4:00 PM CST (22:00 UTC)
-- This upserts excess_hours_alerts from hours_log for the current week.
SELECT cron.schedule(
    'daily-ot-computation',
    '0 22 * * *',
    $$
    INSERT INTO public.excess_hours_alerts
        (employee_id, week_start, hours_through_today, daily_average,
         fri_forecast, sat_forecast, alert_status, stop_work_date)
    SELECT
        e.id,
        DATE_TRUNC('week', hl.work_date)::DATE,
        SUM(hl.hours),
        ROUND(SUM(hl.hours) / NULLIF(COUNT(DISTINCT hl.work_date), 0), 2),
        ROUND(SUM(hl.hours) + SUM(hl.hours) / NULLIF(COUNT(DISTINCT hl.work_date), 0), 2),
        ROUND(SUM(hl.hours) + (SUM(hl.hours) / NULLIF(COUNT(DISTINCT hl.work_date), 0)) * 2, 2),
        CASE
            WHEN SUM(hl.hours) >= 45 THEN 'ineligible'
            WHEN SUM(hl.hours) + SUM(hl.hours) / NULLIF(COUNT(DISTINCT hl.work_date), 0) >= 45 THEN 'ineligible'
            WHEN SUM(hl.hours) + (SUM(hl.hours) / NULLIF(COUNT(DISTINCT hl.work_date), 0)) * 2 >= 45 THEN 'warning'
            ELSE 'cleared'
        END,
        CASE WHEN SUM(hl.hours) >= 45 THEN CURRENT_DATE ELSE NULL END
    FROM public.hours_log hl
    JOIN public.employees e ON hl.employee_id = e.id
    WHERE hl.work_date >= DATE_TRUNC('week', CURRENT_DATE)
      AND e.status = 'active'
    GROUP BY e.id, DATE_TRUNC('week', hl.work_date)
    ON CONFLICT (employee_id, week_start)
    DO UPDATE SET
        hours_through_today = EXCLUDED.hours_through_today,
        daily_average       = EXCLUDED.daily_average,
        fri_forecast        = EXCLUDED.fri_forecast,
        sat_forecast        = EXCLUDED.sat_forecast,
        alert_status        = EXCLUDED.alert_status,
        stop_work_date      = COALESCE(excess_hours_alerts.stop_work_date, EXCLUDED.stop_work_date),
        updated_at          = NOW();
    $$
);

-- Daily stale exception cleanup: mark unresolved exceptions older than 7 days as 'deleted'
SELECT cron.schedule(
    'stale-exception-cleanup',
    '0 15 * * *',
    $$
    UPDATE public.punch_exceptions
    SET resolution_status = 'deleted',
        resolved_at = NOW()
    WHERE resolution_status = 'open'
      AND exception_date < CURRENT_DATE - INTERVAL '7 days';
    $$
);

-- =============================================================================
-- DATA FRESHNESS VIEW
-- Quick check on when each table was last populated.
-- =============================================================================
CREATE OR REPLACE VIEW public.v_data_freshness AS
SELECT 'punches' AS table_name, MAX(created_at) AS latest_record FROM public.punches
UNION ALL
SELECT 'hours_log', MAX(created_at) FROM public.hours_log
UNION ALL
SELECT 'punch_exceptions', MAX(created_at) FROM public.punch_exceptions
UNION ALL
SELECT 'notifications', MAX(sent_at) FROM public.notifications
UNION ALL
SELECT 'excess_hours_alerts', MAX(updated_at) FROM public.excess_hours_alerts;

-- =============================================================================
-- DONE
-- =============================================================================
-- Next steps after migration:
--   1. Create auth users for managers/leadership in Supabase Auth
--   2. Map auth_user_id on employees table
--   3. Set role='admin' in user_metadata for Rachel, Ron, leadership
--   4. Deploy Twilio Edge Function for SMS delivery
--   5. Build Epay import Edge Function (CSV -> hours_log + punches)
--   6. Test RLS policies with test accounts per region
-- =============================================================================
