-- Run once in the Supabase SQL editor on an already-provisioned database.
-- Adds lead reminders (emailed / WhatsApp'd to whoever handles the event)
-- and a phone number on profiles so WhatsApp reminders have somewhere to go.

alter table profiles add column if not exists phone text;

create table if not exists reminders (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads(id) on delete cascade,
  channel text not null check (channel in ('email','whatsapp')),
  remind_at timestamptz not null,
  message text,
  recipient_id uuid references profiles(id),  -- defaults to the lead owner (בטיפול)
  status text not null default 'pending'
    check (status in ('pending','sent','failed','cancelled')),
  sent_at timestamptz,
  error text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists reminders_due_idx on reminders (status, remind_at);

alter table reminders enable row level security;
drop policy if exists team_all on reminders;
create policy team_all on reminders
  for all to authenticated using (true) with check (true);
