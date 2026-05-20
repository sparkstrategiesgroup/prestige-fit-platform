-- =============================================================================
-- FIT-001 (part 2/3): Add columns required by Labor Cost Tracking Addendum
--                     §2.1 (site) and §2.2 (employee). Replace the 3-value
--                     `client` CHECK with the addendum's seven-value `chain`.
-- =============================================================================
-- The existing `site.client` CHECK only covered TARGET / HOME_DEPOT / KOHLS.
-- The addendum's chain enum is TARGET / KOHLS / HARDLINES / SOLO / JJM / CAT /
-- ADI. HOME_DEPOT is intentionally NOT carried forward — the addendum's
-- HARDLINES is the umbrella term used by ops; HOME_DEPOT is a subset of
-- HARDLINES and is filed under that chain. (Flagged for K to confirm.)
-- =============================================================================

-- ---- 1. site: §2.1 additions ----
ALTER TABLE public.site
    ADD COLUMN chain           VARCHAR(20),
    ADD COLUMN region_code     VARCHAR(20),
    ADD COLUMN region_manager  VARCHAR(100),
    ADD COLUMN delivery_model  VARCHAR(20)
        CHECK (delivery_model IS NULL OR delivery_model IN ('SELF_PERFORM','TSP','OPEN'));

-- Replace the legacy client check with the addendum's seven-value chain check.
-- Backfill `chain` from the legacy `client` column where possible, then
-- derive the rest from the site_id prefix.
UPDATE public.site
SET    chain = CASE
                  WHEN client = 'TARGET'     THEN 'TARGET'
                  WHEN client = 'KOHLS'      THEN 'KOHLS'
                  WHEN client = 'HOME_DEPOT' THEN 'HARDLINES'
              END
WHERE  client IS NOT NULL;

-- Derive chain from site_id prefix for rows where `client` was NULL.
UPDATE public.site
SET    chain = CASE
                  WHEN site_id ILIKE 'T%'   THEN 'TARGET'
                  WHEN site_id ILIKE 'KOH%' THEN 'KOHLS'
                  WHEN site_id ILIKE 'H%'   THEN 'HARDLINES'
                  WHEN site_id ILIKE 'SOL%' THEN 'SOLO'
                  WHEN site_id ILIKE 'JJM%' THEN 'JJM'
                  WHEN site_id ILIKE 'CAT%' THEN 'CAT'
                  WHEN site_id ILIKE 'ADI%' THEN 'ADI'
              END
WHERE  chain IS NULL;

ALTER TABLE public.site
    ADD CONSTRAINT site_chain_check
    CHECK (chain IS NULL OR chain IN ('TARGET','KOHLS','HARDLINES','SOLO','JJM','CAT','ADI'));

-- Drop the legacy client column now that chain is the system of record.
DROP INDEX IF EXISTS public.idx_site_client;
ALTER TABLE public.site DROP COLUMN client;

CREATE INDEX idx_site_chain ON public.site(chain) WHERE chain IS NOT NULL;

COMMENT ON COLUMN public.site.chain IS
    'Client brand. Addendum §2.1. Backfilled from site_id prefix.';

-- ---- 2. employee: §2.2 additions ----
ALTER TABLE public.employee
    ADD COLUMN middle_name        VARCHAR(100),
    ADD COLUMN phone_2            VARCHAR(20),
    ADD COLUMN phone_3            VARCHAR(20),
    ADD COLUMN hire_date          DATE,
    ADD COLUMN classification     VARCHAR(80),
    ADD COLUMN employee_type      VARCHAR(80),
    ADD COLUMN primary_job_id     VARCHAR(20)
        REFERENCES public.site(site_id),
    ADD COLUMN preferred_language VARCHAR(5) NOT NULL DEFAULT 'en'
        CHECK (preferred_language IN ('en','es'));

COMMENT ON COLUMN public.employee.preferred_language IS
    'Outreach SMS language preference. Addendum §2.2. Defaults to en.';
COMMENT ON COLUMN public.employee.primary_job_id IS
    'FK to site.site_id (the natural key, not the SERIAL id). Addendum §2.2.';
