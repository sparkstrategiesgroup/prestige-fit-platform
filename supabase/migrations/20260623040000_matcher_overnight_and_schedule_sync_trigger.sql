-- Caveat fixes on top of 20260623030000_sync_shift_blocks_from_schedule.sql:
--   1. fn_pick_shift_block: handle overnight shifts and stop matching punches that
--      have no real shift to a nonsensical block.
--   2. Auto-sync the matcher whenever schedule_slot changes (covers the manual
--      shift-change form, not just the master-schedule-apply flow).

-- Shift start time is needed to reason about the shift window (overnight wrap).
alter table public.job_site_schedules
  add column if not exists scheduled_in_local time without time zone;

-- ---------------------------------------------------------------------------
-- 1. Matcher: window-aware, overnight-aware, no nonsensical wrap-around.
--
-- The dominant pattern here is an early clock-in (often hours before the
-- scheduled start) for a shift that ends later the same morning, so the primary
-- rule stays "the next shift to END at/after the clock-in is yours". On top of
-- that:
--   * overnight shifts (end_time < start_time) that are currently in progress
--     (clock-in at/after start) match the block that ends the next morning;
--   * a clock-in up to 60 min AFTER a shift end still matches that shift
--     (slight overrun / rounding);
--   * if nothing qualifies, return NULL instead of assigning the arbitrary
--     nearest block (e.g. a 10pm punch at a site that only runs 5-10am).
-- ---------------------------------------------------------------------------
create or replace function public.fn_pick_shift_block(p_job_site_id integer, p_time_in timestamp with time zone)
returns integer
language sql
stable
as $function$
  with opts as (
    select
      sb.id,
      sb.end_time_local as end_t,
      jss.scheduled_in_local as start_t,
      (p_time_in at time zone sb.end_timezone)::time as local_in
    from public.job_site_schedules jss
    join public.shift_blocks sb on sb.id = jss.shift_block_id
    where jss.job_site_id = p_job_site_id
      and jss.active = true
      and sb.active = true
  ),
  scored as (
    select id,
      case
        -- shift ends later today than the clock-in (covers early clock-ins too)
        when end_t >= local_in then end_t - local_in
        -- overnight shift in progress: started today, ends tomorrow
        when start_t is not null and end_t < start_t and local_in >= start_t
          then (end_t - local_in) + interval '24 hours'
        else null
      end as time_to_end,
      -- clock-in shortly after a shift end (slight overrun)
      case
        when end_t < local_in
          and (start_t is null or end_t >= start_t)
          and (local_in - end_t) <= interval '60 minutes'
          then local_in - end_t
        else null
      end as recent_overrun
    from opts
  )
  select id from scored
  where time_to_end is not null or recent_overrun is not null
  order by
    case when time_to_end is not null then 0 else 1 end,  -- prefer an upcoming/ongoing shift
    coalesce(time_to_end, recent_overrun)                 -- nearest of whichever applies
  limit 1;
$function$;

-- ---------------------------------------------------------------------------
-- 2. fn_sync_shift_blocks_from_schedule: also maintain scheduled_in_local.
-- ---------------------------------------------------------------------------
create or replace function public.fn_sync_shift_blocks_from_schedule()
returns table(blocks_created integer, schedules_upserted integer, schedules_deactivated integer)
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_blocks_created integer := 0;
  v_upserted integer := 0;
  v_deactivated integer := 0;
