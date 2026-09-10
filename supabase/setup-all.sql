-- FitFlow / GymPilot - One-shot Supabase setup
-- Purpose: execute everything needed for this project in a single SQL run.
-- Run in Supabase SQL Editor as project owner/admin.
-- Recommended order:
--   1) Run reset-all.sql (optional, destructive)
--   2) Run this file: setup-all.sql

-- =====================================================
-- 0) Extensions
-- =====================================================
create extension if not exists pgcrypto;

-- =====================================================
-- 1) Social base schema (from social-schema.sql)
-- =====================================================
create table if not exists public.social_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.social_profiles(id) on delete cascade,
  addressee_id uuid not null references public.social_profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester_id <> addressee_id),
  unique (requester_id, addressee_id)
);

create table if not exists public.social_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.social_profiles(id) on delete cascade,
  receiver_id uuid not null references public.social_profiles(id) on delete cascade,
  body text not null check (char_length(body) <= 1000),
  created_at timestamptz not null default now()
);

create table if not exists public.workout_shares (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.social_profiles(id) on delete cascade,
  receiver_id uuid not null references public.social_profiles(id) on delete cascade,
  title text not null,
  message text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  imported_at timestamptz
);

alter table public.social_profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.social_messages enable row level security;
alter table public.workout_shares enable row level security;

drop policy if exists "profiles are readable by signed users" on public.social_profiles;
drop policy if exists "users insert their own profile" on public.social_profiles;
drop policy if exists "users update their own profile" on public.social_profiles;
drop policy if exists "friendships visible to both users" on public.friendships;
drop policy if exists "users request friendships" on public.friendships;
drop policy if exists "users update received or sent friendships" on public.friendships;
drop policy if exists "messages visible to sender and receiver" on public.social_messages;
drop policy if exists "users send own messages" on public.social_messages;
drop policy if exists "shares visible to sender and receiver" on public.workout_shares;
drop policy if exists "users send own shares" on public.workout_shares;
drop policy if exists "receivers mark shares imported" on public.workout_shares;

create policy "profiles are readable by signed users"
  on public.social_profiles for select
  to authenticated
  using (true);

create policy "users insert their own profile"
  on public.social_profiles for insert
  to authenticated
  with check (auth.uid() = id);

create policy "users update their own profile"
  on public.social_profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "friendships visible to both users"
  on public.friendships for select
  to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

create policy "users request friendships"
  on public.friendships for insert
  to authenticated
  with check (auth.uid() = requester_id);

create policy "users update received or sent friendships"
  on public.friendships for update
  to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id)
  with check (auth.uid() = requester_id or auth.uid() = addressee_id);

create policy "messages visible to sender and receiver"
  on public.social_messages for select
  to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

create policy "users send own messages"
  on public.social_messages for insert
  to authenticated
  with check (auth.uid() = sender_id);

create policy "shares visible to sender and receiver"
  on public.workout_shares for select
  to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

create policy "users send own shares"
  on public.workout_shares for insert
  to authenticated
  with check (auth.uid() = sender_id);

create policy "receivers mark shares imported"
  on public.workout_shares for update
  to authenticated
  using (auth.uid() = receiver_id)
  with check (auth.uid() = receiver_id);

-- =====================================================
-- 2) Social full upgrade (from social-feed-upgrade.sql)
-- =====================================================
alter table public.social_profiles
  add column if not exists bio text,
  add column if not exists login_email text,
  add column if not exists is_private boolean not null default false,
  add column if not exists show_consistency boolean not null default true,
  add column if not exists show_load_progression boolean not null default true,
  add column if not exists show_daily_calories boolean not null default false,
  add column if not exists show_water boolean not null default false,
  add column if not exists show_bmi boolean not null default false,
  add column if not exists show_weight_progress boolean not null default false,
  add column if not exists show_today_workout boolean not null default true;

alter table public.friendships
  add column if not exists deleted_at timestamptz;

create or replace function public.enforce_friendship_rules()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.social_profiles p where p.id = new.addressee_id and p.is_private = true) then
      new.status := 'pending';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'pending' and new.status = 'accepted' and auth.uid() <> old.addressee_id then
      raise exception 'Apenas quem recebeu a solicitação pode aceitar.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_friendship_rules_trigger on public.friendships;
create trigger enforce_friendship_rules_trigger
  before insert or update on public.friendships
  for each row execute function public.enforce_friendship_rules();

create or replace function public.handle_new_social_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_username text;
  final_username text;
  suffix int := 0;
begin
  base_username := lower(regexp_replace(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)), '[^a-z0-9_]', '', 'g'));
  if length(base_username) < 3 then
    base_username := 'user_' || substr(new.id::text, 1, 8);
  end if;
  base_username := substr(base_username, 1, 20);
  final_username := base_username;

  while exists (select 1 from public.social_profiles where username = final_username) loop
    suffix := suffix + 1;
    final_username := substr(base_username, 1, greatest(3, 20 - length(suffix::text) - 1)) || '_' || suffix::text;
  end loop;

  insert into public.social_profiles (id, username, display_name, login_email)
  values (
    new.id,
    final_username,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), final_username),
    new.email
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_social_profile on auth.users;
create trigger on_auth_user_created_social_profile
  after insert on auth.users
  for each row execute function public.handle_new_social_user();

