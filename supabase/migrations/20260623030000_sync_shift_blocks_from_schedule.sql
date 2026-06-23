-- Drive shift-block matching from the Master Schedule Report.
--
-- Background: punches (labor_control_tracking) are matched to a shift_block at
-- import time via fn_pick_shift_block, which joins job_site_schedules (site ->
-- block). That table was empty and shift_blocks only held a handful of retail
-- end-times, so most punches went unmatched. The Schedule Report (schedule_slot)
-- is the real source of truth for which shifts each site runs.
--
-- This migration adds fn_sync_shift_blocks_from_schedule(), an idempotent routine
-- that rebuilds the matcher inputs from schedule_slot:
--   1. ensure an active shift_block exists for every (end_time, time_zone) in the
--      report (reusing existing blocks; day/client coverage unioned from the report),
--   2. upsert one job_site_schedules row per site x block, and
--   3. deactivate job_site_schedules rows that no longer match any schedule_slot.
--
-- The site-code bridge: schedule_slot.site_id (varchar) = site.site_id, and
-- job_site_schedules.job_site_id = site.id (integer). Time zones map to label
-- suffixes so shift_blocks.label (UNIQUE) stays distinct across zones.
--
-- master-schedule-apply calls this after applying a revision, so every approved
-- Schedule Report refreshes the matcher. A one-time backfill of historical
-- labor_control_tracking.shift_block_id was run separately (re-running
-- fn_pick_shift_block over existing rows); it is intentionally NOT part of this
-- routine, which only maintains blocks + job_site_schedules.

