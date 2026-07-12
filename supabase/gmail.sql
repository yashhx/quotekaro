-- QuoteKaro Gmail connector columns. Paste into Supabase Dashboard > SQL Editor > Run.
-- Safe to run more than once. Run schema.sql FIRST (it creates tenants).
--
-- The Gmail refresh token is written ONLY via the service role (gmail-connect
-- function); users cannot read or write tenants directly, so the token never
-- reaches the browser after connect.

alter table public.tenants add column if not exists gmail_refresh_token text;
alter table public.tenants add column if not exists gmail_email text default '';
alter table public.tenants add column if not exists gmail_error text default '';
alter table public.tenants add column if not exists gmail_last_ts bigint default 0;

-- Admin cheat-sheet:
--   who has Gmail connected / in error:
--     select shop_name, gmail_email, gmail_error, to_timestamp(gmail_last_ts/1000)
--     from public.tenants where gmail_refresh_token is not null;
--   disconnect someone by hand:
--     update public.tenants set gmail_refresh_token = null, gmail_email = '', gmail_error = ''
--     where user_id = '...';
