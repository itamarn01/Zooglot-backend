-- ============================================================
-- Zooglot.DB — CRM for KOLOT band
-- Supabase schema. Run in the Supabase SQL editor (or psql).
-- Auth itself is handled by Supabase Auth (auth.users);
-- profiles extends it with app data.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ---------- users / team ----------
-- Auth is handled at the application level (bcrypt + JWT, emails via Resend),
-- so the same code path works in mock mode and in production.
create table if not exists profiles (
  id uuid primary key default uuid_generate_v4(),
  email text not null unique,
  full_name text not null default '',
  avatar_url text,
  phone text,                               -- for WhatsApp reminders
  role text not null default 'member' check (role in ('admin','member')),
  password_hash text,
  email_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- one-time codes for OTP login / email verification / password reset
create table if not exists otp_codes (
  id uuid primary key default uuid_generate_v4(),
  email text not null,
  code text not null,
  purpose text not null check (purpose in ('login','verify','reset')),
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);

-- invite-only registration
create table if not exists invitations (
  id uuid primary key default uuid_generate_v4(),
  email text not null,
  token text not null unique,
  invited_by uuid references profiles(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- leads (מעקב זוגות) ----------
-- Columns mirror the Monday.com board "מעקב זוגות"
create table if not exists leads (
  id uuid primary key default uuid_generate_v4(),
  -- identity
  name text not null,                      -- Name (שם הפריט)
  contact_name text,                       -- Contact (איש קשר ראשי)
  -- event
  event_type text default 'חתונה',         -- סוג אירוע
  event_date date,                         -- Event date
  event_location text,                     -- Event location
  relation text,                           -- קרבה: כלה/חתן/הורה/מפיק/ה...
  -- ownership
  owner_id uuid references profiles(id),   -- בטיפול
  team text,                               -- צוות
  -- contact info
  email text,
  phone1 text,                             -- טלפון 1
  phone2 text,                             -- טלפון 2
  id_number text,                          -- ת"ז של איש הקשר הראשי
  address text,                            -- כתובת
  -- sale
  proposed_price numeric,                  -- מחיר שהוצע
  deposit_amount numeric,                   -- מקדמה לשריון תאריך (סכום חופשי; {{deposit}})
  stage text default 'לקוח חדש ידני',      -- שלב: לקוח חדש ידני / לקוח משאלון
  sale_status text not null default 'open' -- סטאטוס מכירה / pipeline
    check (sale_status in ('open','win','lost')),
  next_action text default 'עוד פרטים',    -- פעולה הבאה
  package_type text,                       -- סוג חבילה
  date_status text,                        -- סטטוס תאריך
  -- marketing
  hear_about_us text,                      -- How'd You Hear About Us
  referrer text,                           -- מי המליץ
  came_to_see_event text,                  -- באו לראות באירוע
  seen_at_date date,                       -- הגיעו בתאריך
  seen_at_place text,                      -- מקום שראו
  -- lifecycle dates
  first_contact_date date,                 -- תאריך התקשרות
  close_date date,                         -- תאריך סגירה
  -- LOST (both required by app logic when sale_status='lost')
  lost_reason text,                        -- למה לא?
  lost_competitor text,                    -- מתחרה שזכה
  -- contract
  contract_link text,                      -- קישור לחוזה (historical links + auto-filled on send)
  -- ingestion
  source text not null default 'manual'    -- manual/form/webhook/whatsapp/voice/import
    check (source in ('manual','form','webhook','whatsapp','voice','import')),
  source_ref text,                         -- form id / wa chat id / monday item id
  creation_log text,                       -- Monday "Creation Log" (free text: who + when)
  last_updated_log text,                   -- Monday "Last Updated" (free text: who + when)
  -- bookkeeping
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leads_status_idx on leads (sale_status);
create index if not exists leads_event_date_idx on leads (event_date);
create index if not exists leads_owner_idx on leads (owner_id);

-- hard guard: moving to LOST requires reason + competitor
create or replace function enforce_lost_fields() returns trigger as $$
begin
  if new.sale_status = 'lost'
     and (coalesce(new.lost_reason,'') = '' or coalesce(new.lost_competitor,'') = '') then
    raise exception 'Moving a lead to LOST requires lost_reason and lost_competitor';
  end if;
  new.updated_at := now();
  return new;
end $$ language plpgsql;
drop trigger if exists leads_lost_guard on leads;
create trigger leads_lost_guard before insert or update on leads
  for each row execute function enforce_lost_fields();

-- competitors dropdown for the LOST flow
create table if not exists competitors (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- multiple contacts per lead (אנשי קשר נוספים)
create table if not exists lead_contacts (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads(id) on delete cascade,
  name text not null,
  role text,                                -- כלה/חתן/אמא/מפיק...
  phone text,
  email text,
  id_number text,                           -- ת"ז
  address text,                             -- כתובת
  created_at timestamptz not null default now()
);

-- updates thread per lead (אזור עדכונים כמו במאנדיי)
create table if not exists lead_updates (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads(id) on delete cascade,
  author_id uuid references profiles(id),
  body text not null,
  kind text not null default 'note'         -- note/system (merge, status change...)
    check (kind in ('note','system')),
  created_at timestamptz not null default now()
);

-- reminders per lead — emailed or WhatsApp'd to whoever handles the event
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

-- ---------- products (מוצרים) ----------
create table if not exists products (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  description text,
  default_price numeric not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- packages (חבילות) ----------
create table if not exists packages (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  description text,
  base_price numeric not null default 0,    -- price covering included products
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists package_items (
  id uuid primary key default uuid_generate_v4(),
  package_id uuid not null references packages(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  included boolean not null default true,   -- true=part of base price, false=optional add-on
  override_price numeric,                   -- per-package price override for optional items
  sort_order int not null default 0,
  unique (package_id, product_id)
);

-- ---------- contracts (חוזים) ----------
create table if not exists management_signatures (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  image_data text not null,                 -- data URL (drawn or uploaded)
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists contracts (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads(id) on delete cascade,
  package_id uuid references packages(id),
  title text not null default 'חוזה הופעה',
  body_html text not null default '',       -- closing terms / legal text (rich text with {{variables}})
  header jsonb not null default '{}',        -- legacy proposal header (superseded by title/text sections)
  sections jsonb not null default '[]',      -- typed proposal blocks: title / text / products (see routes/contracts.js)
  fields jsonb not null default '[]',        -- fill-in fields: [{ id, key, label, source, lead_field, value, client_editable }]
  extra_fields jsonb not null default '[]', -- legacy custom fill-in fields (kept for old contracts)
  language text not null default 'he',       -- 'he' | 'en' (localises the client-facing labels)
  direction text not null default 'rtl',     -- 'rtl' | 'ltr' (default text direction of the proposal)
  require_client_signature boolean not null default true, -- when false, client "approves" without drawing a signature
  selected_options jsonb not null default '[]', -- optional product ids client picked (locked at signing)
  post_sign_options jsonb not null default '[]', -- extra options the client added AFTER signing
  vat_mode text not null default 'none' check (vat_mode in ('none','added','included')), -- how VAT is shown in the TOTAL
  vat_rate numeric not null default 18,      -- VAT percentage
  discount_type text not null default 'none' check (discount_type in ('none','percent','amount')),
  discount_value numeric not null default 0, -- percent or fixed money, per discount_type
  base_price numeric not null default 0,
  final_price numeric not null default 0,
  status text not null default 'draft'
    check (status in ('draft','sent','client_signed','completed','cancelled')),
  client_token text unique,                 -- public portal access token
  management_signature_id uuid references management_signatures(id),
  management_signature_id_2 uuid references management_signatures(id), -- optional 2nd signatory
  management_signed_at timestamptz,
  client_signature text,                    -- data URL drawn by client
  client_signed_at timestamptz,
  client_signer_name text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- reusable proposal design templates (shared across the team)
create table if not exists contract_templates (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  data jsonb not null default '{}',
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- ---------- lead forms (מחולל טפסים) ----------
create table if not exists lead_forms (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text not null unique,                -- public URL + webhook key
  intro_html text,                          -- free text above the form
  logo_url text,
  colors jsonb not null default '{"primary":"#87cedf","bg":"#0e1b20","text":"#eef7fa"}',
  fields jsonb not null default '[]',       -- [{key,label,type,required,options,description}]
  language text not null default 'he' check (language in ('he','en')),
  active boolean not null default true,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists form_submissions (
  id uuid primary key default uuid_generate_v4(),
  form_id uuid references lead_forms(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------- voice notes (ניתוח AI) ----------
create table if not exists voice_notes (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid references leads(id) on delete set null,
  audio_path text,                          -- Supabase Storage path
  transcript text,
  extracted jsonb,                          -- AI-extracted lead fields
  status text not null default 'pending'
    check (status in ('pending','transcribed','extracted','applied','failed')),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- ---------- Google Calendar sync ----------
create table if not exists calendar_links (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references profiles(id) on delete cascade,
  google_refresh_token text not null,
  google_email text,
  calendar_id text not null default 'primary',
  created_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists calendar_events (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads(id) on delete cascade,
  google_event_id text not null,
  calendar_id text not null default 'primary',
  last_synced_at timestamptz,
  unique (lead_id, google_event_id)
);

-- ---------- WhatsApp ingestion (OpenWA) ----------
create table if not exists whatsapp_messages (
  id uuid primary key default uuid_generate_v4(),
  wa_chat_id text not null,                 -- e.g. 972555081080@s.whatsapp.net
  wa_message_id text unique,
  from_number text,
  from_name text,
  body text,
  direction text not null default 'in',     -- 'in' (received) | 'out' (sent by the band)
  lead_id uuid references leads(id) on delete set null,
  created_at timestamptz not null default now()
);

-- persisted Baileys auth so the WhatsApp link survives redeploys (Railway's FS is ephemeral)
create table if not exists whatsapp_sessions (
  id uuid primary key default uuid_generate_v4(),
  session_id text unique not null,
  data text,                                -- serialized Baileys auth state (creds + keys)
  updated_at timestamptz not null default now()
);

-- ---------- storage buckets (run once; ignore errors if exist) ----------
insert into storage.buckets (id, name, public)
  values ('avatars','avatars', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
  values ('voice-notes','voice-notes', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
  values ('form-assets','form-assets', true)
  on conflict (id) do nothing;

-- ---------- RLS ----------
-- The Express backend talks to Supabase with the service-role key,
-- so RLS mainly protects against direct client access.
alter table profiles enable row level security;
alter table leads enable row level security;
alter table lead_contacts enable row level security;
alter table lead_updates enable row level security;
alter table reminders enable row level security;
alter table products enable row level security;
alter table packages enable row level security;
alter table package_items enable row level security;
alter table contracts enable row level security;
alter table contract_templates enable row level security;
alter table management_signatures enable row level security;
alter table lead_forms enable row level security;
alter table form_submissions enable row level security;
alter table voice_notes enable row level security;
alter table calendar_links enable row level security;
alter table calendar_events enable row level security;
alter table whatsapp_messages enable row level security;
alter table whatsapp_sessions enable row level security;
alter table invitations enable row level security;
alter table competitors enable row level security;
alter table otp_codes enable row level security;

-- authenticated team members can do everything (single-tenant internal CRM)
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','leads','lead_contacts','lead_updates','reminders','products','packages',
    'package_items','contracts','contract_templates','management_signatures','lead_forms',
    'form_submissions','voice_notes','calendar_links','calendar_events',
    'whatsapp_messages','whatsapp_sessions','invitations','competitors']
  loop
    execute format(
      'drop policy if exists team_all on %I; create policy team_all on %I
         for all to authenticated using (true) with check (true);', t, t);
  end loop;
end $$;

-- seed: default competitors + demo products
insert into competitors (name) values
  ('להקה אחרת'), ('DJ'), ('הרכב אקוסטי'), ('לא ידוע')
  on conflict do nothing;