insert into public.social_profiles (id, username, display_name, login_email)
select
  u.id,
  substr(lower(regexp_replace(coalesce(u.raw_user_meta_data->>'username', split_part(u.email, '@', 1), 'user'), '[^a-z0-9_]', '', 'g')), 1, 11) || '_' || substr(u.id::text, 1, 8),
  coalesce(nullif(u.raw_user_meta_data->>'display_name', ''), split_part(u.email, '@', 1), 'Usuario'),
  u.email
from auth.users u
where not exists (
  select 1 from public.social_profiles p where p.id = u.id
)
on conflict (id) do nothing;

create or replace function public.get_login_email(p_username text)
returns text
language sql
security definer
set search_path = public
as $$
  select login_email
  from public.social_profiles
  where username = lower(regexp_replace(p_username, '[^a-z0-9_]', '', 'g'))
  limit 1
$$;

grant execute on function public.get_login_email(text) to anon, authenticated;

create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return jsonb_build_object('success', false, 'error', 'Usuário não autenticado.');
  end if;

  delete from auth.users where id = v_user;

  return jsonb_build_object('success', true);
exception
  when others then
    return jsonb_build_object('success', false, 'error', left(sqlerrm, 1000));
end;
$$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

create table if not exists public.social_profile_stats (
  user_id uuid primary key references public.social_profiles(id) on delete cascade,
  consistency_count int not null default 0,
  load_progression text,
  daily_calories int not null default 0,
  daily_calorie_goal int not null default 0,
  water_glasses int not null default 0,
  bmi numeric,
  weight_start numeric,
  weight_latest numeric,
  today_workout text,
  updated_at timestamptz not null default now()
);

alter table public.social_profile_stats enable row level security;

drop policy if exists "stats are readable by logged users" on public.social_profile_stats;
drop policy if exists "users upsert own stats" on public.social_profile_stats;
drop policy if exists "users update own stats" on public.social_profile_stats;

create policy "stats are readable by logged users"
  on public.social_profile_stats for select
  to authenticated
  using (true);

create policy "users upsert own stats"
  on public.social_profile_stats for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users update own stats"
  on public.social_profile_stats for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.social_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.social_profiles(id) on delete cascade,
  receiver_id uuid not null references public.social_profiles(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 1000),
  created_at timestamptz not null default now()
);

alter table public.social_messages
  alter column body set default '',
  add column if not exists media_url text,
  add column if not exists media_type text check (media_type is null or media_type in ('image', 'video')),
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz;

create table if not exists public.social_chat_preferences (
  user_id uuid not null references public.social_profiles(id) on delete cascade,
  peer_id uuid not null references public.social_profiles(id) on delete cascade,
  is_archived boolean not null default false,
  is_pinned boolean not null default false,
  hidden_before timestamptz,
  last_read_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, peer_id),
  check (user_id <> peer_id)
);

alter table public.social_chat_preferences
  add column if not exists is_archived boolean not null default false,
  add column if not exists is_pinned boolean not null default false,
  add column if not exists hidden_before timestamptz,
  add column if not exists last_read_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.social_message_likes (
  message_id uuid not null references public.social_messages(id) on delete cascade,
  user_id uuid not null references public.social_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.social_messages enable row level security;
alter table public.social_chat_preferences enable row level security;
alter table public.social_message_likes enable row level security;

drop policy if exists "messages visible to sender and receiver" on public.social_messages;
drop policy if exists "users send own messages" on public.social_messages;
drop policy if exists "messages visible to both users" on public.social_messages;
drop policy if exists "friends send direct messages" on public.social_messages;
drop policy if exists "users update own messages" on public.social_messages;
drop policy if exists "users read own chat preferences" on public.social_chat_preferences;
drop policy if exists "users upsert own chat preferences" on public.social_chat_preferences;
drop policy if exists "users update own chat preferences" on public.social_chat_preferences;
drop policy if exists "message likes visible to participants" on public.social_message_likes;
drop policy if exists "users like visible messages" on public.social_message_likes;
drop policy if exists "users remove own message likes" on public.social_message_likes;

create policy "messages visible to both users"
  on public.social_messages for select
  to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

create policy "friends send direct messages"
  on public.social_messages for insert
  to authenticated
  with check (
    auth.uid() = sender_id
    and sender_id <> receiver_id
    and (
      exists (
        select 1
        from public.friendships f
        where f.status = 'accepted'
          and f.deleted_at is null
          and (
            (f.requester_id = sender_id and f.addressee_id = receiver_id)
            or (f.requester_id = receiver_id and f.addressee_id = sender_id)
          )
      )
      or exists (
        select 1
        from public.social_profiles sender_profile
        join public.social_profiles receiver_profile on receiver_profile.id = receiver_id
        where sender_profile.id = sender_id
          and sender_profile.is_private = false
          and receiver_profile.is_private = false
      )
    )
  );

create policy "users update own messages"
  on public.social_messages for update
  to authenticated
  using (auth.uid() = sender_id)
  with check (auth.uid() = sender_id);

create policy "users read own chat preferences"
  on public.social_chat_preferences for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users upsert own chat preferences"
  on public.social_chat_preferences for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users update own chat preferences"
  on public.social_chat_preferences for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "message likes visible to participants"
  on public.social_message_likes for select
  to authenticated
  using (
    exists (
      select 1
      from public.social_messages m
      where m.id = message_id
        and (auth.uid() = m.sender_id or auth.uid() = m.receiver_id)
    )
  );

create policy "users like visible messages"
  on public.social_message_likes for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.social_messages m
      where m.id = message_id
        and (auth.uid() = m.sender_id or auth.uid() = m.receiver_id)
    )
  );

