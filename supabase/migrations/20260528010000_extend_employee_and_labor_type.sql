-- =============================================================================
-- Scheduling foundation: WinTeam labor types + payroll columns on employee.
-- =============================================================================
-- Powers the Master Schedule -> WinTeam Budget pipeline.
--
-- 1. `labor_type` — lookup of the 7 WinTeam Classifications observed in the
--    user's AWR & OT Report. `wt_hours_type_id` left NULL until the user
--    provides the WinTeam codes.
-- 2. Extend `employee` with payroll columns. Refreshed from each AWR upload.
-- =============================================================================

CREATE TABLE public.labor_type (
    code                    VARCHAR(40) PRIMARY KEY,
    name                    VARCHAR(80) NOT NULL,
    wt_hours_type_id        INTEGER,
    wt_task_string          VARCHAR(100),
    include_in_budget       BOOLEAN     NOT NULL DEFAULT TRUE,
    active                  BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.labor_type IS
    'WinTeam Classifications seen in the AWR & OT Report. Drives the Description column on the WinTeam Budget export.';
COMMENT ON COLUMN public.labor_type.wt_hours_type_id IS
    'WinTeam HoursTypeID for this classification. Populate via UPDATE once user provides the codes.';
COMMENT ON COLUMN public.labor_type.wt_task_string IS
    'Matches the AWR `Task` column value, e.g. ''Regular Service[Lab01]''. Used to map AWR rows back to a labor_type.';
COMMENT ON COLUMN public.labor_type.include_in_budget IS
    'False for Subcontract Labor — tracked in awr_data but excluded from v_wt_budget_export.';

-- Seed the 7 classifications from the AWR Data sheet.
INSERT INTO public.labor_type (code, name, wt_task_string, include_in_budget) VALUES
    ('CUSTODIAN',             'Custodian',             'Regular Service[Lab01]',         TRUE),
    ('LEAD_CUSTODIAN',        'Lead Custodian',        'Lead Custodial[LeadCustodial]',  TRUE),
    ('PORTER',                'Porter',                'Porter[Porter]',                 TRUE),
    ('FLOATER',               'Floater',               NULL,                             TRUE),
    ('FACILITIES_SUPERVISOR', 'Facilities Supervisor', 'Visit[Visit]',                   TRUE),
    ('PROJECT_TECH',          'Project Tech',          NULL,                             TRUE),
    ('SUBCONTRACT_LABOR',     'Subcontract Labor',     NULL,                             FALSE);

CREATE TRIGGER trg_updated_labor_type
    BEFORE UPDATE ON public.labor_type
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

ALTER TABLE public.labor_type ENABLE ROW LEVEL SECURITY;
CREATE POLICY labor_type_read_all ON public.labor_type FOR SELECT USING (TRUE);
CREATE POLICY labor_type_admin    ON public.labor_type FOR ALL    USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- employee: add payroll columns refreshed from AWR.
-- -----------------------------------------------------------------------------
-- pay_rate (NUMERIC) already exists on employee from the initial schema.
ALTER TABLE public.employee
    ADD COLUMN bill_rate                      NUMERIC(10,4),
    ADD COLUMN winteam_classification         VARCHAR(40) REFERENCES public.labor_type(code),
    ADD COLUMN awr_classification_updated_at  TIMESTAMPTZ;

COMMENT ON COLUMN public.employee.bill_rate IS
    'Per-employee bill rate. Usually NULL; budget export pulls bill rate from contract_bill_rate by (site, classification).';
COMMENT ON COLUMN public.employee.winteam_classification IS
    'Normalized WinTeam Classification (FK to labor_type.code). Distinct from the free-text addendum `classification` column.';

CREATE INDEX idx_employee_winteam_classification
    ON public.employee(winteam_classification)
    WHERE winteam_classification IS NOT NULL;

-- -----------------------------------------------------------------------------
-- contract_bill_rate: per (site, classification) bill rates from WinTeam contracts.
-- Empty on launch — user will populate from a future WinTeam contract export.
-- -----------------------------------------------------------------------------
CREATE TABLE public.contract_bill_rate (
    site_id                 VARCHAR(20) NOT NULL REFERENCES public.site(site_id),
    winteam_classification  VARCHAR(40) NOT NULL REFERENCES public.labor_type(code),
    bill_rate               NUMERIC(10,4) NOT NULL,
    effective_from          DATE        NOT NULL,
    effective_to            DATE,
    notes                   TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (site_id, winteam_classification, effective_from),
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE public.contract_bill_rate IS
    'Per (site, classification) bill rates from WinTeam contracts. Joined into v_wt_budget_export on (site_id, winteam_classification) where effective_from <= effective_date <= COALESCE(effective_to, ''infinity'').';

CREATE TRIGGER trg_updated_contract_bill_rate
    BEFORE UPDATE ON public.contract_bill_rate
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

ALTER TABLE public.contract_bill_rate ENABLE ROW LEVEL SECURITY;
CREATE POLICY contract_bill_rate_read_all ON public.contract_bill_rate FOR SELECT USING (TRUE);
CREATE POLICY contract_bill_rate_admin    ON public.contract_bill_rate FOR ALL    USING (public.is_admin());
