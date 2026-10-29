-- =============================================================
--  Spark Apps: de appstore beschermen
--  Eén keer uitvoeren in Supabase → SQL Editor → New query → Run.
--  (Controleer dat het adres kplorhptmnfddvozpxwl bevat.)
--
--  De appstore (pakket nl.thomas.sparkapps) is de app waarmee
--  iedereen de andere apps installeert. Deze regel zorgt dat hij
--  niet per ongeluk verwijderd, verborgen of omgenummerd wordt,
--  ook niet buiten het beheerportaal om.
-- =============================================================

create or replace function public.store_protect() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.package_name = 'nl.thomas.sparkapps' then
      raise exception 'De appstore kan niet verwijderd worden.';
    end if;
    return old;
  end if;
  if old.package_name = 'nl.thomas.sparkapps' then
    if new.package_name is distinct from old.package_name then
      raise exception 'Het pakket van de appstore moet nl.thomas.sparkapps blijven.';
    end if;
    if new.status <> 'live' then
      raise exception 'De appstore moet live blijven, anders kan niemand hem downloaden.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists apps_store_protect on public.apps;
create trigger apps_store_protect before update or delete on public.apps
  for each row execute function public.store_protect();
