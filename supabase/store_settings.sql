-- =============================================================
--  Spark Store: instellingen die je in Spark Beheer aanpast
--  (labels, Binnenkort, slideshow). Eén keer uitvoeren in
--  Supabase → SQL Editor → New query → Run.
--
--  Iedereen mag lezen (de store toont het aan alle gebruikers),
--  alleen beheerders (profiles.is_admin) mogen aanpassen.
-- =============================================================

create table if not exists public.store_settings (
  key         text primary key check (key in ('labels', 'soon', 'slides', 'soon_slide')),
  value       jsonb not null check (pg_column_size(value) < 65536),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

-- Is de ingelogde gebruiker beheerder (en niet geblokkeerd)?
create or replace function public.store_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_admin = true and coalesce(is_blocked, false) = false
  );
$$;
revoke all on function public.store_is_admin() from public;
grant execute on function public.store_is_admin() to anon, authenticated;

alter table public.store_settings enable row level security;

drop policy if exists "store_settings: iedereen mag lezen" on public.store_settings;
create policy "store_settings: iedereen mag lezen"
  on public.store_settings for select to anon, authenticated using (true);

drop policy if exists "store_settings: alleen beheerders" on public.store_settings;
create policy "store_settings: alleen beheerders"
  on public.store_settings for all to authenticated
  using (public.store_is_admin()) with check (public.store_is_admin());

grant select on public.store_settings to anon, authenticated;
grant insert, update, delete on public.store_settings to authenticated;

create or replace function public.store_settings_touch() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists store_settings_touch on public.store_settings;
create trigger store_settings_touch before insert or update on public.store_settings
  for each row execute function public.store_settings_touch();
