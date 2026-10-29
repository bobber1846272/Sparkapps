-- =============================================================
--  Spark Beheer: je eigen overzicht kiezen (per beheerder)
--  Eén keer uitvoeren in Supabase → SQL Editor → New query → Run.
--  Controleer eerst dat het adres kplorhptmnfddvozpxwl bevat.
--  Voer eerst beheerders_aanvragen.sql uit als je dat nog niet deed.
-- =============================================================

alter table public.admin_staff add column if not exists prefs jsonb not null default '{}'::jsonb;

-- Wat mag ik? (voor het beheerportaal) + mijn eigen instellingen
create or replace function public.sa_me() returns json
language sql stable security definer set search_path = public as $$
  select case when not exists (select 1 from public.profiles where id = auth.uid() and is_admin and not coalesce(is_blocked, false)) then null
    else coalesce(
      (select json_build_object('owner', s.role = 'eigenaar', 'role', s.role,
              'perms', case when s.role = 'eigenaar' then public.sa_all_perms() else s.perms end,
              'prefs', s.prefs)
       from public.admin_staff s where s.user_id = auth.uid()),
      json_build_object('owner', false, 'role', null, 'perms', '{}'::text[], 'prefs', '{}'::json))
  end;
$$;

-- Eigen instellingen opslaan (bijv. welke blokken op je overzicht staan). Alleen je eigen rij.
create or replace function public.sa_save_prefs(p_prefs jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_prefs is null or jsonb_typeof(p_prefs) <> 'object' or pg_column_size(p_prefs) > 4096 then raise exception 'Ongeldige instellingen.'; end if;
  update public.admin_staff set prefs = p_prefs, updated_at = now() where user_id = auth.uid();
  if not found then raise exception 'Je staat (nog) niet in de lijst met beheerders.'; end if;
end $$;
revoke all on function public.sa_save_prefs(jsonb) from public, anon;
grant execute on function public.sa_save_prefs(jsonb) to authenticated;
