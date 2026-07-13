-- Run once in the Supabase SQL editor on an already-provisioned database.
-- Allows the Excel/CSV import feature to tag leads with source = 'import'
-- (previously only manual/form/webhook/whatsapp/voice were allowed, so every
-- imported row was rejected by this constraint).
alter table leads drop constraint if exists leads_source_check;
alter table leads add constraint leads_source_check
  check (source in ('manual','form','webhook','whatsapp','voice','import'));
