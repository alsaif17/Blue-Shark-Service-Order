begin;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
create schema if not exists api;

revoke all on schema app from public, anon, authenticated;
revoke all on schema api from public, anon;
grant usage on schema app, api to authenticated;

alter default privileges for role postgres in schema app revoke execute on functions from public;
alter default privileges for role postgres in schema api revoke execute on functions from public;
alter default privileges for role postgres in schema api revoke execute on functions from anon;

create type app.membership_role as enum ('supervisor', 'employee');
create type app.device_state as enum ('pending', 'approved', 'revoked');
create type app.order_status as enum ('finalized', 'cancelled');
create type app.document_status as enum ('pending_upload', 'ready', 'failed');
create type app.action_channel as enum ('print', 'whatsapp');
create type app.action_status as enum ('queued', 'in_progress', 'succeeded', 'failed_before_effect', 'uncertain');

create table app.profiles (
  user_id uuid primary key references auth.users(id) on delete restrict,
  username text not null,
  display_name text not null,
  is_system_admin boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_not_blank check (btrim(username) <> ''),
  constraint profiles_display_name_not_blank check (btrim(display_name) <> '')
);

create unique index profiles_username_lower_uidx on app.profiles (lower(username));
create index profiles_active_user_idx on app.profiles (user_id) where active;

create table app.branches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  phone_e164 text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint branches_code_format check (code ~ '^[A-Z0-9_-]{2,20}$'),
  constraint branches_name_not_blank check (btrim(name) <> ''),
  constraint branches_phone_format check (phone_e164 = '' or phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);

create unique index branches_active_name_uidx on app.branches (lower(name)) where active;

create table app.user_branch_memberships (
  user_id uuid not null references app.profiles(user_id) on delete restrict,
  branch_id uuid not null references app.branches(id) on delete restrict,
  role app.membership_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, branch_id)
);

create index user_branch_memberships_branch_user_idx
  on app.user_branch_memberships (branch_id, user_id) where active;

create table app.devices (
  id uuid primary key,
  owner_user_id uuid not null references app.profiles(user_id) on delete restrict,
  installation_id uuid not null,
  machine_label text not null,
  credential_hash bytea not null,
  state app.device_state not null default 'pending',
  update_channel text not null default 'stable',
  enrolled_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references app.profiles(user_id) on delete restrict,
  revoked_at timestamptz,
  revoked_by uuid references app.profiles(user_id) on delete restrict,
  last_seen_at timestamptz,
  last_server_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint devices_machine_label_not_blank check (btrim(machine_label) <> ''),
  constraint devices_credential_hash_length check (octet_length(credential_hash) = 32),
  constraint devices_approval_consistent check (
    (state = 'approved' and approved_at is not null and approved_by is not null and revoked_at is null)
    or (state = 'revoked' and revoked_at is not null and revoked_by is not null)
    or (state = 'pending' and approved_at is null and revoked_at is null)
  ),
  constraint devices_update_channel check (update_channel in ('pilot', 'stable')),
  unique (owner_user_id, installation_id)
);

create index devices_state_owner_idx on app.devices (state, owner_user_id);
create index devices_last_seen_idx on app.devices (last_seen_at desc) where state = 'approved';

create table app.app_sessions (
  session_id uuid primary key,
  user_id uuid not null references app.profiles(user_id) on delete restrict,
  device_id uuid not null references app.devices(id) on delete restrict,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references app.profiles(user_id) on delete restrict,
  constraint app_sessions_revocation_consistent check (
    (revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null)
  )
);

create index app_sessions_user_active_idx on app.app_sessions (user_id, last_seen_at desc) where revoked_at is null;
create index app_sessions_device_active_idx on app.app_sessions (device_id, last_seen_at desc) where revoked_at is null;

create table app.order_counters (
  year smallint primary key,
  next_value bigint not null,
  updated_at timestamptz not null default now(),
  constraint order_counters_year_range check (year between 2020 and 2199),
  constraint order_counters_next_positive check (next_value > 0)
);

create table app.migration_sources (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  branch_id uuid references app.branches(id) on delete restrict,
  source_sha256 text not null unique,
  source_bytes bigint not null,
  captured_at timestamptz not null,
  imported_at timestamptz,
  row_count bigint,
  manifest jsonb not null default '{}'::jsonb,
  created_by uuid references app.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint migration_sources_sha256_format check (source_sha256 ~ '^[a-f0-9]{64}$'),
  constraint migration_sources_bytes_positive check (source_bytes >= 0)
);

create table app.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique,
  legacy_order_number text,
  migration_source_id uuid references app.migration_sources(id) on delete restrict,
  branch_id uuid not null references app.branches(id) on delete restrict,
  migration_content_sha256 text,
  finalized_by uuid not null references app.profiles(user_id) on delete restrict,
  client_command_id uuid unique,
  status app.order_status not null default 'finalized',
  snapshot jsonb not null,
  customer_name text not null,
  customer_phone_e164 text not null,
  total_amount numeric(12,2) not null default 0,
  deposit_paid numeric(12,2) not null default 0,
  remaining_amount numeric(12,2) not null default 0,
  version bigint not null default 1,
  finalized_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references app.profiles(user_id) on delete restrict,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_migration_hash_format check (migration_content_sha256 is null or migration_content_sha256 ~ '^[a-f0-9]{64}$'),
  constraint orders_number_kind check (
    (migration_source_id is null and order_number is not null and legacy_order_number is null and migration_content_sha256 is null)
    or (migration_source_id is not null and legacy_order_number is not null and migration_content_sha256 is not null)
  ),
  constraint orders_number_format check (order_number is null or order_number ~ '^BS-[0-9]{2}-[0-9]{4,}$'),
  constraint orders_customer_name_not_blank check (btrim(customer_name) <> ''),
  constraint orders_customer_phone_format check (customer_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint orders_amounts_nonnegative check (total_amount >= 0 and deposit_paid >= 0 and remaining_amount >= 0),
  constraint orders_deposit_not_excessive check (deposit_paid <= total_amount),
  constraint orders_remaining_matches check (remaining_amount = total_amount - deposit_paid),
  constraint orders_version_positive check (version > 0),
  constraint orders_cancel_consistent check (
    (status = 'finalized' and cancelled_at is null and cancelled_by is null and cancellation_reason is null)
    or (status = 'cancelled' and cancelled_at is not null and cancelled_by is not null and btrim(cancellation_reason) <> '')
  )
);

create index orders_branch_finalized_idx on app.orders (branch_id, finalized_at desc, id desc);
create index orders_customer_name_idx on app.orders (branch_id, lower(customer_name));
create index orders_customer_phone_idx on app.orders (branch_id, customer_phone_e164);
create index orders_legacy_number_idx on app.orders (legacy_order_number) where legacy_order_number is not null;
create index orders_active_status_idx on app.orders (branch_id, finalized_at desc) where status = 'finalized';
create unique index orders_legacy_content_uidx on app.orders (legacy_order_number, migration_content_sha256) where migration_source_id is not null;
create table app.order_migration_origins (
  order_id uuid not null references app.orders(id) on delete restrict,
  migration_source_id uuid not null references app.migration_sources(id) on delete restrict,
  source_row_key text not null,
  content_sha256 text not null,
  created_at timestamptz not null default now(),
  primary key (migration_source_id, source_row_key),
  constraint order_migration_origins_row_key_not_blank check (btrim(source_row_key) <> ''),
  constraint order_migration_origins_hash_format check (content_sha256 ~ '^[a-f0-9]{64}$')
);

create index order_migration_origins_order_idx on app.order_migration_origins (order_id);

create table app.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references app.orders(id) on delete restrict,
  line_number smallint not null,
  category text not null,
  description text not null,
  products jsonb not null default '[]'::jsonb,
  amount numeric(12,2),
  created_at timestamptz not null default now(),
  constraint order_items_line_positive check (line_number > 0),
  constraint order_items_description_not_blank check (btrim(description) <> ''),
  constraint order_items_amount_nonnegative check (amount is null or amount >= 0),
  unique (order_id, line_number)
);

create index order_items_order_idx on app.order_items (order_id, line_number);

