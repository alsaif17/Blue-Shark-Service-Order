create index if not exists app_sessions_revoked_by_idx on app.app_sessions (revoked_by);
create index if not exists audit_events_actor_device_id_idx on app.audit_events (actor_device_id);
create index if not exists devices_approved_by_idx on app.devices (approved_by);
create index if not exists devices_revoked_by_idx on app.devices (revoked_by);
create index if not exists migration_conflicts_imported_order_id_idx on app.migration_conflicts (imported_order_id);
create index if not exists migration_conflicts_migration_source_id_idx on app.migration_conflicts (migration_source_id);
create index if not exists migration_conflicts_resolved_by_idx on app.migration_conflicts (resolved_by);
create index if not exists migration_sources_branch_id_idx on app.migration_sources (branch_id);
create index if not exists migration_sources_created_by_idx on app.migration_sources (created_by);
create index if not exists order_actions_attempted_by_idx on app.order_actions (attempted_by);
create index if not exists order_actions_device_id_idx on app.order_actions (device_id);
create index if not exists order_amendments_amended_by_idx on app.order_amendments (amended_by);
create index if not exists order_documents_uploaded_by_idx on app.order_documents (uploaded_by);
create index if not exists orders_cancelled_by_idx on app.orders (cancelled_by);
create index if not exists orders_finalized_by_idx on app.orders (finalized_by);
create index if not exists orders_migration_source_id_idx on app.orders (migration_source_id);
create index if not exists release_publishers_created_by_idx on app.release_publishers (created_by);
create index if not exists update_releases_published_by_idx on app.update_releases (published_by);

drop policy if exists order_migration_origins_admin_write on app.order_migration_origins;
create policy order_migration_origins_admin_insert on app.order_migration_origins
for insert to authenticated
with check ((select app.current_is_system_admin()));
create policy order_migration_origins_admin_update on app.order_migration_origins
for update to authenticated
using ((select app.current_is_system_admin()))
with check ((select app.current_is_system_admin()));
create policy order_migration_origins_admin_delete on app.order_migration_origins
for delete to authenticated
using ((select app.current_is_system_admin()));
