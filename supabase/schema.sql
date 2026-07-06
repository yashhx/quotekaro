-- QuoteKaro multi-tenant schema. Paste this whole file into
-- Supabase Dashboard > SQL Editor > New query > Run.
-- Safe to run more than once.

-- ============================================================
-- 1. shop_data: one private row per user holding the whole app
--    state (same JSON shape as the on-device quotekaro:v5 blob).
--    Row-level security means the DATABASE refuses to return or
--    accept another user's row, even if app code had a bug.
-- ============================================================
create table if not exists public.shop_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.shop_data enable row level security;

drop policy if exists "own data select" on public.shop_data;
create policy "own data select" on public.shop_data
  for select using (auth.uid() = user_id);

drop policy if exists "own data insert" on public.shop_data;
create policy "own data insert" on public.shop_data
  for insert with check (auth.uid() = user_id);

drop policy if exists "own data update" on public.shop_data;
create policy "own data update" on public.shop_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- (no delete policy: users can't delete the row via the API; account
--  deletion cascades from auth.users)

-- ============================================================
-- 2. tenants: maps each user to THEIR WhatsApp business number
--    (Meta phone_number_id). The enquiries function only shows a
--    user the messages sent TO their number. wa_phone_id is set
--    by the admin (service role) - users cannot claim a number.
-- ============================================================
create table if not exists public.tenants (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  shop_name   text default '',
  wa_phone_id text unique,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table public.tenants enable row level security;

drop policy if exists "own tenant select" on public.tenants;
create policy "own tenant select" on public.tenants
  for select using (auth.uid() = user_id);

-- no insert/update/delete policies: only the service role (used by
-- Netlify functions / the admin) can write tenant rows.

-- ============================================================
-- 3. auto-create a tenant row whenever a new user signs up
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.tenants (user_id, shop_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- Admin cheat-sheet (run by hand when needed):
--
-- Make yourself admin (see every unrouted enquiry):
--   update public.tenants set is_admin = true
--   where user_id = (select id from auth.users where email = 'YOUR@EMAIL');
--
-- Assign a WhatsApp number (Meta phone_number_id) to a customer:
--   update public.tenants set wa_phone_id = '123456789012345'
--   where user_id = (select id from auth.users where email = 'CUSTOMER@EMAIL');
-- ============================================================