create table app.order_documents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references app.orders(id) on delete restrict,
  status app.document_status not null default 'pending_upload',
  storage_bucket text not null default 'order-documents',
  object_path text,
  sha256 text,
  size_bytes bigint,
  uploaded_by uuid references app.profiles(user_id) on delete restrict,
  ready_at timestamptz,
  failure_code text,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_documents_hash_format check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  constraint order_documents_size_positive check (size_bytes is null or size_bytes > 0),
  constraint order_documents_ready_consistent check (
    (status = 'ready' and object_path is not null and sha256 is not null and size_bytes is not null and ready_at is not null)
    or (status = 'pending_upload' and ready_at is null)
    or (status = 'failed' and failure_code is not null)
  ),
  unique (order_id)
);

create index order_documents_status_idx on app.order_documents (status, updated_at);

create table app.order_actions (
  id uuid primary key,
  order_id uuid not null references app.orders(id) on delete restrict,
  channel app.action_channel not null,
  status app.action_status not null,
  attempted_by uuid not null references app.profiles(user_id) on delete restrict,
  device_id uuid not null references app.devices(id) on delete restrict,
  external_receipt jsonb,
  failure_code text,
  version bigint not null default 1,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_actions_version_positive check (version > 0),
  constraint order_actions_time_consistent check (
    (status = 'queued' and started_at is null and completed_at is null)
    or (status = 'in_progress' and started_at is not null and completed_at is null)
    or (status in ('succeeded', 'failed_before_effect', 'uncertain') and completed_at is not null)
  )
);

create index order_actions_order_created_idx on app.order_actions (order_id, created_at desc);
create index order_actions_uncertain_idx on app.order_actions (updated_at) where status = 'uncertain';

create table app.order_amendments (
  id bigint generated always as identity primary key,
  order_id uuid not null references app.orders(id) on delete restrict,
  field_name text not null,
  old_value jsonb,
  new_value jsonb,
  reason text not null,
  amended_by uuid not null references app.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint order_amendments_reason_not_blank check (btrim(reason) <> '')
);

create index order_amendments_order_idx on app.order_amendments (order_id, created_at desc);

create table app.audit_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  branch_id uuid references app.branches(id) on delete restrict,
  actor_user_id uuid references app.profiles(user_id) on delete restrict,
  actor_device_id uuid references app.devices(id) on delete restrict,
  command_id uuid,
  entity_type text not null,
  entity_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_events_event_type_not_blank check (btrim(event_type) <> ''),
  constraint audit_events_entity_not_blank check (btrim(entity_type) <> '' and btrim(entity_id) <> '')
);

create index audit_events_branch_cursor_idx on app.audit_events (branch_id, id);
create index audit_events_actor_cursor_idx on app.audit_events (actor_user_id, id);
create index audit_events_entity_idx on app.audit_events (entity_type, entity_id, id desc);

create table app.command_results (
  command_id uuid primary key,
  user_id uuid not null references app.profiles(user_id) on delete restrict,
  operation text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  constraint command_results_operation_not_blank check (btrim(operation) <> '')
);

create index command_results_user_created_idx on app.command_results (user_id, created_at desc);

create table app.migration_conflicts (
  id bigint generated always as identity primary key,
  migration_source_id uuid not null references app.migration_sources(id) on delete restrict,
  legacy_order_number text not null,
  conflict_group uuid not null,
  imported_order_id uuid references app.orders(id) on delete restrict,
  content_sha256 text not null,
  details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by uuid references app.profiles(user_id) on delete restrict,
  resolution_note text,
  created_at timestamptz not null default now(),
  constraint migration_conflicts_hash_format check (content_sha256 ~ '^[a-f0-9]{64}$')
);

create index migration_conflicts_group_idx on app.migration_conflicts (conflict_group, id);
create index migration_conflicts_open_idx on app.migration_conflicts (created_at) where resolved_at is null;

create table app.release_publishers (
  user_id uuid primary key references app.profiles(user_id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references app.profiles(user_id) on delete restrict
);

create table app.update_releases (
  release_sequence bigint primary key,
  version text not null unique,
  channel text not null,
  minimum_sequence bigint not null,
  package_path text not null unique,
  size_bytes bigint not null,
  sha256 text not null,
  published_at timestamptz not null,
  rollout_cohort text not null,
  mandatory_after timestamptz,
  signing_key_id text not null,
  canonical_manifest jsonb not null,
  signature text not null,
  active boolean not null default true,
  published_by uuid not null references app.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint update_releases_sequence_positive check (release_sequence > 0 and minimum_sequence >= 0 and minimum_sequence <= release_sequence),
  constraint update_releases_size_positive check (size_bytes > 0),
  constraint update_releases_hash_format check (sha256 ~ '^[a-f0-9]{64}$'),
  constraint update_releases_channel check (channel in ('pilot', 'stable'))
);

create index update_releases_active_channel_idx
  on app.update_releases (channel, release_sequence desc) where active;

create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on app.profiles
for each row execute function app.set_updated_at();
create trigger branches_set_updated_at before update on app.branches
for each row execute function app.set_updated_at();
create trigger memberships_set_updated_at before update on app.user_branch_memberships
for each row execute function app.set_updated_at();
create trigger devices_set_updated_at before update on app.devices
for each row execute function app.set_updated_at();
create trigger orders_set_updated_at before update on app.orders
for each row execute function app.set_updated_at();
create trigger documents_set_updated_at before update on app.order_documents
for each row execute function app.set_updated_at();
create trigger actions_set_updated_at before update on app.order_actions
for each row execute function app.set_updated_at();

create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text;
  v_display_name text;
begin
  v_username := coalesce(nullif(btrim(new.raw_app_meta_data ->> 'username'), ''), split_part(new.email, '@', 1), new.id::text);
  v_display_name := coalesce(nullif(btrim(new.raw_app_meta_data ->> 'display_name'), ''), v_username);
  insert into app.profiles (user_id, username, display_name)
  values (new.id, v_username, v_display_name)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke execute on function app.handle_new_auth_user() from public, anon, authenticated;

create trigger blue_shark_auth_user_created
after insert on auth.users
for each row execute function app.handle_new_auth_user();

create or replace function app.request_header(p_name text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((nullif(current_setting('request.headers', true), '')::jsonb ->> lower(p_name)), '');
$$;

create or replace function app.current_auth_session_id()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
begin
  return nullif(auth.jwt() ->> 'session_id', '')::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

create or replace function app.current_request_device_id()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
begin
  return nullif(app.request_header('x-device-id'), '')::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

create or replace function app.request_is_approved()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.profiles p
    join app.devices d on d.owner_user_id = p.user_id
    join app.app_sessions s on s.user_id = p.user_id and s.device_id = d.id
    where p.user_id = (select auth.uid())
      and p.active
      and d.id = app.current_request_device_id()
      and d.state = 'approved'
      and d.credential_hash = extensions.digest(convert_to(app.request_header('x-device-token'), 'UTF8'), 'sha256')
      and s.session_id = app.current_auth_session_id()
      and s.revoked_at is null
  );
$$;

create or replace function app.current_is_aal2()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

create or replace function app.current_is_system_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.request_is_approved() and app.current_is_aal2() and exists (
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
    (
      app.current_is_aal2() and exists (
        select 1 from app.profiles
        where user_id = (select auth.uid()) and active and is_system_admin
      )
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
  select app.request_is_approved() and app.current_is_aal2() and exists (
    select 1 from app.release_publishers
    where user_id = (select auth.uid()) and active
  );
$$;

revoke execute on function app.request_header(text) from public, anon;
revoke execute on function app.current_auth_session_id() from public, anon;
revoke execute on function app.current_request_device_id() from public, anon;
revoke execute on function app.request_is_approved() from public, anon;
revoke execute on function app.current_is_aal2() from public, anon;
revoke execute on function app.current_is_system_admin() from public, anon;
revoke execute on function app.can_access_branch(uuid, boolean) from public, anon;
revoke execute on function app.current_is_release_publisher() from public, anon;
grant execute on function app.request_header(text) to authenticated;
grant execute on function app.current_auth_session_id() to authenticated;
grant execute on function app.current_request_device_id() to authenticated;
grant execute on function app.request_is_approved() to authenticated;
grant execute on function app.current_is_aal2() to authenticated;
grant execute on function app.current_is_system_admin() to authenticated;
grant execute on function app.can_access_branch(uuid, boolean) to authenticated;
grant execute on function app.current_is_release_publisher() to authenticated;

alter table app.profiles enable row level security;
alter table app.profiles force row level security;
alter table app.branches enable row level security;
alter table app.branches force row level security;
alter table app.user_branch_memberships enable row level security;
alter table app.user_branch_memberships force row level security;
alter table app.devices enable row level security;
alter table app.devices force row level security;
alter table app.app_sessions enable row level security;
alter table app.app_sessions force row level security;
alter table app.order_counters enable row level security;
alter table app.order_counters force row level security;
alter table app.orders enable row level security;
alter table app.orders force row level security;
alter table app.order_migration_origins enable row level security;
alter table app.order_migration_origins force row level security;
alter table app.order_items enable row level security;
alter table app.order_items force row level security;
alter table app.order_documents enable row level security;
alter table app.order_documents force row level security;
alter table app.order_actions enable row level security;
alter table app.order_actions force row level security;
alter table app.order_amendments enable row level security;
alter table app.order_amendments force row level security;
alter table app.audit_events enable row level security;
alter table app.audit_events force row level security;
alter table app.command_results enable row level security;
alter table app.command_results force row level security;
alter table app.migration_sources enable row level security;
alter table app.migration_sources force row level security;
alter table app.migration_conflicts enable row level security;
alter table app.migration_conflicts force row level security;
alter table app.release_publishers enable row level security;
alter table app.release_publishers force row level security;
alter table app.update_releases enable row level security;
alter table app.update_releases force row level security;

create policy profiles_read on app.profiles for select to authenticated
using (user_id = (select auth.uid()) or (select app.current_is_system_admin()));
create policy profiles_admin_write on app.profiles for update to authenticated
using ((select app.current_is_system_admin())) with check ((select app.current_is_system_admin()));

create policy branches_read on app.branches for select to authenticated
using ((select app.current_is_system_admin()) or (select app.can_access_branch(id, false)));
create policy branches_admin_insert on app.branches for insert to authenticated
with check ((select app.current_is_system_admin()));
create policy branches_admin_update on app.branches for update to authenticated
using ((select app.current_is_system_admin())) with check ((select app.current_is_system_admin()));

create policy memberships_read on app.user_branch_memberships for select to authenticated
using (user_id = (select auth.uid()) or (select app.current_is_system_admin()));
create policy memberships_admin_insert on app.user_branch_memberships for insert to authenticated
with check ((select app.current_is_system_admin()));
create policy memberships_admin_update on app.user_branch_memberships for update to authenticated
using ((select app.current_is_system_admin())) with check ((select app.current_is_system_admin()));

create policy devices_read on app.devices for select to authenticated
using (owner_user_id = (select auth.uid()) or (select app.current_is_system_admin()));
create policy devices_enroll on app.devices for insert to authenticated
with check (owner_user_id = (select auth.uid()) and state = 'pending');
create policy devices_update on app.devices for update to authenticated
using (owner_user_id = (select auth.uid()) or (select app.current_is_system_admin()))
with check (owner_user_id = (select auth.uid()) or (select app.current_is_system_admin()));

create policy sessions_read on app.app_sessions for select to authenticated
using (user_id = (select auth.uid()) or (select app.current_is_system_admin()));
create policy sessions_insert on app.app_sessions for insert to authenticated
with check (user_id = (select auth.uid()));
create policy sessions_update on app.app_sessions for update to authenticated
using (user_id = (select auth.uid()) or (select app.current_is_system_admin()))
with check (user_id = (select auth.uid()) or (select app.current_is_system_admin()));

create policy counters_read on app.order_counters for select to authenticated
using ((select app.request_is_approved()));
create policy counters_insert on app.order_counters for insert to authenticated
with check ((select app.request_is_approved()));
create policy counters_update on app.order_counters for update to authenticated
using ((select app.request_is_approved())) with check ((select app.request_is_approved()));

create policy orders_read on app.orders for select to authenticated
using ((select app.can_access_branch(branch_id, false)));
create policy orders_insert on app.orders for insert to authenticated
with check (finalized_by = (select auth.uid()) and (select app.can_access_branch(branch_id, false)));
create policy orders_supervisor_update on app.orders for update to authenticated
using ((select app.can_access_branch(branch_id, true)))
with check ((select app.can_access_branch(branch_id, true)));

create policy order_migration_origins_admin_read on app.order_migration_origins for select to authenticated
using ((select app.current_is_system_admin()));
create policy order_migration_origins_admin_write on app.order_migration_origins for all to authenticated
using ((select app.current_is_system_admin())) with check ((select app.current_is_system_admin()));

create policy order_items_read on app.order_items for select to authenticated
using (exists (select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)));
create policy order_items_insert on app.order_items for insert to authenticated
with check (exists (select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)));

create policy documents_read on app.order_documents for select to authenticated
using (exists (select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)));
create policy documents_insert on app.order_documents for insert to authenticated
with check (exists (select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)));
create policy documents_update on app.order_documents for update to authenticated
using (exists (select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)))
with check (exists (select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)));

