-- =============================================================================
-- DEMO ONLY: anon INSERT on master_schedule_revision + master_schedule_change
-- so the Shift Change Request card on Daily Control can submit pending
-- revisions without authentication. Real per-user auth lands with the
-- supervisor-login work. Mirrors store_exception_anon_writes.
-- =============================================================================

CREATE POLICY msr_anon_insert ON public.master_schedule_revision
  FOR INSERT TO anon WITH CHECK (TRUE);

CREATE POLICY msc_anon_insert ON public.master_schedule_change
  FOR INSERT TO anon WITH CHECK (TRUE);