create policy "users remove own message likes"
  on public.social_message_likes for delete
  to authenticated
  using (auth.uid() = user_id);

create index if not exists social_messages_sender_receiver_idx
  on public.social_messages (sender_id, receiver_id, created_at desc);

create index if not exists social_messages_receiver_sender_idx
  on public.social_messages (receiver_id, sender_id, created_at desc);

create index if not exists social_chat_preferences_user_idx
  on public.social_chat_preferences (user_id, is_pinned desc, is_archived, updated_at desc);

create index if not exists social_message_likes_message_idx
  on public.social_message_likes (message_id, created_at desc);

create index if not exists friendships_active_users_idx
  on public.friendships (requester_id, addressee_id, status)
  where deleted_at is null;

create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.social_profiles(id) on delete cascade,
  body text check (char_length(coalesce(body, '')) <= 2000),
  comments_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.social_posts
  add column if not exists comments_enabled boolean not null default true,
  add column if not exists deleted_at timestamptz;

create table if not exists public.social_post_images (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts(id) on delete cascade,
  image_url text not null,
  position int not null default 0
);

create table if not exists public.social_post_likes (
  post_id uuid not null references public.social_posts(id) on delete cascade,
  user_id uuid not null references public.social_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.social_post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts(id) on delete cascade,
  user_id uuid not null references public.social_profiles(id) on delete cascade,
  body text not null check (char_length(body) <= 1000),
  created_at timestamptz not null default now()
);

alter table public.social_post_comments
  add column if not exists deleted_at timestamptz,
  add column if not exists edited_at timestamptz;

create table if not exists public.social_post_comment_likes (
  comment_id uuid not null references public.social_post_comments(id) on delete cascade,
  user_id uuid not null references public.social_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

alter table public.social_posts enable row level security;
alter table public.social_post_images enable row level security;
alter table public.social_post_likes enable row level security;
alter table public.social_post_comments enable row level security;
alter table public.social_post_comment_likes enable row level security;

drop policy if exists "posts are public readable" on public.social_posts;
drop policy if exists "users create own posts" on public.social_posts;
drop policy if exists "users update own posts" on public.social_posts;
drop policy if exists "users delete own posts" on public.social_posts;
drop policy if exists "post images public readable" on public.social_post_images;
drop policy if exists "post owner adds images" on public.social_post_images;
drop policy if exists "likes public readable" on public.social_post_likes;
drop policy if exists "users like as themselves" on public.social_post_likes;
drop policy if exists "users remove own likes" on public.social_post_likes;
drop policy if exists "comments public readable" on public.social_post_comments;
drop policy if exists "users comment as themselves" on public.social_post_comments;
drop policy if exists "users update own comments" on public.social_post_comments;
drop policy if exists "users update own or received comments" on public.social_post_comments;
drop policy if exists "users delete own comments" on public.social_post_comments;
drop policy if exists "users delete own or received comments" on public.social_post_comments;
drop policy if exists "comment likes public readable" on public.social_post_comment_likes;
drop policy if exists "users like comments as themselves" on public.social_post_comment_likes;
drop policy if exists "users remove own comment likes" on public.social_post_comment_likes;

create policy "posts are public readable"
  on public.social_posts for select
  to authenticated
  using (true);

create policy "users create own posts"
  on public.social_posts for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users update own posts"
  on public.social_posts for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users delete own posts"
  on public.social_posts for delete
  to authenticated
  using (auth.uid() = user_id);

create policy "post images public readable"
  on public.social_post_images for select
  to authenticated
  using (true);

create policy "post owner adds images"
  on public.social_post_images for insert
  to authenticated
  with check (exists (select 1 from public.social_posts p where p.id = post_id and p.user_id = auth.uid()));

create policy "likes public readable"
  on public.social_post_likes for select
  to authenticated
  using (true);

create policy "users like as themselves"
  on public.social_post_likes for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users remove own likes"
  on public.social_post_likes for delete
  to authenticated
  using (auth.uid() = user_id);

create policy "comments public readable"
  on public.social_post_comments for select
  to authenticated
  using (true);

create policy "users comment as themselves"
  on public.social_post_comments for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.social_posts p
      where p.id = post_id
        and p.comments_enabled = true
    )
  );

