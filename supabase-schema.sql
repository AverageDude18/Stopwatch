-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query)
-- for the friends / leaderboard / username features in index.html.
-- Safe to re-run individual statements if something already exists, but as a
-- whole it's meant to run once against a fresh project.

-- profiles: public, unique username per account
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  updated_at timestamptz default now()
);
alter table public.profiles enable row level security;
create policy "profiles readable by authenticated users"
  on public.profiles for select using (auth.role() = 'authenticated');
create policy "insert own profile"
  on public.profiles for insert with check (auth.uid() = user_id);
create policy "update own profile"
  on public.profiles for update using (auth.uid() = user_id);

-- friend_requests: pending requests
create table public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  unique (sender_id, receiver_id)
);
alter table public.friend_requests enable row level security;
create policy "see own sent or received requests"
  on public.friend_requests for select
  using (auth.uid() = sender_id or auth.uid() = receiver_id);
create policy "send request as yourself"
  on public.friend_requests for insert with check (auth.uid() = sender_id);
create policy "cancel or decline own request"
  on public.friend_requests for delete
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

-- friendships: confirmed, mutual friendship (one row per direction)
create table public.friendships (
  user_id uuid not null references auth.users(id) on delete cascade,
  friend_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, friend_id)
);
alter table public.friendships enable row level security;
create policy "see own friendships"
  on public.friendships for select using (auth.uid() = user_id);
create policy "delete own friendship row"
  on public.friendships for delete using (auth.uid() = user_id);

