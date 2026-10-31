-- Phase 3: jobs and applications.
--
-- Recruiters enter job orders by hand in ward (from direct facility contracts).
-- Each job is split in two:
--   jobs                  fields that may be published on the job board
--   job_internal_details  facility, requisition, rates and notes; staff only
-- The split is in the schema rather than the UI so nothing internal can reach
-- a public listing by mistake: the only public read path is list_public_jobs,
-- which selects from jobs alone.
--
-- Pay is internal only for now. Whether rates (and the facility name) may be
-- published depends on each supplier agreement; see docs/STATUS.md.
--
-- Errors follow the staff pipeline migration: PT400 (safe to show), PT404 (not
-- found or another organization), PT409 (stale version).

create type public.job_status as enum ('draft', 'open', 'on_hold', 'filled', 'closed');
create type public.job_employment_type as enum ('travel', 'local_contract', 'per_diem', 'permanent');
create type public.job_shift as enum ('day', 'evening', 'night', 'rotating', 'variable');
create type public.job_source as enum ('direct_contract', 'vms', 'other');

create type public.application_stage as enum (
  'applied', 'screening', 'submitted', 'offered', 'hired', 'rejected', 'withdrawn'
);
create type public.application_source as enum ('website', 'recruiter');

-- Jobs ----------------------------------------------------------------------

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  status public.job_status not null default 'draft',

  -- Public fields. Everything in this block may appear on the job board.
  title text not null check (char_length(title) between 1 and 120),
  specialty text not null check (char_length(specialty) between 1 and 80),
  employment_type public.job_employment_type not null,
  city text not null check (char_length(city) between 1 and 100),
  state text not null check (state ~ '^[A-Z]{2}$'),
  shift public.job_shift,
  hours_per_week integer check (hours_per_week between 1 and 84),
  start_date date,
  duration_weeks integer check (duration_weeks between 1 and 104),
  openings integer not null default 1 check (openings between 1 and 100),
  public_description text check (char_length(public_description) <= 4000),

  -- Set the first time the job opens. A published job can't return to draft.
  published_at timestamptz,
  version integer not null default 1,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_org_status_idx on public.jobs (organization_id, status, created_at desc);

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function private.set_updated_at();

create table public.job_internal_details (
  job_id uuid primary key references public.jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  facility_name text not null check (char_length(facility_name) between 1 and 200),
  facility_contact text check (char_length(facility_contact) <= 300),
  source public.job_source not null default 'direct_contract',
  requisition_reference text check (char_length(requisition_reference) <= 100),
  rate_notes text check (char_length(rate_notes) <= 2000),
  internal_notes text check (char_length(internal_notes) <= 4000),
  updated_at timestamptz not null default now()
);

create trigger job_internal_details_set_updated_at
  before update on public.job_internal_details
  for each row execute function private.set_updated_at();

create table public.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event_type text not null check (char_length(event_type) <= 50),
  from_status public.job_status,
  to_status public.job_status,
  actor_id uuid references public.profiles (id) on delete set null,
  -- Field names only, never values, so rates don't spread into the history.
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index job_events_job_idx on public.job_events (job_id, created_at);

-- Applications --------------------------------------------------------------

