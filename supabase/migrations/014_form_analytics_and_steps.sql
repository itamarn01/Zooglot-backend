-- 014 — form analytics + multi-step forms
--
-- One row per page view, updated in place when that view converts. Keeping the
-- view and its submission on a single row is what makes completion rate, average
-- fill time and the step funnel simple, honest counts rather than a join.
--
-- No IP address is stored: country comes from the browser's own IANA timezone,
-- so nothing identifying is retained.

create table if not exists form_views (
  id uuid primary key default uuid_generate_v4(),
  form_id uuid not null references lead_forms(id) on delete cascade,
  -- funnel
  submitted boolean not null default false,
  submitted_at timestamptz,
  duration_ms integer,                   -- first paint → submit, for avg fill time
  max_step integer not null default 0,   -- furthest step reached (drop-off)
  -- audience
  country text,                          -- ISO2, derived from the browser timezone
  device text,                           -- mobile | tablet | desktop
  browser text,                          -- Chrome | Safari | Firefox | Edge | …
  os text,
  referrer text,
  created_at timestamptz not null default now()
);

create index if not exists form_views_form_idx on form_views (form_id);
create index if not exists form_views_form_created_idx on form_views (form_id, created_at desc);
create index if not exists form_views_submitted_idx on form_views (form_id, submitted);

alter table form_views enable row level security;
drop policy if exists team_all on form_views;
create policy team_all on form_views
  for all to authenticated using (true) with check (true);

-- ---- multi-step forms + conversion copy ----
-- form_type 'steps' splits the fields across numbered steps (Zeigarnik effect:
-- once someone starts, they tend to finish). Each field carries its own `step`
-- inside the fields jsonb, so no extra table is needed.
alter table lead_forms add column if not exists form_type text not null default 'single'
  check (form_type in ('single', 'steps'));
alter table lead_forms add column if not exists submit_label text;   -- benefit-led CTA
alter table lead_forms add column if not exists next_label text;     -- "continue →"
alter table lead_forms add column if not exists privacy_note text;   -- trust microcopy
alter table lead_forms add column if not exists step_titles jsonb not null default '[]'::jsonb;
