-- =====================================================================
--  接龙之树 · Supabase 数据库结构与全部规则
--  用法：Supabase 控制台 → SQL Editor → 粘贴整个文件 → Run
--  可以重复运行（升级时再跑一遍即可），不会清空已有数据。
--
--  设计：三张表全部开启 RLS 且不给任何策略，网页端无法直接读写表；
--  所有操作都通过下面的 relay_* 函数完成，规则在数据库内强制执行，
--  因此公开的 anon / publishable key 放在网页里是安全的。
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------- 表 ----------------
create table if not exists public.relay_users (
  name          text primary key,
  pw_hash       text not null,
  is_admin      boolean not null default false,
  verified      boolean not null default false,
  created_at    timestamptz not null default now(),
  failed_logins int not null default 0,
  locked_until  timestamptz
);
create unique index if not exists relay_users_lower_name on public.relay_users (lower(name));

create table if not exists public.relay_sessions (
  token_hash text primary key,
  name       text not null references public.relay_users(name) on delete cascade on update cascade,
  expires_at timestamptz not null
);
create index if not exists relay_sessions_name on public.relay_sessions (name);

-- 节点编号：根为 1，节点 i 的子节点为 2i 和 2i+1；不存在的行即“灰色”
create table if not exists public.relay_nodes (
  id          bigint primary key check (id >= 1 and id < 1073741824),
  state       text not null check (state in ('white', 'yellow', 'green', 'red')),
  owner       text references public.relay_users(name) on update cascade,
  title       text not null default '',
  content     text not null default '',
  claimed_at  timestamptz,
  updated_at  timestamptz,
  finished_at timestamptz
);
insert into public.relay_nodes (id, state) values (1, 'white') on conflict do nothing;

alter table public.relay_users    enable row level security;
alter table public.relay_sessions enable row level security;
alter table public.relay_nodes    enable row level security;

-- ---------------- 内部工具函数 ----------------
create or replace function public._relay_ms(t timestamptz) returns bigint
language sql immutable as $$ select (extract(epoch from t) * 1000)::bigint $$;

create or replace function public._relay_hash(p_token text) returns text
language sql immutable set search_path = public, extensions as $$
  select encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

create or replace function public._relay_user_json(u public.relay_users) returns json
language sql immutable as $$
  select case when u.name is null then null
    else json_build_object('name', u.name, 'admin', u.is_admin, 'verified', u.verified) end
$$;

create or replace function public._relay_me(p_token text) returns public.relay_users
language sql stable security definer set search_path = public, extensions as $$
  select u.* from relay_sessions s join relay_users u on u.name = s.name
  where s.token_hash = _relay_hash(p_token) and s.expires_at > now()
$$;

create or replace function public._relay_require(p_token text) returns public.relay_users
language plpgsql stable security definer set search_path = public, extensions as $$
declare u relay_users;
begin
  u := _relay_me(p_token);
  if u.name is null then raise exception '请先登录（登录可能已过期）'; end if;
  return u;
end $$;

