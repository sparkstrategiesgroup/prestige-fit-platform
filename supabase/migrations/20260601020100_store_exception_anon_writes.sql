-- =============================================================================
-- DEMO ONLY: anon INSERT/UPDATE on store_exception so the dashboard's
-- Store Exceptions form works without authentication. Drop before prod
-- in favor of per-user auth + admin role check.
-- =============================================================================

CREATE POLICY store_exception_anon_insert ON public.store_exception
  FOR INSERT TO anon WITH CHECK (TRUE);

CREATE POLICY store_exception_anon_update ON public.store_exception
  FOR UPDATE TO anon USING (TRUE) WITH CHECK (TRUE);
