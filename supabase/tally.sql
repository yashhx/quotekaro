-- QuoteKaro Tally integration tables. Paste this whole file into
-- Supabase Dashboard > SQL Editor > New query > Run.
-- Safe to run more than once. Run schema.sql FIRST (it creates tenants).

-- ============================================================
-- 1. tenants.connector_key: the secret the on-premise Tally
--    connector sends on every call (x-connector-key header).
--    Issued per user by the tally-key function via the service
--    role - users cannot write tenant rows themselves, so a key
--    can never be claimed or changed from the browser.
-- ============================================================
alter table public.tenants add column if not exists connector_key text unique;

-- ============================================================
-- 2. tally_sync: one row per quote the connector has tried to
--    push into Tally. status is "done" or "error". A "done" row
--    removes the quote from the pending feed; an "error" row
--    keeps it pending so the connector retries next pass - up to
--    5 tries (attempts), after which the quote is given up.
--    detail holds a short human-readable note (Tally's reply).
-- ============================================================
create table if not exists public.tally_sync (
  user_id   uuid references auth.users(id) on delete cascade,
  quote_id  text,
  status    text not null,
  detail    text,
  attempts  int not null default 0,
  synced_at timestamptz default now(),
  primary key (user_id, quote_id)
);
-- (in case the table was created before attempts existed)
alter table public.tally_sync add column if not exists attempts int not null default 0;

alter table public.tally_sync enable row level security;

drop policy if exists "own sync select" on public.tally_sync;
create policy "own sync select" on public.tally_sync
  for select using (auth.uid() = user_id);

-- no insert/update/delete policies: rows are written only by the
-- tally-sync function using the service role (bypasses RLS).

-- ============================================================
-- 3. tally_ledgers: customer outstanding balances pulled OUT of
--    Tally so the app can show "this customer owes Rs X" next to
--    quotes. Replaced wholesale on every connector report, so
--    as_of tells you how fresh the numbers are.
-- ============================================================
create table if not exists public.tally_ledgers (
  user_id uuid references auth.users(id) on delete cascade,
  name    text,
  balance numeric,
  as_of   timestamptz default now(),
  primary key (user_id, name)
);

alter table public.tally_ledgers enable row level security;

drop policy if exists "own ledgers select" on public.tally_ledgers;
create policy "own ledgers select" on public.tally_ledgers
  for select using (auth.uid() = user_id);

-- no insert/update/delete policies: rows are written only by the
-- tally-sync function using the service role (bypasses RLS).

-- ============================================================
-- Admin cheat-sheet (run by hand when needed):
--
-- See how Tally syncing is going across all users:
--   select t.shop_name, s.quote_id, s.status, s.detail, s.attempts, s.synced_at
--   from public.tally_sync s
--   join public.tenants t on t.user_id = s.user_id
--   order by s.synced_at desc
--   limit 50;
--
-- Re-queue a quote that was given up after 5 failed tries (the user has
-- fixed the cause in Tally and asked you to retry):
--   delete from public.tally_sync
--   where quote_id = 'THE_QUOTE_ID' and status = 'error';
-- ============================================================

-- ============================================================
-- 4. Insights additions (2026-07-12): ledger group + vouchers.
--    Safe to re-run; run this whole file again if you ran the
--    older version before.
-- ============================================================
alter table public.tally_ledgers add column if not exists grp text default 'debtor';

create table if not exists public.tally_vouchers (
  user_id uuid references auth.users(id) on delete cascade,
  vkey    text,                -- stable voucher identity (guid/number+date)
  vdate   bigint,              -- ms epoch
  vtype   text,                -- Sales / Purchase
  party   text,
  amount  numeric,
  item    text default '',
  qty     numeric default 0,
  unit    text default '',
  as_of   timestamptz default now(),
  primary key (user_id, vkey)
);

alter table public.tally_vouchers enable row level security;

drop policy if exists "own vouchers select" on public.tally_vouchers;
create policy "own vouchers select" on public.tally_vouchers
  for select using (auth.uid() = user_id);
-- writes only via the tally-sync function (service role bypasses RLS)
