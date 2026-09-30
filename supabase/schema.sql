-- ============================================================================
-- Second Brain — database schema for the public, multi-user edition
--
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- It is safe to run again; everything is guarded with "if not exists".
--
-- The shape mirrors what the app already uses: one row per item, carrying the
-- item's own JSON and the timestamp the app stamps on every edit. That lets the
-- existing merge rules work unchanged — newest edit wins, deletions are
-- tombstones — and lets a device pull only what changed since it last synced.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The data
-- ----------------------------------------------------------------------------
create table if not exists public.items (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  coll       text        not null,              -- 'journal', 'tasks', 'courses'…
  item_id    text        not null,              -- the id the app already gives each item
  ts         bigint      not null default 0,    -- the app's own edit stamp, for merging
  deleted    boolean     not null default false,-- a tombstone, so deletes travel
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),-- server clock, for "what changed since"
  primary key (user_id, coll, item_id)
);

-- Per-user settings (name, currency, notification preferences…), one row each.
create table if not exists public.profiles (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  settings   jsonb       not null default '{}'::jsonb,
  ts         bigint      not null default 0,
  updated_at timestamptz not null default now()
);

-- A device pulls with "give me everything after this point", so this index is
-- what keeps that cheap as the table grows.
create index if not exists items_sync_idx on public.items (user_id, updated_at desc);
create index if not exists items_coll_idx on public.items (user_id, coll);

-- ----------------------------------------------------------------------------
-- 2. Keep updated_at honest
--    A client must not be able to backdate a row and hide it from other
--    devices' sync cursors, so the server sets this itself on every write.
-- ----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.user_id := auth.uid();      -- a row can only ever belong to the caller
  return new;
end;
$$;

drop trigger if exists items_touch on public.items;
create trigger items_touch
  before insert or update on public.items
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before insert or update on public.profiles
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Isolation
--    This is the part that matters most. With row level security on and these
--    policies in place, a query can only ever see or change rows belonging to
--    the signed-in user — enforced by the database, not by the app. Even a
--    tampered client asking for everything gets back only its own rows.
-- ----------------------------------------------------------------------------
alter table public.items    enable row level security;
alter table public.profiles enable row level security;

-- Postgres has no "create policy if not exists", so drop then create.
drop policy if exists items_select on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
drop policy if exists items_delete on public.items;

create policy items_select on public.items
  for select using (auth.uid() = user_id);
create policy items_insert on public.items
  for insert with check (auth.uid() = user_id);
create policy items_update on public.items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy items_delete on public.items
  for delete using (auth.uid() = user_id);

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;

create policy profiles_select on public.profiles
  for select using (auth.uid() = user_id);
create policy profiles_insert on public.profiles
  for insert with check (auth.uid() = user_id);
create policy profiles_update on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Anonymous visitors get nothing at all; only a signed-in session can read.
revoke all on public.items    from anon;
revoke all on public.profiles from anon;
grant select, insert, update, delete on public.items    to authenticated;
grant select, insert, update on public.profiles         to authenticated;

-- ----------------------------------------------------------------------------
-- 4. "Delete my account and everything in it"
--    Called by the app; removes the caller's rows. The auth user itself is
--    removed by the account-deletion endpoint, and the cascade above clears
--    anything left behind.
-- ----------------------------------------------------------------------------
create or replace function public.delete_my_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.items    where user_id = auth.uid();
  delete from public.profiles where user_id = auth.uid();
end;
$$;

revoke all on function public.delete_my_data() from public, anon;
grant execute on function public.delete_my_data() to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Housekeeping: tombstones are only needed until every device has seen them.
--    Schedule this monthly (Supabase → Database → Cron) once you have users:
--       select public.prune_tombstones();
-- ----------------------------------------------------------------------------
create or replace function public.prune_tombstones()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare removed integer;
begin
  delete from public.items
   where deleted and updated_at < now() - interval '120 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_tombstones() from public, anon, authenticated;
