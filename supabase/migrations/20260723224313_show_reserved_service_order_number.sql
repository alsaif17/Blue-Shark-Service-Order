create or replace function api.reserve_order_number(p_command_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_year smallint;
  v_sequence bigint;
  v_response jsonb;
begin
  perform app.touch_request();
  if v_user_id is null or not app.request_is_approved() then
    raise exception 'approved device required' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text, 0));
  select response into v_response
  from app.command_results
  where command_id = p_command_id
    and user_id = v_user_id
    and operation = 'reserve_order_number';
  if found then
    return v_response;
  end if;

  v_year := extract(year from timezone('Asia/Riyadh', now()))::smallint;
  insert into app.order_counters (year, next_value)
  values (v_year, 2)
  on conflict (year) do update
    set next_value = app.order_counters.next_value + 1,
        updated_at = now()
  returning next_value - 1 into v_sequence;

  v_response := jsonb_build_object(
    'orderNumber', 'BS-' || right(v_year::text, 2) || '-' || lpad(v_sequence::text, 4, '0')
  );

  insert into app.command_results (command_id, user_id, operation, response)
  values (p_command_id, v_user_id, 'reserve_order_number', v_response);
  return v_response;
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
  v_reservation jsonb;
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

  select response into v_reservation
  from app.command_results
  where command_id = p_command_id
    and user_id = v_user_id
    and operation = 'reserve_order_number';

  if found then
    v_order_number := v_reservation ->> 'orderNumber';
    if v_order_number is null
       or v_order_number !~ '^BS-[0-9]{2}-[0-9]{4,}$'
       or exists (select 1 from app.orders where order_number = v_order_number) then
      raise exception 'invalid reserved order number' using errcode = '22023';
    end if;
  else
    v_year := extract(year from timezone('Asia/Riyadh', now()))::smallint;
    insert into app.order_counters (year, next_value)
    values (v_year, 2)
    on conflict (year) do update
      set next_value = app.order_counters.next_value + 1,
          updated_at = now()
    returning next_value - 1 into v_sequence;
    v_order_number := 'BS-' || right(v_year::text, 2) || '-' || lpad(v_sequence::text, 4, '0');
  end if;

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

revoke execute on function api.reserve_order_number(uuid) from public, anon;
grant execute on function api.reserve_order_number(uuid) to authenticated;
