-- =============================================================================
-- fn_pick_shift_block: given a site + punch time, return the shift_block whose
-- local end-time is the soonest >= the punch's local time-of-day. Falls back to
-- the latest end-time if every mapped block already ended. NULL when the site
-- has no active job_site_schedules row.
--
-- Replaces the importer's previous .maybeSingle() lookup, which silently
-- returned NULL for sites mapped to more than one block (e.g. the 80 sites
-- mapped to both the 11:00 and 1:30 shifts).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_pick_shift_block(
  p_job_site_id INTEGER,
  p_time_in     TIMESTAMPTZ
) RETURNS INTEGER LANGUAGE sql STABLE AS $$
  WITH options AS (
    SELECT
      sb.id,
      sb.end_time_local,
      (p_time_in AT TIME ZONE sb.end_timezone)::time AS local_in
    FROM public.job_site_schedules jss
    JOIN public.shift_blocks sb ON sb.id = jss.shift_block_id
    WHERE jss.job_site_id = p_job_site_id
      AND jss.active = TRUE
      AND sb.active = TRUE
  )
  SELECT id FROM options
  ORDER BY
    CASE WHEN end_time_local >= local_in THEN 0 ELSE 1 END,
    CASE WHEN end_time_local >= local_in
         THEN end_time_local - local_in
         ELSE local_in - end_time_local
    END
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.fn_pick_shift_block(INTEGER, TIMESTAMPTZ)
  TO anon, authenticated, service_role;

-- Backfill recent punches that landed with NULL because of the old single-row lookup.
UPDATE public.labor_control_tracking
   SET shift_block_id = public.fn_pick_shift_block(job_site_id, time_in)
 WHERE work_date >= CURRENT_DATE - 7
   AND shift_block_id IS NULL;
