-- 010 — lead contract link + Monday audit logs
--
-- contract_link   : the client-facing proposal link. Holds links to historical
--                   contracts pasted in by hand, and is filled automatically
--                   when a contract is sent from Zooglot.DB.
-- creation_log    : Monday's "Creation Log" column (free text: who + when).
-- last_updated_log: Monday's "Last Updated" column (free text: who + when).
--                   Kept as text — these are audit strings from Monday, not
--                   timestamps we own (leads.updated_at remains our own field).

alter table leads add column if not exists contract_link text;
alter table leads add column if not exists creation_log text;
alter table leads add column if not exists last_updated_log text;
