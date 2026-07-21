-- Contract pricing terms: VAT handling + discount, shown in the proposal TOTAL box.
alter table contracts add column if not exists vat_mode text not null default 'none';
alter table contracts add column if not exists vat_rate numeric not null default 18;
alter table contracts add column if not exists discount_type text not null default 'none';
alter table contracts add column if not exists discount_value numeric not null default 0;

alter table contracts drop constraint if exists contracts_vat_mode_check;
alter table contracts add constraint contracts_vat_mode_check
  check (vat_mode in ('none', 'added', 'included'));

alter table contracts drop constraint if exists contracts_discount_type_check;
alter table contracts add constraint contracts_discount_type_check
  check (discount_type in ('none', 'percent', 'amount'));