create or replace function public._relay_new_session(p_name text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_token text := encode(gen_random_bytes(24), 'hex');
  u relay_users;
begin
  delete from relay_sessions where expires_at < now();
  insert into relay_sessions (token_hash, name, expires_at) values (_relay_hash(v_token), p_name, now() + interval '30 days');
  select * into u from relay_users where name = p_name;
  return json_build_object('token', v_token, 'user', _relay_user_json(u));
end $$;

create or replace function public._relay_check_password(p text) returns void
language plpgsql immutable as $$
begin
  if char_length(coalesce(p, '')) < 6 then raise exception '密码至少 6 位'; end if;
  if octet_length(p) > 72 then raise exception '密码过长'; end if;
end $$;

-- ---------------- 账号 ----------------
create or replace function public.relay_register(p_username text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_name text := btrim(coalesce(p_username, ''));
begin
  if char_length(v_name) not between 2 and 20
     or v_name !~ '^[^[:space:][:cntrl:]<>&"''/\\@#?%]+$' then
    raise exception '用户名需为 2–20 个字符，不能包含空格和特殊符号';
  end if;
  perform _relay_check_password(p_password);
  if exists (select 1 from relay_users where lower(name) = lower(v_name)) then
    raise exception '用户名已被占用';
  end if;
  insert into relay_users (name, pw_hash) values (v_name, crypt(p_password, gen_salt('bf', 8)));
  return _relay_new_session(v_name);
end $$;

-- 登录失败不抛异常（否则失败计数会随事务回滚），而是返回 {"error": ...}
create or replace function public.relay_login(p_username text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare u relay_users;
begin
  select * into u from relay_users where name = btrim(coalesce(p_username, ''));
  if u.name is null then return json_build_object('error', '用户名或密码错误'); end if;
  if u.locked_until > now() then return json_build_object('error', '尝试次数过多，请 10 分钟后再试'); end if;
  if u.pw_hash <> crypt(coalesce(p_password, ''), u.pw_hash) then
    update relay_users set
      failed_logins = case when failed_logins >= 9 then 0 else failed_logins + 1 end,
      locked_until  = case when failed_logins >= 9 then now() + interval '10 minutes' else locked_until end
    where name = u.name;
    return json_build_object('error', '用户名或密码错误');
  end if;
  update relay_users set failed_logins = 0, locked_until = null where name = u.name;
  return _relay_new_session(u.name);
end $$;

create or replace function public.relay_logout(p_token text) returns json
language sql security definer set search_path = public, extensions as $$
  delete from relay_sessions where token_hash = _relay_hash(p_token);
  select json_build_object('ok', true);
$$;

create or replace function public.relay_me(p_token text) returns json
language sql stable security definer set search_path = public, extensions as $$
  select _relay_user_json(_relay_me(p_token))
$$;

create or replace function public.relay_change_password(p_token text, p_old text, p_new text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare u relay_users := _relay_require(p_token);
begin
  if u.pw_hash <> crypt(coalesce(p_old, ''), u.pw_hash) then raise exception '原密码错误'; end if;
  perform _relay_check_password(p_new);
  update relay_users set pw_hash = crypt(p_new, gen_salt('bf', 8)) where name = u.name;
  delete from relay_sessions where name = u.name and token_hash <> _relay_hash(p_token);
  return json_build_object('ok', true);
end $$;

-- ---------------- 读取（游客可用） ----------------
create or replace function public.relay_get_tree() returns json
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(json_object_agg(id::text, json_build_object('state', state, 'owner', owner, 'title', title)), '{}'::json)
  from relay_nodes
$$;

create or replace function public.relay_get_node(p_id bigint) returns json
language plpgsql stable security definer set search_path = public, extensions as $$
declare n relay_nodes;
begin
  select * into n from relay_nodes where id = p_id;
  if n.id is null then raise exception '该节点尚未开放'; end if;
  return json_build_object(
    'id', n.id, 'state', n.state, 'owner', n.owner, 'title', n.title, 'content', n.content,
    'claimedAt', _relay_ms(n.claimed_at), 'updatedAt', _relay_ms(n.updated_at), 'finishedAt', _relay_ms(n.finished_at),
    'parent', (select json_build_object('id', p.id, 'state', p.state, 'title', p.title) from relay_nodes p where p.id = p_id / 2 and p_id > 1),
    'children', (select json_agg(json_build_object('id', c, 'state', coalesce(x.state, 'gray'), 'title', coalesce(x.title, ''), 'owner', x.owner) order by c)
                 from unnest(array[2 * p_id, 2 * p_id + 1]) c left join relay_nodes x on x.id = c)
  );
end $$;

-- 从根到某节点的整条链
create or replace function public.relay_get_chain(p_id bigint) returns json
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from relay_nodes where id = p_id) then raise exception '该节点尚未开放'; end if;
  return (select json_agg(json_build_object('id', id, 'state', state, 'owner', owner, 'title', title, 'content', content) order by id)
          from relay_nodes where id in (select p_id >> k from generate_series(0, 30) k where (p_id >> k) >= 1));
end $$;

-- ---------------- 写作 ----------------
create or replace function public.relay_claim_node(p_token text, p_id bigint) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare u relay_users := _relay_require(p_token);
begin
  if not u.verified then raise exception '账号尚未被管理员认证'; end if;
  update relay_nodes set state = 'yellow', owner = u.name, claimed_at = now(), updated_at = now()
  where id = p_id and state = 'white';
  if not found then raise exception '该节点当前不可认领'; end if;
  return json_build_object('ok', true);
end $$;

-- 取得一个“写作中”的节点并加锁；p_allow_admin 为真时管理员也可操作
create or replace function public._relay_lock_yellow(u public.relay_users, p_id bigint, p_allow_admin boolean) returns public.relay_nodes
language plpgsql security definer set search_path = public, extensions as $$
declare n relay_nodes;
begin
  select * into n from relay_nodes where id = p_id for update;
  if n.id is null or n.state <> 'yellow' then raise exception '该节点已锁定，不能再修改'; end if;
  if n.owner is distinct from u.name and not (p_allow_admin and u.is_admin) then
    raise exception '只有认领者可以操作此节点';
  end if;
  return n;
end $$;

create or replace function public.relay_save_node(p_token text, p_id bigint, p_title text default null, p_content text default null) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  u relay_users := _relay_require(p_token);
  n relay_nodes := _relay_lock_yellow(u, p_id, false);
begin
  if char_length(coalesce(p_content, '')) > 200000 then raise exception '正文超过 200000 字符上限'; end if;
  update relay_nodes set title = left(coalesce(p_title, n.title), 60), content = coalesce(p_content, n.content), updated_at = now()
  where id = p_id;
  return json_build_object('ok', true, 'updatedAt', _relay_ms(now()));
end $$;

-- p_result: 'green' 完成并开放两个子节点；'red' 终止并删除整个子树
create or replace function public.relay_finish_node(p_token text, p_id bigint, p_result text, p_title text default null, p_content text default null) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  u relay_users := _relay_require(p_token);
  n relay_nodes := _relay_lock_yellow(u, p_id, false);
begin
  if p_result not in ('green', 'red') then raise exception 'p_result 必须是 green 或 red'; end if;
  if char_length(coalesce(p_content, '')) > 200000 then raise exception '正文超过 200000 字符上限'; end if;
  update relay_nodes set state = p_result, title = left(coalesce(p_title, n.title), 60), content = coalesce(p_content, n.content),
    updated_at = now(), finished_at = now()
  where id = p_id;
  if p_result = 'green' then
    insert into relay_nodes (id, state)
      select c, 'white' from unnest(array[2 * p_id, 2 * p_id + 1]) c where c < 1073741824
    on conflict (id) do nothing;
  else
    with recursive d(id) as (
      select x.id from relay_nodes x where x.id in (2 * p_id, 2 * p_id + 1)
      union all
      select x.id from relay_nodes x join d on x.id in (2 * d.id, 2 * d.id + 1)
    )
    delete from relay_nodes where id in (select id from d);
  end if;
  return json_build_object('ok', true);
end $$;

-- 认领者放弃认领，或管理员强制释放：节点回到白色，内容清空
create or replace function public.relay_release_node(p_token text, p_id bigint) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  u relay_users := _relay_require(p_token);
  n relay_nodes := _relay_lock_yellow(u, p_id, true);
begin
  update relay_nodes set state = 'white', owner = null, title = '', content = '',
    claimed_at = null, updated_at = null, finished_at = null
  where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ---------------- 管理员 ----------------
create or replace function public._relay_require_admin(p_token text) returns public.relay_users
language plpgsql stable security definer set search_path = public, extensions as $$
declare u relay_users := _relay_require(p_token);
begin
  if not u.is_admin then raise exception '需要管理员权限'; end if;
  return u;
end $$;

create or replace function public.relay_admin_list_users(p_token text) returns json
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform _relay_require_admin(p_token);
  return (select coalesce(json_agg(json_build_object(
      'name', u.name, 'admin', u.is_admin, 'verified', u.verified, 'createdAt', _relay_ms(u.created_at),
      'claims', (select count(*) from relay_nodes n where n.owner = u.name))), '[]'::json)
    from relay_users u);
end $$;

create or replace function public.relay_admin_update_user(p_token text, p_name text, p_verified boolean default null, p_password text default null) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare t relay_users;
begin
  perform _relay_require_admin(p_token);
  select * into t from relay_users where name = p_name;
  if t.name is null then raise exception '用户不存在'; end if;
  if t.is_admin then raise exception '不能修改管理员'; end if;
  if p_verified is not null then update relay_users set verified = p_verified where name = p_name; end if;
  if p_password is not null then
    perform _relay_check_password(p_password);
    update relay_users set pw_hash = crypt(p_password, gen_salt('bf', 8)), failed_logins = 0, locked_until = null where name = p_name;
    delete from relay_sessions where name = p_name;
  end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.relay_admin_export(p_token text) returns json
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform _relay_require_admin(p_token);
  return json_build_object('exportedAt', now(), 'nodes',
    (select coalesce(json_object_agg(id::text, json_build_object(
        'state', state, 'owner', owner, 'title', title, 'content', content,
        'claimedAt', claimed_at, 'updatedAt', updated_at, 'finishedAt', finished_at) order by id), '{}'::json)
     from relay_nodes));
end $$;

-- 只能在 SQL Editor 里运行（网页端无权调用）：
--   select relay_bootstrap_admin('admin', '你的密码');
-- 用户已存在时会把它提升为管理员并重设密码。
create or replace function public.relay_bootstrap_admin(p_name text, p_password text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _relay_check_password(p_password);
  insert into relay_users (name, pw_hash, is_admin, verified)
    values (btrim(p_name), crypt(p_password, gen_salt('bf', 8)), true, true)
  on conflict (name) do update set pw_hash = excluded.pw_hash, is_admin = true, verified = true, failed_logins = 0, locked_until = null;
  return '管理员 ' || btrim(p_name) || ' 已就绪';
end $$;

-- ---------------- 权限 ----------------
-- 网页端角色（anon / authenticated）对表没有任何直接权限
revoke all on table public.relay_users, public.relay_sessions, public.relay_nodes from public, anon, authenticated;

-- 内部函数与管理员初始化函数：网页端不可调用
revoke all on function
  public._relay_ms(timestamptz), public._relay_hash(text), public._relay_user_json(public.relay_users),
  public._relay_me(text), public._relay_require(text), public._relay_new_session(text),
  public._relay_check_password(text), public._relay_lock_yellow(public.relay_users, bigint, boolean),
  public._relay_require_admin(text), public.relay_bootstrap_admin(text, text)
from public, anon, authenticated;

-- 对外接口
revoke all on function
  public.relay_register(text, text), public.relay_login(text, text), public.relay_logout(text),
  public.relay_me(text), public.relay_change_password(text, text, text),
  public.relay_get_tree(), public.relay_get_node(bigint), public.relay_get_chain(bigint),
  public.relay_claim_node(text, bigint), public.relay_save_node(text, bigint, text, text),
  public.relay_finish_node(text, bigint, text, text, text), public.relay_release_node(text, bigint),
  public.relay_admin_list_users(text), public.relay_admin_update_user(text, text, boolean, text),
  public.relay_admin_export(text)
from public;
grant execute on function
  public.relay_register(text, text), public.relay_login(text, text), public.relay_logout(text),
  public.relay_me(text), public.relay_change_password(text, text, text),
  public.relay_get_tree(), public.relay_get_node(bigint), public.relay_get_chain(bigint),
  public.relay_claim_node(text, bigint), public.relay_save_node(text, bigint, text, text),
  public.relay_finish_node(text, bigint, text, text, text), public.relay_release_node(text, bigint),
  public.relay_admin_list_users(text), public.relay_admin_update_user(text, text, boolean, text),
  public.relay_admin_export(text)
to anon, authenticated;

-- 让 API 立即识别新函数
notify pgrst, 'reload schema';
