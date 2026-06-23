# Driving shift-block matching from the Master Schedule Report

## Problem

Punches (`labor_control_tracking`) are matched to a `shift_block` at import time by
`fn_pick_shift_block`, which joins `job_site_schedules` (site → block) and picks the
block whose `end_time_local` best follows the punch's clock-in.

That pipeline had stalled:

- `job_site_schedules` was **empty**, so `fn_pick_shift_block` returned `NULL`.
- `shift_blocks` held only ~14 retail end-times (08:00–16:30), far fewer than the
  real book of business.

Result: only **24%** of punches (2,802 / 11,706) carried a `shift_block_id`, so the
end-of-shift texting pipeline and per-block metrics had nothing to work with.

The `schedule_slot` table (the imported **Master Schedule Report**) is the real source
of truth for which shifts each site runs. This work makes it drive matching.

## Data model bridge

```
labor_control_tracking.job_site_id (int)  =  site.id (int PK)
site.site_id (varchar code)               =  schedule_slot.site_id (varchar)
job_site_schedules.job_site_id (int)      =  site.id (int PK)
shift_blocks  <- (end_time_local, end_timezone)  ->  schedule_slot (end_time, time_zone)
```

Coverage of the Schedule Report over the punch data is ~**98.6%** (TARGET/KOHLS 100%,
HARDLINES ~98%). The remainder are sites with no schedule rows at all.

## Ongoing sync (committed)

`fn_sync_shift_blocks_from_schedule()` (migration
`20260623030000_sync_shift_blocks_from_schedule.sql`) idempotently rebuilds the matcher
inputs from `schedule_slot`:

1. ensure an **active** `shift_block` exists for every `(end_time, time_zone)` in the
   report (reusing existing blocks; day/client coverage unioned from the report; non-CT
   zones get a label suffix `(MT)` / `(ET)` so `shift_blocks.label` stays unique),
2. **upsert** one `job_site_schedules` row per `(site, block)` (per-shift hours and
   headcount aggregated; overnight shifts handled), and
3. **deactivate** `job_site_schedules` rows that no longer match any `schedule_slot`.

`master-schedule-apply` calls this RPC after each approved revision, so every Schedule
Report approval refreshes blocks + `job_site_schedules` automatically.

> Note: the **manual shift-change** path writes `schedule_slot` directly from the
> frontend and does not yet call the sync. Wiring it there (or a statement-level trigger
> on `schedule_slot`) is a sensible follow-up.

## One-time historical backfill (run directly on prod 2026-06-23)

The sync above only maintains blocks + `job_site_schedules`. Existing punches were
re-matched once, in this order:

1. **Snapshots** into schema `lct_backup` (`shift_blocks_20260623`,
   `job_site_schedules_20260623`, `lct_block_20260623`).
2. **Blocks**: refresh/activate the 14 existing blocks for report end-times; insert the
   43 missing ones (ids 15–57) — same logic as `fn_sync_shift_blocks_from_schedule`.
3. **Schedules**: populate `job_site_schedules` (569 rows from 728 slots).
4. **Backfill** `labor_control_tracking.shift_block_id`:

   ```sql
   UPDATE public.labor_control_tracking lct
   SET shift_block_id = COALESCE(fn_pick_shift_block(lct.job_site_id, lct.time_in),
                                 lct.shift_block_id),
       updated_at = now()
   WHERE lct.time_in IS NOT NULL
     AND COALESCE(fn_pick_shift_block(lct.job_site_id, lct.time_in), lct.shift_block_id)
         IS DISTINCT FROM lct.shift_block_id;
   ```

   `COALESCE(new, old)` re-matches covered sites authoritatively while preserving the
   existing block for the few uncovered-but-already-matched rows.

### Result

Match rate **24% → 99.5%** (11,650 / 11,706). 11,013 rows changed (8,848 filled,
2,165 corrected off the stale retail blocks). 56 remain unmatched (sites with no
schedule). Of matched rows, ~95.9% are "clean" (clock-in before the assigned shift-end);
~4.1% (483) are "nearest" fallbacks — late-night / overnight punches where clock-in is
after all of the site's shift-ends.

### Rollback

```sql
UPDATE public.labor_control_tracking lct
SET shift_block_id = b.shift_block_id
FROM lct_backup.lct_block_20260623 b
WHERE b.id = lct.id;
-- shift_blocks / job_site_schedules can likewise be restored from lct_backup.*_20260623
```

Drop the `lct_backup` schema once the new behavior is confirmed in production.

## Known follow-up

`fn_pick_shift_block` compares clock-in **time-of-day** to shift-**end** time-of-day,
which mis-handles overnight shifts and punches clocked in after all ends (the ~4.1%
fallback above). Revisiting that matcher to consider shift start/end windows (and
overnight wrap) would tighten those cases.