create table public.job_applications (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- Set when a recruiter puts forward a clinician who came in as an inquiry.
  inquiry_id uuid references public.inquiries (id) on delete set null,
  source public.application_source not null,
  stage public.application_stage not null default 'applied',
  stage_reason text check (char_length(stage_reason) <= 500),

  full_name text not null check (char_length(full_name) between 2 and 160),
  email text not null
    check (char_length(email) <= 254 and email = lower(email)
           and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text check (char_length(phone) <= 40),

  -- Website applications record the consent text the applicant agreed to.
  consent_given_at timestamptz,
  consent_version text check (char_length(consent_version) <= 50),

  version integer not null default 1,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One application per person per job. Resubmissions return the original.
  unique (job_id, email),
  check ((stage in ('rejected', 'withdrawn')) = (stage_reason is not null)),
  check (source <> 'website' or (consent_given_at is not null and consent_version is not null))
);

create index job_applications_job_idx on public.job_applications (job_id, created_at desc);
create index job_applications_inquiry_idx on public.job_applications (inquiry_id) where inquiry_id is not null;

create trigger job_applications_set_updated_at
  before update on public.job_applications
  for each row execute function private.set_updated_at();

create table public.application_events (
  id bigint generated always as identity primary key,
  application_id uuid not null references public.job_applications (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event_type text not null check (char_length(event_type) <= 50),
  from_stage public.application_stage,
  to_stage public.application_stage,
  actor_id uuid references public.profiles (id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index application_events_application_idx on public.application_events (application_id, created_at);

-- Row Level Security --------------------------------------------------------
-- Staff read their own organization's rows. Every write goes through the
-- functions below. Anonymous users have no table access at all; the job board
-- reads through list_public_jobs.

alter table public.jobs enable row level security;
alter table public.job_internal_details enable row level security;
alter table public.job_events enable row level security;
alter table public.job_applications enable row level security;
alter table public.application_events enable row level security;

revoke all on public.jobs, public.job_internal_details, public.job_events,
  public.job_applications, public.application_events
  from anon, authenticated;

grant select on public.jobs, public.job_internal_details, public.job_events,
  public.job_applications, public.application_events
  to authenticated;

create policy "Staff read their organization's jobs"
  on public.jobs for select to authenticated
  using (private.has_org_role(organization_id));

create policy "Staff read their organization's internal job details"
  on public.job_internal_details for select to authenticated
  using (private.has_org_role(organization_id));

create policy "Staff read their organization's job events"
  on public.job_events for select to authenticated
  using (private.has_org_role(organization_id));

create policy "Staff read their organization's applications"
  on public.job_applications for select to authenticated
  using (private.has_org_role(organization_id));

create policy "Staff read their organization's application events"
  on public.application_events for select to authenticated
  using (private.has_org_role(organization_id));

-- Input parsing ---------------------------------------------------------------

create or replace function private.require_length(p_value text, p_max integer, p_label text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if char_length(p_value) > p_max then
    raise exception 'Keep the % under % characters', p_label, p_max using errcode = 'PT400';
  end if;
end;
$$;

-- Builds a jobs row from client input. Only the public fields listed here are
-- read; anything else in the object (including internal fields sent to the
-- wrong place) is ignored.
create or replace function private.job_input(p_job jsonb)
returns public.jobs
language plpgsql
stable
set search_path = ''
as $$
declare
  v public.jobs;
  v_fields jsonb;
begin
  if p_job is null or jsonb_typeof(p_job) <> 'object' then
    raise exception 'Job details are required' using errcode = 'PT400';
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_fields
  from jsonb_each(p_job)
  where key in ('title', 'specialty', 'employment_type', 'city', 'state', 'shift',
                'hours_per_week', 'start_date', 'duration_weeks', 'openings',
                'public_description');

  begin
    v := jsonb_populate_record(null::public.jobs, v_fields);
  exception when data_exception then
    raise exception 'Check the job details: a value is in the wrong format' using errcode = 'PT400';
  end;

  v.title := nullif(trim(v.title), '');
  v.specialty := nullif(trim(v.specialty), '');
  v.city := nullif(trim(v.city), '');
  v.state := upper(nullif(trim(v.state), ''));
  v.public_description := nullif(trim(v.public_description), '');
  v.openings := coalesce(v.openings, 1);

  if v.title is null then raise exception 'Give the job a title' using errcode = 'PT400'; end if;
  if v.specialty is null then raise exception 'Give the job a specialty' using errcode = 'PT400'; end if;
  if v.employment_type is null then raise exception 'Choose an employment type' using errcode = 'PT400'; end if;
  if v.city is null then raise exception 'Give the job a city' using errcode = 'PT400'; end if;
  if v.state is null or v.state !~ '^[A-Z]{2}$' then
    raise exception 'Use a two-letter state code, like TX' using errcode = 'PT400';
  end if;
  perform private.require_length(v.title, 120, 'title');
  perform private.require_length(v.specialty, 80, 'specialty');
  perform private.require_length(v.city, 100, 'city');
  perform private.require_length(v.public_description, 4000, 'public description');
  if v.hours_per_week not between 1 and 84 then
    raise exception 'Hours per week must be between 1 and 84' using errcode = 'PT400';
  end if;
  if v.duration_weeks not between 1 and 104 then
    raise exception 'Duration must be between 1 and 104 weeks' using errcode = 'PT400';
  end if;
  if v.openings not between 1 and 100 then
    raise exception 'Openings must be between 1 and 100' using errcode = 'PT400';
  end if;
  return v;
end;
$$;

create or replace function private.job_internal_input(p_internal jsonb)
returns public.job_internal_details
language plpgsql
stable
set search_path = ''
as $$
declare
  v public.job_internal_details;
  v_fields jsonb;
begin
  if p_internal is null or jsonb_typeof(p_internal) <> 'object' then
    raise exception 'Internal job details are required' using errcode = 'PT400';
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_fields
  from jsonb_each(p_internal)
  where key in ('facility_name', 'facility_contact', 'source', 'requisition_reference',
                'rate_notes', 'internal_notes');

  begin
    v := jsonb_populate_record(null::public.job_internal_details, v_fields);
  exception when data_exception then
    raise exception 'Check the internal details: a value is in the wrong format' using errcode = 'PT400';
  end;

  v.facility_name := nullif(trim(v.facility_name), '');
  v.facility_contact := nullif(trim(v.facility_contact), '');
  v.requisition_reference := nullif(trim(v.requisition_reference), '');
  v.rate_notes := nullif(trim(v.rate_notes), '');
  v.internal_notes := nullif(trim(v.internal_notes), '');
  v.source := coalesce(v.source, 'direct_contract');

  if v.facility_name is null then raise exception 'Give the facility name' using errcode = 'PT400'; end if;
  perform private.require_length(v.facility_name, 200, 'facility name');
  perform private.require_length(v.facility_contact, 300, 'facility contact');
  perform private.require_length(v.requisition_reference, 100, 'requisition reference');
  perform private.require_length(v.rate_notes, 2000, 'rate notes');
  perform private.require_length(v.internal_notes, 4000, 'internal notes');
  return v;
end;
$$;

-- Locks a job for a staff change. Another organization's job reports "not
-- found". A null expected version skips the concurrency check.
create or replace function private.lock_job_for_staff(p_job_id uuid, p_expected_version integer)
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.jobs;
begin
  select * into r from public.jobs where id = p_job_id for update;
  if not found or not private.has_org_role(r.organization_id) then
    raise exception 'Job not found' using errcode = 'PT404';
  end if;
  if p_expected_version is not null and r.version <> p_expected_version then
    raise exception 'Someone else changed this job. Reload to see the latest version.' using errcode = 'PT409';
  end if;
  return r;
end;
$$;

revoke all on function private.require_length(text, integer, text) from public, anon, authenticated;
revoke all on function private.job_input(jsonb) from public, anon, authenticated;
revoke all on function private.job_internal_input(jsonb) from public, anon, authenticated;
revoke all on function private.lock_job_for_staff(uuid, integer) from public, anon, authenticated;

-- Staff: jobs -----------------------------------------------------------------

-- The organization id comes from the client, so membership is checked here
-- before anything is written. New jobs start as drafts.
create or replace function public.create_job(
  p_organization_id uuid,
  p_job jsonb,
  p_internal jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.jobs;
  v_internal public.job_internal_details;
begin
  if p_organization_id is null or not private.has_org_role(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'PT404';
  end if;
  v := private.job_input(p_job);
  v_internal := private.job_internal_input(p_internal);

  insert into public.jobs (
    organization_id, title, specialty, employment_type, city, state, shift,
    hours_per_week, start_date, duration_weeks, openings, public_description, created_by
  ) values (
    p_organization_id, v.title, v.specialty, v.employment_type, v.city, v.state, v.shift,
    v.hours_per_week, v.start_date, v.duration_weeks, v.openings, v.public_description,
    (select auth.uid())
  )
  returning * into v;

  insert into public.job_internal_details (
    job_id, organization_id, facility_name, facility_contact, source,
    requisition_reference, rate_notes, internal_notes
  ) values (
    v.id, v.organization_id, v_internal.facility_name, v_internal.facility_contact, v_internal.source,
    v_internal.requisition_reference, v_internal.rate_notes, v_internal.internal_notes
  );

  insert into public.job_events (job_id, organization_id, event_type, to_status, actor_id)
  values (v.id, v.organization_id, 'created', v.status, (select auth.uid()));

  return jsonb_build_object('id', v.id, 'status', v.status, 'version', v.version);
end;
$$;

-- Replaces every editable field (public and internal) in one change.
create or replace function public.update_job(
  p_job_id uuid,
  p_expected_version integer,
  p_job jsonb,
  p_internal jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.jobs;
  v public.jobs;
  v_internal public.job_internal_details;
  v_old_internal public.job_internal_details;
  v_changed jsonb;
begin
  if p_expected_version is null then
    raise exception 'Version is required' using errcode = 'PT400';
  end if;
  r := private.lock_job_for_staff(p_job_id, p_expected_version);
  v := private.job_input(p_job);
  v_internal := private.job_internal_input(p_internal);
  select * into v_old_internal from public.job_internal_details where job_id = r.id;

  select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_changed
  from (
    select k from unnest(array['title', 'specialty', 'employment_type', 'city', 'state', 'shift',
                               'hours_per_week', 'start_date', 'duration_weeks', 'openings',
                               'public_description']) k
    where to_jsonb(v) -> k is distinct from to_jsonb(r) -> k
    union all
    select k from unnest(array['facility_name', 'facility_contact', 'source',
                               'requisition_reference', 'rate_notes', 'internal_notes']) k
    where to_jsonb(v_internal) -> k is distinct from to_jsonb(v_old_internal) -> k
  ) changed;

  if v_changed = '[]'::jsonb then
    raise exception 'Nothing changed' using errcode = 'PT400';
  end if;

  update public.jobs set
    title = v.title, specialty = v.specialty, employment_type = v.employment_type,
    city = v.city, state = v.state, shift = v.shift, hours_per_week = v.hours_per_week,
    start_date = v.start_date, duration_weeks = v.duration_weeks, openings = v.openings,
    public_description = v.public_description, version = version + 1
  where id = r.id
  returning * into r;

  update public.job_internal_details set
    facility_name = v_internal.facility_name, facility_contact = v_internal.facility_contact,
    source = v_internal.source, requisition_reference = v_internal.requisition_reference,
    rate_notes = v_internal.rate_notes, internal_notes = v_internal.internal_notes
  where job_id = r.id;

  insert into public.job_events (job_id, organization_id, event_type, actor_id, details)
  values (r.id, r.organization_id, 'updated', (select auth.uid()), jsonb_build_object('fields', v_changed));

  return jsonb_build_object('id', r.id, 'version', r.version);
end;
$$;

-- Opening a job publishes it and lets it take applications. Every other
-- status hides it and stops new applications. Existing applications are left
-- alone so recruiters can still work them.
create or replace function public.set_job_status(
  p_job_id uuid,
  p_expected_version integer,
  p_status public.job_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.jobs;
  v_from public.job_status;
begin
  if p_expected_version is null or p_status is null then
    raise exception 'Status and version are required' using errcode = 'PT400';
  end if;
  r := private.lock_job_for_staff(p_job_id, p_expected_version);
  v_from := r.status;

  if v_from = p_status then
    raise exception 'The job already has that status' using errcode = 'PT400';
  end if;
  if p_status = 'draft' and r.published_at is not null then
    raise exception 'A published job can''t go back to draft. Put it on hold instead.' using errcode = 'PT400';
  end if;

  update public.jobs
  set status = p_status,
      published_at = case when p_status = 'open' then coalesce(published_at, now()) else published_at end,
      version = version + 1
  where id = r.id
  returning * into r;

  insert into public.job_events (job_id, organization_id, event_type, from_status, to_status, actor_id)
  values (r.id, r.organization_id, 'status_changed', v_from, p_status, (select auth.uid()));

  return jsonb_build_object('id', r.id, 'status', r.status, 'published_at', r.published_at, 'version', r.version);
end;
$$;

-- Staff: applications ---------------------------------------------------------

-- A recruiter puts forward a clinician who came in through an inquiry. The
-- contact details are copied from the inquiry, so they can't be typed in wrong.
create or replace function public.add_application_from_inquiry(
  p_job_id uuid,
  p_inquiry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.jobs;
  i public.inquiries;
  v_id uuid;
begin
  -- Shared lock: a concurrent status change waits, so a job can't close
  -- between this check and the insert.
  select * into j from public.jobs where id = p_job_id for share;
  if not found or not private.has_org_role(j.organization_id) then
    raise exception 'Job not found' using errcode = 'PT404';
  end if;
  if j.status <> 'open' then
    raise exception 'This job isn''t open, so it can''t take applications' using errcode = 'PT400';
  end if;

  select * into i from public.inquiries where id = p_inquiry_id;
  if not found or i.organization_id <> j.organization_id or i.inquiry_type <> 'clinician' then
    raise exception 'Choose a clinician inquiry from this agency' using errcode = 'PT400';
  end if;

  insert into public.job_applications (
    job_id, organization_id, inquiry_id, source, full_name, email, phone, created_by
  ) values (
    j.id, j.organization_id, i.id, 'recruiter', i.full_name, i.email, i.phone, (select auth.uid())
  )
  on conflict (job_id, email) do nothing
  returning id into v_id;

  if v_id is null then
    raise exception 'This clinician has already applied to this job' using errcode = 'PT400';
  end if;

  insert into public.application_events (application_id, organization_id, event_type, to_stage, actor_id, details)
  values (v_id, j.organization_id, 'created', 'applied', (select auth.uid()),
          jsonb_build_object('source', 'recruiter', 'inquiry_id', i.id));

  return jsonb_build_object('id', v_id);
end;
$$;

-- Rejected and withdrawn take a reason; moving back out of them clears it.
create or replace function public.change_application_stage(
  p_application_id uuid,
  p_expected_version integer,
  p_stage public.application_stage,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.job_applications;
  v_from public.application_stage;
  v_reason text := nullif(trim(p_reason), '');
  v_needs_reason boolean := p_stage in ('rejected', 'withdrawn');
begin
  if p_expected_version is null or p_stage is null then
    raise exception 'Stage and version are required' using errcode = 'PT400';
  end if;

  select * into r from public.job_applications where id = p_application_id for update;
  if not found or not private.has_org_role(r.organization_id) then
    raise exception 'Application not found' using errcode = 'PT404';
  end if;
  if r.version <> p_expected_version then
    raise exception 'Someone else changed this application. Reload to see the latest version.' using errcode = 'PT409';
  end if;
  v_from := r.stage;

  if v_from = p_stage then
    raise exception 'The application is already in that stage' using errcode = 'PT400';
  end if;
  if v_needs_reason and v_reason is null then
    raise exception 'Give a reason' using errcode = 'PT400';
  end if;
  if not v_needs_reason and v_reason is not null then
    raise exception 'Only rejected or withdrawn applications take a reason' using errcode = 'PT400';
  end if;
  perform private.require_length(v_reason, 500, 'reason');

  update public.job_applications
  set stage = p_stage, stage_reason = v_reason, version = version + 1
  where id = r.id
  returning * into r;

  insert into public.application_events (application_id, organization_id, event_type, from_stage, to_stage, actor_id, details)
  values (r.id, r.organization_id, 'stage_changed', v_from, p_stage, (select auth.uid()),
          jsonb_strip_nulls(jsonb_build_object('reason', v_reason)));

  return jsonb_build_object('id', r.id, 'stage', r.stage, 'stage_reason', r.stage_reason, 'version', r.version);
end;
$$;

-- Public ----------------------------------------------------------------------

-- The job board's only read path: open jobs, public columns only.
create or replace function public.list_public_jobs(p_organization_slug text)
returns table (
  id uuid,
  title text,
  specialty text,
  employment_type public.job_employment_type,
  city text,
  state text,
  shift public.job_shift,
  hours_per_week integer,
  start_date date,
  duration_weeks integer,
  openings integer,
  public_description text,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.title, j.specialty, j.employment_type, j.city, j.state, j.shift,
         j.hours_per_week, j.start_date, j.duration_weeks, j.openings,
         j.public_description, j.published_at
  from public.jobs j
  join public.organizations o on o.id = j.organization_id
  where o.slug = p_organization_slug
    and j.status = 'open'
  order by j.published_at desc, j.id
  limit 500;
$$;

-- Saves an application from the public website. Callable only with the service
-- role (a future apply endpoint will validate the request first, as intake
-- does); the checks here are the last line.
--
-- Returns {"status": "created" | "duplicate" | "job_closed" | "job_not_found"
--          | "rate_limited", "application_id"?}.
create or replace function public.submit_job_application(
  p_organization_slug text,
  p_job_id uuid,
  p_application jsonb,
  p_client_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.jobs;
  v_name text := trim(p_application ->> 'full_name');
  v_email text := lower(trim(p_application ->> 'email'));
  v_phone text := nullif(trim(p_application ->> 'phone'), '');
  v_consent text := nullif(trim(p_application ->> 'consent_version'), '');
  v_id uuid;
begin
  if v_name is null or char_length(v_name) not between 2 and 160 then
    raise exception 'Enter your full name' using errcode = 'PT400';
  end if;
  if v_email is null or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address' using errcode = 'PT400';
  end if;
  perform private.require_length(v_phone, 40, 'phone number');
  if v_consent is null then
    raise exception 'Consent is required' using errcode = 'PT400';
  end if;
  perform private.require_length(v_consent, 50, 'consent version');

  select j2.* into j
  from public.jobs j2
  join public.organizations o on o.id = j2.organization_id
  where j2.id = p_job_id and o.slug = p_organization_slug
  for share of j2;
  if not found then
    return jsonb_build_object('status', 'job_not_found');
  end if;
  if j.status <> 'open' then
    return jsonb_build_object('status', 'job_closed');
  end if;

  -- A repeat from the same person returns the original application, before
  -- any rate limit, so a retry never looks like a failure.
  select id into v_id from public.job_applications where job_id = j.id and email = v_email;
  if found then
    return jsonb_build_object('status', 'duplicate', 'application_id', v_id);
  end if;

  if p_client_hash is not null
     and private.hit_rate_limit('apply:' || p_client_hash, interval '10 minutes', 10) then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  insert into public.job_applications (
    job_id, organization_id, source, full_name, email, phone, consent_given_at, consent_version
  ) values (
    j.id, j.organization_id, 'website', v_name, v_email, v_phone, now(), v_consent
  )
  on conflict (job_id, email) do nothing
  returning id into v_id;

  -- Lost a race with an identical submission.
  if v_id is null then
    select id into v_id from public.job_applications where job_id = j.id and email = v_email;
    return jsonb_build_object('status', 'duplicate', 'application_id', v_id);
  end if;

  insert into public.application_events (application_id, organization_id, event_type, to_stage, details)
  values (v_id, j.organization_id, 'created', 'applied', jsonb_build_object('source', 'website'));

  return jsonb_build_object('status', 'created', 'application_id', v_id);
end;
$$;

-- Grants ----------------------------------------------------------------------

revoke all on function public.create_job(uuid, jsonb, jsonb) from public, anon;
revoke all on function public.update_job(uuid, integer, jsonb, jsonb) from public, anon;
revoke all on function public.set_job_status(uuid, integer, public.job_status) from public, anon;
revoke all on function public.add_application_from_inquiry(uuid, uuid) from public, anon;
revoke all on function public.change_application_stage(uuid, integer, public.application_stage, text) from public, anon;
revoke all on function public.list_public_jobs(text) from public;
revoke all on function public.submit_job_application(text, uuid, jsonb, text) from public, anon, authenticated;

grant execute on function public.create_job(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.update_job(uuid, integer, jsonb, jsonb) to authenticated;
grant execute on function public.set_job_status(uuid, integer, public.job_status) to authenticated;
grant execute on function public.add_application_from_inquiry(uuid, uuid) to authenticated;
grant execute on function public.change_application_stage(uuid, integer, public.application_stage, text) to authenticated;
grant execute on function public.list_public_jobs(text) to anon, authenticated;
grant execute on function public.submit_job_application(text, uuid, jsonb, text) to service_role;