create policy "users update own or received comments"
  on public.social_post_comments for update
  to authenticated
  using (
    auth.uid() = user_id
    or exists (
      select 1
      from public.social_posts p
      where p.id = post_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    or exists (
      select 1
      from public.social_posts p
      where p.id = post_id
        and p.user_id = auth.uid()
    )
  );

create policy "users delete own or received comments"
  on public.social_post_comments for delete
  to authenticated
  using (
    auth.uid() = user_id
    or exists (
      select 1
      from public.social_posts p
      where p.id = post_id
        and p.user_id = auth.uid()
    )
  );

create policy "comment likes public readable"
  on public.social_post_comment_likes for select
  to authenticated
  using (true);

create policy "users like comments as themselves"
  on public.social_post_comment_likes for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users remove own comment likes"
  on public.social_post_comment_likes for delete
  to authenticated
  using (auth.uid() = user_id);

create index if not exists social_post_comments_post_idx
  on public.social_post_comments (post_id, created_at asc);

create index if not exists social_post_comment_likes_comment_idx
  on public.social_post_comment_likes (comment_id, created_at desc);

create index if not exists social_posts_active_created_idx
  on public.social_posts (created_at desc)
  where deleted_at is null;

-- =====================================================
-- 3) Workout engine backend (from workout-engine-schema.sql)
-- =====================================================
create table if not exists public.workout_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source text not null default 'SYSTEM' check (source in ('SYSTEM', 'USER', 'AI')),
  owner_id uuid references auth.users(id) on delete cascade,
  visibility text not null default 'PRIVATE' check (visibility in ('PUBLIC', 'PRIVATE')),
  split text[] not null,
  workouts jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workout_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'DRAFTING' check (status in ('DRAFTING', 'READY', 'AWAITING_CONFIRMATION', 'SAVING', 'SAVED', 'ERROR')),
  split text not null check (split in ('ABC', 'ABCD', 'ABCDE')),
  workouts jsonb not null,
  recommendation text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_workout_programs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  version int not null default 1,
  status text not null default 'active' check (status in ('active', 'archived')),
  split text not null check (split in ('ABC', 'ABCD', 'ABCDE')),
  workouts jsonb not null,
  source text not null default 'AI' check (source in ('SYSTEM', 'USER', 'AI')),
  created_from_draft_id uuid references public.workout_drafts(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workout_replace_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  draft_id uuid references public.workout_drafts(id) on delete set null,
  expected_version int,
  result_program_id uuid references public.user_workout_programs(id) on delete set null,
  status text not null default 'processing' check (status in ('processing', 'success', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);

create table if not exists public.user_app_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create unique index if not exists user_workout_programs_one_active_idx
  on public.user_workout_programs (user_id)
  where status = 'active';

create index if not exists workout_drafts_user_status_idx
  on public.workout_drafts (user_id, status, updated_at desc);

create index if not exists workout_programs_user_status_idx
  on public.user_workout_programs (user_id, status, updated_at desc);

create index if not exists workout_templates_owner_visibility_idx
  on public.workout_templates (owner_id, visibility, updated_at desc);

create or replace function public.workout_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists workout_templates_touch_updated_at on public.workout_templates;
create trigger workout_templates_touch_updated_at
  before update on public.workout_templates
  for each row execute function public.workout_touch_updated_at();

drop trigger if exists workout_drafts_touch_updated_at on public.workout_drafts;
create trigger workout_drafts_touch_updated_at
  before update on public.workout_drafts
  for each row execute function public.workout_touch_updated_at();

drop trigger if exists user_workout_programs_touch_updated_at on public.user_workout_programs;
create trigger user_workout_programs_touch_updated_at
  before update on public.user_workout_programs
  for each row execute function public.workout_touch_updated_at();

drop trigger if exists workout_replace_requests_touch_updated_at on public.workout_replace_requests;
create trigger workout_replace_requests_touch_updated_at
  before update on public.workout_replace_requests
  for each row execute function public.workout_touch_updated_at();

create or replace function public.validate_workout_payload(p_workouts jsonb, p_split text)
returns text
language plpgsql
as $$
declare
  slots text[];
  slot text;
  workout_item jsonb;
  exercises jsonb;
  expected_count int;
begin
  if p_split not in ('ABC', 'ABCD', 'ABCDE') then
    return 'Split inválido.';
  end if;

  slots := case p_split
    when 'ABC' then array['A', 'B', 'C']
    when 'ABCD' then array['A', 'B', 'C', 'D']
    else array['A', 'B', 'C', 'D', 'E']
  end;

  expected_count := array_length(slots, 1);

  if jsonb_typeof(p_workouts) <> 'array' then
    return 'Workouts precisa ser um array JSON.';
  end if;

  if jsonb_array_length(p_workouts) <> expected_count then
    return format('Para split %s é obrigatório enviar %s treinos.', p_split, expected_count);
  end if;

  foreach slot in array slots loop
    workout_item := null;
    select w.value
      into workout_item
      from jsonb_array_elements(p_workouts) as w(value)
      where upper(coalesce(w.value->>'type', '')) = slot
      limit 1;

    if workout_item is null then
      return format('Treino %s ausente no payload.', slot);
    end if;

    exercises := workout_item->'exercises';
    if jsonb_typeof(exercises) <> 'array' or jsonb_array_length(exercises) < 5 then
      return format('Treino %s deve ter no mínimo 5 exercícios.', slot);
    end if;
  end loop;

  return null;
end;
$$;

create or replace function public.save_workout_draft(
  p_split text,
  p_workouts jsonb,
  p_recommendation text default null,
  p_draft_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_split text := upper(trim(coalesce(p_split, '')));
  v_error text;
  v_draft_id uuid;
begin
  if v_user is null then
    return jsonb_build_object('success', false, 'error', 'Usuário não autenticado.');
  end if;

  v_error := public.validate_workout_payload(p_workouts, v_split);
  if v_error is not null then
    return jsonb_build_object('success', false, 'error', v_error);
  end if;

  if p_draft_id is not null then
    update public.workout_drafts
       set split = v_split,
           workouts = p_workouts,
           recommendation = p_recommendation,
           status = 'AWAITING_CONFIRMATION',
           error_message = null,
           updated_at = now()
     where id = p_draft_id
       and user_id = v_user
     returning id into v_draft_id;
  end if;

  if v_draft_id is null then
    insert into public.workout_drafts (user_id, split, workouts, recommendation, status)
    values (v_user, v_split, p_workouts, p_recommendation, 'AWAITING_CONFIRMATION')
    returning id into v_draft_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'draftId', v_draft_id,
    'status', 'AWAITING_CONFIRMATION'
  );
end;
$$;

create or replace function public.replace_current_workout(
  p_draft_id uuid,
  p_idempotency_key text,
  p_expected_version int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_key text := trim(coalesce(p_idempotency_key, ''));
  v_draft public.workout_drafts%rowtype;
  v_current public.user_workout_programs%rowtype;
  v_new_program_id uuid;
  v_next_version int := 1;
  v_error text;
  v_existing_status text;
  v_existing_program uuid;
begin
  if v_user is null then
    return jsonb_build_object('success', false, 'error', 'Usuário não autenticado.');
  end if;

  if p_draft_id is null then
    return jsonb_build_object('success', false, 'error', 'draftId é obrigatório.');
  end if;

  if length(v_key) < 8 then
    return jsonb_build_object('success', false, 'error', 'idempotencyKey inválida.');
  end if;

  insert into public.workout_replace_requests (user_id, idempotency_key, draft_id, expected_version, status)
  values (v_user, v_key, p_draft_id, p_expected_version, 'processing')
  on conflict (user_id, idempotency_key) do nothing;

  select status, result_program_id
    into v_existing_status, v_existing_program
    from public.workout_replace_requests
    where user_id = v_user
      and idempotency_key = v_key;

  if v_existing_status = 'success' then
    return jsonb_build_object('success', true, 'idempotent', true, 'programId', v_existing_program);
  end if;

  update public.workout_drafts
     set status = 'SAVING',
         error_message = null,
         updated_at = now()
   where id = p_draft_id
     and user_id = v_user;

  select *
    into v_draft
    from public.workout_drafts
    where id = p_draft_id
      and user_id = v_user
    for update;

  if v_draft.id is null then
    update public.workout_replace_requests
       set status = 'failed', error_message = 'Draft não encontrado.'
     where user_id = v_user and idempotency_key = v_key;
    return jsonb_build_object('success', false, 'error', 'Draft não encontrado.');
  end if;

  v_error := public.validate_workout_payload(v_draft.workouts, v_draft.split);
  if v_error is not null then
    update public.workout_drafts
       set status = 'ERROR', error_message = v_error
     where id = v_draft.id;
    update public.workout_replace_requests
       set status = 'failed', error_message = v_error
     where user_id = v_user and idempotency_key = v_key;
    return jsonb_build_object('success', false, 'error', v_error);
  end if;

  select *
    into v_current
    from public.user_workout_programs
    where user_id = v_user
      and status = 'active'
    order by created_at desc
    limit 1
    for update;

  if p_expected_version is not null then
    if v_current.id is null and p_expected_version <> 0 then
      update public.workout_replace_requests
         set status = 'failed', error_message = 'Versão esperada não confere com estado atual.'
       where user_id = v_user and idempotency_key = v_key;
      return jsonb_build_object('success', false, 'error', 'Versão esperada não confere com estado atual.');
    end if;

    if v_current.id is not null and v_current.version <> p_expected_version then
      update public.workout_replace_requests
         set status = 'failed', error_message = 'Conflito de versão do treino ativo.'
       where user_id = v_user and idempotency_key = v_key;
      return jsonb_build_object('success', false, 'error', 'Conflito de versão do treino ativo.');
    end if;
  end if;

  if v_current.id is not null then
    update public.user_workout_programs
       set status = 'archived', archived_at = now(), updated_at = now()
     where id = v_current.id;
    v_next_version := v_current.version + 1;
  end if;

  insert into public.user_workout_programs (
    user_id,
    version,
    status,
    split,
    workouts,
    source,
    created_from_draft_id
  )
  values (
    v_user,
    v_next_version,
    'active',
    v_draft.split,
    v_draft.workouts,
    'AI',
    v_draft.id
  )
  returning id into v_new_program_id;

  update public.workout_drafts
     set status = 'SAVED', error_message = null, updated_at = now()
   where id = v_draft.id;

  update public.workout_replace_requests
     set status = 'success', result_program_id = v_new_program_id, error_message = null, updated_at = now()
   where user_id = v_user and idempotency_key = v_key;

  return jsonb_build_object(
    'success', true,
    'programId', v_new_program_id,
    'version', v_next_version,
    'draftId', v_draft.id
  );
exception
  when others then
    update public.workout_drafts
       set status = 'ERROR', error_message = left(sqlerrm, 1000), updated_at = now()
     where id = p_draft_id
       and user_id = v_user;

    update public.workout_replace_requests
       set status = 'failed', error_message = left(sqlerrm, 1000), updated_at = now()
     where user_id = v_user and idempotency_key = v_key;

    return jsonb_build_object('success', false, 'error', left(sqlerrm, 1000));
end;
$$;

create or replace function public.get_active_workout_program()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_program public.user_workout_programs%rowtype;
begin
  if v_user is null then
    return jsonb_build_object('success', false, 'error', 'Usuário não autenticado.');
  end if;

  select *
    into v_program
    from public.user_workout_programs
    where user_id = v_user
      and status = 'active'
    order by created_at desc
    limit 1;

  if v_program.id is null then
    return jsonb_build_object('success', false, 'error', 'Nenhum treino ativo encontrado.');
  end if;

  return jsonb_build_object(
    'success', true,
    'programId', v_program.id,
    'version', v_program.version,
    'split', v_program.split,
    'workouts', v_program.workouts,
    'updatedAt', v_program.updated_at
  );
end;
$$;

alter table public.workout_templates enable row level security;
alter table public.workout_drafts enable row level security;
alter table public.user_workout_programs enable row level security;
alter table public.workout_replace_requests enable row level security;
alter table public.user_app_snapshots enable row level security;

drop policy if exists "templates readable by visibility" on public.workout_templates;
drop policy if exists "users manage own templates" on public.workout_templates;
drop policy if exists "users read own drafts" on public.workout_drafts;
drop policy if exists "users create own drafts" on public.workout_drafts;
drop policy if exists "users update own drafts" on public.workout_drafts;
drop policy if exists "users delete own drafts" on public.workout_drafts;
drop policy if exists "users read own programs" on public.user_workout_programs;
drop policy if exists "users read own replace requests" on public.workout_replace_requests;
drop policy if exists "users read own app snapshot" on public.user_app_snapshots;
drop policy if exists "users upsert own app snapshot" on public.user_app_snapshots;

create policy "templates readable by visibility"
  on public.workout_templates for select
  to authenticated
  using (visibility = 'PUBLIC' or owner_id = auth.uid());

create policy "users manage own templates"
  on public.workout_templates for all
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "users read own drafts"
  on public.workout_drafts for select
  to authenticated
  using (user_id = auth.uid());

create policy "users create own drafts"
  on public.workout_drafts for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "users update own drafts"
  on public.workout_drafts for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users delete own drafts"
  on public.workout_drafts for delete
  to authenticated
  using (user_id = auth.uid());

create policy "users read own programs"
  on public.user_workout_programs for select
  to authenticated
  using (user_id = auth.uid());

create policy "users read own replace requests"
  on public.workout_replace_requests for select
  to authenticated
  using (user_id = auth.uid());

create policy "users read own app snapshot"
  on public.user_app_snapshots for select
  to authenticated
  using (user_id = auth.uid());

create policy "users upsert own app snapshot"
  on public.user_app_snapshots for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant execute on function public.save_workout_draft(text, jsonb, text, uuid) to authenticated;
grant execute on function public.replace_current_workout(uuid, text, int) to authenticated;
grant execute on function public.get_active_workout_program() to authenticated;

-- =====================================================
-- 4) AI playbook knowledge base
-- =====================================================
create table if not exists public.ai_knowledge_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  rule_key text,
  feature text not null default 'all' check (feature in (
    'all',
    'chat',
    'dashboard_insight',
    'workout_tip',
    'meal_calc',
    'workout_builder',
    'weekly_report',
    'post_workout_feedback',
    'meal_photo',
    'plan_reeval'
  )),
  title text not null,
  rule_condition jsonb not null default '{}'::jsonb check (jsonb_typeof(rule_condition) = 'object'),
  recommendation text not null check (char_length(trim(recommendation)) >= 8),
  evidence_ref text,
  source_type text check (source_type is null or source_type in ('guideline', 'meta_analysis', 'systematic_review', 'rct', 'cohort', 'expert_consensus', 'internal_protocol', 'position_stand', 'position_statement', 'systematic_review_meta_analysis', 'meta_regression', 'umbrella_review')),
  source_title text,
  source_authors text,
  source_journal text,
  source_year int check (source_year is null or (source_year >= 1900 and source_year <= 2100)),
  source_url text,
  source_doi text,
  source_quality text check (source_quality is null or source_quality in ('high', 'moderate', 'low', 'very_low')),
  source_notes text,
  review_status text not null default 'pending_human_review' check (review_status in ('pending_human_review', 'approved', 'rejected')),
  priority int not null default 100 check (priority between 1 and 1000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_knowledge_rules
  add column if not exists rule_key text,
  add column if not exists source_type text check (source_type is null or source_type in ('guideline', 'meta_analysis', 'systematic_review', 'rct', 'cohort', 'expert_consensus', 'internal_protocol', 'position_stand', 'position_statement', 'systematic_review_meta_analysis', 'meta_regression', 'umbrella_review')),
  add column if not exists source_title text,
  add column if not exists source_authors text,
  add column if not exists source_journal text,
  add column if not exists source_year int check (source_year is null or (source_year >= 1900 and source_year <= 2100)),
  add column if not exists source_url text,
  add column if not exists source_doi text,
  add column if not exists source_quality text check (source_quality is null or source_quality in ('high', 'moderate', 'low', 'very_low')),
  add column if not exists source_notes text,
  add column if not exists review_status text not null default 'pending_human_review';

do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.ai_knowledge_rules'::regclass
      and contype = 'c'
      and conname like 'ai_knowledge_rules_source_type%'
  loop
    execute format('alter table public.ai_knowledge_rules drop constraint %I', v_constraint.conname);
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_knowledge_rules_source_type_chk'
      and conrelid = 'public.ai_knowledge_rules'::regclass
  ) then
    alter table public.ai_knowledge_rules
      add constraint ai_knowledge_rules_source_type_chk
      check (source_type is null or source_type in ('guideline', 'meta_analysis', 'systematic_review', 'rct', 'cohort', 'expert_consensus', 'internal_protocol', 'position_stand', 'position_statement', 'systematic_review_meta_analysis', 'meta_regression', 'umbrella_review'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_knowledge_rules_review_status_chk'
      and conrelid = 'public.ai_knowledge_rules'::regclass
  ) then
    alter table public.ai_knowledge_rules
      add constraint ai_knowledge_rules_review_status_chk
      check (review_status in ('pending_human_review', 'approved', 'rejected'));
  end if;
end $$;

create unique index if not exists ai_knowledge_rules_rule_key_uq
  on public.ai_knowledge_rules (rule_key)
  where rule_key is not null;

create index if not exists ai_knowledge_rules_feature_priority_idx
  on public.ai_knowledge_rules (feature, is_active, priority, updated_at desc);

create index if not exists ai_knowledge_rules_owner_feature_idx
  on public.ai_knowledge_rules (owner_id, feature, updated_at desc);

create index if not exists ai_knowledge_rules_condition_gin_idx
  on public.ai_knowledge_rules using gin (rule_condition);

alter table public.ai_knowledge_rules enable row level security;

drop policy if exists "users read own and global active ai rules" on public.ai_knowledge_rules;
drop policy if exists "users insert own ai rules" on public.ai_knowledge_rules;
drop policy if exists "users update own ai rules" on public.ai_knowledge_rules;
drop policy if exists "users delete own ai rules" on public.ai_knowledge_rules;

create policy "users read own and global active ai rules"
  on public.ai_knowledge_rules for select
  to authenticated
  using (
    owner_id = auth.uid()
    or (owner_id is null and is_active = true)
  );

create policy "users insert own ai rules"
  on public.ai_knowledge_rules for insert
  to authenticated
  with check (owner_id = auth.uid());

create policy "users update own ai rules"
  on public.ai_knowledge_rules for update
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "users delete own ai rules"
  on public.ai_knowledge_rules for delete
  to authenticated
  using (owner_id = auth.uid());

drop trigger if exists ai_knowledge_rules_touch_updated_at on public.ai_knowledge_rules;
create trigger ai_knowledge_rules_touch_updated_at
  before update on public.ai_knowledge_rules
  for each row execute function public.workout_touch_updated_at();

grant select, insert, update, delete on public.ai_knowledge_rules to authenticated;

-- =====================================================
-- 5) Billing + Entitlements (server authoritative)
-- =====================================================
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.user_ai_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'ultimate')),
  status text not null default 'inactive' check (status in ('inactive', 'active', 'canceled', 'past_due')),
  billing_cycle text not null default 'manual' check (billing_cycle in ('manual', 'monthly', 'annual')),
  provider text not null default 'manual' check (provider in ('manual', 'mercadopago', 'stripe')),
  source text not null default 'manual_grant' check (source in ('manual_grant', 'checkout', 'webhook')),
  provider_customer_id text,
  provider_subscription_id text,
  provider_payment_id text,
  started_at timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('mercadopago', 'stripe')),
  plan text not null check (plan in ('ultimate')),
  billing_cycle text not null check (billing_cycle in ('monthly', 'annual')),
  amount_cents int not null check (amount_cents > 0),
  currency text not null default 'BRL',
  status text not null default 'created' check (status in ('created', 'pending', 'approved', 'rejected', 'canceled', 'expired')),
  checkout_url text,
  provider_reference text,
  provider_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_ai_free_trials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  trial_session_id text not null,
  trial_call_count int not null default 0,
  trial_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_ai_subscriptions_user_status_idx
  on public.user_ai_subscriptions (user_id, status, current_period_end desc, updated_at desc);

