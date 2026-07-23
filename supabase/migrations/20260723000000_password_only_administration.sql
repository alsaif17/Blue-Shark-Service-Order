create or replace function app.current_is_system_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.request_is_approved() and exists (
    select 1 from app.profiles
    where user_id = (select auth.uid()) and active and is_system_admin
  );
$$;

create or replace function app.can_access_branch(p_branch_id uuid, p_supervisor_required boolean default false)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.request_is_approved() and (
    exists (
      select 1 from app.profiles
      where user_id = (select auth.uid()) and active and is_system_admin
    )
    or exists (
      select 1 from app.user_branch_memberships m
      join app.branches b on b.id = m.branch_id
      where m.user_id = (select auth.uid())
        and m.branch_id = p_branch_id
        and m.active
        and b.active
        and (not p_supervisor_required or m.role = 'supervisor')
    )
  );
$$;

create or replace function app.current_is_release_publisher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.request_is_approved() and exists (
    select 1 from app.release_publishers
    where user_id = (select auth.uid()) and active
  );
$$;

revoke execute on function app.current_is_system_admin() from public, anon;
revoke execute on function app.can_access_branch(uuid, boolean) from public, anon;
revoke execute on function app.current_is_release_publisher() from public, anon;

grant execute on function app.current_is_system_admin() to authenticated;
grant execute on function app.can_access_branch(uuid, boolean) to authenticated;
grant execute on function app.current_is_release_publisher() to authenticated;
