-- Classement du Ski Simulator (Supabase / PostgreSQL)
create table if not exists public.runs (
  id bigint generated always as identity primary key,
  piste_id text not null,
  piste_name text not null,
  player text not null check (char_length(player) between 1 and 24),
  time_s real not null check (time_s > 5),
  max_kmh real not null check (max_kmh between 0 and 200),
  avg_kmh real not null,
  score integer not null,
  tricks integer not null default 0,
  approximate boolean not null default false,
  user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists runs_piste_time on public.runs (piste_id, time_s);

alter table public.runs enable row level security;
create policy "lecture publique" on public.runs for select using (true);
create policy "insertion anonyme" on public.runs for insert with check (true);

-- Phase 4 : profils utilisateurs (Supabase Auth)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  home_station text,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;
create policy "profil lisible" on public.profiles for select using (true);
create policy "profil modifiable par son proprietaire" on public.profiles for all using (auth.uid() = id);
