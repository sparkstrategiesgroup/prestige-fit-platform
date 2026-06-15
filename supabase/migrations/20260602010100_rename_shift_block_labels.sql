-- =============================================================================
-- Rename shift_block labels: "8:00am End" -> "8:00 shift".
-- =============================================================================
-- Matches how the ops lead describes them in conversation. The label is
-- rendered verbatim in the tile grid, hero card, and modal header.
-- =============================================================================

UPDATE public.shift_blocks SET label = '8:00 shift'  WHERE end_time_local = '08:00:00';
UPDATE public.shift_blocks SET label = '9:00 shift'  WHERE end_time_local = '09:00:00';
UPDATE public.shift_blocks SET label = '11:00 shift' WHERE end_time_local = '11:00:00';
UPDATE public.shift_blocks SET label = '12:00 shift' WHERE end_time_local = '12:00:00';
UPDATE public.shift_blocks SET label = '1:30 shift'  WHERE end_time_local = '13:30:00';
UPDATE public.shift_blocks SET label = '2:30 shift'  WHERE end_time_local = '14:30:00';
UPDATE public.shift_blocks SET label = '3:30 shift'  WHERE end_time_local = '15:30:00';
UPDATE public.shift_blocks SET label = '4:30 shift'  WHERE end_time_local = '16:30:00';
