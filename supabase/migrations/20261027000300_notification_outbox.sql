-- Durable notification outbox. Rows are written in the same transaction as the
-- record that caused them, so a provider outage never loses an intake. A worker
-- (the process-outbox Edge Function) claims due rows, sends them, and records
-- the outcome with bounded retries.

create type public.notification_status as enum (
  'pending', 'sending', 'sent', 'failed', 'cancelled'
);

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- One logical notification per key, e.g. inquiry:<id>:confirmation.
  dedupe_key text not null unique check (char_length(dedupe_key) <= 200),
  channel text not null default 'email' check (channel in ('email')),
  template text not null check (char_length(template) <= 100),
  recipient text not null check (char_length(recipient) <= 254),
  template_data jsonb not null default '{}'::jsonb,
  inquiry_id uuid references public.inquiries (id) on delete set null,

  status public.notification_status not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text check (char_length(last_error) <= 500),
  provider text check (char_length(provider) <= 50),
  provider_message_id text check (char_length(provider_message_id) <= 200),
  sent_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notification_outbox_due_idx
  on public.notification_outbox (next_attempt_at)
  where status in ('pending', 'sending');
create index notification_outbox_org_created_idx
  on public.notification_outbox (organization_id, created_at desc);
create index notification_outbox_inquiry_idx
  on public.notification_outbox (inquiry_id) where inquiry_id is not null;

create trigger notification_outbox_set_updated_at
  before update on public.notification_outbox
  for each row execute function private.set_updated_at();

alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from anon, authenticated;
grant select on public.notification_outbox to authenticated;

-- Operational visibility for agency admins. Recipients are email addresses, so
-- recruiters do not get this view by default.
create policy "Admins read their organization's notifications"
  on public.notification_outbox for select to authenticated
  using (private.has_org_role(organization_id, array['admin']::public.org_role[]));

-- Worker functions (service role only) --------------------------------------

-- Claims up to p_limit due notifications. A row stuck in 'sending' past its
-- lease (worker crashed) becomes claimable again; the provider idempotency key
-- (the row id) keeps that retry from producing a second email.
create or replace function public.claim_notifications(
  p_limit integer default 20,
  p_lease_seconds integer default 120
)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Expired leases that have used every attempt are finished as failed.
  update public.notification_outbox
  set status = 'failed', locked_until = null,
      last_error = coalesce(last_error, 'Lease expired after final attempt')
  where status = 'sending' and locked_until < now() and attempts >= max_attempts;

  return query
  update public.notification_outbox o
  set status = 'sending',
      attempts = o.attempts + 1,
      locked_until = now() + make_interval(secs => p_lease_seconds)
  where o.id in (
    select c.id from public.notification_outbox c
    where c.attempts < c.max_attempts
      and ((c.status = 'pending' and c.next_attempt_at <= now())
           or (c.status = 'sending' and c.locked_until < now()))
    order by c.next_attempt_at
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  )
  returning o.*;
end;
$$;

-- Records a send outcome. Only a row currently claimed ('sending') changes, so
-- a late report from a worker whose lease expired cannot undo a later result.
-- Failed retryable sends back off exponentially (1, 2, 4 ... capped at 60 min).
create or replace function public.complete_notification(
  p_id uuid,
  p_success boolean,
  p_provider text default null,
  p_provider_message_id text default null,
  p_error text default null,
  p_retryable boolean default true
)
returns public.notification_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.notification_status;
begin
  update public.notification_outbox
  set status = case
        when p_success then 'sent'
        when p_retryable and attempts < max_attempts then 'pending'
        else 'failed'
      end::public.notification_status,
      sent_at = case when p_success then now() end,
      provider = coalesce(p_provider, provider),
      provider_message_id = coalesce(p_provider_message_id, provider_message_id),
      last_error = case when p_success then null else left(p_error, 500) end,
      locked_until = null,
      next_attempt_at = case
        when p_success then next_attempt_at
        else now() + make_interval(mins => least(60, power(2, attempts - 1)::integer))
      end
  where id = p_id and status = 'sending'
  returning status into v_status;

  return v_status;
end;
$$;

revoke all on function public.claim_notifications(integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_notification(uuid, boolean, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_notifications(integer, integer) to service_role;
grant execute on function public.complete_notification(uuid, boolean, text, text, text, boolean)
  to service_role;
