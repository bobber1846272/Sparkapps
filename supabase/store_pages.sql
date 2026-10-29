-- =============================================================
--  Spark Store: volledige app-pagina's beheren in Spark Beheer
--  (categorie, functies, gegevensbeveiliging, screenshots, ...)
--  Eén keer uitvoeren in Supabase → SQL Editor → New query → Run.
--  Draai eerst store_settings.sql (die maakt store_is_admin()).
-- =============================================================

-- 1. Extra gegevens per app (alles van de store-pagina)
alter table public.apps add column if not exists details jsonb not null default '{}'::jsonb;

-- 2. Map voor screenshots: iedereen mag kijken, alleen beheerders uploaden
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('app-shots', 'app-shots', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "app-shots: iedereen mag kijken" on storage.objects;
create policy "app-shots: iedereen mag kijken"
  on storage.objects for select to anon, authenticated using (bucket_id = 'app-shots');

drop policy if exists "app-shots: beheerders uploaden" on storage.objects;
create policy "app-shots: beheerders uploaden"
  on storage.objects for insert to authenticated with check (bucket_id = 'app-shots' and public.store_is_admin());

drop policy if exists "app-shots: beheerders wijzigen" on storage.objects;
create policy "app-shots: beheerders wijzigen"
  on storage.objects for update to authenticated using (bucket_id = 'app-shots' and public.store_is_admin());

drop policy if exists "app-shots: beheerders verwijderen" on storage.objects;
create policy "app-shots: beheerders verwijderen"
  on storage.objects for delete to authenticated using (bucket_id = 'app-shots' and public.store_is_admin());
