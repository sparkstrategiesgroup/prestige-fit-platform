-- =============================================================================
-- Real ePay schedule: 9 reports per day (8am, 9am, 10am, 11am, 12pm,
-- 1:30pm, 2:30pm, 3:30pm, 4:30pm). Replaces the placeholder seeds from
-- 20260602010000_epay_expected_report.sql.
-- =============================================================================

DELETE FROM public.epay_expected_report;

INSERT INTO public.epay_expected_report (label, expected_at) VALUES
  ('8 AM',    '08:00:00'),
  ('9 AM',    '09:00:00'),
  ('10 AM',   '10:00:00'),
  ('11 AM',   '11:00:00'),
  ('12 PM',   '12:00:00'),
  ('1:30 PM', '13:30:00'),
  ('2:30 PM', '14:30:00'),
  ('3:30 PM', '15:30:00'),
  ('4:30 PM', '16:30:00');
