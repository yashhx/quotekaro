-- TrackRakho shop-floor (worker device) tables. Paste this whole file into
-- Supabase Dashboard > SQL Editor > New query > Run.
-- Safe to run more than once. Run schema.sql FIRST (it creates tenants).
--
-- WHY A SEPARATE STREAM AND NOT shop_data:
-- the owner's whole shop is ONE jsonb row saved last-write-wins. Two devices
-- writing it would silently destroy each other's work. So the floor device
-- never touches shop_data: it appends EVENTS here, and the owner's app - the
-- only writer of shop_data - reads them. Worker phones hold no shop data at
-- all: not hidden, absent.

-- ============================================================
-- 1. floor_devices: one row per phone/tablet on the shop floor.
--    The owner creates a row with a 6-digit pairing code; the
--    worker enters the code once and the row is handed a long
--    secret token, which that device sends on every call
--    (x-floor-token). Rows are written ONLY by the floor-pair /
--    floor-event functions using the service role.
-- ============================================================
create table if not exists public.floor_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade,
  name         text,                      -- "Shop floor phone", set by the owner
  token        text unique,               -- fl_<40 hex>; null until the code is claimed
  pair_code    text,                      -- 6 digits, cleared the moment it is used
  pair_expires bigint,                    -- ms epoch; a code is dead after 15 minutes
  paired_at    timestamptz,
  last_seen    timestamptz,
  created_at   timestamptz default now()
);
create index if not exists floor_devices_user on public.floor_devices(user_id);
create unique index if not exists floor_devices_code on public.floor_devices(pair_code) where pair_code is not null;

alter table public.floor_devices enable row level security;

drop policy if exists "own devices select" on public.floor_devices;
create policy "own devices select" on public.floor_devices
  for select using (auth.uid() = user_id);
-- deliberately no insert/update/delete policy: a browser must never be able to
-- mint or read a device token. The functions do it with the service role.

-- ============================================================
-- 2. floor_events: append-only log of what happened on the floor.
--    kind is one of:
--      start     - job started on a machine   (job_id, machine_uid)
--      count     - pieces done so far         (qty = pieces this entry)
--      done      - job finished on a machine  (qty good, rej rejects)
--      down      - machine stopped            (reason, machine_uid)
--      up        - machine running again      (machine_uid)
--      move      - work moved to another machine (machine_uid = to, from_uid)
--      note      - shift handover note        (note)
--    Nothing is ever edited or deleted; the owner's app folds the log into
--    its own view. `seen` lets the owner's app mark the feed read.
-- ============================================================
create table if not exists public.floor_events (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  device_id   uuid references public.floor_devices(id) on delete set null,
  kind        text not null,
  machine_uid text,
  from_uid    text,
  job_id      text,
  qty         numeric,
  rej         numeric,
  reason      text,
  note        text,
  at          bigint,                    -- ms epoch, set by the server
  seen        boolean not null default false,
  created_at  timestamptz default now()
);
-- payload carries whatever a kind needs beyond the columns above. A `start`
-- from the floor carries the whole job (part, customer, qty, cycleMin,
-- manualMin, units) so the owner's app can turn it into a REAL job with a real
-- ETA - the floor is allowed to create work, not just report on it.
alter table public.floor_events add column if not exists payload jsonb;

create index if not exists floor_events_user_at on public.floor_events(user_id, id desc);

alter table public.floor_events enable row level security;

drop policy if exists "own events select" on public.floor_events;
create policy "own events select" on public.floor_events
  for select using (auth.uid() = user_id);

drop policy if exists "own events seen" on public.floor_events;
create policy "own events seen" on public.floor_events
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own events insert" on public.floor_events;
create policy "own events insert" on public.floor_events
  for insert with check (auth.uid() = user_id);
-- the OWNER may add his own events (marking a machine back up from his phone,
-- leaving a note). A floor device has no login at all, so its inserts still go
-- through floor-event.js with the service role.

-- ============================================================
-- 3. push_subs: Web Push subscriptions for the OWNER's phone, so
--    a breakdown reaches him with the app closed. One row per
--    browser/device; endpoint is unique.
-- ============================================================
create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  p256dh     text,
  auth       text,
  created_at timestamptz default now()
);
create index if not exists push_subs_user on public.push_subs(user_id);

alter table public.push_subs enable row level security;

drop policy if exists "own subs select" on public.push_subs;
create policy "own subs select" on public.push_subs
  for select using (auth.uid() = user_id);
-- written by the push-subscribe function with the service role.
