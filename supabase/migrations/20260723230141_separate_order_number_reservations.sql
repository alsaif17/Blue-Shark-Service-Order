alter table app.command_results
  drop constraint command_results_pkey;

alter table app.command_results
  add constraint command_results_pkey primary key (command_id, operation);