create policy actions_read on app.order_actions for select to authenticated
using (exists (select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)));
create policy actions_insert on app.order_actions for insert to authenticated
with check (attempted_by = (select auth.uid()) and device_id = app.current_request_device_id()
  and exists (select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)));
create policy actions_update on app.order_actions for update to authenticated
using (
  (attempted_by = (select auth.uid()) and exists (
    select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)
  )) or (status = 'uncertain' and exists (
    select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, true)
  ))
)
with check (exists (
  select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)
));

create policy amendments_read on app.order_amendments for select to authenticated
using (exists (select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, false)));
create policy amendments_supervisor_insert on app.order_amendments for insert to authenticated
with check (amended_by = (select auth.uid())
  and exists (select 1 from app.orders o where o.id = order_id and app.can_access_branch(o.branch_id, true)));

create policy audit_read on app.audit_events for select to authenticated
using ((select app.current_is_system_admin()) or (branch_id is not null and (select app.can_access_branch(branch_id, true))));
create policy audit_insert on app.audit_events for insert to authenticated
with check ((select app.request_is_approved()) and actor_user_id = (select auth.uid())
  and actor_device_id = app.current_request_device_id());

create policy command_results_read on app.command_results for select to authenticated
using (user_id = (select auth.uid()));
create policy command_results_insert on app.command_results for insert to authenticated
with check (user_id = (select auth.uid()) and (select app.request_is_approved()));

create policy migration_sources_admin on app.migration_sources for all to authenticated
using ((select app.current_is_system_admin())) with check ((select app.current_is_system_admin()));
create policy migration_conflicts_admin on app.migration_conflicts for all to authenticated
using ((select app.current_is_system_admin())) with check ((select app.current_is_system_admin()));
create policy release_publishers_admin on app.release_publishers for all to authenticated
using ((select app.current_is_system_admin())) with check ((select app.current_is_system_admin()));
create policy update_releases_read on app.update_releases for select to authenticated
using ((select app.request_is_approved()));
create policy update_releases_publish on app.update_releases for insert to authenticated
with check (published_by = (select auth.uid()) and (select app.current_is_release_publisher()));

grant select, update on app.profiles to authenticated;
grant select, insert, update on app.branches, app.user_branch_memberships, app.devices, app.app_sessions to authenticated;
grant select, insert, update on app.order_counters, app.orders, app.order_documents, app.order_actions to authenticated;
grant select, insert on app.order_migration_origins to authenticated;
grant select, insert on app.order_items, app.order_amendments, app.audit_events, app.command_results to authenticated;
grant select, insert, update on app.migration_sources, app.migration_conflicts, app.release_publishers to authenticated;
grant select, insert on app.update_releases to authenticated;
grant usage, select on all sequences in schema app to authenticated;

create or replace function app.touch_request()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not app.request_is_approved() then
    raise exception 'device or session is not approved' using errcode = '42501';
  end if;

  update app.devices
  set last_seen_at = now(), last_server_at = now()
  where id = app.current_request_device_id() and owner_user_id = (select auth.uid());

  update app.app_sessions
  set last_seen_at = now()
  where session_id = app.current_auth_session_id()
    and user_id = (select auth.uid())
    and revoked_at is null;
end;
$$;

revoke execute on function app.touch_request() from public, anon;
grant execute on function app.touch_request() to authenticated;

