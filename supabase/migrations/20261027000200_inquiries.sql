-- Inquiries from the public website (clinician interest and facility staffing
-- requests), their activity history, and intake abuse limits.

create type public.inquiry_type as enum ('clinician', 'facility');

create type public.inquiry_stage as enum (
  'new', 'contacted', 'qualified', 'onboarding', 'placed', 'closed'
);

create type public.inquiry_timeline as enum (
  'asap', 'within_1_3_months', 'within_3_6_months', 'exploring'
);

create table public.inquiries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  inquiry_type public.inquiry_type not null,
  source text not null default 'website' check (char_length(source) <= 50),
  stage public.inquiry_stage not null default 'new',
  closed_reason text check (char_length(closed_reason) <= 500),

  -- Contact details as submitted (trimmed; email lowercased).
  full_name text not null check (char_length(full_name) between 2 and 160),
  email text not null
    check (char_length(email) <= 254 and email = lower(email)
           and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text check (char_length(phone) <= 40),

  -- Clinician fields (also used by facilities for the role they need).
  specialty text check (char_length(specialty) <= 80),
  preferred_location text check (char_length(preferred_location) <= 160),
  timeline public.inquiry_timeline,
  housing_assistance_requested boolean not null default false,

  -- Facility fields.
  organization_name text check (char_length(organization_name) <= 200),
  staffing_type text check (char_length(staffing_type) <= 80),
  headcount integer check (headcount between 1 and 1000),
  desired_start_date date,
  desired_end_date date,
  staffing_requirements text check (char_length(staffing_requirements) <= 2000),

  consent_given_at timestamptz not null,
  consent_version text not null check (char_length(consent_version) <= 50),

  -- Pipeline fields, managed by staff in the next delivery phase.
  assigned_recruiter_id uuid references public.profiles (id) on delete set null,
  follow_up_on date,
  version integer not null default 1,

  -- Retry handling: a client-supplied Idempotency-Key, plus a fingerprint used to
  -- collapse identical resubmissions that arrive without one.
  idempotency_key text check (char_length(idempotency_key) between 8 and 200),
  submission_fingerprint text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, idempotency_key),
  check ((stage = 'closed') = (closed_reason is not null)),
  check (desired_end_date is null or desired_start_date is null
         or desired_end_date >= desired_start_date)
);

create index inquiries_org_stage_created_idx
  on public.inquiries (organization_id, stage, created_at desc);
create index inquiries_org_email_idx
  on public.inquiries (organization_id, email);
create index inquiries_assigned_recruiter_idx
  on public.inquiries (assigned_recruiter_id) where assigned_recruiter_id is not null;
create index inquiries_fingerprint_idx
  on public.inquiries (organization_id, submission_fingerprint, created_at desc);

create trigger inquiries_set_updated_at
  before update on public.inquiries
  for each row execute function private.set_updated_at();

