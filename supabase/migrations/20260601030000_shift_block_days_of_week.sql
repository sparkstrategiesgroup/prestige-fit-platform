-- =============================================================================
-- shift_blocks: days_of_week mask + Mon-Fri schedule.
-- =============================================================================
-- Per user: Mon has 7 checkpoints; Tue-Fri has 8 (+4:30).
--   Mon (& Tue-Fri): 8:00, 9:00, 11:00, 12:00, 1:30, 2:30, 3:30
--   Tue-Fri only adds:                                             4:30
-- All other blocks (8:30, 9:30, 10:00, 10:30, 11:30, 2:00) are deactivated.
-- =============================================================================

ALTER TABLE public.shift_blocks
  ADD COLUMN IF NOT EXISTS days_of_week BOOLEAN[7];

COMMENT ON COLUMN public.shift_blocks.days_of_week IS
  'Per-weekday active flag. NULL = active every day. Index 0 = Sunday.';

-- Deactivate everything, then re-enable the user-specified schedule.
UPDATE public.shift_blocks SET active = FALSE, days_of_week = NULL;

UPDATE public.shift_blocks SET active = TRUE,
  days_of_week = ARRAY[FALSE,TRUE,TRUE,TRUE,TRUE,TRUE,FALSE]   -- Mon-Fri
WHERE end_time_local IN ('08:00:00','09:00:00','11:00:00','12:00:00',
                         '13:30:00','14:30:00','15:30:00');

UPDATE public.shift_blocks SET active = TRUE,
  days_of_week = ARRAY[FALSE,FALSE,TRUE,TRUE,TRUE,TRUE,FALSE]  -- Tue-Fri
WHERE end_time_local = '16:30:00';
