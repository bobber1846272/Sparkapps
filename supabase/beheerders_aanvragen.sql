-- =============================================================
--  Spark Beheer: subbeheerders met rechten + aanvragen van de website
--  Eén keer uitvoeren in Supabase → SQL Editor → New query → Run.
--  Controleer eerst dat het adres kplorhptmnfddvozpxwl bevat.
--  Je mag dit gerust nog een keer uitvoeren; er gaat niks dubbel.
--
--  Wat het doet:
--  1. Beheerders krijgen een rol en rechten (vinkjes). Er is precies
--     één eigenaar: alleen die kan beheerders toevoegen, wijzigen of
--     weghalen. De eigenaar is de oudste bestaande beheerder (jij).
--     Alle andere beheerders die er nu al zijn, houden alle rechten.
--  2. De database controleert die rechten zelf, dus ook buiten het
--     beheerportaal om kan een beheerder niet meer dan hij mag.
--  3. Een tabel voor aanvragen, foutmeldingen en feedback vanaf de
--     website. Iedereen ziet alleen zijn eigen aanvragen.
-- =============================================================

-- ---------- 1. Beheerders en rechten ----------

create or replace function public.sa_all_perms() returns text[]
language sql immutable as $$
  select array['apps','store','users','users_delete','announcements','trips','files','server','log','requests']::text[];
$$;

create table if not exists public.admin_staff (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  role        text not null default 'eigen' check (role in ('eigenaar','beheerder','app-beheerder','moderator','helpdesk','eigen')),
  perms       text[] not null default '{}',
  added_by    uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists admin_staff_one_owner on public.admin_staff ((true)) where role = 'eigenaar';
alter table public.admin_staff enable row level security;

-- Mag de ingelogde beheerder dit onderdeel?
create or replace function public.sa_can(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_staff s join public.profiles p on p.id = s.user_id
    where s.user_id = auth.uid() and p.is_admin and not coalesce(p.is_blocked, false)
      and (s.role = 'eigenaar' or p_perm = any (s.perms))
  );
$$;

create or replace function public.sa_is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_staff s join public.profiles p on p.id = s.user_id
    where s.user_id = auth.uid() and s.role = 'eigenaar' and p.is_admin and not coalesce(p.is_blocked, false)
  );
$$;

drop policy if exists "admin_staff eigen rij of eigenaar" on public.admin_staff;
create policy "admin_staff eigen rij of eigenaar" on public.admin_staff for select to authenticated
  using (user_id = auth.uid() or public.sa_is_owner());
grant select on public.admin_staff to authenticated;

-- Iedereen die nu al beheerder is, krijgt alle rechten (er verandert dus niks)
insert into public.admin_staff (user_id, role, perms)
select p.id, 'beheerder', public.sa_all_perms() from public.profiles p
where p.is_admin and exists (select 1 from auth.users u where u.id = p.id)
on conflict (user_id) do nothing;

-- De oudste beheerder wordt eigenaar (alleen als er nog geen eigenaar is)
update public.admin_staff set role = 'eigenaar', perms = public.sa_all_perms()
where not exists (select 1 from public.admin_staff where role = 'eigenaar')
  and user_id = (select s.user_id from public.admin_staff s join auth.users u on u.id = s.user_id
                 order by u.created_at nulls last, s.created_at limit 1);

-- Logboek (lukt het niet, dan is dat niet erg)
create or replace function public.sa_log(p_action text, p_target text) returns void
language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into public.admin_log (action, target) values (p_action, p_target);
  exception when others then null;
  end;
end $$;
revoke all on function public.sa_log(text, text) from public, anon, authenticated;

-- Wat mag ik? (voor het beheerportaal)
create or replace function public.sa_me() returns json
language sql stable security definer set search_path = public as $$
  select case when not exists (select 1 from public.profiles where id = auth.uid() and is_admin and not coalesce(is_blocked, false)) then null
    else coalesce(
      (select json_build_object('owner', s.role = 'eigenaar', 'role', s.role,
              'perms', case when s.role = 'eigenaar' then public.sa_all_perms() else s.perms end)
       from public.admin_staff s where s.user_id = auth.uid()),
      json_build_object('owner', false, 'role', null, 'perms', '{}'::text[]))
  end;
$$;