create table public.inquiry_events (
  id bigint generated always as identity primary key,
  inquiry_id uuid not null references public.inquiries (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event_type text not null check (char_length(event_type) <= 50),
  from_stage public.inquiry_stage,
  to_stage public.inquiry_stage,
  actor_id uuid references public.profiles (id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index inquiry_events_inquiry_idx
  on public.inquiry_events (inquiry_id, created_at);

-- Fixed-window counters keyed by hashed identifiers (never raw IPs or emails).
create table public.intake_rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);

-- Row Level Security --------------------------------------------------------

alter table public.inquiries enable row level security;
alter table public.inquiry_events enable row level security;
alter table public.intake_rate_limits enable row level security;

revoke all on public.inquiries, public.inquiry_events, public.intake_rate_limits
  from anon, authenticated;

grant select on public.inquiries to authenticated;
grant select on public.inquiry_events to authenticated;

create policy "Staff read their organization's inquiries"
  on public.inquiries for select to authenticated
  using (private.has_org_role(organization_id));

create policy "Staff read their organization's inquiry events"
  on public.inquiry_events for select to authenticated
  using (private.has_org_role(organization_id));

-- No client write policies. Public submissions go through submit_inquiry below;
-- staff pipeline changes will go through validated functions.

-- Intake --------------------------------------------------------------------

create or replace function private.hit_rate_limit(
  p_bucket text,
  p_window interval,
  p_limit integer
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_window_start timestamptz :=
    to_timestamp(floor(extract(epoch from now()) / extract(epoch from p_window))
                 * extract(epoch from p_window));
  v_hits integer;
begin
  insert into public.intake_rate_limits as r (bucket, window_start, hits)
  values (p_bucket, v_window_start, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;

  return v_hits > p_limit;
end;
$$;

-- Saves a validated public submission and queues its notifications in one
-- transaction. Callable only with the service role (the intake Edge Function),
-- which has already validated and normalized the payload; table constraints
-- enforce the same limits again here.
--
-- Returns {"status": "created" | "duplicate" | "rate_limited", "inquiry_id"?}.
create or replace function public.submit_inquiry(
  p_organization_slug text,
  p_inquiry jsonb,
  p_idempotency_key text default null,
  p_client_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations;
  v_email text := lower(trim(p_inquiry ->> 'email'));
  v_type public.inquiry_type := (p_inquiry ->> 'inquiry_type')::public.inquiry_type;
  v_fingerprint text;
  v_existing uuid;
  v_inquiry public.inquiries;
begin
  select * into v_org from public.organizations where slug = p_organization_slug;
  if not found then
    raise exception 'Unknown intake organization' using errcode = 'P0002';
  end if;

  -- Same person + type + content => same fingerprint.
  v_fingerprint := encode(sha256(convert_to(
    concat_ws('|', v_type, v_email,
      p_inquiry ->> 'full_name', p_inquiry ->> 'phone', p_inquiry ->> 'specialty',
      p_inquiry ->> 'preferred_location', p_inquiry ->> 'timeline',
      p_inquiry ->> 'organization_name', p_inquiry ->> 'staffing_type',
      p_inquiry ->> 'headcount', p_inquiry ->> 'desired_start_date',
      p_inquiry ->> 'desired_end_date', p_inquiry ->> 'staffing_requirements',
      p_inquiry ->> 'housing_assistance_requested'),
    'UTF8')), 'hex');

  -- Serialize submissions for one email so the duplicate checks below are race-free.
  perform pg_advisory_xact_lock(hashtextextended(v_org.id::text || ':' || v_email, 0));

  -- A retried request with the same Idempotency-Key returns the original result.
  if p_idempotency_key is not null then
    select id into v_existing from public.inquiries
    where organization_id = v_org.id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('status', 'duplicate', 'inquiry_id', v_existing);
    end if;
  end if;

  -- An identical submission within 30 minutes (double-click, browser retry
  -- without a key) is treated as the same inquiry.
  select id into v_existing from public.inquiries
  where organization_id = v_org.id
    and submission_fingerprint = v_fingerprint
    and created_at > now() - interval '30 minutes'
  order by created_at desc
  limit 1;
  if found then
    return jsonb_build_object('status', 'duplicate', 'inquiry_id', v_existing);
  end if;

  -- Abuse limits: per client (hashed IP) and per email address.
  if p_client_hash is not null
     and private.hit_rate_limit('client:' || p_client_hash, interval '10 minutes', 5) then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  if private.hit_rate_limit(
       'email:' || encode(sha256(convert_to(v_org.id::text || v_email, 'UTF8')), 'hex'),
       interval '1 hour', 3) then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  insert into public.inquiries (
    organization_id, inquiry_type, source, full_name, email, phone,
    specialty, preferred_location, timeline, housing_assistance_requested,
    organization_name, staffing_type, headcount, desired_start_date,
    desired_end_date, staffing_requirements, consent_given_at, consent_version,
    idempotency_key, submission_fingerprint
  ) values (
    v_org.id, v_type, coalesce(p_inquiry ->> 'source', 'website'),
    trim(p_inquiry ->> 'full_name'), v_email, nullif(trim(p_inquiry ->> 'phone'), ''),
    nullif(trim(p_inquiry ->> 'specialty'), ''),
    nullif(trim(p_inquiry ->> 'preferred_location'), ''),
    (p_inquiry ->> 'timeline')::public.inquiry_timeline,
    coalesce((p_inquiry ->> 'housing_assistance_requested')::boolean, false),
    nullif(trim(p_inquiry ->> 'organization_name'), ''),
    nullif(trim(p_inquiry ->> 'staffing_type'), ''),
    (p_inquiry ->> 'headcount')::integer,
    (p_inquiry ->> 'desired_start_date')::date,
    (p_inquiry ->> 'desired_end_date')::date,
    nullif(trim(p_inquiry ->> 'staffing_requirements'), ''),
    now(), p_inquiry ->> 'consent_version',
    p_idempotency_key, v_fingerprint
  )
  returning * into v_inquiry;

  insert into public.inquiry_events (inquiry_id, organization_id, event_type, to_stage, details)
  values (v_inquiry.id, v_org.id, 'submitted', 'new',
          jsonb_build_object('source', v_inquiry.source));

  -- Notification payloads carry no contact details beyond the recipient address;
  -- templates link staff to the authenticated dashboard instead.
  insert into public.notification_outbox
    (organization_id, dedupe_key, template, recipient, template_data, inquiry_id)
  values
    (v_org.id, 'inquiry:' || v_inquiry.id || ':confirmation',
     case v_type when 'clinician' then 'clinician_inquiry_confirmation'
                 else 'facility_inquiry_confirmation' end,
     v_email,
     jsonb_build_object('organization_name', v_org.name),
     v_inquiry.id);

  if v_org.intake_notification_email is not null then
    insert into public.notification_outbox
      (organization_id, dedupe_key, template, recipient, template_data, inquiry_id)
    values
      (v_org.id, 'inquiry:' || v_inquiry.id || ':staff_alert',
       'staff_new_inquiry_alert',
       v_org.intake_notification_email,
       jsonb_build_object('inquiry_id', v_inquiry.id, 'inquiry_type', v_type,
                          'specialty', v_inquiry.specialty),
       v_inquiry.id);
  end if;

  return jsonb_build_object('status', 'created', 'inquiry_id', v_inquiry.id);
end;
$$;

revoke all on function public.submit_inquiry(text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_inquiry(text, jsonb, text, text) to service_role;

revoke all on function private.hit_rate_limit(text, interval, integer) from public;
