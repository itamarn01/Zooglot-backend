-- ============================================================
-- Migration 005 — free-form deposit amount on the lead (מקדמה לשריון תאריך)
-- Injected into proposals as {{deposit}}; falls back to 10% of the final price.
-- Run once in the Supabase SQL editor.
-- ============================================================

alter table leads add column if not exists deposit_amount numeric;