-- Alle beheerders (alleen voor de eigenaar)
create or replace function public.sa_list()
returns table (user_id uuid, username text, display_name text, avatar_url text, role text, perms text[], is_blocked boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.sa_is_owner() then raise exception 'Alleen de eigenaar mag beheerders zien.' using errcode = '42501'; end if;
  return query
    select s.user_id, p.username, p.display_name, p.avatar_url, s.role,
           case when s.role = 'eigenaar' then public.sa_all_perms() else s.perms end,
           coalesce(p.is_blocked, false), s.created_at
    from public.admin_staff s join public.profiles p on p.id = s.user_id
    where p.is_admin
    order by (s.role = 'eigenaar') desc, s.created_at;
end $$;

-- Beheerder maken of rechten wijzigen (alleen de eigenaar)
create or replace function public.sa_set(p_user uuid, p_role text, p_perms text[]) returns void
language plpgsql security definer set search_path = public as $$
declare clean text[]; who text;
begin
  if not public.sa_is_owner() then raise exception 'Alleen de eigenaar mag beheerders toevoegen of wijzigen.' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('beheerder','app-beheerder','moderator','helpdesk','eigen') then raise exception 'Onbekende rol.'; end if;
  if exists (select 1 from public.admin_staff where user_id = p_user and role = 'eigenaar') then raise exception 'De eigenaar kun je niet wijzigen.'; end if;
  select username into who from public.profiles where id = p_user and not coalesce(is_blocked, false);
  if who is null then raise exception 'Deze gebruiker bestaat niet of is geblokkeerd.'; end if;
  clean := array(select distinct x from unnest(coalesce(p_perms, '{}')) x where x = any (public.sa_all_perms()) order by x);
  insert into public.admin_staff (user_id, role, perms, added_by) values (p_user, p_role, clean, auth.uid())
  on conflict (user_id) do update set role = excluded.role, perms = excluded.perms, updated_at = now();
  update public.profiles set is_admin = true where id = p_user and not is_admin;
  perform public.sa_log('Beheerder ingesteld (' || p_role || ')', '@' || who);
end $$;

-- Beheerder weghalen (alleen de eigenaar). Het account zelf blijft bestaan.
create or replace function public.sa_remove(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  if not public.sa_is_owner() then raise exception 'Alleen de eigenaar mag beheerders weghalen.' using errcode = '42501'; end if;
  if exists (select 1 from public.admin_staff where user_id = p_user and role = 'eigenaar') then raise exception 'De eigenaar kun je niet weghalen.'; end if;
  select username into who from public.profiles where id = p_user;
  delete from public.admin_staff where user_id = p_user;
  update public.profiles set is_admin = false where id = p_user;
  perform public.sa_log('Beheerder weggehaald', '@' || coalesce(who, '?'));
end $$;

revoke all on function public.sa_can(text), public.sa_is_owner(), public.sa_me(), public.sa_list(), public.sa_set(uuid, text, text[]), public.sa_remove(uuid) from public, anon;
grant execute on function public.sa_can(text), public.sa_is_owner(), public.sa_me(), public.sa_list(), public.sa_set(uuid, text, text[]), public.sa_remove(uuid) to authenticated;

-- Profielen: beheerder-zijn alleen via sa_set/sa_remove; blokkeren alleen met het recht 'users';
-- een andere beheerder blokkeren of verwijderen mag alleen de eigenaar.
create or replace function public.sa_profiles_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if auth.uid() is not null and old.id <> auth.uid() and old.is_admin and not public.sa_is_owner() then
      raise exception 'Alleen de eigenaar mag een beheerder verwijderen.' using errcode = '42501';
    end if;
    if auth.uid() is not null and exists (select 1 from public.admin_staff where user_id = old.id and role = 'eigenaar') then
      raise exception 'Het account van de eigenaar kan niet verwijderd worden.' using errcode = '42501';
    end if;
    return old;
  end if;
  if current_user in ('authenticated', 'anon') then
    if new.is_admin is distinct from old.is_admin then
      raise exception 'Beheerders toevoegen of weghalen kan alleen de eigenaar, via Beheerders.' using errcode = '42501';
    end if;
    if new.is_blocked is distinct from old.is_blocked then
      if not public.sa_can('users') then raise exception 'Je hebt geen recht om gebruikers te blokkeren.' using errcode = '42501'; end if;
      if old.is_admin and not public.sa_is_owner() then raise exception 'Alleen de eigenaar mag een beheerder blokkeren.' using errcode = '42501'; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists sa_profiles_guard on public.profiles;
create trigger sa_profiles_guard before update or delete on public.profiles
  for each row execute function public.sa_profiles_guard();

-- Tabellen van het beheerportaal: schrijven alleen met het juiste recht.
-- (Dit zijn "beperkende" regels bovenop wat er al was; bestaande regels blijven.)
do $$
declare t record;
begin
  for t in select * from (values ('apps','apps'), ('app_versions','apps'), ('announcements','announcements'), ('store_settings','store')) v(tbl, perm) loop
    if to_regclass('public.' || t.tbl) is null then continue; end if;
    execute format('drop policy if exists "recht %1$s maken" on public.%1$I', t.tbl);
    execute format('drop policy if exists "recht %1$s wijzigen" on public.%1$I', t.tbl);
    execute format('drop policy if exists "recht %1$s verwijderen" on public.%1$I', t.tbl);
    execute format('create policy "recht %1$s maken" on public.%1$I as restrictive for insert to authenticated with check (public.sa_can(%2$L))', t.tbl, t.perm);
    execute format('create policy "recht %1$s wijzigen" on public.%1$I as restrictive for update to authenticated using (public.sa_can(%2$L)) with check (public.sa_can(%2$L))', t.tbl, t.perm);
    execute format('create policy "recht %1$s verwijderen" on public.%1$I as restrictive for delete to authenticated using (public.sa_can(%2$L))', t.tbl, t.perm);
  end loop;
  if to_regclass('public.admin_log') is not null then
    execute 'drop policy if exists "recht logboek lezen" on public.admin_log';
    execute 'create policy "recht logboek lezen" on public.admin_log as restrictive for select to authenticated using (public.sa_can(''log''))';
  end if;
end $$;

-- Bestanden: APK's, iconen en screenshots alleen met 'apps'; de beheermap alleen met 'files'.
drop policy if exists "recht beheerbestanden maken" on storage.objects;
create policy "recht beheerbestanden maken" on storage.objects as restrictive for insert to authenticated
  with check (bucket_id not in ('apks','app-icons','app-shots','beheer-bestanden')
              or (bucket_id = 'beheer-bestanden' and public.sa_can('files'))
              or (bucket_id <> 'beheer-bestanden' and public.sa_can('apps')));
drop policy if exists "recht beheerbestanden wijzigen" on storage.objects;
create policy "recht beheerbestanden wijzigen" on storage.objects as restrictive for update to authenticated
  using (bucket_id not in ('apks','app-icons','app-shots','beheer-bestanden')
         or (bucket_id = 'beheer-bestanden' and public.sa_can('files'))
         or (bucket_id <> 'beheer-bestanden' and public.sa_can('apps')));
drop policy if exists "recht beheerbestanden verwijderen" on storage.objects;
create policy "recht beheerbestanden verwijderen" on storage.objects as restrictive for delete to authenticated
  using (bucket_id not in ('apks','app-icons','app-shots','beheer-bestanden')
         or (bucket_id = 'beheer-bestanden' and public.sa_can('files'))
         or (bucket_id <> 'beheer-bestanden' and public.sa_can('apps')));
drop policy if exists "recht beheerbestanden lezen" on storage.objects;
create policy "recht beheerbestanden lezen" on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'beheer-bestanden' or public.sa_can('files'));

-- De bestaande beheerfuncties krijgen een rechtencontrole ervoor.
-- De oude functie blijft bestaan als <naam>__core en is alleen nog via de controle bereikbaar.
do $$
declare
  m jsonb := '{"admin_list_users":"users","admin_confirm_user":"users","admin_delete_user":"users_delete",
              "admin_mv_reports":"trips","admin_mv_report_done":"trips","admin_mv_hide":"trips",
              "admin_mv_hide_comment":"trips","admin_mv_public_list":"trips"}';
  r record; core text; types text; callargs text; body text; res text;
