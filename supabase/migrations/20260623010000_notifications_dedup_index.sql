-- Prevent the shift-block notification cron from double-sending.
--
-- shift-block-runner inserts one notification row per (employee, language) for a
-- block + kind. If the cron fires twice, the old code did a plain INSERT and
-- produced duplicate rows (and duplicate SMS). This makes the natural key unique
-- so a repeated batch fails atomically with 23505, which the runner treats as an
-- already-sent no-op.
--
-- Notes:
--  * `language` IS part of the key: an employee legitimately receives both the EN
--    and ES message, which share every other key column. (A key without language
--    would drop the second message.)
--  * Per-day, matching the runner's "due today" semantics. A direct
--    `scheduled_for::date` cast is only STABLE (timestamptz->date depends on the
--    session TimeZone), so it cannot be indexed; we wrap a fixed-UTC cast in an
--    IMMUTABLE helper (UTC has no DST/offset changes, so the result is constant).
--  * Scoped to scheduled_for >= 2026-06-23 because the historical (stub-mode)
--    notification log already contains ~632 duplicate groups; those pre-cutoff
--    rows are intentionally left untouched. The cutoff is a one-time static
--    boundary -- every new notification is covered.

create or replace function public.notif_dedup_day(ts timestamptz)
returns date
language sql
immutable
as $$ select (ts at time zone 'UTC')::date $$;

create unique index if not exists idx_notifications_dedup
  on public.notifications (
    employee_id, shift_block_id, notification_type, language, public.notif_dedup_day(scheduled_for)
  )
  where shift_block_id is not null
    and scheduled_for is not null
    and scheduled_for >= '2026-06-23T00:00:00Z';
