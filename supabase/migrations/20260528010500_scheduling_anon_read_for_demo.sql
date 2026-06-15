-- =============================================================================
-- DEMO ONLY: anon SELECT on the scheduling tables.
-- =============================================================================
-- Mirrors the existing email_imports.anon_read pattern so the unauthenticated
-- dashboard can render the Scheduling tab. Real per-user auth (FIT supervisor
-- login) lands in a follow-up PR; drop these before any production cutover.
-- =============================================================================

CREATE POLICY msr_anon_read         ON public.master_schedule_revision FOR SELECT TO anon USING (TRUE);
CREATE POLICY msc_anon_read         ON public.master_schedule_change   FOR SELECT TO anon USING (TRUE);
CREATE POLICY awr_import_anon_read  ON public.awr_import               FOR SELECT TO anon USING (TRUE);
CREATE POLICY awr_data_anon_read    ON public.awr_data                 FOR SELECT TO anon USING (TRUE);
CREATE POLICY cbr_anon_read         ON public.contract_bill_rate       FOR SELECT TO anon USING (TRUE);