begin
  for r in
    select p.oid, p.proname, p.prosecdef, p.proretset, p.pronargs, p.proargnames, p.proargmodes, p.proargtypes
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (select jsonb_object_keys(m))
  loop
    core := r.proname || '__core';
    types := oidvectortypes(r.proargtypes);
    if to_regprocedure(format('public.%I(%s)', core, types)) is null then
      if not r.prosecdef then raise notice 'Overgeslagen (geen security definer): %', r.proname; continue; end if;
      execute format('alter function public.%I(%s) rename to %I', r.proname, types, core);
    end if;
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', core, types);
    -- argumenten doorgeven op naam
    select string_agg(format('%1$I => %1$I', nm), ', ' order by ord) into callargs
    from unnest(r.proargnames, coalesce(r.proargmodes, array_fill('i'::"char", array[coalesce(array_length(r.proargnames, 1), 0)]))) with ordinality a(nm, md, ord)
    where md in ('i', 'b', 'v');
    callargs := coalesce(callargs, '');
    select pg_get_function_result(p.oid) into res from pg_proc p where p.oid = to_regprocedure(format('public.%I(%s)', core, types));
    if r.proretset then body := format('return query select * from public.%I(%s);', core, callargs);
    elsif res = 'void' then body := format('perform public.%I(%s);', core, callargs);
    else body := format('return public.%I(%s);', core, callargs);
    end if;
    execute format($f$create or replace function public.%1$I(%2$s) returns %3$s language plpgsql security definer set search_path = public as $w$
begin
  if not public.sa_can(%4$L) then raise exception 'Je hebt geen recht voor dit onderdeel.' using errcode = '42501'; end if;
  %5$s
end $w$;$f$,
      r.proname,
      pg_get_function_arguments(to_regprocedure(format('public.%I(%s)', core, types))),
      res, m ->> r.proname, body);
    execute format('revoke all on function public.%I(%s) from public, anon', r.proname, types);
    execute format('grant execute on function public.%I(%s) to authenticated', r.proname, types);
  end loop;
