begin;
select plan(28);

select has_schema('app', 'internal app schema exists');
select has_schema('api', 'dedicated api schema exists');
select has_table('app', 'orders', 'central orders table exists');
select has_table('app', 'devices', 'device registry exists');
select has_table('app', 'audit_events', 'append-only audit stream exists');

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'app.orders'::regclass),
  'orders enforce row level security'
);

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'app.devices'::regclass),
  'devices enforce row level security'
);

select ok(
  not has_schema_privilege('anon', 'app', 'usage'),
  'anonymous role cannot use internal schema'
);

select ok(
  not has_function_privilege(
    'anon',
    'api.finalize_order(uuid,uuid,jsonb,bigint)',
    'execute'
  ),
  'anonymous role cannot finalize orders'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.finalize_order(uuid,uuid,jsonb,bigint)',
    'execute'
  ),
  'authenticated role can call the guarded finalization rpc'
);

select ok(
  not has_function_privilege(
    'anon',
    'api.reserve_order_number(uuid)',
    'execute'
  ),
  'anonymous role cannot reserve order numbers'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.reserve_order_number(uuid)',
    'execute'
  ),
  'authenticated users can call the approved-device number reservation rpc'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'api.edge_check_update(uuid,text,bigint)',
    'execute'
  ),
  'client users cannot call the privileged update lookup'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.edge_check_update(uuid,text,bigint)',
    'execute'
  ),
  'edge service can call only the update lookup entry point'
);

select ok(
  to_regprocedure('api.admin_list_devices()') is not null,
  'device administration list rpc exists'
);

select ok(
  to_regprocedure('api.admin_list_users()') is not null,
  'user administration list rpc exists'
);

select ok(
  to_regprocedure('api.admin_upsert_branch(uuid,text,text,text,boolean)') is not null,
  'branch administration rpc exists'
);

select ok(
  to_regprocedure('api.admin_revoke_sessions(uuid,text)') is not null,
  'session revocation rpc exists'
);

select ok(
  not has_function_privilege(
    'anon',
    'api.admin_upsert_branch(uuid,text,text,text,boolean)',
    'execute'
  ),
  'anonymous role cannot administer branches'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.admin_upsert_branch(uuid,text,text,text,boolean)',
    'execute'
  ),
  'authenticated role can call the guarded branch administration rpc'
);

select ok(
  position('current_is_aal2' in pg_get_functiondef('app.current_is_system_admin()'::regprocedure)) = 0,
  'system administrator checks accept password-authenticated sessions'
);

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'app.branches'::regclass),
  'branches enforce row level security'
);

select ok(
  to_regclass('app.order_migration_origins') is not null,
  'migration origin provenance table exists'
);

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'app.order_migration_origins'::regclass),
  'migration origins enforce row level security'
);

select ok(
  to_regprocedure('api.admin_register_migration_source(text,text,bigint,timestamptz,bigint,jsonb)') is not null,
  'migration source registration rpc exists'
);

select ok(
  to_regprocedure('api.admin_import_legacy_order(uuid,uuid,text,jsonb)') is not null,
  'idempotent legacy order import rpc exists'
);
select is((select public from storage.buckets where id = 'order-documents'), false, 'order documents bucket is private');
select is((select public from storage.buckets where id = 'app-updates'), false, 'update bucket is private');

select * from finish();
rollback;
