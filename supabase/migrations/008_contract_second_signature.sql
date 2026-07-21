-- A contract may carry a second management signatory.
alter table contracts add column if not exists management_signature_id_2 uuid references management_signatures(id);