end $$;


-- ---------- 2. Aanvragen, foutmeldingen en feedback (website) ----------

create table if not exists public.spark_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('app', 'fout', 'feedback')),
  app_name    text check (length(app_name) <= 60),
  title       text not null check (length(title) between 3 and 100),
  body        text not null default '' check (length(body) <= 3000),
  device      text check (length(device) <= 200),
  status      text not null default 'nieuw' check (status in ('nieuw', 'bekeken', 'bezig', 'klaar', 'afgewezen')),
  reply       text check (length(reply) <= 3000),
  replied_at  timestamptz,
  handled_by  uuid references auth.users(id) on delete set null,
  seen_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists spark_requests_user on public.spark_requests (user_id, created_at desc);
create index if not exists spark_requests_status on public.spark_requests (status, created_at desc);
alter table public.spark_requests enable row level security;

create or replace function public.spark_requests_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not public.sa_can('requests') and
       (select count(*) from public.spark_requests where user_id = new.user_id and created_at > now() - interval '1 day') >= 5 then
      raise exception 'Je hebt vandaag al 5 berichten gestuurd. Probeer het morgen weer.';
    end if;
    if exists (select 1 from public.profiles where id = new.user_id and coalesce(is_blocked, false)) then
      raise exception 'Je account is geblokkeerd.';
    end if;
    new.status := 'nieuw'; new.reply := null; new.replied_at := null; new.handled_by := null; new.seen_at := null;
    new.created_at := now();
  else
    if new.reply is distinct from old.reply then
      new.replied_at := case when new.reply is null or new.reply = '' then null else now() end;
      new.seen_at := null;
    end if;
    if new.status is distinct from old.status or new.reply is distinct from old.reply then new.handled_by := auth.uid(); end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists spark_requests_guard on public.spark_requests;
create trigger spark_requests_guard before insert or update on public.spark_requests
  for each row execute function public.spark_requests_guard();

drop policy if exists "aanvragen lezen" on public.spark_requests;
create policy "aanvragen lezen" on public.spark_requests for select to authenticated
  using (user_id = auth.uid() or public.sa_can('requests'));
drop policy if exists "aanvragen insturen" on public.spark_requests;
create policy "aanvragen insturen" on public.spark_requests for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "aanvragen beantwoorden" on public.spark_requests;
create policy "aanvragen beantwoorden" on public.spark_requests for update to authenticated
  using (public.sa_can('requests')) with check (public.sa_can('requests'));
drop policy if exists "aanvragen verwijderen" on public.spark_requests;
create policy "aanvragen verwijderen" on public.spark_requests for delete to authenticated
  using ((user_id = auth.uid() and status = 'nieuw') or public.sa_can('requests'));
grant select, insert, update, delete on public.spark_requests to authenticated;

-- Antwoorden als gelezen markeren (de website doet dit als je je berichten opent)
create or replace function public.spark_requests_seen() returns void
language sql security definer set search_path = public as $$
  update public.spark_requests set seen_at = now()
  where user_id = auth.uid() and replied_at is not null and (seen_at is null or seen_at < replied_at);
$$;
revoke all on function public.spark_requests_seen() from public, anon;
grant execute on function public.spark_requests_seen() to authenticated;


-- ---------- Klaar: wie is de eigenaar? ----------
select p.username as eigenaar, p.display_name
from public.admin_staff s join public.profiles p on p.id = s.user_id
where s.role = 'eigenaar';
