-- =============================================================================
-- ePay expected-reports checklist.
-- =============================================================================
-- The user gets several ePay Punches Reports per day at known times. The
-- dashboard shows a chip strip across the top with one chip per expected
-- report; a chip flips ✓ when a matching epay_imports row arrives within a
-- tolerance window. Drives the "did the 9am report come in?" validation that
-- Claudia does today by hand.
--
-- Day-of-week mask: BOOLEAN[7] with index 0 = Sunday (same convention as
-- shift_blocks.days_of_week). Defaults to Mon-Fri.
--
-- Placeholder times (9am, 11am, 1pm, 3pm) ship with the migration. The user
-- will replace them with the real ePay schedule via UPDATE.
-- =============================================================================

CREATE TABLE public.epay_expected_report (
  id            BIGSERIAL PRIMARY KEY,
  label         VARCHAR(40) NOT NULL,
  expected_at   TIME        NOT NULL,
  days_of_week  BOOLEAN[7]  NOT NULL DEFAULT ARRAY[FALSE,TRUE,TRUE,TRUE,TRUE,TRUE,FALSE],
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_updated_epay_expected_report
  BEFORE UPDATE ON public.epay_expected_report
  FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

ALTER TABLE public.epay_expected_report ENABLE ROW LEVEL SECURITY;
CREATE POLICY epay_expected_report_read_all ON public.epay_expected_report FOR SELECT USING (TRUE);
CREATE POLICY epay_expected_report_admin    ON public.epay_expected_report FOR ALL    USING (public.is_admin());

INSERT INTO public.epay_expected_report (label, expected_at) VALUES
  ('9 AM report',  '09:00:00'),
  ('11 AM report', '11:00:00'),
  ('1 PM report',  '13:00:00'),
  ('3 PM report',  '15:00:00');

-- ----------------------------------------------------------------------------
-- v_epay_reports_today — one row per expected report active for today's
-- day-of-week, left-joined to the nearest epay_imports row within a
-- -90/+120-min window. Drives the chip strip in the UI.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_epay_reports_today AS
SELECT
  e.id, e.label, e.expected_at,
  i.id           AS import_id,
  i.completed_at AS arrived_at,
  i.filename,
  i.row_count
FROM public.epay_expected_report e
LEFT JOIN LATERAL (
  SELECT id, completed_at, filename, row_count
  FROM public.epay_imports
  WHERE completed_at::date = CURRENT_DATE
    AND completed_at::time BETWEEN (e.expected_at - INTERVAL '90 minutes')
                               AND (e.expected_at + INTERVAL '120 minutes')
  ORDER BY ABS(EXTRACT(EPOCH FROM (completed_at::time - e.expected_at)))
  LIMIT 1
) i ON TRUE
WHERE e.active
  AND e.days_of_week[EXTRACT(DOW FROM CURRENT_DATE)::INT + 1]
ORDER BY e.expected_at;

GRANT SELECT ON public.v_epay_reports_today TO anon, authenticated;