create index if not exists billing_checkout_sessions_user_created_idx
  on public.billing_checkout_sessions (user_id, created_at desc);

create index if not exists user_ai_free_trials_expires_idx
  on public.user_ai_free_trials (trial_expires_at);

drop trigger if exists user_ai_subscriptions_touch_updated_at on public.user_ai_subscriptions;
create trigger user_ai_subscriptions_touch_updated_at
  before update on public.user_ai_subscriptions
  for each row execute function public.workout_touch_updated_at();

drop trigger if exists billing_checkout_sessions_touch_updated_at on public.billing_checkout_sessions;
create trigger billing_checkout_sessions_touch_updated_at
  before update on public.billing_checkout_sessions
  for each row execute function public.workout_touch_updated_at();

drop trigger if exists user_ai_free_trials_touch_updated_at on public.user_ai_free_trials;
create trigger user_ai_free_trials_touch_updated_at
  before update on public.user_ai_free_trials
  for each row execute function public.workout_touch_updated_at();

alter table public.app_admins enable row level security;
alter table public.user_ai_subscriptions enable row level security;
alter table public.billing_checkout_sessions enable row level security;
alter table public.user_ai_free_trials enable row level security;

drop policy if exists "admins read own membership" on public.app_admins;
drop policy if exists "users read own subscriptions" on public.user_ai_subscriptions;
drop policy if exists "users read own checkout sessions" on public.billing_checkout_sessions;
drop policy if exists "users read own free ai trial" on public.user_ai_free_trials;