create or replace function api.register_device(
  p_device_id uuid,
  p_installation_id uuid,
  p_machine_label text,
  p_device_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid := app.current_auth_session_id();
  v_device app.devices%rowtype;
begin
  if v_user_id is null or v_session_id is null then
    raise exception 'authenticated session required' using errcode = '42501';
  end if;
  if not exists (select 1 from app.profiles where user_id = v_user_id and active) then
    raise exception 'user is disabled' using errcode = '42501';
  end if;
  if length(p_device_token) < 32 or length(p_device_token) > 256 then
    raise exception 'invalid device token' using errcode = '22023';
  end if;
  if btrim(coalesce(p_machine_label, '')) = '' then
    raise exception 'machine label is required' using errcode = '22023';
  end if;

  insert into app.devices (
    id, owner_user_id, installation_id, machine_label, credential_hash, state, last_seen_at
  ) values (
    p_device_id, v_user_id, p_installation_id, left(btrim(p_machine_label), 160),
    extensions.digest(convert_to(p_device_token, 'UTF8'), 'sha256'), 'pending', now()
  )
  on conflict (owner_user_id, installation_id) do update
    set machine_label = excluded.machine_label,
        last_seen_at = now()
  returning * into v_device;

  if v_device.credential_hash <> extensions.digest(convert_to(p_device_token, 'UTF8'), 'sha256') then
    raise exception 'device credential mismatch' using errcode = '42501';
  end if;

  insert into app.app_sessions (session_id, user_id, device_id)
  values (v_session_id, v_user_id, v_device.id)
  on conflict (session_id) do update
    set last_seen_at = now()
  where app.app_sessions.user_id = excluded.user_id
    and app.app_sessions.device_id = excluded.device_id
    and app.app_sessions.revoked_at is null;

  return jsonb_build_object(
    'deviceId', v_device.id,
    'state', v_device.state,
    'approvedAt', v_device.approved_at,
    'serverTime', now()
  );
end;
$$;

create or replace function api.session_status()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_device app.devices%rowtype;
  v_profile app.profiles%rowtype;
  v_memberships jsonb;
begin
  select * into v_profile from app.profiles where user_id = v_user_id;
  if not found or not v_profile.active then
    raise exception 'user is disabled' using errcode = '42501';
  end if;

  select * into v_device
  from app.devices
  where id = app.current_request_device_id()
    and owner_user_id = v_user_id
    and credential_hash = extensions.digest(convert_to(app.request_header('x-device-token'), 'UTF8'), 'sha256');

  if not found then
    raise exception 'device is not registered' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'branchId', m.branch_id,
    'branchCode', b.code,
    'branchName', b.name,
    'role', m.role
  ) order by b.name), '[]'::jsonb)
  into v_memberships
  from app.user_branch_memberships m
  join app.branches b on b.id = m.branch_id
  where m.user_id = v_user_id and m.active and b.active;

  return jsonb_build_object(
    'userId', v_profile.user_id,
    'username', v_profile.username,
    'displayName', v_profile.display_name,
    'systemAdmin', v_profile.is_system_admin,
    'mfaVerified', app.current_is_aal2(),
    'deviceId', v_device.id,
    'deviceState', v_device.state,
    'lastServerAt', v_device.last_server_at,
    'memberships', v_memberships,
    'serverTime', now()
  );
end;
$$;

create or replace function api.approve_device(p_device_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_device app.devices%rowtype;
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  update app.devices
  set state = 'approved', approved_at = now(), approved_by = v_user_id,
      revoked_at = null, revoked_by = null
  where id = p_device_id and state = 'pending'
  returning * into v_device;
  if not found then
    raise exception 'pending device not found' using errcode = 'P0002';
  end if;
  insert into app.audit_events (
    event_type, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    'device.approved', v_user_id, app.current_request_device_id(), 'device', v_device.id::text,
    jsonb_build_object('ownerUserId', v_device.owner_user_id)
  );
  return jsonb_build_object('deviceId', v_device.id, 'state', v_device.state, 'approvedAt', v_device.approved_at);
end;
$$;

create or replace function api.revoke_device(p_device_id uuid, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_device app.devices%rowtype;
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'revocation reason is required' using errcode = '22023';
  end if;
  update app.devices
  set state = 'revoked', revoked_at = now(), revoked_by = v_user_id
  where id = p_device_id and state <> 'revoked'
  returning * into v_device;
  if not found then
    raise exception 'device not found' using errcode = 'P0002';
  end if;
  update app.app_sessions
  set revoked_at = now(), revoked_by = v_user_id
  where device_id = p_device_id and revoked_at is null;
  insert into app.audit_events (
    event_type, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    'device.revoked', v_user_id, app.current_request_device_id(), 'device', v_device.id::text,
    jsonb_build_object('reason', left(btrim(p_reason), 500))
  );
  return jsonb_build_object('deviceId', v_device.id, 'state', v_device.state, 'revokedAt', v_device.revoked_at);
end;
$$;

create or replace function api.list_branches()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform app.touch_request();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'code', b.code, 'name', b.name, 'phone', b.phone_e164, 'active', b.active
  ) order by b.active desc, b.name), '[]'::jsonb)
  into v_result
  from app.branches b
  where b.active or app.current_is_system_admin();
  return v_result;
end;
$$;

