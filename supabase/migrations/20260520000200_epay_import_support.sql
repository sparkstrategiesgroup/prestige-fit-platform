-- =============================================================================
-- Epay Punches Report import — companion schema
-- =============================================================================
-- Adds:
--   1. job_sites.epay_site_code   — lookup key for the alphanumeric Epay code
--                                   (e.g. "T3447") that the Punches Report uses
--                                   in column A; required to resolve job_site_id.
--   2. job_sites.time_zone         — IANA TZ for each site (Kohl's spans 4).
--   3. job_site_schedules          — per site × shift_block, holds the
--                                   per_schedule_out / scheduled_hours /
--                                   people_per_shift that Epay doesn't export.
--   4. epay_imports                — audit log of every uploaded Punches Report
--                                   (who uploaded, row counts, errors).
-- =============================================================================

ALTER TABLE public.job_sites
    ADD COLUMN epay_site_code VARCHAR(20),
    ADD COLUMN time_zone      VARCHAR(40) NOT NULL DEFAULT 'America/Chicago';

CREATE UNIQUE INDEX idx_job_sites_epay_code
    ON public.job_sites(epay_site_code)
    WHERE epay_site_code IS NOT NULL;

COMMENT ON COLUMN public.job_sites.epay_site_code IS
    'Alphanumeric site code used in Epay exports (e.g. "T3447", "K1234"). Maps Punches Report column A to job_sites.id.';

COMMENT ON COLUMN public.job_sites.time_zone IS
    'IANA TZ for the site. Kohl''s spans America/New_York, America/Chicago, America/Denver, America/Los_Angeles.';

CREATE TABLE public.job_site_schedules (
    id                  SERIAL PRIMARY KEY,
    job_site_id         INTEGER       NOT NULL REFERENCES public.job_sites(id),
    shift_block_id      INTEGER       NOT NULL REFERENCES public.shift_blocks(id),
    scheduled_out_local TIME          NOT NULL,
    scheduled_hours     DECIMAL(5,2)  NOT NULL,
    people_per_shift    INTEGER       NOT NULL DEFAULT 1,
    active              BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    UNIQUE (job_site_id, shift_block_id)
);

CREATE INDEX idx_job_site_schedules_site ON public.job_site_schedules(job_site_id);

COMMENT ON TABLE public.job_site_schedules IS
    'Per site × shift_block scheduling data. Source for labor_control_tracking.per_schedule_out, per_schedule_hours, and people_per_shift. Hand-maintained from the Excel workbook tabs.';

CREATE TRIGGER trg_updated_job_site_schedules
    BEFORE UPDATE ON public.job_site_schedules
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

ALTER TABLE public.job_site_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_site_schedules_select ON public.job_site_schedules FOR SELECT
    USING (
        public.is_admin()
        OR job_site_id IN (
            SELECT id FROM public.job_sites WHERE region_id = public.user_region_id()
        )
    );
CREATE POLICY job_site_schedules_admin ON public.job_site_schedules FOR ALL USING (public.is_admin());

CREATE TABLE public.epay_imports (
    id              BIGSERIAL PRIMARY KEY,
    filename        VARCHAR(255) NOT NULL,
    uploaded_by     UUID         REFERENCES auth.users(id),
    file_sha256     VARCHAR(64),
    row_count       INTEGER      NOT NULL DEFAULT 0,
    imported_count  INTEGER      NOT NULL DEFAULT 0,
    skipped_count   INTEGER      NOT NULL DEFAULT 0,
    error_count     INTEGER      NOT NULL DEFAULT 0,
    errors          JSONB,
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','succeeded','failed','partial')),
    started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_epay_imports_started ON public.epay_imports(started_at);
CREATE INDEX idx_epay_imports_status  ON public.epay_imports(status);

COMMENT ON TABLE public.epay_imports IS
    'Audit trail for Epay Punches Report uploads. errors JSONB shape: [{row, field, message}, ...].';

ALTER TABLE public.epay_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY epay_imports_admin ON public.epay_imports FOR ALL USING (public.is_admin());

-- Link labor_control_tracking back to its source import (for re-imports / rollback)
ALTER TABLE public.labor_control_tracking
    ADD COLUMN epay_import_id BIGINT REFERENCES public.epay_imports(id);

CREATE INDEX idx_lct_epay_import ON public.labor_control_tracking(epay_import_id);