-- accept_friend_request: security-definer RPC. Accepting must atomically
-- create BOTH friendship directions and remove the request, which the plain
-- RLS above doesn't allow for the sender's side.
create or replace function public.accept_friend_request(request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare req record;
begin
  select * into req from friend_requests where id = request_id;
  if req is null then raise exception 'Request not found'; end if;
  if req.receiver_id <> auth.uid() then raise exception 'Not authorized'; end if;
  insert into friendships (user_id, friend_id) values (req.sender_id, req.receiver_id) on conflict do nothing;
  insert into friendships (user_id, friend_id) values (req.receiver_id, req.sender_id) on conflict do nothing;
  delete from friend_requests where id = request_id;
end; $$;
grant execute on function public.accept_friend_request(uuid) to authenticated;

-- remove_friend: RPC so unfriending also cleans up the other person's row
create or replace function public.remove_friend(other_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from friendships where (user_id = auth.uid() and friend_id = other_id)
    or (user_id = other_id and friend_id = auth.uid());
end; $$;
grant execute on function public.remove_friend(uuid) to authenticated;

-- leaderboard_stats: narrow, leaderboard-only copy of a user's records
create table public.leaderboard_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  records jsonb not null default '{}',
  best_day_seconds integer not null default 0,
  longest_streak integer not null default 0,
  updated_at timestamptz default now()
);
alter table public.leaderboard_stats enable row level security;
create policy "read own or friends leaderboard stats"
  on public.leaderboard_stats for select
  using (
    auth.uid() = user_id
    or exists (select 1 from friendships f where f.user_id = auth.uid() and f.friend_id = leaderboard_stats.user_id)
  );
create policy "upsert own leaderboard stats"
  on public.leaderboard_stats for insert with check (auth.uid() = user_id);
create policy "update own leaderboard stats"
  on public.leaderboard_stats for update using (auth.uid() = user_id);

-- ============================================================
-- Added later: profile avatars (emoji OR an uploaded photo).
-- Only run this block if you already ran everything above in an
-- earlier session - it's additive to the existing profiles table.
-- ============================================================

alter table public.profiles add column if not exists avatar_emoji text;
alter table public.profiles add column if not exists avatar_url text;

-- Storage bucket for uploaded profile photos. Public read (avatars are
-- shown to friends/leaderboard viewers), but only the owner can write to
-- their own folder (path convention: avatars/<user_id>/<filename>).
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
  on conflict (id) do nothing;

create policy "avatar images are publicly accessible"
  on storage.objects for select using (bucket_id = 'avatars');
create policy "users can upload their own avatar"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users can update their own avatar"
  on storage.objects for update
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users can delete their own avatar"
  on storage.objects for delete
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================
-- Added later: fix "null value in column username violates
-- not-null constraint" when setting an avatar before ever saving
-- a username. The existing format check (username ~ '...') still
-- applies once a username IS set - Postgres only enforces CHECK
-- constraints on non-null values, so this is safe.
-- ============================================================
alter table public.profiles alter column username drop not null;

-- ============================================================
-- Added later: reactions on leaderboard entries.
-- One reaction per (reactor, target, metric) - toggled by delete/insert
-- from the client rather than an "active" flag. metric is either
-- 'bestday', 'streak', or 'exercise:<key>' (e.g. 'exercise:plank').
-- ============================================================
create table public.leaderboard_reactions (
  from_user_id uuid not null references auth.users(id) on delete cascade,
  to_user_id uuid not null references auth.users(id) on delete cascade,
  metric text not null,
  emoji text not null default '👍',
  created_at timestamptz default now(),
  primary key (from_user_id, to_user_id, metric)
);
alter table public.leaderboard_reactions enable row level security;
create policy "read reactions you sent, received, or on a friend's entry"
  on public.leaderboard_reactions for select
  using (
    from_user_id = auth.uid() or to_user_id = auth.uid()
    or exists (select 1 from friendships f where f.user_id = auth.uid() and f.friend_id = to_user_id)
  );
create policy "react as yourself"
  on public.leaderboard_reactions for insert with check (from_user_id = auth.uid());
create policy "remove own reaction"
  on public.leaderboard_reactions for delete using (from_user_id = auth.uid());

-- ============================================================
-- Added later: leaderboard trend history.
-- leaderboard_stats only ever holds the latest snapshot (upserted), so
-- a trend-over-time graph needs its own append-only-per-day table.
-- One row per user per day; the client upserts today's row on every
-- pushToCloud() alongside leaderboard_stats.
-- ============================================================
create table public.leaderboard_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  records jsonb not null default '{}',
  best_day_seconds integer not null default 0,
  longest_streak integer not null default 0,
  recorded_at date not null default current_date,
  unique (user_id, recorded_at)
);
alter table public.leaderboard_history enable row level security;
create policy "read own or friends leaderboard history"
  on public.leaderboard_history for select
  using (
    auth.uid() = user_id
    or exists (select 1 from friendships f where f.user_id = auth.uid() and f.friend_id = leaderboard_history.user_id)
  );
create policy "upsert own leaderboard history"
  on public.leaderboard_history for insert with check (auth.uid() = user_id);
create policy "update own leaderboard history"
  on public.leaderboard_history for update using (auth.uid() = user_id);

-- ============================================================
-- Added later: push notifications.
-- push_subscriptions holds Web Push subscriptions (one per device/browser a
-- user enabled notifications on). Only the owner can manage their own rows
-- via the client; the Deno proxy reads across all users with the
-- service-role key (bypasses RLS) to actually send notifications, since
-- that's server-side only and never exposed to the client.
--
-- current_streak/last_trained_date are new columns on leaderboard_stats: the
-- existing longest_streak is an all-time record, not "is today covered", so
-- the streak-reminder cron needs its own fields to know who to remind and
-- what number to put in the message. appLanguage lets the cron pick the
-- right translation per user.
-- ============================================================
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now()
);
alter table public.push_subscriptions enable row level security;
create policy "manage own push subscriptions"
  on public.push_subscriptions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.leaderboard_stats add column if not exists current_streak integer not null default 0;
alter table public.leaderboard_stats add column if not exists last_trained_date date;
alter table public.leaderboard_stats add column if not exists app_language text not null default 'nl';
