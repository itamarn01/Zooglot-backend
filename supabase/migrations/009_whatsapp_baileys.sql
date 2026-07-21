-- WhatsApp via Baileys: message direction + persisted auth session.
alter table whatsapp_messages add column if not exists direction text not null default 'in';

create table if not exists whatsapp_sessions (
  id uuid primary key default uuid_generate_v4(),
  session_id text unique not null,
  data text,
  updated_at timestamptz not null default now()
);

alter table whatsapp_sessions enable row level security;
drop policy if exists team_all on whatsapp_sessions;
create policy team_all on whatsapp_sessions
  for all to authenticated using (true) with check (true);
