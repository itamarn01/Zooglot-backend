-- ============================================================
-- Migration 003 — proposal builder for contracts + contact identity fields
-- Run once in the Supabase SQL editor.
-- ============================================================

-- ---- contracts: structured proposal (sections/fields/header) + signature toggle ----
alter table contracts add column if not exists header jsonb not null default '{}';
alter table contracts add column if not exists sections jsonb not null default '[]';
alter table contracts add column if not exists fields jsonb not null default '[]';
alter table contracts add column if not exists require_client_signature boolean not null default true;

-- ---- identity fields on the primary lead contact ----
alter table leads add column if not exists id_number text;   -- ת"ז
alter table leads add column if not exists address text;      -- כתובת

-- ---- identity fields on the additional contacts ----
alter table lead_contacts add column if not exists id_number text;
alter table lead_contacts add column if not exists address text;
