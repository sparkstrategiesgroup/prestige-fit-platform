-- =============================================================================
-- WinTeam Employee List (113) email ingestion
-- =============================================================================
-- The WinTeam "Employee List" scheduled report (`%ID%` = 113) exports daily at
-- 6:00pm and is forwarded into the FIT intake mailbox. It follows the same
-- email-driven workflow as the ePay Punches Report:
--
--   Email (Fit@prestigeusa.net) -> Power Automate -> employee-list-import-email
--     -> sender allowlist + dedup -> parse CSV/XLSX -> refresh `employee`.
--
-- Columns: EmployeeID, FirstName, LastName, Phone1, Phone2, PrimaryJob,
-- PrimaryJobSite, EEStatus. The report is the authoritative roster, so each
-- import REFRESHES mutable fields on the existing `employee` row matched by
-- `employee_number`. It is update-only: a new EmployeeID with no `employee`
-- row cannot be inserted (employee.region_id / department_id are NOT NULL and
-- the 113 report carries neither), so unmatched rows are recorded in
-- `errors` for an operator to onboard manually.
--
-- Two changes:
--   1. employee_list_imports  — audit log of every Employee List import
--                               (mirrors epay_imports).
--   2. email_imports.employee_list_import_id — link the email wrapper row to
--                               the parsed import, like epay_import_id.
-- And the sender allowlist gains the daily forwarder.
-- =============================================================================

CREATE TABLE public.employee_list_imports (
    id               BIGSERIAL    PRIMARY KEY,
    filename         VARCHAR(255) NOT NULL,
    uploaded_by      UUID         REFERENCES auth.users(id),
    file_sha256      VARCHAR(64),
    row_count        INTEGER      NOT NULL DEFAULT 0,
    matched_count    INTEGER      NOT NULL DEFAULT 0,
    updated_count    INTEGER      NOT NULL DEFAULT 0,
    unmatched_count  INTEGER      NOT NULL DEFAULT 0,
    error_count      INTEGER      NOT NULL DEFAULT 0,
    errors           JSONB,
    status           VARCHAR(20)  NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','succeeded','failed','partial')),
    started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ
);

CREATE INDEX idx_employee_list_imports_started ON public.employee_list_imports(started_at);
CREATE INDEX idx_employee_list_imports_status  ON public.employee_list_imports(status);

COMMENT ON TABLE public.employee_list_imports IS
    'Audit trail for WinTeam Employee List (113) imports. One row per parsed file. matched_count = EmployeeIDs found in `employee`; updated_count = rows whose fields changed; unmatched_count = EmployeeIDs with no `employee` row (likely new hires to onboard). errors JSONB shape: [{row, field, message}, ...].';

ALTER TABLE public.employee_list_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY employee_list_imports_admin ON public.employee_list_imports FOR ALL
    USING (public.is_admin());

-- Link the email wrapper row to its parsed import (parallels email_imports.epay_import_id).
ALTER TABLE public.email_imports
    ADD COLUMN employee_list_import_id BIGINT REFERENCES public.employee_list_imports(id);

-- Allow the daily forwarder. The allowlist is shared across both email
-- webhooks; routing to the correct parser is by endpoint (Power Automate POSTs
-- 113_* files to employee-list-import-email), per the file-prefix convention.
INSERT INTO public.email_allowed_senders (email, notes) VALUES
    ('kneff@sparkstrategiesgroup.com', 'Daily WinTeam Employee List (113) forward, 6:00pm ET')
ON CONFLICT (email) DO NOTHING;
