create table if not exists public.refunds (
  notification_id text primary key,
  event jsonb not null,
  received_at timestamptz not null default now()
);

create table if not exists public.refund_actions (
  action_id text primary key,
  notification_id text not null unique references public.refunds(notification_id) on delete restrict,
  transaction_id text,
  user_id bigint,
  product_id bigint,
  robux_amount bigint,
  status text not null check (status in ('PENDING', 'PROCESSING', 'APPLIED', 'FAILED', 'IGNORED')),
  attempt integer not null default 0 check (attempt >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  lease_token text,
  lease_expires_at timestamptz,
  last_error text,
  resolution_reason text
);

create index if not exists refund_actions_status_updated_idx
  on public.refund_actions(status, updated_at desc);

create index if not exists refund_actions_lease_idx
  on public.refund_actions(status, lease_expires_at)
  where status = 'PROCESSING';

alter table public.refunds enable row level security;
alter table public.refund_actions enable row level security;

create or replace function public.rb_ingest_refund(p_event jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_notification_id text := p_event->>'NotificationId';
  v_payload jsonb := coalesce(p_event->'EventPayload', '{}'::jsonb);
  v_inserted integer := 0;
  v_received_at timestamptz := coalesce(
    nullif(p_event->>'ReceivedAt', '')::timestamptz,
    now()
  );
begin
  if v_notification_id is null or v_notification_id = '' then
    raise exception 'NotificationId is required';
  end if;

  insert into public.refunds(notification_id, event, received_at)
  values (v_notification_id, p_event, v_received_at)
  on conflict (notification_id) do nothing;

  get diagnostics v_inserted = row_count;

  insert into public.refund_actions(
    action_id,
    notification_id,
    transaction_id,
    user_id,
    product_id,
    robux_amount,
    status,
    attempt,
    created_at,
    updated_at
  )
  values (
    v_notification_id,
    v_notification_id,
    v_payload->>'TransactionId',
    nullif(v_payload->>'UserId', '')::bigint,
    nullif(v_payload->>'ProductId', '')::bigint,
    nullif(v_payload->>'RobuxAmount', '')::bigint,
    'PENDING',
    0,
    v_received_at,
    v_received_at
  )
  on conflict (action_id) do nothing;

  return jsonb_build_object(
    'stored', v_inserted = 1,
    'duplicate', v_inserted = 0
  );
end;
$$;

create or replace function public.rb_list_actions(
  p_status text default null,
  p_claimable boolean default false,
  p_limit integer default 20
)
returns setof public.refund_actions
language sql
stable
as $$
  select a.*
  from public.refund_actions a
  where
    case
      when p_claimable then
        a.status = 'PENDING'
        or (
          a.status = 'PROCESSING'
          and (a.lease_expires_at is null or a.lease_expires_at <= now())
        )
      when p_status is not null then a.status = upper(p_status)
      else true
    end
  order by a.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

create or replace function public.rb_claim_action(
  p_action_id text,
  p_lease_token text,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
as $$
declare
  v_action public.refund_actions%rowtype;
  v_seconds integer := greatest(15, least(coalesce(p_lease_seconds, 60), 300));
begin
  update public.refund_actions
  set
    status = 'PROCESSING',
    attempt = attempt + 1,
    updated_at = now(),
    lease_token = p_lease_token,
    lease_expires_at = now() + make_interval(secs => v_seconds),
    last_error = null
  where action_id = p_action_id
    and (
      status = 'PENDING'
      or (
        status = 'PROCESSING'
        and (lease_expires_at is null or lease_expires_at <= now())
      )
    )
  returning * into v_action;

  if found then
    return jsonb_build_object('ok', true, 'idempotent', false, 'action', to_jsonb(v_action));
  end if;

  select * into v_action from public.refund_actions where action_id = p_action_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'action_not_found');
  end if;

  if v_action.status = 'PROCESSING'
    and v_action.lease_expires_at is not null
    and v_action.lease_expires_at > now() then
    return jsonb_build_object('ok', false, 'reason', 'action_already_leased');
  end if;

  return jsonb_build_object('ok', false, 'reason', 'action_not_claimable');
end;
$$;

create or replace function public.rb_complete_action(
  p_action_id text,
  p_lease_token text
)
returns jsonb
language plpgsql
as $$
declare
  v_action public.refund_actions%rowtype;
begin
  select * into v_action from public.refund_actions where action_id = p_action_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'action_not_found');
  end if;

  if v_action.status = 'APPLIED' then
    if v_action.lease_token = p_lease_token then
      return jsonb_build_object('ok', true, 'idempotent', true, 'action', to_jsonb(v_action));
    end if;
    return jsonb_build_object('ok', false, 'reason', 'lease_token_mismatch');
  end if;

  if v_action.status <> 'PROCESSING' then
    return jsonb_build_object('ok', false, 'reason', 'action_not_processing');
  end if;

  if v_action.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'reason', 'lease_token_mismatch');
  end if;

  update public.refund_actions
  set
    status = 'APPLIED',
    updated_at = now(),
    lease_expires_at = null,
    last_error = null
  where action_id = p_action_id
    and status = 'PROCESSING'
    and lease_token is not distinct from p_lease_token
  returning * into v_action;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'lease_token_mismatch');
  end if;

  return jsonb_build_object('ok', true, 'idempotent', false, 'action', to_jsonb(v_action));
