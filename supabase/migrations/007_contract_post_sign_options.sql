-- Optional products a client adds AFTER signing (post-sign upsell). Kept separate
-- from selected_options so what was agreed at signing can never be altered.
alter table contracts add column if not exists post_sign_options jsonb not null default '[]';
