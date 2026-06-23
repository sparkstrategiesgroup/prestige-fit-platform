-- fn_audit_log() intentionally sets audit_log.record_id to NULL for tables whose
-- primary key is not a numeric column -- e.g. schedule_slot, keyed by a uuid
-- slot_id -- and captures the full row body in old_data/new_data instead. The
-- NOT NULL constraint on record_id contradicted that design: every INSERT or
-- DELETE on such a table raised "null value in column record_id violates not-null
-- constraint", which also meant fn_apply_master_schedule_revision could never
-- delete/replace schedule_slot rows on approval.
--
-- Allow record_id to be NULL, matching the trigger's documented behaviour.
alter table audit_log alter column record_id drop not null;
