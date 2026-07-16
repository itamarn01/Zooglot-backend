-- ============================================================
-- Migration 004 — contract language/direction + reusable design templates
-- Run once in the Supabase SQL editor.
-- ============================================================

-- ---- language + text direction on the proposal ----
alter table contracts add column if not exists language text not null default 'he';
alter table contracts add column if not exists direction text not null default 'rtl';

-- ---- reusable proposal templates (shared across the team) ----
create table if not exists contract_templates (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  data jsonb not null default '{}',   -- { language, direction, sections, fields, require_client_signature }
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table contract_templates enable row level security;
drop policy if exists team_all on contract_templates;
create policy team_all on contract_templates
  for all to authenticated using (true) with check (true);
