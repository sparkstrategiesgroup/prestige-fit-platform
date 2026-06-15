-- =============================================================================
-- Email-driven Punches Report ingestion (Power Automate webhook)
-- =============================================================================
-- Powers the no-code flow that watches a shared Outlook mailbox and POSTs
-- matching .xlsx attachments to /functions/v1/epay-import-email.
--
-- Two tables:
--   1. email_allowed_senders  — strict allowlist of sender emails / domains.
--   2. email_imports          — audit log of every email-driven import.
-- =============================================================================

CREATE TABLE public.email_allowed_senders (
    email       TEXT          PRIMARY KEY,
    active      BOOLEAN       NOT NULL DEFAULT TRUE,
    notes       TEXT,
    added_by    UUID          REFERENCES auth.users(id),
    added_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.email_allowed_senders IS
    'Allowlist for the epay-import-email webhook. Email values are matched case-insensitively. A leading "*@" treats the rest as a domain wildcard, e.g. "*@epayinc.com".';

CREATE TRIGGER trg_updated_email_allowed_senders
    BEFORE UPDATE ON public.email_allowed_senders
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

-- Seed with two reasonable defaults for the demo. Update via SQL or the
-- (future) Settings UI when the real Epay system sender is known.
INSERT INTO public.email_allowed_senders (email, notes) VALUES
    ('claudia@prestigeusa.net', 'Labor Control lead — manual forwards'),
    ('*@epayinc.com',           'Anything from the Epay system')
ON CONFLICT (email) DO NOTHING;

CREATE TABLE public.email_imports (
    id                    BIGSERIAL PRIMARY KEY,
    sender                TEXT          NOT NULL,
    subject               TEXT,
    received_at           TIMESTAMPTZ,
    attachment_filename   TEXT,
    attachment_sha256     VARCHAR(64),
    attachment_bytes      INTEGER,
    imported_count        INTEGER       NOT NULL DEFAULT 0,
    sites_created         INTEGER       NOT NULL DEFAULT 0,
    error_count           INTEGER       NOT NULL DEFAULT 0,
    errors                JSONB,
    status                VARCHAR(20)   NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','rejected','succeeded','partial','failed')),
    rejection_reason      TEXT,
    epay_import_id        BIGINT        REFERENCES public.epay_imports(id),
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    completed_at          TIMESTAMPTZ
);

CREATE INDEX idx_email_imports_created ON public.email_imports(created_at);
CREATE INDEX idx_email_imports_status  ON public.email_imports(status);
CREATE INDEX idx_email_imports_sender  ON public.email_imports(sender);

COMMENT ON TABLE public.email_imports IS
    'One row per email received by the epay-import-email webhook. Rejected rows preserve a paper trail of senders that were blocked by the allowlist.';

-- RLS: admin only for now. Demo dashboard can SELECT via anon policy below.
ALTER TABLE public.email_allowed_senders ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_allowed_senders_admin ON public.email_allowed_senders FOR ALL
    USING (public.is_admin());

ALTER TABLE public.email_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_imports_admin ON public.email_imports FOR ALL
    USING (public.is_admin());
-- Demo: let the unauthenticated dashboard render the imports list. Drop
-- this policy before pointing at production data.
CREATE POLICY email_imports_anon_read ON public.email_imports FOR SELECT TO anon
    USING (TRUE);

-- Audit triggers.
CREATE TRIGGER trg_audit_email_allowed_senders
    AFTER INSERT OR UPDATE OR DELETE ON public.email_allowed_senders
    FOR EACH ROW EXECUTE FUNCTION public.fn_audit_log();

-- email_imports is high-volume audit data; skip audit triggers (the table
-- itself is the audit trail).