create policy "admins read own membership"
  on public.app_admins for select
  to authenticated
  using (user_id = auth.uid());

create policy "users read own subscriptions"
  on public.user_ai_subscriptions for select
  to authenticated
  using (user_id = auth.uid());

create policy "users read own checkout sessions"
  on public.billing_checkout_sessions for select
  to authenticated
  using (user_id = auth.uid());

create policy "users read own free ai trial"
  on public.user_ai_free_trials for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.get_my_ai_plan()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row public.user_ai_subscriptions%rowtype;
begin
  if v_user is null then
    return jsonb_build_object(
      'plan', 'free',
      'status', 'inactive',
      'billingCycle', 'manual',
      'provider', 'manual',
      'source', 'manual_grant'
    );
  end if;

  select *
    into v_row
    from public.user_ai_subscriptions
    where user_id = v_user
      and status = 'active'
      and (current_period_end is null or current_period_end > now())
    order by current_period_end desc nulls last, updated_at desc
    limit 1;

  if v_row.id is null then
    return jsonb_build_object(
      'plan', 'free',
      'status', 'inactive',
      'billingCycle', 'manual',
      'provider', 'manual',
      'source', 'manual_grant'
    );
  end if;

  return jsonb_build_object(
    'plan', v_row.plan,
    'status', v_row.status,
    'billingCycle', v_row.billing_cycle,
    'provider', v_row.provider,
    'source', v_row.source,
    'currentPeriodEnd', v_row.current_period_end,
    'cancelAtPeriodEnd', v_row.cancel_at_period_end
  );