begin
  with day_union as (
    select ss.end_time, ss.time_zone, x.idx, bool_or(x.val) as day_on
    from public.schedule_slot ss
    cross join lateral unnest(ss.days_of_week) with ordinality as x(val, idx)
    group by ss.end_time, ss.time_zone, x.idx
  ),
  days as (
    select end_time, time_zone, array_agg(day_on order by idx) as days_of_week
    from day_union group by end_time, time_zone
  ),
  clients as (
    select ss.end_time, ss.time_zone,
           coalesce(array_agg(distinct s.chain) filter (where s.chain is not null),
                    array[]::varchar[]) as clients
    from public.schedule_slot ss
    left join public.site s on s.site_id = ss.site_id
    group by ss.end_time, ss.time_zone
  ),
  needed as (
    select d.end_time, d.time_zone, d.days_of_week, c.clients
    from days d join clients c using (end_time, time_zone)
  )
  update public.shift_blocks sb
  set active = true,
      days_of_week = n.days_of_week,
      clients = n.clients,
      updated_at = now()
  from needed n
  where sb.end_time_local = n.end_time
    and sb.end_timezone = n.time_zone;

  with day_union as (
    select ss.end_time, ss.time_zone, x.idx, bool_or(x.val) as day_on
    from public.schedule_slot ss
    cross join lateral unnest(ss.days_of_week) with ordinality as x(val, idx)
    group by ss.end_time, ss.time_zone, x.idx
  ),
  days as (
    select end_time, time_zone, array_agg(day_on order by idx) as days_of_week
    from day_union group by end_time, time_zone
  ),
  clients as (
    select ss.end_time, ss.time_zone,
           coalesce(array_agg(distinct s.chain) filter (where s.chain is not null),
                    array[]::varchar[]) as clients
    from public.schedule_slot ss
    left join public.site s on s.site_id = ss.site_id
    group by ss.end_time, ss.time_zone
  ),
  needed as (
    select d.end_time, d.time_zone, d.days_of_week, c.clients
    from days d join clients c using (end_time, time_zone)
  )
  insert into public.shift_blocks (label, end_time_local, end_timezone, clients, days_of_week, active)
  select
    to_char(n.end_time, 'FMHH12:MI AM') || ' Shift'
      || case n.time_zone
           when 'America/Chicago'  then ''
           when 'America/Denver'   then ' (MT)'
           when 'America/New_York' then ' (ET)'
           else ' (' || n.time_zone || ')'
         end,
    n.end_time, n.time_zone, n.clients, n.days_of_week, true
  from needed n
  where not exists (
    select 1 from public.shift_blocks sb
    where sb.end_time_local = n.end_time and sb.end_timezone = n.time_zone
  );
  get diagnostics v_blocks_created = row_count;

  with agg as (
    select s.id as job_site_id,
           sb.id as shift_block_id,
           ss.end_time as scheduled_out_local,
           min(ss.start_time) as scheduled_in_local,
           round(max(extract(epoch from (ss.end_time - ss.start_time)) / 3600.0
                     + case when ss.end_time < ss.start_time then 24 else 0 end)::numeric, 2)
             as scheduled_hours,
           count(*)::int as people_per_shift
    from public.schedule_slot ss
    join public.site s on s.site_id = ss.site_id
    join public.shift_blocks sb
      on sb.end_time_local = ss.end_time and sb.end_timezone = ss.time_zone
    group by s.id, sb.id, ss.end_time
  )
  insert into public.job_site_schedules
    (job_site_id, shift_block_id, scheduled_out_local, scheduled_in_local, scheduled_hours, people_per_shift, active)
  select job_site_id, shift_block_id, scheduled_out_local, scheduled_in_local, scheduled_hours, people_per_shift, true
  from agg
  on conflict (job_site_id, shift_block_id) do update
    set scheduled_out_local = excluded.scheduled_out_local,
        scheduled_in_local  = excluded.scheduled_in_local,
        scheduled_hours     = excluded.scheduled_hours,
        people_per_shift    = excluded.people_per_shift,
        active              = true,
        updated_at          = now();
  get diagnostics v_upserted = row_count;

  update public.job_site_schedules jss
  set active = false, updated_at = now()
  where jss.active = true
    and not exists (
      select 1
      from public.schedule_slot ss
      join public.site s on s.site_id = ss.site_id
      join public.shift_blocks sb
        on sb.end_time_local = ss.end_time and sb.end_timezone = ss.time_zone
      where s.id = jss.job_site_id and sb.id = jss.shift_block_id
    );
  get diagnostics v_deactivated = row_count;

  return query select v_blocks_created, v_upserted, v_deactivated;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Auto-sync the matcher whenever schedule_slot changes.
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger fires at COMMIT, after all
-- of a transaction's schedule_slot changes are applied, so fn_sync sees the
-- final state. A transaction-local flag makes it run once per transaction even
-- though it is a row-level trigger. This covers every writer: the bulk
-- master-schedule-apply loop AND the manual shift-change form's direct insert.
-- ---------------------------------------------------------------------------
create or replace function public.fn_trg_schedule_slot_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
begin
  if coalesce(current_setting('prestige.slot_synced_tx', true), '') = 'on' then
    return null;  -- already synced once in this transaction
  end if;
  perform set_config('prestige.slot_synced_tx', 'on', true);  -- transaction-local
  -- Non-fatal: a sync hiccup must not roll back the schedule_slot write that
  -- triggered it (e.g. a shift-change form submission). Matcher inputs are
  -- refreshed again on the next schedule_slot change or master-schedule-apply.
  begin
    perform public.fn_sync_shift_blocks_from_schedule();
  exception when others then
    raise warning 'fn_sync_shift_blocks_from_schedule failed in schedule_slot trigger: %', sqlerrm;
  end;
  return null;
end;
$function$;

drop trigger if exists trg_schedule_slot_sync on public.schedule_slot;
create constraint trigger trg_schedule_slot_sync
  after insert or update or delete on public.schedule_slot
  deferrable initially deferred
  for each row
  execute function public.fn_trg_schedule_slot_sync();
