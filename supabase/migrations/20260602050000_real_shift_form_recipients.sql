-- =============================================================================
-- Real shift form reminder distribution list.
-- =============================================================================
-- Per Lisa Riebe's "Schedule / Budget Updates" Tuesday reminder thread.
-- Replaces the demo placeholders.
--
-- To:  Mary Martin, Micaela Cordero, Ron Stapleton, Jason Dinverno
-- Cc:  William Bruens
--
-- Power Automate Recurrence flow GETs this list each Tuesday and uses
-- the emails as the To: line. We don't distinguish To/Cc at this layer;
-- if needed later, add a recipient_type column.
-- =============================================================================

DELETE FROM public.shift_form_recipient;

INSERT INTO public.shift_form_recipient (email, name, notes) VALUES
  ('mmartin@prestigeusa.net',    'Mary Martin',     'To: per Lisa Riebe distro'),
  ('mcordero@prestigeusa.net',   'Micaela Cordero', 'To: per Lisa Riebe distro'),
  ('rstapleton@prestigeusa.net', 'Ron Stapleton',   'To: per Lisa Riebe distro'),
  ('jdinverno@prestigeusa.net',  'Jason Dinverno',  'To: per Lisa Riebe distro'),
  ('wbruens@prestigeusa.net',    'William Bruens',  'Cc: per Lisa Riebe distro');