CREATE OR REPLACE FUNCTION public.fn_sync_shift_blocks_from_schedule()
RETURNS TABLE(blocks_created integer, schedules_upserted integer, schedules_deactivated integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_blocks_created integer := 0;
  v_upserted integer := 0;
  v_deactivated integer := 0;
BEGIN
  -- 1a. Refresh + activate existing blocks whose (end_time, tz) appear in the report.
  WITH day_union AS (
    SELECT ss.end_time, ss.time_zone, x.idx, bool_or(x.val) AS day_on
    FROM public.schedule_slot ss
    CROSS JOIN LATERAL unnest(ss.days_of_week) WITH ORDINALITY AS x(val, idx)
    GROUP BY ss.end_time, ss.time_zone, x.idx
  ),
  days AS (
    SELECT end_time, time_zone, array_agg(day_on ORDER BY idx) AS days_of_week
    FROM day_union GROUP BY end_time, time_zone
  ),
  clients AS (
    SELECT ss.end_time, ss.time_zone,
           COALESCE(array_agg(DISTINCT s.chain) FILTER (WHERE s.chain IS NOT NULL),
                    ARRAY[]::varchar[]) AS clients
    FROM public.schedule_slot ss
    LEFT JOIN public.site s ON s.site_id = ss.site_id
    GROUP BY ss.end_time, ss.time_zone
  ),
  needed AS (
    SELECT d.end_time, d.time_zone, d.days_of_week, c.clients
    FROM days d JOIN clients c USING (end_time, time_zone)
  )
  UPDATE public.shift_blocks sb
  SET active = true,
      days_of_week = n.days_of_week,
      clients = n.clients,
      updated_at = now()
  FROM needed n
  WHERE sb.end_time_local = n.end_time
    AND sb.end_timezone = n.time_zone;

  -- 1b. Create blocks for report end-times that have no block yet.
  WITH day_union AS (
    SELECT ss.end_time, ss.time_zone, x.idx, bool_or(x.val) AS day_on
    FROM public.schedule_slot ss
    CROSS JOIN LATERAL unnest(ss.days_of_week) WITH ORDINALITY AS x(val, idx)
    GROUP BY ss.end_time, ss.time_zone, x.idx
  ),
  days AS (
    SELECT end_time, time_zone, array_agg(day_on ORDER BY idx) AS days_of_week
    FROM day_union GROUP BY end_time, time_zone
  ),
  clients AS (
    SELECT ss.end_time, ss.time_zone,
           COALESCE(array_agg(DISTINCT s.chain) FILTER (WHERE s.chain IS NOT NULL),
                    ARRAY[]::varchar[]) AS clients
    FROM public.schedule_slot ss
    LEFT JOIN public.site s ON s.site_id = ss.site_id
    GROUP BY ss.end_time, ss.time_zone
  ),
  needed AS (
    SELECT d.end_time, d.time_zone, d.days_of_week, c.clients
    FROM days d JOIN clients c USING (end_time, time_zone)
  )
  INSERT INTO public.shift_blocks (label, end_time_local, end_timezone, clients, days_of_week, active)
  SELECT
    to_char(n.end_time, 'FMHH12:MI AM') || ' Shift'
      || CASE n.time_zone
           WHEN 'America/Chicago'  THEN ''
           WHEN 'America/Denver'   THEN ' (MT)'
           WHEN 'America/New_York' THEN ' (ET)'
           ELSE ' (' || n.time_zone || ')'
         END,
    n.end_time, n.time_zone, n.clients, n.days_of_week, true
  FROM needed n
  WHERE NOT EXISTS (
    SELECT 1 FROM public.shift_blocks sb
    WHERE sb.end_time_local = n.end_time AND sb.end_timezone = n.time_zone
  );
  GET DIAGNOSTICS v_blocks_created = ROW_COUNT;

  -- 2. Upsert job_site_schedules (one row per site x block) from the report.
  WITH agg AS (
    SELECT s.id AS job_site_id,
           sb.id AS shift_block_id,
           ss.end_time AS scheduled_out_local,
           round(max(extract(epoch FROM (ss.end_time - ss.start_time)) / 3600.0
                     + CASE WHEN ss.end_time < ss.start_time THEN 24 ELSE 0 END)::numeric, 2)
             AS scheduled_hours,
           count(*)::int AS people_per_shift
    FROM public.schedule_slot ss
    JOIN public.site s ON s.site_id = ss.site_id
    JOIN public.shift_blocks sb
      ON sb.end_time_local = ss.end_time AND sb.end_timezone = ss.time_zone
    GROUP BY s.id, sb.id, ss.end_time
  )
  INSERT INTO public.job_site_schedules
    (job_site_id, shift_block_id, scheduled_out_local, scheduled_hours, people_per_shift, active)
  SELECT job_site_id, shift_block_id, scheduled_out_local, scheduled_hours, people_per_shift, true
  FROM agg
  ON CONFLICT (job_site_id, shift_block_id) DO UPDATE
    SET scheduled_out_local = EXCLUDED.scheduled_out_local,
        scheduled_hours     = EXCLUDED.scheduled_hours,
        people_per_shift    = EXCLUDED.people_per_shift,
        active              = true,
        updated_at          = now();
  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  -- 3. Deactivate job_site_schedules that no longer correspond to any schedule_slot.
  UPDATE public.job_site_schedules jss
  SET active = false, updated_at = now()
  WHERE jss.active = true
    AND NOT EXISTS (
      SELECT 1
      FROM public.schedule_slot ss
      JOIN public.site s ON s.site_id = ss.site_id
      JOIN public.shift_blocks sb
        ON sb.end_time_local = ss.end_time AND sb.end_timezone = ss.time_zone
      WHERE s.id = jss.job_site_id AND sb.id = jss.shift_block_id
    );
  GET DIAGNOSTICS v_deactivated = ROW_COUNT;

  RETURN QUERY SELECT v_blocks_created, v_upserted, v_deactivated;
END;
$function$;

COMMENT ON FUNCTION public.fn_sync_shift_blocks_from_schedule() IS
  'Idempotently rebuilds shift_blocks + job_site_schedules from schedule_slot (the Master Schedule Report). Called by master-schedule-apply after each approved revision.';
