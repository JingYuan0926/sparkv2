-- Spark cloud schema for Supabase (Postgres).
-- Run ONCE in your Supabase project: SQL Editor → paste → Run.
-- Creates the central tables + token-gated access functions. Tables are locked by RLS;
-- the only way in is via these SECURITY DEFINER functions, which check the room token.
-- The "token" is just the room code (join-by-code) — knowing the code = access to that room.

create table if not exists spark_rooms (
  room_id    text primary key,
  token      text not null,
  created_at timestamptz not null default now()
);

create table if not exists spark_solutions (
  id         bigint generated always as identity primary key,
  room_id    text not null,
  problem    text not null,
  solution   text not null,
  context    text,
  tags       text not null default '',
  status     text not null default 'unverified',
  helped     int  not null default 0,
  author     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists spark_solutions_room on spark_solutions(room_id, updated_at desc);

create table if not exists spark_context (
  room_id    text not null,
  section    text not null,
  content    text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (room_id, section)
);

-- Lock the tables: RLS on, no policies → no direct table access for the public key.
alter table spark_rooms     enable row level security;
alter table spark_solutions enable row level security;
alter table spark_context   enable row level security;

-- ---- token-gated access functions (the only interface) ----

create or replace function spark_auth(p_room text, p_token text) returns boolean
language sql security definer set search_path = public as $$
  select exists(select 1 from spark_rooms where room_id = p_room and token = p_token);
$$;

-- First call for a room creates it (sets its token); later calls validate.
create or replace function spark_join(p_room text, p_token text) returns boolean
language plpgsql security definer set search_path = public as $$
declare existing text;
begin
  select token into existing from spark_rooms where room_id = p_room;
  if existing is null then
    insert into spark_rooms(room_id, token) values (p_room, p_token);
    return true;
  end if;
  return existing = p_token;
end; $$;

create or replace function spark_cards(p_room text, p_token text) returns setof spark_solutions
language plpgsql security definer set search_path = public as $$
begin
  if not spark_auth(p_room, p_token) then raise exception 'invalid room token'; end if;
  return query select * from spark_solutions where room_id = p_room order by updated_at desc;
end; $$;

create or replace function spark_record(p_room text, p_token text, p_problem text, p_solution text, p_context text, p_tags text, p_author text)
returns spark_solutions language plpgsql security definer set search_path = public as $$
declare r spark_solutions;
begin
  if not spark_auth(p_room, p_token) then raise exception 'invalid room token'; end if;
  insert into spark_solutions(room_id, problem, solution, context, tags, author)
  values (p_room, p_problem, p_solution, nullif(p_context, ''), coalesce(p_tags, ''), p_author)
  returning * into r;
  return r;
end; $$;

create or replace function spark_confirm(p_room text, p_token text, p_id bigint)
returns spark_solutions language plpgsql security definer set search_path = public as $$
declare r spark_solutions;
begin
  if not spark_auth(p_room, p_token) then raise exception 'invalid room token'; end if;
  update spark_solutions set status='verified', helped=helped+1, updated_at=now()
  where room_id=p_room and id=p_id returning * into r;
  return r;
end; $$;

create or replace function spark_update(p_room text, p_token text, p_id bigint, p_problem text, p_solution text, p_context text, p_tags text)
returns spark_solutions language plpgsql security definer set search_path = public as $$
declare r spark_solutions;
begin
  if not spark_auth(p_room, p_token) then raise exception 'invalid room token'; end if;
  update spark_solutions set
    problem  = coalesce(nullif(p_problem, ''), problem),
    solution = coalesce(nullif(p_solution, ''), solution),
    context  = case when p_context is null then context else nullif(p_context, '') end,
    tags     = coalesce(p_tags, tags),
    updated_at = now()
  where room_id=p_room and id=p_id returning * into r;
  return r;
end; $$;

create or replace function spark_delete(p_room text, p_token text, p_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not spark_auth(p_room, p_token) then raise exception 'invalid room token'; end if;
  delete from spark_solutions where room_id=p_room and id=p_id;
  get diagnostics n = row_count;
  return n > 0;
end; $$;

create or replace function spark_get_context(p_room text, p_token text) returns setof spark_context
language plpgsql security definer set search_path = public as $$
begin
  if not spark_auth(p_room, p_token) then raise exception 'invalid room token'; end if;
  return query select * from spark_context where room_id = p_room;
end; $$;

create or replace function spark_set_context(p_room text, p_token text, p_section text, p_content text, p_by text)
returns spark_context language plpgsql security definer set search_path = public as $$
declare r spark_context;
begin
  if not spark_auth(p_room, p_token) then raise exception 'invalid room token'; end if;
  insert into spark_context(room_id, section, content, updated_at, updated_by)
  values (p_room, p_section, p_content, now(), p_by)
  on conflict (room_id, section) do update
    set content = excluded.content, updated_at = now(), updated_by = excluded.updated_by
  returning * into r;
  return r;
end; $$;

-- Let the public (anon) key CALL these functions, but nothing else.
grant execute on all functions in schema public to anon, authenticated;
