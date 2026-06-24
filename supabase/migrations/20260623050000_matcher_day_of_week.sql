-- Make shift-block matching day-of-week aware.
--
-- job_site_schedules previously carried no day-of-week, so fn_pick_shift_block
-- chose the nearest end-time across ALL of a site's shifts regardless of the
-- punch's weekday. At sites whose end-time varies by day (e.g. ends 13:00 on
-- Wed but 12:00 on other days) this mis-assigned the block. The Schedule Report
-- (schedule_slot.days_of_week) has the day info; this propagates it to
-- job_site_schedules and teaches the matcher to use it.

-- Per-(site, block) day mask: OR-union of days_of_week across the slots that map
-- to that block. Maintained by fn_sync_shift_blocks_from_schedule below.
alter table public.job_site_schedules
  add column if not exists days_of_week boolean[];

-- ---------------------------------------------------------------------------
-- Matcher: consider only blocks active on the punch's local weekday, then apply
-- the same nearest-end / overnight / overrun logic as before.
--
-- days_of_week is indexed 1=Sun .. 7=Sat (EXTRACT(DOW)+1), matching
-- schedule_slot / shift_blocks. An all-false or NULL mask is treated as
-- "every day" so sites with missing day data don't silently lose all matches.
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
      (p_time_in at time zone sb.end_timezone)::time as local_in,
      jss.days_of_week as dow,
      (extract(dow from (p_time_in at time zone sb.end_timezone))::int + 1) as dow_idx
    from public.job_site_schedules jss
    join public.shift_blocks sb on sb.id = jss.shift_block_id
    where jss.job_site_id = p_job_site_id
      and jss.active = true
      and sb.active = true
  ),
  active_today as (
    select * from opts
    where dow is null
       or dow[dow_idx] = true
       or true <> all(dow)   -- all-false mask => treat as every day (missing data)
  ),
  scored as (
    select id,
      case
        when end_t >= local_in then end_t - local_in
        when start_t is not null and end_t < start_t and local_in >= start_t
          then (end_t - local_in) + interval '24 hours'
        else null
      end as time_to_end,
      case
        when end_t < local_in
          and (start_t is null or end_t >= start_t)
          and (local_in - end_t) <= interval '60 minutes'
          then local_in - end_t
        else null
      end as recent_overrun
    from active_today
  )
  select id from scored
  where time_to_end is not null or recent_overrun is not null
  order by
    case when time_to_end is not null then 0 else 1 end,
    coalesce(time_to_end, recent_overrun)
  limit 1;
$function$;

-- ---------------------------------------------------------------------------
-- fn_sync: also maintain job_site_schedules.days_of_week (OR-union per pair).
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

  with slot_block as (
    select s.id as job_site_id, sb.id as shift_block_id,
           ss.end_time, ss.start_time, ss.days_of_week
    from public.schedule_slot ss
    join public.site s on s.site_id = ss.site_id
    join public.shift_blocks sb
      on sb.end_time_local = ss.end_time and sb.end_timezone = ss.time_zone
  ),
  dow_pair as (
    select job_site_id, shift_block_id, array_agg(day_on order by i) as days_of_week
    from (
      select job_site_id, shift_block_id, u.i, bool_or(u.v) as day_on
      from slot_block
      cross join lateral unnest(days_of_week) with ordinality as u(v, i)
      group by job_site_id, shift_block_id, u.i
    ) e
    group by job_site_id, shift_block_id
  ),
  agg as (
    select job_site_id, shift_block_id,
           min(end_time) as scheduled_out_local,
           min(start_time) as scheduled_in_local,
           round(max(extract(epoch from (end_time - start_time)) / 3600.0
                     + case when end_time < start_time then 24 else 0 end)::numeric, 2)
             as scheduled_hours,
           count(*)::int as people_per_shift
    from slot_block
    group by job_site_id, shift_block_id
  )
  insert into public.job_site_schedules
    (job_site_id, shift_block_id, scheduled_out_local, scheduled_in_local,
     scheduled_hours, people_per_shift, days_of_week, active)
  select a.job_site_id, a.shift_block_id, a.scheduled_out_local, a.scheduled_in_local,
         a.scheduled_hours, a.people_per_shift, d.days_of_week, true
  from agg a
  join dow_pair d using (job_site_id, shift_block_id)
  on conflict (job_site_id, shift_block_id) do update
    set scheduled_out_local = excluded.scheduled_out_local,
        scheduled_in_local  = excluded.scheduled_in_local,
        scheduled_hours     = excluded.scheduled_hours,
        people_per_shift    = excluded.people_per_shift,
        days_of_week        = excluded.days_of_week,
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
