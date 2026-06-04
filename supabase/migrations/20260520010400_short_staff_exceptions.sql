-- =============================================================================
-- Short-staff exceptions tracking
-- =============================================================================
-- Stores daily short-staff exceptions that ops managers track per site.
-- Data comes from the yellow-highlighted Excel sheet ("BELOW STORES") or
-- manual entry in the Daily Control page.
-- =============================================================================

CREATE TABLE public.short_staff_exception (
    id              BIGSERIAL PRIMARY KEY,
    store_code      VARCHAR(20)   NOT NULL,
    site_name       VARCHAR(200),
    notes           TEXT,
    department      VARCHAR(200),
    exception_date  DATE          NOT NULL,
    created_by      UUID          REFERENCES auth.users(id),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    UNIQUE (store_code, exception_date)
);

CREATE INDEX idx_short_staff_exception_date ON public.short_staff_exception(exception_date);
CREATE INDEX idx_short_staff_exception_store ON public.short_staff_exception(store_code);

COMMENT ON TABLE public.short_staff_exception IS
    'Daily short-staff exceptions per store. One row per store per day. Source: ops manager Excel or manual entry in Daily Control.';

CREATE TRIGGER trg_updated_short_staff_exception
    BEFORE UPDATE ON public.short_staff_exception
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

ALTER TABLE public.short_staff_exception ENABLE ROW LEVEL SECURITY;
CREATE POLICY short_staff_exception_select ON public.short_staff_exception FOR SELECT USING (TRUE);
CREATE POLICY short_staff_exception_admin ON public.short_staff_exception FOR ALL USING (public.is_admin());