end;
$$;

create or replace function public.rb_fail_action(
  p_action_id text,
  p_lease_token text,
  p_error text default 'handler_failed'
)
returns jsonb
language plpgsql
as $$
declare
  v_action public.refund_actions%rowtype;
begin
  select * into v_action from public.refund_actions where action_id = p_action_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'action_not_found');
  end if;

  if v_action.status = 'FAILED' and v_action.lease_token = p_lease_token then
    return jsonb_build_object('ok', true, 'idempotent', true, 'action', to_jsonb(v_action));
  end if;

  if v_action.status <> 'PROCESSING' then
    return jsonb_build_object('ok', false, 'reason', 'action_not_processing');
  end if;

  if v_action.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'reason', 'lease_token_mismatch');
  end if;

  update public.refund_actions
  set
    status = 'FAILED',
    updated_at = now(),
    lease_expires_at = null,
    last_error = left(coalesce(nullif(p_error, ''), 'handler_failed'), 500)
  where action_id = p_action_id
    and status = 'PROCESSING'
    and lease_token is not distinct from p_lease_token
  returning * into v_action;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'lease_token_mismatch');
  end if;

  return jsonb_build_object('ok', true, 'idempotent', false, 'action', to_jsonb(v_action));
end;
$$;

create or replace function public.rb_ignore_action(
  p_action_id text,
  p_reason text default 'manual_ignore'
)
returns jsonb
language plpgsql
as $$
declare
  v_action public.refund_actions%rowtype;
begin
  select * into v_action from public.refund_actions where action_id = p_action_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'action_not_found');
  end if;

  if v_action.status = 'IGNORED' then
    return jsonb_build_object('ok', true, 'idempotent', true, 'action', to_jsonb(v_action));
  end if;

  if v_action.status not in ('PENDING', 'FAILED') then
    return jsonb_build_object('ok', false, 'reason', 'action_not_ignorable');
  end if;

  update public.refund_actions
  set
    status = 'IGNORED',
    updated_at = now(),
    lease_token = null,
    lease_expires_at = null,
    resolution_reason = left(coalesce(nullif(p_reason, ''), 'manual_ignore'), 500)
  where action_id = p_action_id
    and status in ('PENDING', 'FAILED')
  returning * into v_action;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'action_not_ignorable');
  end if;

  return jsonb_build_object('ok', true, 'idempotent', false, 'action', to_jsonb(v_action));
end;
$$;

create or replace function public.rb_retry_action(p_action_id text)
returns jsonb
language plpgsql
as $$
declare
  v_action public.refund_actions%rowtype;
begin
  select * into v_action from public.refund_actions where action_id = p_action_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'action_not_found');
  end if;

  if v_action.status = 'PENDING' then
    return jsonb_build_object('ok', true, 'idempotent', true, 'action', to_jsonb(v_action));
  end if;

  if v_action.status <> 'FAILED' then
    return jsonb_build_object('ok', false, 'reason', 'action_not_retryable');
  end if;

  update public.refund_actions
  set
    status = 'PENDING',
    updated_at = now(),
    lease_token = null,
    lease_expires_at = null,
    last_error = null,
    resolution_reason = null
  where action_id = p_action_id
    and status = 'FAILED'
  returning * into v_action;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'action_not_retryable');
  end if;

  return jsonb_build_object('ok', true, 'idempotent', false, 'action', to_jsonb(v_action));
end;
$$;
