-- =============================================================================
-- shift_form_recipient — distribution list for the Tuesday shift-form
-- reminder email. Power Automate Recurrence flow fetches this list and
-- uses it as the To: line.
-- =============================================================================

CREATE TABLE public.shift_form_recipient (
  id          BIGSERIAL PRIMARY KEY,
  email       VARCHAR(200) NOT NULL UNIQUE,
  name        VARCHAR(120),
  site_id     VARCHAR(20) REFERENCES public.site(site_id), -- NULL = global
  notes       TEXT,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_updated_shift_form_recipient
  BEFORE UPDATE ON public.shift_form_recipient
  FOR EACH ROW EXECUTE FUNCTION public.fn_update_timestamp();

ALTER TABLE public.shift_form_recipient ENABLE ROW LEVEL SECURITY;
CREATE POLICY shift_form_recipient_read_all
  ON public.shift_form_recipient FOR SELECT USING (TRUE);
CREATE POLICY shift_form_recipient_anon_insert
  ON public.shift_form_recipient FOR INSERT TO anon WITH CHECK (TRUE);
CREATE POLICY shift_form_recipient_anon_update
  ON public.shift_form_recipient FOR UPDATE TO anon USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY shift_form_recipient_admin
  ON public.shift_form_recipient FOR ALL USING (public.is_admin());

INSERT INTO public.shift_form_recipient (email, name, notes) VALUES
  ('kneff@sparkstrategiesgroup.com', 'Karina Neff', 'Spark Strategies — demo seed'),
  ('claudia@prestigeusa.net',         'Claudia',     'Labor Control lead — demo seed');

COMMENT ON TABLE public.shift_form_recipient IS
  'Distribution list for the weekly Tuesday shift-form reminder. Power Automate Recurrence flow reads this via PostgREST.';
