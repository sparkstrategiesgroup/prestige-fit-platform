-- =============================================================================
-- AWR & OT Report ingestion.
-- =============================================================================
-- One row per AWR XLSX upload in `awr_import`, one row per Data-sheet row in
-- `awr_data`. After each successful import, employee.pay_rate and
-- employee.winteam_classification are refreshed from the latest week observed.
-- =============================================================================

CREATE TABLE public.awr_import (
    id                  BIGSERIAL PRIMARY KEY,
    wk_end              DATE,
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploaded_by         UUID REFERENCES auth.users(id),
    source_filename     TEXT,
    file_sha256         VARCHAR(64),
    row_count           INTEGER NOT NULL DEFAULT 0,
    unique_employees    INTEGER NOT NULL DEFAULT 0,
    unique_sites        INTEGER NOT NULL DEFAULT 0,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','succeeded','partial','failed')),
    error_count         INTEGER NOT NULL DEFAULT 0,
    errors              JSONB,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_awr_import_wk_end ON public.awr_import(wk_end);
CREATE INDEX idx_awr_import_uploaded_at ON public.awr_import(uploaded_at);

COMMENT ON TABLE public.awr_import IS
    'One row per AWR XLSX upload. The corresponding awr_data rows carry the actual hours/wages.';

ALTER TABLE public.awr_import ENABLE ROW LEVEL SECURITY;
CREATE POLICY awr_import_read_authed ON public.awr_import FOR SELECT
    USING (auth.uid() IS NOT NULL);
CREATE POLICY awr_import_admin ON public.awr_import FOR ALL
    USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- awr_data: raw rows from the AWR `Data` sheet. ~14K rows/week.
-- Indexes support v_site_classification_rate joins and weekly drilldowns.
-- -----------------------------------------------------------------------------
CREATE TABLE public.awr_data (
    id                       BIGSERIAL PRIMARY KEY,
    awr_import_id            BIGINT NOT NULL REFERENCES public.awr_import(id) ON DELETE CASCADE,
    wk_end                   DATE,
    dept                     VARCHAR(20),
    job_site_number          VARCHAR(20),
    job_no                   VARCHAR(20),
    store                    VARCHAR(80),
    region                   VARCHAR(40),
    state                    VARCHAR(2),
    job_site_name            VARCHAR(200),
    employee_number          INTEGER,
    employee_name            VARCHAR(200),
    work_date                DATE,
    task                     VARCHAR(100),
    hours                    NUMERIC(10,4),
    rate_type                VARCHAR(80),
    pay_rate                 NUMERIC(10,4),
    winteam_classification   VARCHAR(40) REFERENCES public.labor_type(code),
    wages                    NUMERIC(12,4),
    no_ot_wages              NUMERIC(12,4),
    no_ot_hrs                NUMERIC(10,4),
    no_ot_rate               NUMERIC(10,4),
    ot_wages                 NUMERIC(12,4),
    ot_hrs                   NUMERIC(10,4),
    ot_half_cost             NUMERIC(12,4),
    fully_staffed            BOOLEAN,
    bud_hrs                  NUMERIC(10,4),
    bud_awr                  NUMERIC(10,4),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite uniqueness within a single import to guard against re-upload duplication.
CREATE UNIQUE INDEX uq_awr_data_natural
    ON public.awr_data (awr_import_id, dept, job_no, employee_number, work_date, task)
    WHERE employee_number IS NOT NULL AND work_date IS NOT NULL;

CREATE INDEX idx_awr_data_site_week ON public.awr_data(job_no, wk_end);
CREATE INDEX idx_awr_data_employee_week ON public.awr_data(employee_number, wk_end)
    WHERE employee_number IS NOT NULL;
CREATE INDEX idx_awr_data_classification ON public.awr_data(winteam_classification)
    WHERE winteam_classification IS NOT NULL;

COMMENT ON TABLE public.awr_data IS
    'Raw rows from the AWR & OT Report Data sheet. Source of truth for actual hours, pay rates, and OT.';

ALTER TABLE public.awr_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY awr_data_read_authed ON public.awr_data FOR SELECT
    USING (auth.uid() IS NOT NULL);
CREATE POLICY awr_data_admin ON public.awr_data FOR ALL
    USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- fn_refresh_employee_payroll_from_awr(awr_import_id)
-- After an AWR import succeeds, refresh employee.pay_rate +
-- employee.winteam_classification from the latest week's rows.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_refresh_employee_payroll_from_awr(p_awr_import_id BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_updated INTEGER := 0;
BEGIN
    WITH latest_per_employee AS (
        SELECT DISTINCT ON (employee_number)
            employee_number,
            pay_rate,
            winteam_classification
        FROM public.awr_data
        WHERE awr_import_id = p_awr_import_id
          AND employee_number IS NOT NULL
          AND pay_rate IS NOT NULL
        ORDER BY employee_number, work_date DESC NULLS LAST
    ),
    upd AS (
        UPDATE public.employee e
        SET pay_rate = l.pay_rate,
            winteam_classification = l.winteam_classification,
            awr_classification_updated_at = NOW()
        FROM latest_per_employee l
        WHERE e.employee_number = l.employee_number
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_updated FROM upd;

    RETURN v_updated;
END;
$$;

COMMENT ON FUNCTION public.fn_refresh_employee_payroll_from_awr IS
    'Update employee.pay_rate and winteam_classification from the latest week in a given AWR import.';

GRANT EXECUTE ON FUNCTION public.fn_refresh_employee_payroll_from_awr TO authenticated;
