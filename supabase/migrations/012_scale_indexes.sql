-- 012 — indexes for a large board
--
-- The board lists leads newest-first, filters by pipeline, and counts updates
-- per lead. Without these, every one of those is a sequential scan, which is
-- what makes a big board feel slow.

-- leads: default list order (created_at desc) and the pipeline tabs
create index if not exists leads_created_at_idx on leads (created_at desc);
create index if not exists leads_status_created_idx on leads (sale_status, created_at desc);

-- child lookups: counting updates and attaching contacts per lead
create index if not exists lead_updates_lead_idx on lead_updates (lead_id);
create index if not exists lead_updates_lead_created_idx on lead_updates (lead_id, created_at desc);
create index if not exists lead_contacts_lead_idx on lead_contacts (lead_id);

-- duplicate matching during import (name / Monday item id)
create index if not exists leads_name_idx on leads (name);
create index if not exists leads_source_ref_idx on leads (source_ref);

-- contracts are looked up per lead on the contracts tab
create index if not exists contracts_lead_idx on contracts (lead_id);
