-- =============================================================
--  Tidepool: samen één pot
--  Eén keer uitvoeren in Supabase → SQL Editor → New query → Run.
--
--  Een reis die je "online zet" komt hier te staan. Alleen leden van
--  een reis kunnen hem zien en aanpassen. Je wordt lid door de reis
--  te maken of door de uitnodigingscode in te vullen (tp_join).
-- =============================================================

create table if not exists public.tp_trips (
  id          text primary key check (length(id) between 4 and 40),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code        text not null unique check (code ~ '^[A-Z2-9]{6}$'),
  name        text not null check (length(name) between 1 and 60),
  theme       text not null default 'strand' check (length(theme) <= 20),
  start_date  text,
  end_date    text,
  status      text not null default 'active' check (status in ('active', 'archived')),
  split       jsonb not null default '{"mode":"equal"}'::jsonb check (pg_column_size(split) < 8192),
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create table if not exists public.tp_members (
  trip_id    text not null references public.tp_trips(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (trip_id, user_id)
);

create table if not exists public.tp_people (
  trip_id     text not null references public.tp_trips(id) on delete cascade,
  id          text not null check (length(id) between 4 and 40),
  name        text not null check (length(name) between 1 and 40),
  color       text not null default '#FF6B45' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  user_id     uuid references auth.users(id) on delete set null,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (trip_id, id)
);

create table if not exists public.tp_expenses (
  trip_id     text not null references public.tp_trips(id) on delete cascade,
  id          text not null check (length(id) between 4 and 40),
  amount      integer not null check (amount > 0 and amount < 100000000),
  descr       text not null default '' check (length(descr) <= 120),
  cat         text not null default 'overig' check (length(cat) <= 20),
  payer       text not null check (length(payer) <= 40),
  date        text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  split       jsonb not null check (pg_column_size(split) < 8192),
  created     text,
  created_by  uuid default auth.uid(),
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (trip_id, id)
);

create index if not exists tp_people_sync   on public.tp_people (trip_id, updated_at);
create index if not exists tp_expenses_sync on public.tp_expenses (trip_id, updated_at);
create index if not exists tp_members_user  on public.tp_members (user_id);

-- Lid van deze reis?
create or replace function public.tp_is_member(p_trip text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tp_members where trip_id = p_trip and user_id = auth.uid());
$$;
revoke all on function public.tp_is_member(text) from public;
grant execute on function public.tp_is_member(text) to authenticated;

-- updated_at altijd door de server (zo werkt "wat is er nieuw sinds" eerlijk)
create or replace function public.tp_touch() returns trigger
language plpgsql security invoker set search_path = public as $$
begin new.updated_at := clock_timestamp(); return new; end $$;

drop trigger if exists tp_trips_touch on public.tp_trips;
create trigger tp_trips_touch before insert or update on public.tp_trips for each row execute function public.tp_touch();
drop trigger if exists tp_people_touch on public.tp_people;
create trigger tp_people_touch before insert or update on public.tp_people for each row execute function public.tp_touch();
drop trigger if exists tp_expenses_touch on public.tp_expenses;
create trigger tp_expenses_touch before insert or update on public.tp_expenses for each row execute function public.tp_touch();

-- Wie een reis online zet, is meteen lid
create or replace function public.tp_owner_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.tp_members (trip_id, user_id) values (new.id, new.owner) on conflict do nothing;
  return new;
end $$;
drop trigger if exists tp_trips_owner on public.tp_trips;
create trigger tp_trips_owner after insert on public.tp_trips for each row execute function public.tp_owner_member();

-- Toegang
alter table public.tp_trips    enable row level security;
alter table public.tp_members  enable row level security;
alter table public.tp_people   enable row level security;
alter table public.tp_expenses enable row level security;

drop policy if exists "tp_trips lezen" on public.tp_trips;
create policy "tp_trips lezen" on public.tp_trips for select to authenticated using (public.tp_is_member(id) or owner = auth.uid());
drop policy if exists "tp_trips maken" on public.tp_trips;
create policy "tp_trips maken" on public.tp_trips for insert to authenticated with check (owner = auth.uid());
drop policy if exists "tp_trips wijzigen" on public.tp_trips;
create policy "tp_trips wijzigen" on public.tp_trips for update to authenticated using (public.tp_is_member(id)) with check (public.tp_is_member(id));
drop policy if exists "tp_trips verwijderen" on public.tp_trips;
create policy "tp_trips verwijderen" on public.tp_trips for delete to authenticated using (owner = auth.uid());

drop policy if exists "tp_members lezen" on public.tp_members;
create policy "tp_members lezen" on public.tp_members for select to authenticated using (public.tp_is_member(trip_id));
drop policy if exists "tp_members zelf weg" on public.tp_members;
create policy "tp_members zelf weg" on public.tp_members for delete to authenticated using (user_id = auth.uid());

drop policy if exists "tp_people leden" on public.tp_people;
create policy "tp_people leden" on public.tp_people for all to authenticated using (public.tp_is_member(trip_id)) with check (public.tp_is_member(trip_id));
drop policy if exists "tp_expenses leden" on public.tp_expenses;
create policy "tp_expenses leden" on public.tp_expenses for all to authenticated using (public.tp_is_member(trip_id)) with check (public.tp_is_member(trip_id));

grant select, insert, update, delete on public.tp_trips, public.tp_people, public.tp_expenses to authenticated;
grant select, delete on public.tp_members to authenticated;

-- Meedoen met een uitnodigingscode
create or replace function public.tp_join(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if auth.uid() is null then raise exception 'niet ingelogd'; end if;
  select id into t from public.tp_trips where code = upper(trim(p_code));
  if t is null then raise exception 'code onbekend'; end if;
  insert into public.tp_members (trip_id, user_id) values (t, auth.uid()) on conflict do nothing;
  return t;
end $$;
revoke all on function public.tp_join(text) from public;
grant execute on function public.tp_join(text) to authenticated;

-- Leden van een reis met hun Spark-naam (alleen voor leden)
create or replace function public.tp_member_list(p_trip text) returns table (user_id uuid, display_name text, username text, joined_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.display_name, p.username, m.joined_at
  from public.tp_members m left join public.profiles p on p.id = m.user_id
  where m.trip_id = p_trip and public.tp_is_member(p_trip)
  order by m.joined_at;
$$;
revoke all on function public.tp_member_list(text) from public;
grant execute on function public.tp_member_list(text) to authenticated;
