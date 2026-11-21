-- APPLIED على Supabase (HoloulEnergyQL) بتاريخ 2026-11-21 باسم offline_leases_and_ops — للتوثيق فقط، لا تشغّله تاني.
-- الوضع الأوفلاين: عقود الصلاحية (24 ساعة) + طابور العمليات + مفتاح توقيع العقود. إضافي فقط.

create table public.device_leases (
  id            uuid primary key default gen_random_uuid(),
  device_id     text not null check (device_id ~ '^[A-Za-z0-9-]{16,64}$'),
  actor         text not null,
  actor_ver     integer not null,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  price_version text,
  revoked_at    timestamptz,
  constraint device_leases_max_24h
    check (expires_at > issued_at and expires_at <= issued_at + interval '24 hours')
);
create index device_leases_actor_device_idx on public.device_leases (actor, device_id, issued_at desc);

create table public.device_state (
  device_id    text primary key check (device_id ~ '^[A-Za-z0-9-]{16,64}$'),
  actor        text not null,
  last_seq     bigint not null default 0,
  last_sync_at timestamptz,
  blocked      boolean not null default false
);

create table public.offline_ops (
  id                bigint generated always as identity primary key,
  client_op_id      uuid not null unique,
  device_id         text not null,
  device_seq        bigint not null check (device_seq > 0),
  lease_id          uuid references public.device_leases(id),
  actor             text not null,
  op_type           text not null check (op_type in (
                      'cash_receipt','cash_payment','goods_receipt','goods_delivery','crm_note','quote_draft')),
  payload           jsonb not null check (pg_column_size(payload) <= 65536),
  client_created_at timestamptz not null,
  received_at       timestamptz not null default now(),
  flags             text[] not null default '{}',
  status            text not null check (status in ('accepted','pending_review','applied','rejected','failed')),
  reject_reason     text,
  result            jsonb,
  reviewed_by       text,
  reviewed_at       timestamptz,
  review_note       text
);
create index offline_ops_device_seq_idx on public.offline_ops (device_id, device_seq);
create index offline_ops_lease_idx      on public.offline_ops (lease_id);
create index offline_ops_review_idx     on public.offline_ops (received_at)
  where status in ('pending_review','failed','accepted');

-- مفتاح توقيع العقود (service_role فقط). المفتاح العام فقط مضمّن في holoul-offline.js.
create table public.offline_keys (
  id          smallint primary key check (id = 1),
  public_jwk  jsonb not null,
  private_jwk jsonb not null,
  created_at  timestamptz not null default now()
);
-- (صف المفتاح أُدخل بعد الـmigration بشكل منفصل ولا يُحفظ في الريبو.)

alter table public.device_leases enable row level security;
alter table public.device_state  enable row level security;
alter table public.offline_ops   enable row level security;
alter table public.offline_keys  enable row level security;
revoke all on public.device_leases, public.device_state, public.offline_ops, public.offline_keys from anon, authenticated;

create or replace function public.offline_register_op(
  p_device_id          text,
  p_actor              text,
  p_device_seq         bigint,
  p_client_op_id       uuid,
  p_lease_id           uuid,
  p_op_type            text,
  p_payload            jsonb,
  p_client_created_at  timestamptz
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_state    public.device_state%rowtype;
  v_lease    public.device_leases%rowtype;
  v_existing public.offline_ops%rowtype;
  v_flags    text[] := '{}';
  v_reject   text;
  v_status   text;
  v_id       bigint;
begin
  insert into public.device_state (device_id, actor)
    values (p_device_id, p_actor)
    on conflict (device_id) do nothing;

  select * into v_state from public.device_state where device_id = p_device_id for update;

  if v_state.blocked then
    return jsonb_build_object('status','rejected','reject_reason','device_blocked');
  end if;

  select * into v_existing from public.offline_ops where client_op_id = p_client_op_id;
  if found then
    return jsonb_build_object('id', v_existing.id, 'status', v_existing.status,
                              'flags', to_jsonb(v_existing.flags), 'duplicate', true,
                              'result', v_existing.result, 'reject_reason', v_existing.reject_reason);
  end if;

  select * into v_lease from public.device_leases where id = p_lease_id;
  if not found or v_lease.actor <> p_actor or v_lease.device_id <> p_device_id then
    v_reject := 'bad_lease';
  else
    if p_client_created_at > v_lease.expires_at then
      v_flags := array_append(v_flags, 'late');
    end if;
    if p_client_created_at < v_lease.issued_at - interval '5 minutes' then
      v_flags := array_append(v_flags, 'before_lease');
    end if;
    if v_lease.revoked_at is not null and p_client_created_at > v_lease.revoked_at then
      v_flags := array_append(v_flags, 'after_revoke');
    end if;
  end if;

  if p_client_created_at > now() + interval '5 minutes' then
    v_flags := array_append(v_flags, 'clock_future');
  end if;

  if p_device_seq <= v_state.last_seq then
    v_reject := coalesce(v_reject, 'seq_replay');
  elsif p_device_seq > v_state.last_seq + 1 then
    v_flags := array_append(v_flags, 'seq_gap');
  end if;

  if 'late' = any (v_flags) and p_op_type = 'quote_draft' then
    v_reject := coalesce(v_reject, 'late_not_allowed');
  end if;

  v_status := case
    when v_reject is not null     then 'rejected'
    when cardinality(v_flags) > 0 then 'pending_review'
    else 'accepted'
  end;

  insert into public.offline_ops
    (client_op_id, device_id, device_seq, lease_id, actor, op_type, payload,
     client_created_at, flags, status, reject_reason)
  values
    (p_client_op_id, p_device_id, p_device_seq,
     case when v_reject = 'bad_lease' then null else p_lease_id end,
     p_actor, p_op_type, p_payload, p_client_created_at, v_flags, v_status, v_reject)
  returning id into v_id;

  if v_reject is null then
    update public.device_state
       set last_seq = greatest(last_seq, p_device_seq), last_sync_at = now()
     where device_id = p_device_id;
  end if;

  return jsonb_build_object('id', v_id, 'status', v_status,
                            'flags', to_jsonb(v_flags), 'reject_reason', v_reject);
end;
$$;

revoke execute on function public.offline_register_op(text,text,bigint,uuid,uuid,text,jsonb,timestamptz) from public, anon, authenticated;
grant  execute on function public.offline_register_op(text,text,bigint,uuid,uuid,text,jsonb,timestamptz) to service_role;
