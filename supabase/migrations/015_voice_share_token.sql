-- iOS has no Web Share Target, so iPhone users reach the same voice pipeline
-- through a Shortcut that POSTs the audio. The Shortcut lives on the phone and
-- cannot hold a session, so it carries a long-lived per-user token instead.
--
-- Stored (not a signed JWT) specifically so it can be revoked: regenerating the
-- token instantly kills the old one, without rotating JWT_SECRET and signing
-- everyone out.
alter table profiles add column if not exists voice_share_token text;

create unique index if not exists profiles_voice_share_token_idx
  on profiles (voice_share_token)
  where voice_share_token is not null;