create or replace function api.finalize_order(
  p_command_id uuid,
  p_branch_id uuid,
  p_draft jsonb,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_year smallint;
  v_sequence bigint;
  v_order_number text;
  v_order_id uuid;
  v_customer_name text;
  v_customer_phone text;
  v_total numeric(12,2);
  v_deposit numeric(12,2);
  v_remaining numeric(12,2);
  v_response jsonb;
begin
  perform app.touch_request();
  if not app.can_access_branch(p_branch_id, false) then
    raise exception 'branch access denied' using errcode = '42501';
  end if;
  if p_expected_version <> 0 then
    raise exception 'new draft version must be zero' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text, 0));
  select response into v_response from app.command_results
  where command_id = p_command_id and user_id = v_user_id and operation = 'finalize_order';
  if found then return v_response; end if;

  if jsonb_typeof(p_draft) <> 'object'
     or jsonb_typeof(p_draft -> 'services') <> 'array'
     or jsonb_array_length(p_draft -> 'services') < 1 then
    raise exception 'invalid order draft' using errcode = '22023';
  end if;

  v_customer_name := btrim(p_draft #>> '{customer,name}');
  v_customer_phone := btrim(p_draft #>> '{customer,phone}');
  if v_customer_name = '' or v_customer_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid customer' using errcode = '22023';
  end if;
  if nullif(btrim(p_draft #>> '{dates,reception}'), '') is null
     or nullif(btrim(p_draft #>> '{dates,delivery}'), '') is null
     or nullif(btrim(p_draft #>> '{vehicle,model}'), '') is null
     or nullif(btrim(p_draft #>> '{vehicle,plateNumber}'), '') is null
     or nullif(btrim(p_draft ->> 'paymentMethod'), '') is null then
    raise exception 'required order fields are missing' using errcode = '22023';
  end if;

  begin
    v_total := coalesce((p_draft #>> '{amounts,total}')::numeric, 0);
    v_deposit := coalesce((p_draft #>> '{amounts,deposit}')::numeric, 0);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid order amounts' using errcode = '22023';
  end;
  if v_total < 0 or v_deposit < 0 or v_deposit > v_total then
    raise exception 'invalid order amounts' using errcode = '22023';
  end if;
  v_remaining := v_total - v_deposit;

  v_year := extract(year from timezone('Asia/Riyadh', now()))::smallint;
  insert into app.order_counters (year, next_value)
  values (v_year, 2)
  on conflict (year) do update
    set next_value = app.order_counters.next_value + 1,
        updated_at = now()
  returning next_value - 1 into v_sequence;

  v_order_number := 'BS-' || right(v_year::text, 2) || '-' || lpad(v_sequence::text, 4, '0');

  insert into app.orders (
    order_number, branch_id, finalized_by, client_command_id, snapshot,
    customer_name, customer_phone_e164, total_amount, deposit_paid, remaining_amount
  ) values (
    v_order_number, p_branch_id, v_user_id, p_command_id, p_draft,
    left(v_customer_name, 200), v_customer_phone, v_total, v_deposit, v_remaining
  ) returning id into v_order_id;

  insert into app.order_items (order_id, line_number, category, description, products, amount)
  select v_order_id, ordinality::smallint,
         left(coalesce(nullif(item ->> 'category', ''), 'service'), 120),
         left(coalesce(nullif(item ->> 'label', ''), 'service'), 500),
         coalesce(item -> 'products', '[]'::jsonb),
         case when (item ->> 'amount') ~ '^[0-9]+(\.[0-9]{1,2})?$' then (item ->> 'amount')::numeric else null end
  from jsonb_array_elements(p_draft -> 'services') with ordinality as items(item, ordinality);

  insert into app.order_documents (order_id) values (v_order_id);

  v_response := jsonb_build_object(
    'orderId', v_order_id,
    'orderNumber', v_order_number,
    'status', 'finalized',
    'version', 1,
    'finalizedAt', now()
  );

  insert into app.audit_events (
    event_type, branch_id, actor_user_id, actor_device_id, command_id, entity_type, entity_id, payload
  ) values (
    'order.finalized', p_branch_id, v_user_id, app.current_request_device_id(), p_command_id,
    'order', v_order_id::text, jsonb_build_object('orderNumber', v_order_number)
  );
  insert into app.command_results (command_id, user_id, operation, response)
  values (p_command_id, v_user_id, 'finalize_order', v_response);
  return v_response;
end;
$$;

create or replace function api.complete_document(
  p_command_id uuid,
  p_order_id uuid,
  p_object_path text,
  p_sha256 text,
  p_size_bytes bigint,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_branch_id uuid;
  v_document app.order_documents%rowtype;
  v_response jsonb;
begin
  perform app.touch_request();
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text, 0));
  select response into v_response from app.command_results
  where command_id = p_command_id and user_id = v_user_id and operation = 'complete_document';
  if found then return v_response; end if;

  select branch_id into v_branch_id from app.orders where id = p_order_id;
  if not found or not app.can_access_branch(v_branch_id, false) then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if p_sha256 !~ '^[a-f0-9]{64}$' or p_size_bytes < 1 or p_size_bytes > 16777216 then
    raise exception 'invalid document metadata' using errcode = '22023';
  end if;
  if p_object_path !~ ('^orders/' || p_order_id::text || '/[a-f0-9]{64}\.pdf$') then
    raise exception 'invalid document path' using errcode = '22023';
  end if;

  update app.order_documents
  set status = 'ready', object_path = p_object_path, sha256 = p_sha256,
      size_bytes = p_size_bytes, uploaded_by = v_user_id, ready_at = now(),
      failure_code = null, version = version + 1
  where order_id = p_order_id and version = p_expected_version and status = 'pending_upload'
  returning * into v_document;
  if not found then
    raise exception 'document version conflict' using errcode = '40001';
  end if;

  v_response := jsonb_build_object('documentId', v_document.id, 'status', v_document.status, 'version', v_document.version);
  insert into app.audit_events (
    event_type, branch_id, actor_user_id, actor_device_id, command_id, entity_type, entity_id, payload
  ) values (
    'document.ready', v_branch_id, v_user_id, app.current_request_device_id(), p_command_id,
    'order_document', v_document.id::text, jsonb_build_object('sha256', p_sha256, 'sizeBytes', p_size_bytes)
  );
  insert into app.command_results (command_id, user_id, operation, response)
  values (p_command_id, v_user_id, 'complete_document', v_response);
  return v_response;
end;
$$;

create or replace function api.record_action(
  p_command_id uuid,
  p_order_id uuid,
  p_action_id uuid,
  p_channel app.action_channel,
  p_target_status app.action_status,
  p_receipt jsonb,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_branch_id uuid;
  v_action app.order_actions%rowtype;
  v_response jsonb;
begin
  perform app.touch_request();
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text, 0));
  select response into v_response from app.command_results
  where command_id = p_command_id and user_id = v_user_id and operation = 'record_action';
  if found then return v_response; end if;

  select o.branch_id into v_branch_id
  from app.orders o join app.order_documents d on d.order_id = o.id
  where o.id = p_order_id and o.status = 'finalized' and d.status = 'ready';
  if not found or not app.can_access_branch(v_branch_id, false) then
    raise exception 'ready order not found' using errcode = 'P0002';
  end if;

  select * into v_action from app.order_actions where id = p_action_id and order_id = p_order_id for update;
  if not found then
    if p_expected_version <> 0 or p_target_status <> 'queued' then
      raise exception 'new action must start queued' using errcode = '22023';
    end if;
    insert into app.order_actions (id, order_id, channel, status, attempted_by, device_id)
    values (p_action_id, p_order_id, p_channel, 'queued', v_user_id, app.current_request_device_id())
    returning * into v_action;
  else
    if v_action.version <> p_expected_version or v_action.channel <> p_channel then
      raise exception 'action version conflict' using errcode = '40001';
    end if;
    if not (
      (v_action.status = 'queued' and p_target_status in ('in_progress', 'failed_before_effect'))
      or (v_action.status = 'in_progress' and p_target_status in ('succeeded', 'failed_before_effect', 'uncertain'))
      or (v_action.status = 'uncertain' and p_target_status in ('succeeded', 'failed_before_effect'))
    ) then
      raise exception 'invalid action transition' using errcode = '22023';
    end if;
    update app.order_actions
    set status = p_target_status,
        external_receipt = p_receipt,
        failure_code = nullif(p_receipt ->> 'failureCode', ''),
        started_at = case when p_target_status = 'in_progress' then coalesce(started_at, now()) else started_at end,
        completed_at = case when p_target_status in ('succeeded', 'failed_before_effect', 'uncertain') then now() else null end,
        version = version + 1
    where id = p_action_id
    returning * into v_action;
  end if;

  v_response := jsonb_build_object('actionId', v_action.id, 'status', v_action.status, 'version', v_action.version);
  insert into app.audit_events (
    event_type, branch_id, actor_user_id, actor_device_id, command_id, entity_type, entity_id, payload
  ) values (
    'order_action.' || v_action.status::text, v_branch_id, v_user_id, app.current_request_device_id(), p_command_id,
    'order_action', v_action.id::text, jsonb_build_object('orderId', p_order_id, 'channel', p_channel)
  );
  insert into app.command_results (command_id, user_id, operation, response)
  values (p_command_id, v_user_id, 'record_action', v_response);
  return v_response;
end;
$$;

create or replace function api.cancel_order(
  p_command_id uuid,
  p_order_id uuid,
  p_reason text,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_order app.orders%rowtype;
  v_response jsonb;
begin
  perform app.touch_request();
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text, 0));
  select response into v_response from app.command_results
  where command_id = p_command_id and user_id = v_user_id and operation = 'cancel_order';
  if found then return v_response; end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'cancellation reason is required' using errcode = '22023';
  end if;
  select * into v_order from app.orders where id = p_order_id;
  if not found or not app.can_access_branch(v_order.branch_id, true) then
    raise exception 'supervisor access required' using errcode = '42501';
  end if;
  update app.orders
  set status = 'cancelled', cancelled_at = now(), cancelled_by = v_user_id,
      cancellation_reason = left(btrim(p_reason), 1000), version = version + 1
  where id = p_order_id and status = 'finalized' and version = p_expected_version
  returning * into v_order;
  if not found then raise exception 'order version conflict' using errcode = '40001'; end if;
  v_response := jsonb_build_object('orderId', v_order.id, 'status', v_order.status, 'version', v_order.version);
  insert into app.audit_events (
    event_type, branch_id, actor_user_id, actor_device_id, command_id, entity_type, entity_id, payload
  ) values (
    'order.cancelled', v_order.branch_id, v_user_id, app.current_request_device_id(), p_command_id,
    'order', v_order.id::text, jsonb_build_object('reason', v_order.cancellation_reason)
  );
  insert into app.command_results (command_id, user_id, operation, response)
  values (p_command_id, v_user_id, 'cancel_order', v_response);
  return v_response;
end;
$$;

create or replace function api.list_orders(p_before_id uuid default null, p_limit integer default 100)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform app.touch_request();
  select coalesce(jsonb_agg(to_jsonb(rows) order by rows.finalized_at desc, rows.id desc), '[]'::jsonb)
  into v_result
  from (
    select o.id, o.order_number, o.legacy_order_number, o.branch_id, o.status,
           o.customer_name, o.customer_phone_e164, o.total_amount, o.deposit_paid,
           o.remaining_amount, o.version, o.finalized_at,
           b.name as branch_name,
           o.snapshot #>> '{vehicle,model}' as vehicle_model,
           d.status as document_status, d.object_path,
           exists (select 1 from app.order_actions a where a.order_id = o.id and a.status = 'uncertain') as has_uncertain_action
    from app.orders o
    join app.branches b on b.id = o.branch_id
    left join app.order_documents d on d.order_id = o.id
    where app.can_access_branch(o.branch_id, false)
      and (p_before_id is null or (o.finalized_at, o.id) < (
        select finalized_at, id from app.orders where id = p_before_id
      ))
    order by o.finalized_at desc, o.id desc
    limit least(greatest(coalesce(p_limit, 100), 1), 200)
  ) rows;
  return v_result;
end;
$$;

create or replace function api.get_order(p_order_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform app.touch_request();
  select jsonb_build_object(
    'order', to_jsonb(o),
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.line_number) from app.order_items i where i.order_id = o.id), '[]'::jsonb),
    'document', (select to_jsonb(d) from app.order_documents d where d.order_id = o.id),
    'actions', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from app.order_actions a where a.order_id = o.id), '[]'::jsonb)
  ) into v_result
  from app.orders o
  where o.id = p_order_id and app.can_access_branch(o.branch_id, false);
  if v_result is null then raise exception 'order not found' using errcode = 'P0002'; end if;
  return v_result;
end;
$$;

create or replace function api.sync_changes(p_after_event_id bigint default 0, p_limit integer default 500)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_events jsonb;
  v_next bigint;
begin
  perform app.touch_request();
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]'::jsonb), coalesce(max(e.id), p_after_event_id)
  into v_events, v_next
  from (
    select id, event_type, branch_id, entity_type, entity_id, payload, created_at
    from app.audit_events
    where id > greatest(coalesce(p_after_event_id, 0), 0)
      and (app.current_is_system_admin() or (branch_id is not null and app.can_access_branch(branch_id, false)))
    order by id
    limit least(greatest(coalesce(p_limit, 500), 1), 1000)
  ) e;
  return jsonb_build_object('events', v_events, 'nextEventId', v_next, 'serverTime', now());
end;
$$;

revoke execute on all functions in schema api from public, anon;
grant execute on function api.register_device(uuid, uuid, text, text) to authenticated;
grant execute on function api.session_status() to authenticated;
grant execute on function api.approve_device(uuid) to authenticated;
grant execute on function api.revoke_device(uuid, text) to authenticated;
grant execute on function api.list_branches() to authenticated;
grant execute on function api.finalize_order(uuid, uuid, jsonb, bigint) to authenticated;
grant execute on function api.complete_document(uuid, uuid, text, text, bigint, bigint) to authenticated;
grant execute on function api.record_action(uuid, uuid, uuid, app.action_channel, app.action_status, jsonb, bigint) to authenticated;
grant execute on function api.cancel_order(uuid, uuid, text, bigint) to authenticated;
grant execute on function api.list_orders(uuid, integer) to authenticated;
grant execute on function api.get_order(uuid) to authenticated;
grant execute on function api.sync_changes(bigint, integer) to authenticated;

create or replace function api.authorize_order_storage(
  p_order_id uuid,
  p_operation text,
  p_sha256 text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_branch_id uuid;
  v_document app.order_documents%rowtype;
  v_path text;
begin
  perform app.touch_request();
  select o.branch_id, d into v_branch_id, v_document
  from app.orders o join app.order_documents d on d.order_id = o.id
  where o.id = p_order_id and o.status = 'finalized';
  if not found or not app.can_access_branch(v_branch_id, false) then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if p_operation = 'upload' then
    if v_document.status <> 'pending_upload' or p_sha256 !~ '^[a-f0-9]{64}$' then
      raise exception 'document is not uploadable' using errcode = '22023';
    end if;
    v_path := 'orders/' || p_order_id::text || '/' || p_sha256 || '.pdf';
  elsif p_operation = 'download' then
    if v_document.status <> 'ready' or v_document.object_path is null then
      raise exception 'document is not ready' using errcode = 'P0002';
    end if;
    v_path := v_document.object_path;
  else
    raise exception 'unsupported storage operation' using errcode = '22023';
  end if;
  return jsonb_build_object('bucket', 'order-documents', 'objectPath', v_path, 'operation', p_operation, 'expiresIn', 300);
end;
$$;

create or replace function api.publish_release(p_manifest jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_sequence bigint;
begin
  perform app.touch_request();
  if not app.current_is_release_publisher() then
    raise exception 'release publisher required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_manifest) <> 'object'
     or (p_manifest ->> 'version') !~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$'
     or (p_manifest ->> 'package_path') !~ '^(pilot|stable)/[1-9][0-9]*/package\.zip$'
     or split_part(p_manifest ->> 'package_path', '/', 1) <> (p_manifest ->> 'channel')
     or (p_manifest ->> 'signing_key_id') !~ '^[A-Za-z0-9._-]{3,80}$'
     or nullif(p_manifest ->> 'published_at', '') is null
     or nullif(p_manifest ->> 'rollout_cohort', '') is null
     or (p_manifest ->> 'minimum_sequence')::bigint > (p_manifest ->> 'release_sequence')::bigint
     or (p_manifest ->> 'size')::bigint > 157286400
     or (p_manifest ->> 'schema_version')::integer <> 1
     or (p_manifest ->> 'release_sequence')::bigint < 1
     or (p_manifest ->> 'minimum_sequence')::bigint < 0
     or (p_manifest ->> 'size')::bigint < 1
     or (p_manifest ->> 'sha256') !~ '^[a-f0-9]{64}$'
     or (p_manifest ->> 'channel') not in ('pilot', 'stable')
     or nullif(p_manifest ->> 'signature', '') is null then
    raise exception 'invalid release manifest' using errcode = '22023';
  end if;
  v_sequence := (p_manifest ->> 'release_sequence')::bigint;
  insert into app.update_releases (
    release_sequence, version, channel, minimum_sequence, package_path,
    size_bytes, sha256, published_at, rollout_cohort, mandatory_after,
    signing_key_id, canonical_manifest, signature, published_by
  ) values (
    v_sequence, p_manifest ->> 'version', p_manifest ->> 'channel',
    (p_manifest ->> 'minimum_sequence')::bigint, p_manifest ->> 'package_path',
    (p_manifest ->> 'size')::bigint, p_manifest ->> 'sha256',
    (p_manifest ->> 'published_at')::timestamptz,
    coalesce(nullif(p_manifest ->> 'rollout_cohort', ''), 'all'),
    nullif(p_manifest ->> 'mandatory_after', '')::timestamptz,
    p_manifest ->> 'signing_key_id', p_manifest - 'signature',
    p_manifest ->> 'signature', v_user_id
  );
  insert into app.audit_events (
    event_type, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    'release.published', v_user_id, app.current_request_device_id(), 'update_release', v_sequence::text,
    jsonb_build_object('version', p_manifest ->> 'version', 'channel', p_manifest ->> 'channel')
  );
  return jsonb_build_object('releaseSequence', v_sequence, 'published', true);
end;
$$;

create or replace function api.edge_check_update(
  p_device_id uuid,
  p_device_token text,
  p_current_sequence bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device app.devices%rowtype;
  v_release app.update_releases%rowtype;
begin
  select d.* into v_device
  from app.devices d join app.profiles p on p.user_id = d.owner_user_id
  where d.id = p_device_id
    and d.state = 'approved'
    and p.active
    and d.credential_hash = extensions.digest(convert_to(p_device_token, 'UTF8'), 'sha256');
  if not found then
    raise exception 'approved device required' using errcode = '42501';
  end if;
  update app.devices set last_seen_at = now(), last_server_at = now() where id = v_device.id;
  select * into v_release
  from app.update_releases
  where active
    and (channel = 'stable' or (v_device.update_channel = 'pilot' and channel = 'pilot'))
  order by release_sequence desc
  limit 1;
  if not found or v_release.release_sequence <= greatest(coalesce(p_current_sequence, 0), 0) then
    return jsonb_build_object('updateAvailable', false, 'serverTime', now());
  end if;
  return jsonb_build_object(
    'updateAvailable', true,
    'releaseSequence', v_release.release_sequence,
    'minimumSequence', v_release.minimum_sequence,
    'packagePath', v_release.package_path,
    'size', v_release.size_bytes,
    'sha256', v_release.sha256,
    'canonicalManifest', v_release.canonical_manifest,
    'signature', v_release.signature,
    'signingKeyId', v_release.signing_key_id,
    'mandatoryAfter', v_release.mandatory_after,
    'serverTime', now()
  );
end;
$$;

revoke execute on function api.authorize_order_storage(uuid, text, text) from public, anon;
revoke execute on function api.publish_release(jsonb) from public, anon;
revoke execute on function api.edge_check_update(uuid, text, bigint) from public, anon, authenticated;
grant execute on function api.authorize_order_storage(uuid, text, text) to authenticated;
grant execute on function api.publish_release(jsonb) to authenticated;
grant execute on function api.edge_check_update(uuid, text, bigint) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('order-documents', 'order-documents', false, 16777216, array['application/pdf']),
  ('app-updates', 'app-updates', false, 157286400, array['application/zip', 'application/octet-stream', 'application/json'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy update_publishers_insert
on storage.objects for insert to authenticated
with check (bucket_id = 'app-updates' and (select app.current_is_release_publisher()));

create policy update_publishers_read
on storage.objects for select to authenticated
using (bucket_id = 'app-updates' and (select app.current_is_release_publisher()));


create or replace function api.admin_set_membership(
  p_user_id uuid,
  p_branch_id uuid,
  p_role app.membership_role,
  p_active boolean default true
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  if not exists (select 1 from app.profiles where user_id = p_user_id)
     or not exists (select 1 from app.branches where id = p_branch_id) then
    raise exception 'user or branch not found' using errcode = 'P0002';
  end if;
  insert into app.user_branch_memberships (user_id, branch_id, role, active)
  values (p_user_id, p_branch_id, p_role, p_active)
  on conflict (user_id, branch_id) do update
  set role = excluded.role, active = excluded.active;
  insert into app.audit_events (
    event_type, branch_id, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    'membership.changed', p_branch_id, auth.uid(), app.current_request_device_id(),
    'membership', p_user_id::text || ':' || p_branch_id::text,
    jsonb_build_object('role', p_role, 'active', p_active)
  );
  return jsonb_build_object('userId', p_user_id, 'branchId', p_branch_id, 'role', p_role, 'active', p_active);
end;
$$;

create or replace function api.admin_set_user_active(p_user_id uuid, p_active boolean)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() and not p_active then
    raise exception 'administrator cannot disable current account' using errcode = '22023';
  end if;
  update app.profiles set active = p_active where user_id = p_user_id;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
  if not p_active then
    update app.app_sessions
    set revoked_at = now(), revoked_by = auth.uid()
    where user_id = p_user_id and revoked_at is null;
  end if;
  insert into app.audit_events (
    event_type, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    case when p_active then 'user.enabled' else 'user.disabled' end,
    auth.uid(), app.current_request_device_id(), 'user', p_user_id::text,
    jsonb_build_object('active', p_active)
  );
  return jsonb_build_object('userId', p_user_id, 'active', p_active);
end;
$$;

revoke execute on function api.admin_set_membership(uuid, uuid, app.membership_role, boolean) from public, anon;
create or replace function api.admin_register_migration_source(
  p_source_name text,
  p_source_sha256 text,
  p_source_bytes bigint,
  p_captured_at timestamptz,
  p_row_count bigint,
  p_manifest jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source app.migration_sources%rowtype;
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  if btrim(coalesce(p_source_name, '')) = ''
     or p_source_sha256 !~ '^[a-f0-9]{64}$'
     or p_source_bytes < 0 or p_row_count < 0 then
    raise exception 'invalid migration source' using errcode = '22023';
  end if;
  select * into v_source from app.migration_sources where source_sha256 = p_source_sha256;
  if found then
    if v_source.source_bytes <> p_source_bytes or v_source.row_count is distinct from p_row_count then
      raise exception 'migration source metadata conflicts with existing hash' using errcode = '23505';
    end if;
    return jsonb_build_object('sourceId', v_source.id, 'idempotent', true);
  end if;
  insert into app.migration_sources (
    source_name, source_sha256, source_bytes, captured_at, imported_at, row_count, manifest, created_by
  ) values (
    left(btrim(p_source_name), 240), p_source_sha256, p_source_bytes, p_captured_at,
    now(), p_row_count, coalesce(p_manifest, '{}'::jsonb), auth.uid()
  ) returning * into v_source;
  insert into app.audit_events (
    event_type, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    'migration.source_registered', auth.uid(), app.current_request_device_id(),
    'migration_source', v_source.id::text, jsonb_build_object('sha256', p_source_sha256, 'rowCount', p_row_count)
  );
  return jsonb_build_object('sourceId', v_source.id, 'idempotent', false);
end;
$$;

create or replace function api.admin_import_legacy_order(
  p_source_id uuid,
  p_branch_id uuid,
  p_source_row_key text,
  p_record jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order app.orders%rowtype;
  v_existing app.orders%rowtype;
  v_item record;
  v_conflict_group uuid;
  v_hash text := p_record ->> 'contentSha256';
  v_number text := btrim(p_record ->> 'legacyOrderNumber');
  v_total numeric(12,2) := (p_record #>> '{amounts,total}')::numeric;
  v_deposit numeric(12,2) := (p_record #>> '{amounts,deposit}')::numeric;
  v_remaining numeric(12,2) := (p_record #>> '{amounts,remaining}')::numeric;
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  if not exists (select 1 from app.migration_sources where id = p_source_id)
     or not exists (select 1 from app.branches where id = p_branch_id)
     or btrim(coalesce(p_source_row_key, '')) = ''
     or v_hash !~ '^[a-f0-9]{64}$'
     or v_number = ''
     or btrim(coalesce(p_record #>> '{customer,name}', '')) = ''
     or coalesce(p_record #>> '{customer,phone}', '') !~ '^\+[1-9][0-9]{7,14}$'
     or v_total < 0 or v_deposit < 0 or v_remaining < 0
     or v_deposit > v_total or v_remaining <> v_total - v_deposit then
    raise exception 'invalid legacy order record' using errcode = '22023';
  end if;

  select o.* into v_order
  from app.order_migration_origins origin
  join app.orders o on o.id = origin.order_id
  where origin.migration_source_id = p_source_id and origin.source_row_key = p_source_row_key;
  if found then
    if v_order.migration_content_sha256 <> v_hash then
      raise exception 'source row was already imported with different content' using errcode = '23505';
    end if;
    return jsonb_build_object('orderId', v_order.id, 'legacyOrderNumber', v_number, 'idempotent', true);
  end if;

  select * into v_order
  from app.orders
  where legacy_order_number = v_number and migration_content_sha256 = v_hash
  limit 1;
  if found then
    insert into app.order_migration_origins (order_id, migration_source_id, source_row_key, content_sha256)
    values (v_order.id, p_source_id, p_source_row_key, v_hash);
    return jsonb_build_object('orderId', v_order.id, 'legacyOrderNumber', v_number, 'mergedExactDuplicate', true);
  end if;

  select * into v_existing
  from app.orders
  where legacy_order_number = v_number and migration_source_id is not null
  order by finalized_at, id
  limit 1;

  insert into app.orders (
    legacy_order_number, migration_source_id, migration_content_sha256, branch_id, finalized_by,
    status, snapshot, customer_name, customer_phone_e164, total_amount, deposit_paid,
    remaining_amount, finalized_at, created_at, updated_at
  ) values (
    v_number, p_source_id, v_hash, p_branch_id, auth.uid(),
    'finalized', p_record, btrim(p_record #>> '{customer,name}'), p_record #>> '{customer,phone}',
    v_total, v_deposit, v_remaining, (p_record ->> 'finalizedAt')::timestamptz,
    (p_record ->> 'finalizedAt')::timestamptz, now()
  ) returning * into v_order;

  for v_item in
    select value, ordinality from jsonb_array_elements(coalesce(p_record -> 'services', '[]'::jsonb)) with ordinality
  loop
    insert into app.order_items (order_id, line_number, category, description, products, amount)
    values (
      v_order.id,
      v_item.ordinality::smallint,
      coalesce(nullif(btrim(v_item.value ->> 'category'), ''), 'legacy'),
      coalesce(nullif(btrim(v_item.value ->> 'label'), ''), 'Legacy service'),
      case when jsonb_typeof(v_item.value -> 'products') = 'array' then v_item.value -> 'products' else '[]'::jsonb end,
      case when (v_item.value ->> 'amount') ~ '^[0-9]+(\.[0-9]{1,2})?$' then (v_item.value ->> 'amount')::numeric else null end
    );
  end loop;

  insert into app.order_documents (order_id, status) values (v_order.id, 'pending_upload');
  insert into app.order_migration_origins (order_id, migration_source_id, source_row_key, content_sha256)
  values (v_order.id, p_source_id, p_source_row_key, v_hash);

  if found and v_existing.id is not null then
    select conflict_group into v_conflict_group
    from app.migration_conflicts where legacy_order_number = v_number limit 1;
    v_conflict_group := coalesce(v_conflict_group, gen_random_uuid());
    if not exists (select 1 from app.migration_conflicts where imported_order_id = v_existing.id) then
      insert into app.migration_conflicts (
        migration_source_id, legacy_order_number, conflict_group, imported_order_id, content_sha256, details
      ) values (
        v_existing.migration_source_id, v_number, v_conflict_group, v_existing.id,
        v_existing.migration_content_sha256, jsonb_build_object('state', 'requires_manual_review')
      );
    end if;
    insert into app.migration_conflicts (
      migration_source_id, legacy_order_number, conflict_group, imported_order_id, content_sha256, details
    ) values (
      p_source_id, v_number, v_conflict_group, v_order.id, v_hash,
      jsonb_build_object('state', 'requires_manual_review')
    );
  end if;

  insert into app.audit_events (
    event_type, branch_id, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    'migration.order_imported', p_branch_id, auth.uid(), app.current_request_device_id(),
    'order', v_order.id::text, jsonb_build_object('legacyOrderNumber', v_number, 'sourceId', p_source_id)
  );
  return jsonb_build_object(
    'orderId', v_order.id,
    'legacyOrderNumber', v_number,
    'conflict', v_existing.id is not null,
    'idempotent', false
  );
exception
  when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
    raise exception 'invalid legacy order record' using errcode = '22023';
end;
$$;

create or replace function api.admin_seed_order_counters_from_history()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  insert into app.order_counters (year, next_value)
  select (2000 + substring(legacy_order_number from '^BS-([0-9]{2})-')::integer)::smallint,
         max(substring(legacy_order_number from '^BS-[0-9]{2}-([0-9]+)$')::bigint) + 1
  from app.orders
  where migration_source_id is not null and legacy_order_number ~ '^BS-[0-9]{2}-[0-9]+$'
  group by substring(legacy_order_number from '^BS-([0-9]{2})-')
  on conflict (year) do update
  set next_value = greatest(app.order_counters.next_value, excluded.next_value), updated_at = now();
  get diagnostics v_count = row_count;
  return jsonb_build_object('updatedYears', v_count);
end;
$$;
create or replace function api.admin_set_release_publisher(p_user_id uuid, p_active boolean)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  if not exists (select 1 from app.profiles where user_id = p_user_id and active) then
    raise exception 'active user not found' using errcode = 'P0002';
  end if;
  insert into app.release_publishers (user_id, active, created_by)
  values (p_user_id, p_active, auth.uid())
  on conflict (user_id) do update set active = excluded.active;
  insert into app.audit_events (
    event_type, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    'release_publisher.changed', auth.uid(), app.current_request_device_id(),
    'user', p_user_id::text, jsonb_build_object('active', p_active)
  );
  return jsonb_build_object('userId', p_user_id, 'releasePublisher', p_active);
end;
$$;
create or replace function api.admin_list_devices()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id,
    'ownerUserId', d.owner_user_id,
    'ownerDisplayName', p.display_name,
    'ownerUsername', p.username,
    'installationId', d.installation_id,
    'machineLabel', d.machine_label,
    'state', d.state,
    'updateChannel', d.update_channel,
    'enrolledAt', d.enrolled_at,
    'approvedAt', d.approved_at,
    'revokedAt', d.revoked_at,
    'lastSeenAt', d.last_seen_at,
    'lastServerAt', d.last_server_at
  ) order by
    case d.state when 'pending' then 0 when 'approved' then 1 else 2 end,
    d.enrolled_at desc
  ), '[]'::jsonb)
  into v_result
  from app.devices d
  join app.profiles p on p.user_id = d.owner_user_id;
  return v_result;
end;
$$;

create or replace function api.admin_list_users()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', p.user_id,
    'username', p.username,
    'releasePublisher', exists (select 1 from app.release_publishers rp where rp.user_id = p.user_id and rp.active),
    'displayName', p.display_name,
    'systemAdmin', p.is_system_admin,
    'active', p.active,
    'createdAt', p.created_at,
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'branchId', m.branch_id,
        'branchCode', b.code,
        'branchName', b.name,
        'role', m.role,
        'active', m.active
      ) order by b.name)
      from app.user_branch_memberships m
      join app.branches b on b.id = m.branch_id
      where m.user_id = p.user_id
    ), '[]'::jsonb)
  ) order by p.active desc, p.display_name), '[]'::jsonb)
  into v_result
  from app.profiles p;
  return v_result;
end;
$$;

create or replace function api.admin_upsert_branch(
  p_branch_id uuid,
  p_code text,
  p_name text,
  p_phone_e164 text,
  p_active boolean default true
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_branch app.branches%rowtype;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := btrim(coalesce(p_phone_e164, ''));
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  if v_code !~ '^[A-Z0-9_-]{2,20}$' or v_name = ''
     or (v_phone <> '' and v_phone !~ '^\+[1-9][0-9]{7,14}$') then
    raise exception 'invalid branch data' using errcode = '22023';
  end if;
  if p_branch_id is not null and not p_active
     and exists (select 1 from app.branches where id = p_branch_id and active)
     and (select count(*) from app.branches where active) <= 1 then
    raise exception 'at least one active branch is required' using errcode = '22023';
  end if;

  if p_branch_id is null then
    insert into app.branches (code, name, phone_e164, active)
    values (v_code, v_name, v_phone, p_active)
    returning * into v_branch;
  else
    update app.branches
    set code = v_code, name = v_name, phone_e164 = v_phone, active = p_active
    where id = p_branch_id
    returning * into v_branch;
    if not found then
      raise exception 'branch not found' using errcode = 'P0002';
    end if;
  end if;

  insert into app.audit_events (
    event_type, branch_id, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    case when p_branch_id is null then 'branch.created' else 'branch.updated' end,
    v_branch.id, auth.uid(), app.current_request_device_id(), 'branch', v_branch.id::text,
    jsonb_build_object('code', v_branch.code, 'name', v_branch.name, 'active', v_branch.active)
  );
  return jsonb_build_object(
    'id', v_branch.id,
    'code', v_branch.code,
    'name', v_branch.name,
    'phone', v_branch.phone_e164,
    'active', v_branch.active
  );
end;
$$;

create or replace function api.admin_revoke_sessions(p_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform app.touch_request();
  if not app.current_is_system_admin() then
    raise exception 'system administrator required' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'administrator cannot revoke the current session set' using errcode = '22023';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'revocation reason is required' using errcode = '22023';
  end if;
  if not exists (select 1 from app.profiles where user_id = p_user_id) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  update app.app_sessions
  set revoked_at = now(), revoked_by = auth.uid()
  where user_id = p_user_id and revoked_at is null;
  get diagnostics v_count = row_count;

  insert into app.audit_events (
    event_type, actor_user_id, actor_device_id, entity_type, entity_id, payload
  ) values (
    'sessions.revoked', auth.uid(), app.current_request_device_id(), 'user', p_user_id::text,
    jsonb_build_object('reason', left(btrim(p_reason), 500), 'sessionCount', v_count)
  );
  return jsonb_build_object('userId', p_user_id, 'revokedSessions', v_count);
end;
$$;
revoke execute on function api.admin_set_membership(uuid, uuid, app.membership_role, boolean) from public, anon;
revoke execute on function api.admin_set_user_active(uuid, boolean) from public, anon;
grant execute on function api.admin_set_membership(uuid, uuid, app.membership_role, boolean) to authenticated;
grant execute on function api.admin_set_user_active(uuid, boolean) to authenticated;
revoke execute on function api.admin_list_devices() from public, anon;
revoke execute on function api.admin_list_users() from public, anon;
revoke execute on function api.admin_upsert_branch(uuid, text, text, text, boolean) from public, anon;
revoke execute on function api.admin_revoke_sessions(uuid, text) from public, anon;
grant execute on function api.admin_list_devices() to authenticated;
grant execute on function api.admin_list_users() to authenticated;
grant execute on function api.admin_upsert_branch(uuid, text, text, text, boolean) to authenticated;
grant execute on function api.admin_revoke_sessions(uuid, text) to authenticated;

revoke execute on function api.admin_set_release_publisher(uuid, boolean) from public, anon;
grant execute on function api.admin_set_release_publisher(uuid, boolean) to authenticated;
revoke execute on function api.admin_register_migration_source(text, text, bigint, timestamptz, bigint, jsonb) from public, anon;
revoke execute on function api.admin_import_legacy_order(uuid, uuid, text, jsonb) from public, anon;
revoke execute on function api.admin_seed_order_counters_from_history() from public, anon;
grant execute on function api.admin_register_migration_source(text, text, bigint, timestamptz, bigint, jsonb) to authenticated;
grant execute on function api.admin_import_legacy_order(uuid, uuid, text, jsonb) to authenticated;
grant execute on function api.admin_seed_order_counters_from_history() to authenticated;
commit;
