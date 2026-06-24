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

**`fn_sync_shift_blocks_from_schedule()`** (migrations `20260623030000_…` and
`20260623040000_…`) idempotently rebuilds the matcher inputs from `schedule_slot`:

1. ensure an **active** `shift_block` exists for every `(end_time, time_zone)` in the
   report (reusing existing blocks; day/client coverage unioned from the report; non-CT
   zones get a label suffix `(MT)` / `(ET)` so `shift_blocks.label` stays unique),
2. **upsert** one `job_site_schedules` row per `(site, block)` — scheduled start
   (`scheduled_in_local`), end, per-shift hours and headcount, and
3. **deactivate** `job_site_schedules` rows that no longer match any `schedule_slot`.

A **deferred constraint trigger** on `schedule_slot` (`trg_schedule_slot_sync`) runs the
sync once per transaction, at commit. This covers **every** writer — the bulk
`master-schedule-apply` loop *and* the manual shift-change form's direct insert — so the
matcher inputs always reflect the latest schedule. The sync is wrapped so a failure warns
rather than rolling back the `schedule_slot` write that triggered it.

### The matcher (`fn_pick_shift_block`, migrations `20260623040000_…` & `…050000_…`)

It first restricts to the site's blocks **active on the punch's local weekday**
(`job_site_schedules.days_of_week`, an OR-union of the slots' days; an all-false/NULL
mask is treated as every-day so missing data never drops all matches). Among those it
picks, in order of preference:

1. the shift whose **end** is at/after the clock-in (nearest) — the dominant case, since
   ~40% of punches clock in *before* the scheduled start (early-morning cleaning);
2. an **overnight** shift (`end < start`) currently in progress (clock-in at/after start),
   which ends the next morning;
3. a shift that ended **within 60 min** before the clock-in (slight overrun).

If none qualify it returns **NULL** rather than assigning an arbitrary block — e.g. a
10 pm punch at a site that only runs 05:00–10:00 has no real shift and is left unmatched.

Why day-of-week matters: many sites end at different times on different weekdays
(e.g. 13:00 Wed but 12:00 other days). Without the weekday filter the matcher chose the
nearest end across *all* days and mis-assigned ~26% of punches at such sites — which also
made the runner's send-list disagree with the Daily Control preview. The weekday filter
corrects both.

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

### Result of the initial backfill

Match rate **24% → 99.5%** (11,650 / 11,706). 11,013 rows changed (8,848 filled,
2,165 corrected off the stale retail blocks). Of matched rows, ~95.9% were "clean"
(clock-in before the assigned shift-end); ~4.1% were "nearest" fallbacks.

## Matcher-refinement backfill (run directly on prod 2026-06-23)

After `fn_pick_shift_block` was upgraded (overnight-aware; NULL instead of a nonsensical
nearest match), historical rows were re-matched once more (snapshot
`lct_backup.lct_block_20260623_v2`):

```sql
UPDATE public.labor_control_tracking lct
SET shift_block_id = CASE
      WHEN EXISTS (SELECT 1 FROM public.job_site_schedules j
                   WHERE j.job_site_id = lct.job_site_id AND j.active)
        THEN public.fn_pick_shift_block(lct.job_site_id, lct.time_in)   -- authoritative
        ELSE COALESCE(public.fn_pick_shift_block(lct.job_site_id, lct.time_in),
                      lct.shift_block_id)                               -- keep legacy if unscheduled
    END
WHERE ...;  -- only rows where the value changes
```

363 rows changed: **2** overnight punches corrected (e.g. a 21:00 clock-in at a
17:00–01:30 site moved from "3:30 PM" to "1:30 AM"), **361** anomalous night punches set
to NULL. The dominant ~95.9% were untouched (verified by dry-run before applying).

## Day-of-week backfill (run directly on prod 2026-06-23)

`job_site_schedules` then gained `days_of_week` and `fn_pick_shift_block` became
weekday-aware (migration `20260623050000_…`). Historical rows were re-matched once more
(snapshot `lct_backup.lct_block_20260623_v3`, same CASE rule as above). **3,443 rows
changed: 3,277 reassigned to the correct weekday block, 166 set to NULL (genuinely
off-schedule that weekday).** 9,304 unchanged; verified by a per-weekday dry-run and a
sample check before applying (zero spurious matches).

### Result (current)

Match rate **95.2%** (~12,144 / 12,755). Remaining unmatched are punches with no shift
scheduled that weekday (off-schedule / anomalous); legacy matches at unscheduled sites are
preserved. This also collapsed the send-list-vs-preview divergence: for block 5 today,
"texted but absent from the preview" went from **25 → 0**; the only residual gap is the
store-exception check still missing from `fn_eligible` (see below).

### Rollback

```sql
-- most recent state (after the day-of-week backfill):
UPDATE public.labor_control_tracking lct
SET shift_block_id = b.shift_block_id
FROM lct_backup.lct_block_20260623_v3 b
WHERE b.id = lct.id;
-- earlier snapshots: ..._v2 (after overnight refinement), ..._20260623 (pre-everything);
-- shift_blocks / job_site_schedules in lct_backup.*_20260623
```

Drop the `lct_backup` schema once the new behavior is confirmed in production.

## Open items

- **`fn_eligible_for_shift_block` vs `fn_candidates_for_shift_block`.** The runner's
  send-list and the Daily Control preview now agree except that `fn_eligible` does **not**
  honor `store_exception` (it would text people at a short-staffed store the operator
  excluded). Fix is unambiguous; pending alongside the product decision on whether texting
  is schedule-driven or punch-driven (now nearly moot since both are weekday-aware).
- The anomalous punches left unmatched are worth investigating upstream (possible
  clock-out-recorded-as-clock-in, or genuinely off-schedule work) — but they correspond to
  no scheduled shift, so leaving them unmatched is correct.
- `fn_pick_shift_block`'s 60-minute overrun grace is a heuristic; adjust if real shifts
  routinely run past their scheduled end by more than that.
