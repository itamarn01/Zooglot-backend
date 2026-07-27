-- 011 — groom/bride names + LOST fields become optional
--
-- 1) groom_name / bride_name: the couple's individual names, kept alongside the
--    lead's display name so contracts can address them directly
--    ({{groom_name}} / {{bride_name}}) and Monday exports map cleanly.
--
-- 2) LOST no longer requires a reason and a competitor. The old trigger raised
--    an exception, which made historical imports fail row by row and forced a
--    guess where the real answer was simply unknown. The trigger is kept (it
--    still maintains updated_at) but the hard check is dropped.

alter table leads add column if not exists groom_name text;
alter table leads add column if not exists bride_name text;

create or replace function enforce_lost_fields() returns trigger as $$
begin
  -- lost_reason / lost_competitor are optional: recommended, never enforced
  new.updated_at := now();
  return new;
end $$ language plpgsql;
