-- 013 — "these are not duplicates" approvals
--
-- Several leads legitimately share a phone number: one producer books many
-- different weddings. Approving such a number here keeps it out of the
-- duplicate review for the whole team (it is a shared judgement about the
-- number, not a per-device preference), and it can always be undone.

create table if not exists duplicate_dismissals (
  id uuid primary key default uuid_generate_v4(),
  phone_key text not null unique,        -- normalised number (see phoneKey in phone.js)
  note text,                             -- e.g. the producer's name, for context
  dismissed_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table duplicate_dismissals enable row level security;
drop policy if exists team_all on duplicate_dismissals;
create policy team_all on duplicate_dismissals
  for all to authenticated using (true) with check (true);
