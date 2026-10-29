-- =============================================================
--  Spark-games: voortgang in de cloud + ranglijsten
--  (Gooi Henk, Henk Herstelt, Gerard's Imperium)
--  Eén keer uitvoeren in Supabase → SQL Editor → New query → Run.
--  Controleer eerst dat het adres kplorhptmnfddvozpxwl bevat.
--  Je mag dit gerust nog een keer uitvoeren.
-- =============================================================

-- ---------- Voortgang (één opslag per speler per game) ----------
create table if not exists public.game_saves (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  app         text not null check (app in ('gooihenk', 'henkherstelt', 'gerard')),
  data        jsonb not null check (pg_column_size(data) < 600000),
  client_t    bigint not null default 0,
  device      text check (length(device) <= 80),
  updated_at  timestamptz not null default now(),
  primary key (user_id, app)
);
alter table public.game_saves enable row level security;
drop policy if exists "game_saves eigen" on public.game_saves;
create policy "game_saves eigen" on public.game_saves for select to authenticated using (user_id = auth.uid());
grant select on public.game_saves to authenticated;

-- Opslaan gaat via deze functie (altijd je eigen rij)
create or replace function public.game_save(p_app text, p_data jsonb, p_client_t bigint, p_device text default null)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare t timestamptz;
begin
  if auth.uid() is null then raise exception 'niet ingelogd'; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and coalesce(is_blocked, false)) then raise exception 'Je account is geblokkeerd.'; end if;
  insert into public.game_saves (user_id, app, data, client_t, device, updated_at)
  values (auth.uid(), p_app, p_data, coalesce(p_client_t, 0), left(p_device, 80), clock_timestamp())
  on conflict (user_id, app) do update set data = excluded.data, client_t = excluded.client_t, device = excluded.device, updated_at = excluded.updated_at
  returning updated_at into t;
  return t;
end $$;
revoke all on function public.game_save(text, jsonb, bigint, text) from public, anon;
grant execute on function public.game_save(text, jsonb, bigint, text) to authenticated;

-- ---------- Ranglijsten ----------
-- Welke ranglijsten er zijn, met een bovengrens tegen onzin-scores
create table if not exists public.game_boards (
  app       text not null,
  board     text not null,
  title     text not null,
  max_score double precision not null,
  primary key (app, board)
);
alter table public.game_boards enable row level security;
drop policy if exists "game_boards lezen" on public.game_boards;
create policy "game_boards lezen" on public.game_boards for select to anon, authenticated using (true);
grant select on public.game_boards to anon, authenticated;
insert into public.game_boards (app, board, title, max_score) values
  ('gooihenk', 'verste', 'Verste worp', 200000),
  ('gooihenk', 'sterren', 'Meeste sterren', 45),
  ('henkherstelt', 'level', 'Hoogste level', 1000),
  ('henkherstelt', 'vang', 'Kroket Vangen', 100000),
  ('henkherstelt', 'plak', 'Pleister Plakken', 100000),
  ('henkherstelt', 'mep', 'Mep Gerard', 100000),
  ('gerard', 'rijkste', 'Rijkste Gerard', 1e300),
  ('gerard', 'doorstarts', 'Meeste doorstarts', 100000)
on conflict (app, board) do update set title = excluded.title, max_score = excluded.max_score;

create table if not exists public.game_scores (
  user_id     uuid not null references auth.users(id) on delete cascade,
  app         text not null,
  board       text not null,
  score       double precision not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, app, board),
  foreign key (app, board) references public.game_boards(app, board) on delete cascade
);
create index if not exists game_scores_top on public.game_scores (app, board, score desc);
alter table public.game_scores enable row level security;
drop policy if exists "game_scores eigen" on public.game_scores;
create policy "game_scores eigen" on public.game_scores for select to authenticated using (user_id = auth.uid());
grant select on public.game_scores to authenticated;

-- Score doorgeven: alleen hoger dan je vorige telt
create or replace function public.game_submit(p_app text, p_board text, p_score double precision)
returns double precision language plpgsql security definer set search_path = public as $$
declare mx double precision; best double precision;
begin
  if auth.uid() is null then raise exception 'niet ingelogd'; end if;
  select max_score into mx from public.game_boards where app = p_app and board = p_board;
  if mx is null then raise exception 'onbekende ranglijst'; end if;
  if p_score is null or p_score < 0 or p_score > mx or p_score <> p_score then raise exception 'ongeldige score'; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and coalesce(is_blocked, false)) then raise exception 'Je account is geblokkeerd.'; end if;
  insert into public.game_scores (user_id, app, board, score) values (auth.uid(), p_app, p_board, p_score)
  on conflict (user_id, app, board) do update set score = greatest(game_scores.score, excluded.score),
    updated_at = case when excluded.score > game_scores.score then now() else game_scores.updated_at end
  returning score into best;
  return best;
end $$;
revoke all on function public.game_submit(text, text, double precision) from public, anon;
grant execute on function public.game_submit(text, text, double precision) to authenticated;

-- Top van een ranglijst (ook zonder account te bekijken). Ben je ingelogd en sta je
-- niet in de top, dan komt je eigen plek er als laatste regel bij.
create or replace function public.game_top(p_app text, p_board text, p_limit int default 50)
returns table (rank bigint, username text, display_name text, avatar_url text, score double precision, is_me boolean)
language sql stable security definer set search_path = public as $$
  with ranked as (
    select s.user_id, s.score, s.updated_at,
           rank() over (order by s.score desc) as rk,
           row_number() over (order by s.score desc, s.updated_at) as rn
    from public.game_scores s join public.profiles p on p.id = s.user_id
    where s.app = p_app and s.board = p_board and not coalesce(p.is_blocked, false)
  )
  select r.rk, p.username, p.display_name, p.avatar_url, r.score, (r.user_id = auth.uid())
  from ranked r join public.profiles p on p.id = r.user_id
  where r.rn <= least(greatest(coalesce(p_limit, 50), 1), 100) or r.user_id = auth.uid()
  order by r.rn;
$$;
grant execute on function public.game_top(text, text, int) to anon, authenticated;
