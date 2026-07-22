-- EXAMPLE ONLY. Copy this file outside the repository, fill every NULL, run once, then destroy the filled copy.
-- Preconditions:
--   1. Migrations are applied to a new empty project.
--   2. The Auth user exists.
--   3. The first device has signed in once and is pending.
--   4. TOTP MFA will be enrolled immediately after this bootstrap approves the first device.
begin;

do $bootstrap$
declare
  v_admin_user_id uuid := null;
  v_first_device_id uuid := null;
  v_username text := null;
  v_display_name text := null;
  v_branch_code text := null;
  v_branch_name text := null;
  v_branch_phone_e164 text := '';
  v_branch_id uuid;
  v_updated_count integer;
begin
  if v_admin_user_id is null
     or v_first_device_id is null
     or nullif(btrim(v_username), '') is null
     or nullif(btrim(v_display_name), '') is null
     or nullif(btrim(v_branch_code), '') is null
     or nullif(btrim(v_branch_name), '') is null then
    raise exception 'Bootstrap variables must be filled before execution';
  end if;

  if not exists (select 1 from auth.users where id = v_admin_user_id) then
    raise exception 'Auth user does not exist';
  end if;

  update app.profiles
  set username = v_username,
      display_name = v_display_name,
      is_system_admin = true,
      active = true
  where user_id = v_admin_user_id;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'Profile does not exist';
  end if;

  insert into app.branches (code, name, phone_e164)
  values (upper(v_branch_code), v_branch_name, coalesce(v_branch_phone_e164, ''))
  returning id into v_branch_id;

  update app.devices
  set state = 'approved',
      approved_at = now(),
      approved_by = v_admin_user_id,
      revoked_at = null,
      revoked_by = null
  where id = v_first_device_id
    and owner_user_id = v_admin_user_id
    and state = 'pending';
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'Pending first device does not exist for the administrator';
  end if;

  insert into app.audit_events (
    event_type, branch_id, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    'system.bootstrap', v_branch_id, v_admin_user_id, v_first_device_id,
    'installation', v_first_device_id::text,
    jsonb_build_object('branchId', v_branch_id, 'bootstrap', true)
  );
end;
$bootstrap$;

commit;