end;
$$;

create or replace function public.set_user_ai_plan_manual(
  p_target_user uuid,
  p_plan text default 'ultimate',
  p_days int default 30,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_is_admin boolean := false;
  v_end timestamptz;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Usuário não autenticado.');
  end if;

  select exists (
    select 1 from public.app_admins where user_id = v_actor
  ) into v_is_admin;

  if not v_is_admin then
    return jsonb_build_object('success', false, 'error', 'Permissão negada.');
  end if;

  if p_target_user is null then
    return jsonb_build_object('success', false, 'error', 'Usuário alvo não informado.');
  end if;

  if p_plan not in ('free', 'ultimate') then
    return jsonb_build_object('success', false, 'error', 'Plano inválido.');
  end if;

  if p_plan = 'ultimate' and coalesce(p_days, 0) > 0 then
    v_end := now() + make_interval(days => p_days);
  else
    v_end := null;
  end if;

  insert into public.user_ai_subscriptions (
    user_id,
    plan,
    status,
    billing_cycle,
    provider,
    source,
    started_at,
    current_period_end,
    note
  ) values (
    p_target_user,
    p_plan,
    case when p_plan = 'ultimate' then 'active' else 'inactive' end,
    'manual',
    'manual',
    'manual_grant',
    now(),
    v_end,
    p_note
  );

  return jsonb_build_object(
    'success', true,
    'userId', p_target_user,
    'plan', p_plan,
    'currentPeriodEnd', v_end
  );
end;
$$;

grant select on public.app_admins to authenticated;
grant select on public.user_ai_subscriptions to authenticated;
grant select on public.billing_checkout_sessions to authenticated;
grant select on public.user_ai_free_trials to authenticated;
grant execute on function public.get_my_ai_plan() to authenticated;
grant execute on function public.set_user_ai_plan_manual(uuid, text, int, text) to authenticated;

notify pgrst, 'reload schema';
