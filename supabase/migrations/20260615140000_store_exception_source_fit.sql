-- Allow 'fit' as a store_exception.source value.
-- Default origin for exceptions is now the FIT app itself (not a phone call),
-- so the source allowlist needs to include it.

ALTER TABLE public.store_exception
  DROP CONSTRAINT IF EXISTS store_exception_source_check;

ALTER TABLE public.store_exception
  ADD CONSTRAINT store_exception_source_check
  CHECK (source IN ('fit', 'manual', 'email', 'phone', 'sms'));
