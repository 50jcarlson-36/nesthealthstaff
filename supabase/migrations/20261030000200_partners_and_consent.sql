-- Recruiting-only partner model. Nest sources and screens candidates and
-- submits them to partner agencies' authorized openings; the partner employs,
-- credentials, pays and contracts with the facility. This adds:
--
--   partners               each partner agency and the terms agreed with it
--   job_partner_terms      per-opening partner link, strike details, pay and
--                          incentives (internal; only is_strike is public)
--   submission_consents    the candidate's approval of one submission, given
--                          through a single-use emailed link
--   partner_submissions    what Nest submitted to whom and when: attribution
--
-- A partner's opening reaches the public job board only while that partner is
-- active and has given advertising permission. Strike assignments are always
-- labelled, and need a consent that names the strike.
--
-- Errors: PT400 invalid input (message safe to show), PT403 not allowed,
-- PT404 not found or another organization's, PT409 stale version.

create type public.partner_status as enum ('prospect', 'applying', 'active', 'paused', 'ended');
create type public.partner_priority as enum ('normal', 'high', 'critical');
create type public.consent_status as enum ('pending', 'granted', 'declined', 'expired', 'revoked');
create type public.partner_submission_status as enum ('submitted', 'partner_duplicate', 'withdrawn');

-- Partners --------------------------------------------------------------------

create table public.partners (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 200),
  status public.partner_status not null default 'prospect',
  contact_name text check (char_length(contact_name) <= 160),
  contact_email text check (contact_email is null or (char_length(contact_email) <= 254
                            and contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  agreement_signed_on date,
  -- The answers to Nest's partnership questions, as agreed.
  eligibility_notes text check (char_length(eligibility_notes) <= 2000),
  fee_terms text check (char_length(fee_terms) <= 2000),
  payment_timing text check (char_length(payment_timing) <= 1000),
  extension_cancellation_terms text check (char_length(extension_cancellation_terms) <= 2000),
  attribution_days integer check (attribution_days between 1 and 730),
  duplicate_rules text check (char_length(duplicate_rules) <= 2000),
  may_advertise boolean not null default false,
  advertising_terms text check (char_length(advertising_terms) <= 2000),
  data_transfer_method text not null default 'manual'
    check (data_transfer_method in ('manual', 'csv', 'api', 'ats_export')),
  data_transfer_notes text check (char_length(data_transfer_notes) <= 2000),
  notes text check (char_length(notes) <= 4000),
  version integer not null default 1,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index partners_org_name_idx on public.partners (organization_id, lower(name));

create trigger partners_set_updated_at
  before update on public.partners
  for each row execute function private.set_updated_at();

-- Partner terms on an opening -----------------------------------------------------

create table public.job_partner_terms (
  job_id uuid primary key references public.jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  partner_id uuid references public.partners (id) on delete restrict,
  partner_reference text check (char_length(partner_reference) <= 100),
  priority public.partner_priority not null default 'normal',

  -- Strike coverage. is_strike is shown publicly; the rest stays internal.
  is_strike boolean not null default false,
  strike_starts_on date,
  strike_ends_on date,
  strike_union text check (char_length(strike_union) <= 200),
  strike_notes text check (char_length(strike_notes) <= 2000),

  -- Pay package as offered by the partner, in cents.
  hourly_rate_cents integer check (hourly_rate_cents between 0 and 100000),
  weekly_gross_cents integer check (weekly_gross_cents between 0 and 2000000),
  housing_stipend_weekly_cents integer check (housing_stipend_weekly_cents between 0 and 1000000),
  meals_stipend_weekly_cents integer check (meals_stipend_weekly_cents between 0 and 1000000),
  is_crisis_rate boolean not null default false,

  -- Incentives, in cents. nest_incentive_cents is what Nest itself adds.
  sign_on_bonus_cents integer check (sign_on_bonus_cents between 0 and 10000000),
  completion_bonus_cents integer check (completion_bonus_cents between 0 and 10000000),
  extension_bonus_cents integer check (extension_bonus_cents between 0 and 10000000),
  referral_bonus_cents integer check (referral_bonus_cents between 0 and 10000000),
  nest_incentive_cents integer check (nest_incentive_cents between 0 and 10000000),
  incentive_notes text check (char_length(incentive_notes) <= 2000),

  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  check (strike_ends_on is null or strike_starts_on is null or strike_ends_on >= strike_starts_on),
  check (is_strike or (strike_starts_on is null and strike_ends_on is null and strike_union is null))
);

create index job_partner_terms_partner_idx on public.job_partner_terms (partner_id) where partner_id is not null;

create trigger job_partner_terms_set_updated_at
  before update on public.job_partner_terms
  for each row execute function private.set_updated_at();

-- Consent -------------------------------------------------------------------------

-- One request per send. Only the SHA-256 of the link token is stored; the token
-- itself exists only in the queued email and is removed once it's sent.
create table public.submission_consents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  application_id uuid not null references public.job_applications (id) on delete cascade,
  partner_id uuid not null references public.partners (id) on delete restrict,
  job_id uuid not null references public.jobs (id) on delete restrict,
  email text not null check (char_length(email) <= 254),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  includes_strike boolean not null,
  -- The exact wording the candidate saw, so the record stands on its own.
  consent_text text not null check (char_length(consent_text) <= 4000),
  consent_version text not null check (char_length(consent_version) <= 50),
  status public.consent_status not null default 'pending',
  requested_by uuid references public.profiles (id) on delete set null,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz,
  response_method text check (response_method in ('email_link')),
  response_client_hash text check (char_length(response_client_hash) <= 128),
  revoked_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  check ((status in ('granted', 'declined')) = (responded_at is not null))
);

create index submission_consents_application_idx
  on public.submission_consents (application_id, partner_id, requested_at desc);
-- At most one open request per application and partner.
create unique index submission_consents_one_pending_idx
  on public.submission_consents (application_id, partner_id) where status = 'pending';

create trigger submission_consents_set_updated_at
  before update on public.submission_consents
  for each row execute function private.set_updated_at();

-- Submissions and attribution -------------------------------------------------------

create table public.partner_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  partner_id uuid not null references public.partners (id) on delete restrict,
  job_id uuid not null references public.jobs (id) on delete restrict,
  application_id uuid not null references public.job_applications (id) on delete restrict,
  consent_id uuid not null references public.submission_consents (id) on delete restrict,
  -- Lowercased candidate email, for attribution and duplicate checks.
  candidate_email text not null check (char_length(candidate_email) <= 254),
  status public.partner_submission_status not null default 'submitted',
  partner_candidate_reference text check (char_length(partner_candidate_reference) <= 100),
  submitted_by uuid references public.profiles (id) on delete set null,
  submitted_at timestamptz not null default now(),
  -- From the partner's attribution period at the time of submission.
  attribution_expires_on date not null,
  status_reason text check (char_length(status_reason) <= 500),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

-- One live submission per application.
create unique index partner_submissions_one_live_idx
  on public.partner_submissions (application_id) where status <> 'withdrawn';
create index partner_submissions_attribution_idx
  on public.partner_submissions (partner_id, candidate_email, attribution_expires_on);

create trigger partner_submissions_set_updated_at
  before update on public.partner_submissions
  for each row execute function private.set_updated_at();

-- Row Level Security ------------------------------------------------------------------
-- Staff of the organization read everything here; writes go through functions.

alter table public.partners enable row level security;
alter table public.job_partner_terms enable row level security;
alter table public.submission_consents enable row level security;
alter table public.partner_submissions enable row level security;

revoke all on public.partners, public.job_partner_terms, public.submission_consents,
  public.partner_submissions from anon, authenticated;
grant select on public.partners, public.job_partner_terms, public.partner_submissions to authenticated;
-- token_hash stays out of reach, even hashed.
grant select (id, organization_id, application_id, partner_id, job_id, email, includes_strike,
              consent_text, consent_version, status, requested_by, requested_at, expires_at,
              responded_at, response_method, revoked_by, updated_at)
  on public.submission_consents to authenticated;

create policy "Staff read their organization's partners"
  on public.partners for select to authenticated using (private.has_org_role(organization_id));
create policy "Staff read their organization's partner terms"
  on public.job_partner_terms for select to authenticated using (private.has_org_role(organization_id));
create policy "Staff read their organization's consents"
  on public.submission_consents for select to authenticated using (private.has_org_role(organization_id));
create policy "Staff read their organization's partner submissions"
  on public.partner_submissions for select to authenticated using (private.has_org_role(organization_id));

-- Helpers -------------------------------------------------------------------------

-- Whether an opening may appear on the public job board: a job with no
-- partner (a direct contract) may; a partner's job only while that partner is
-- active and allows advertising.
create or replace function private.job_is_advertised(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select t.partner_id is null or (p.status = 'active' and p.may_advertise)
    from public.job_partner_terms t
    left join public.partners p on p.id = t.partner_id
    where t.job_id = p_job_id
  ), true);
$$;

revoke all on function private.job_is_advertised(uuid) from public;

create or replace function private.partner_input(p jsonb)
returns public.partners
language plpgsql
stable
set search_path = ''
as $$
declare
  v public.partners;
  v_fields jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Partner details are required' using errcode = 'PT400';
  end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_fields
  from jsonb_each(p)
  where key in ('name', 'status', 'contact_name', 'contact_email', 'agreement_signed_on',
                'eligibility_notes', 'fee_terms', 'payment_timing', 'extension_cancellation_terms',
                'attribution_days', 'duplicate_rules', 'may_advertise', 'advertising_terms',
                'data_transfer_method', 'data_transfer_notes', 'notes');
  begin
    v := jsonb_populate_record(null::public.partners, v_fields);
  exception when data_exception then
    raise exception 'Check the partner details: a value is in the wrong format' using errcode = 'PT400';
  end;

  v.name := nullif(trim(v.name), '');
  v.contact_name := nullif(trim(v.contact_name), '');
  v.contact_email := lower(nullif(trim(v.contact_email), ''));
  v.eligibility_notes := nullif(trim(v.eligibility_notes), '');
  v.fee_terms := nullif(trim(v.fee_terms), '');
  v.payment_timing := nullif(trim(v.payment_timing), '');
  v.extension_cancellation_terms := nullif(trim(v.extension_cancellation_terms), '');
  v.duplicate_rules := nullif(trim(v.duplicate_rules), '');
  v.advertising_terms := nullif(trim(v.advertising_terms), '');
  v.data_transfer_notes := nullif(trim(v.data_transfer_notes), '');
  v.notes := nullif(trim(v.notes), '');
  v.status := coalesce(v.status, 'prospect');
  v.may_advertise := coalesce(v.may_advertise, false);
  v.data_transfer_method := coalesce(nullif(v.data_transfer_method, ''), 'manual');

  if v.name is null then raise exception 'Give the partner''s name' using errcode = 'PT400'; end if;
  perform private.require_length(v.name, 200, 'partner name');
  perform private.require_length(v.contact_name, 160, 'contact name');
  if v.contact_email is not null and v.contact_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid contact email' using errcode = 'PT400';
  end if;
  perform private.require_length(v.eligibility_notes, 2000, 'eligibility notes');
  perform private.require_length(v.fee_terms, 2000, 'fee terms');
  perform private.require_length(v.payment_timing, 1000, 'payment timing');
  perform private.require_length(v.extension_cancellation_terms, 2000, 'extension and cancellation terms');
  perform private.require_length(v.duplicate_rules, 2000, 'duplicate rules');
  perform private.require_length(v.advertising_terms, 2000, 'advertising terms');
  perform private.require_length(v.data_transfer_notes, 2000, 'data transfer notes');
  perform private.require_length(v.notes, 4000, 'notes');
  if v.attribution_days is not null and v.attribution_days not between 1 and 730 then
    raise exception 'Attribution period must be 1 to 730 days' using errcode = 'PT400';
  end if;
  if v.data_transfer_method not in ('manual', 'csv', 'api', 'ats_export') then
    raise exception 'Choose how candidates are transferred' using errcode = 'PT400';
  end if;
  if v.may_advertise and v.advertising_terms is null then
    raise exception 'Record the advertising permission terms before allowing advertising' using errcode = 'PT400';
  end if;
  if v.status = 'active' and v.agreement_signed_on is null then
    raise exception 'Record the agreement date before making the partner active' using errcode = 'PT400';
  end if;
  return v;
end;
$$;

-- Partners: admins write, all staff read ----------------------------------------------

create or replace function public.create_partner(p_organization_id uuid, p_partner jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.partners;
begin
  if p_organization_id is null or not private.has_org_role(p_organization_id, array['admin']::public.org_role[]) then
    raise exception 'Only agency admins can add partners' using errcode = 'PT403';
  end if;
  v := private.partner_input(p_partner);
  begin
    insert into public.partners (
      organization_id, name, status, contact_name, contact_email, agreement_signed_on,
      eligibility_notes, fee_terms, payment_timing, extension_cancellation_terms, attribution_days,
      duplicate_rules, may_advertise, advertising_terms, data_transfer_method, data_transfer_notes,
      notes, created_by
    ) values (
      p_organization_id, v.name, v.status, v.contact_name, v.contact_email, v.agreement_signed_on,
      v.eligibility_notes, v.fee_terms, v.payment_timing, v.extension_cancellation_terms, v.attribution_days,
      v.duplicate_rules, v.may_advertise, v.advertising_terms, v.data_transfer_method, v.data_transfer_notes,
      v.notes, (select auth.uid())
    ) returning * into v;
  exception when unique_violation then
    raise exception 'A partner with that name already exists' using errcode = 'PT400';
  end;
  insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
  values (p_organization_id, (select auth.uid()), 'partner_created', 'partners', v.id::text,
          jsonb_build_object('status', v.status, 'may_advertise', v.may_advertise));
  return jsonb_build_object('id', v.id, 'version', v.version);
end;
$$;

create or replace function public.update_partner(p_partner_id uuid, p_expected_version integer, p_partner jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.partners;
  v public.partners;
  v_changed jsonb;
begin
  select * into r from public.partners where id = p_partner_id for update;
  if not found or not private.has_org_role(r.organization_id) then
    raise exception 'Partner not found' using errcode = 'PT404';
  end if;
  if not private.has_org_role(r.organization_id, array['admin']::public.org_role[]) then
    raise exception 'Only agency admins can change partners' using errcode = 'PT403';
  end if;
  if p_expected_version is null or r.version <> p_expected_version then
    raise exception 'Someone else changed this partner. Reload to see the latest version.' using errcode = 'PT409';
  end if;
  v := private.partner_input(p_partner);

  select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_changed
  from unnest(array['name', 'status', 'contact_name', 'contact_email', 'agreement_signed_on',
                    'eligibility_notes', 'fee_terms', 'payment_timing', 'extension_cancellation_terms',
                    'attribution_days', 'duplicate_rules', 'may_advertise', 'advertising_terms',
                    'data_transfer_method', 'data_transfer_notes', 'notes']) k
  where to_jsonb(v) -> k is distinct from to_jsonb(r) -> k;
  if v_changed = '[]'::jsonb then
    raise exception 'Nothing changed' using errcode = 'PT400';
  end if;

  begin
    update public.partners set
      name = v.name, status = v.status, contact_name = v.contact_name, contact_email = v.contact_email,
      agreement_signed_on = v.agreement_signed_on, eligibility_notes = v.eligibility_notes,
      fee_terms = v.fee_terms, payment_timing = v.payment_timing,
      extension_cancellation_terms = v.extension_cancellation_terms, attribution_days = v.attribution_days,
      duplicate_rules = v.duplicate_rules, may_advertise = v.may_advertise,
      advertising_terms = v.advertising_terms, data_transfer_method = v.data_transfer_method,
      data_transfer_notes = v.data_transfer_notes, notes = v.notes, version = version + 1
    where id = r.id
    returning * into r;
  exception when unique_violation then
    raise exception 'A partner with that name already exists' using errcode = 'PT400';
  end;

  insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
  values (r.organization_id, (select auth.uid()), 'partner_updated', 'partners', r.id::text,
          jsonb_build_object('fields', v_changed));
  return jsonb_build_object('id', r.id, 'version', r.version);
end;
$$;

-- Opening terms ---------------------------------------------------------------------

-- Replaces the partner terms of a job. Uses and bumps the job's version, so
-- the job page and its terms can't be saved over each other.
create or replace function public.set_job_terms(p_job_id uuid, p_expected_version integer, p_terms jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.jobs;
  v public.job_partner_terms;
  v_old public.job_partner_terms;
  v_fields jsonb;
  v_changed jsonb;
  v_partner public.partners;
begin
  if p_expected_version is null then
    raise exception 'Version is required' using errcode = 'PT400';
  end if;
  j := private.lock_job_for_staff(p_job_id, p_expected_version);
  if p_terms is null or jsonb_typeof(p_terms) <> 'object' then
    raise exception 'Terms are required' using errcode = 'PT400';
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_fields
  from jsonb_each(p_terms)
  where key in ('partner_id', 'partner_reference', 'priority', 'is_strike', 'strike_starts_on',
                'strike_ends_on', 'strike_union', 'strike_notes', 'hourly_rate_cents',
                'weekly_gross_cents', 'housing_stipend_weekly_cents', 'meals_stipend_weekly_cents',
                'is_crisis_rate', 'sign_on_bonus_cents', 'completion_bonus_cents',
                'extension_bonus_cents', 'referral_bonus_cents', 'nest_incentive_cents',
                'incentive_notes');
  begin
    v := jsonb_populate_record(null::public.job_partner_terms, v_fields);
  exception when data_exception then
    raise exception 'Check the terms: a value is in the wrong format' using errcode = 'PT400';
  end;

  v.partner_reference := nullif(trim(v.partner_reference), '');
  v.strike_union := nullif(trim(v.strike_union), '');
  v.strike_notes := nullif(trim(v.strike_notes), '');
  v.incentive_notes := nullif(trim(v.incentive_notes), '');
  v.priority := coalesce(v.priority, 'normal');
  v.is_strike := coalesce(v.is_strike, false);
  v.is_crisis_rate := coalesce(v.is_crisis_rate, false);
  perform private.require_length(v.partner_reference, 100, 'partner reference');
  perform private.require_length(v.strike_union, 200, 'union');
  perform private.require_length(v.strike_notes, 2000, 'strike notes');
  perform private.require_length(v.incentive_notes, 2000, 'incentive notes');

  if v.partner_id is not null then
    select * into v_partner from public.partners where id = v.partner_id;
    if not found or v_partner.organization_id <> j.organization_id then
      raise exception 'Choose a partner from this agency' using errcode = 'PT400';
    end if;
  end if;
  if not v.is_strike and (v.strike_starts_on is not null or v.strike_ends_on is not null or v.strike_union is not null) then
    raise exception 'Strike dates and union only apply to strike assignments' using errcode = 'PT400';
  end if;
  if v.strike_ends_on < v.strike_starts_on then
    raise exception 'The strike can''t end before it starts' using errcode = 'PT400';
  end if;
  if coalesce(v.hourly_rate_cents, 0) < 0 or coalesce(v.weekly_gross_cents, 0) < 0
     or coalesce(v.housing_stipend_weekly_cents, 0) < 0 or coalesce(v.meals_stipend_weekly_cents, 0) < 0
     or coalesce(v.sign_on_bonus_cents, 0) < 0 or coalesce(v.completion_bonus_cents, 0) < 0
     or coalesce(v.extension_bonus_cents, 0) < 0 or coalesce(v.referral_bonus_cents, 0) < 0
     or coalesce(v.nest_incentive_cents, 0) < 0 then
    raise exception 'Amounts can''t be negative' using errcode = 'PT400';
  end if;

  select * into v_old from public.job_partner_terms where job_id = j.id;
  select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_changed
  from jsonb_object_keys(to_jsonb(v)) k
  where k not in ('job_id', 'organization_id', 'updated_by', 'updated_at')
    and to_jsonb(v) -> k is distinct from coalesce(nullif(to_jsonb(v_old) -> k, 'null'::jsonb),
      case k when 'priority' then '"normal"'::jsonb when 'is_strike' then 'false'::jsonb
             when 'is_crisis_rate' then 'false'::jsonb else 'null'::jsonb end);
  if v_changed = '[]'::jsonb then
    raise exception 'Nothing changed' using errcode = 'PT400';
  end if;

  begin
    insert into public.job_partner_terms (
      job_id, organization_id, partner_id, partner_reference, priority, is_strike, strike_starts_on,
      strike_ends_on, strike_union, strike_notes, hourly_rate_cents, weekly_gross_cents,
      housing_stipend_weekly_cents, meals_stipend_weekly_cents, is_crisis_rate, sign_on_bonus_cents,
      completion_bonus_cents, extension_bonus_cents, referral_bonus_cents, nest_incentive_cents,
      incentive_notes, updated_by
    ) values (
      j.id, j.organization_id, v.partner_id, v.partner_reference, v.priority, v.is_strike, v.strike_starts_on,
      v.strike_ends_on, v.strike_union, v.strike_notes, v.hourly_rate_cents, v.weekly_gross_cents,
      v.housing_stipend_weekly_cents, v.meals_stipend_weekly_cents, v.is_crisis_rate, v.sign_on_bonus_cents,
      v.completion_bonus_cents, v.extension_bonus_cents, v.referral_bonus_cents, v.nest_incentive_cents,
      v.incentive_notes, (select auth.uid())
    )
    on conflict (job_id) do update set
      partner_id = excluded.partner_id, partner_reference = excluded.partner_reference,
      priority = excluded.priority, is_strike = excluded.is_strike,
      strike_starts_on = excluded.strike_starts_on, strike_ends_on = excluded.strike_ends_on,
      strike_union = excluded.strike_union, strike_notes = excluded.strike_notes,
      hourly_rate_cents = excluded.hourly_rate_cents, weekly_gross_cents = excluded.weekly_gross_cents,
      housing_stipend_weekly_cents = excluded.housing_stipend_weekly_cents,
      meals_stipend_weekly_cents = excluded.meals_stipend_weekly_cents,
      is_crisis_rate = excluded.is_crisis_rate, sign_on_bonus_cents = excluded.sign_on_bonus_cents,
      completion_bonus_cents = excluded.completion_bonus_cents,
      extension_bonus_cents = excluded.extension_bonus_cents,
      referral_bonus_cents = excluded.referral_bonus_cents,
      nest_incentive_cents = excluded.nest_incentive_cents,
      incentive_notes = excluded.incentive_notes, updated_by = excluded.updated_by;
  exception when check_violation then
    raise exception 'Check the terms: an amount or date is out of range' using errcode = 'PT400';
  end;

  update public.jobs set version = version + 1 where id = j.id returning * into j;
  insert into public.job_events (job_id, organization_id, event_type, actor_id, details)
  values (j.id, j.organization_id, 'terms_updated', (select auth.uid()), jsonb_build_object('fields', v_changed));
  return jsonb_build_object('id', j.id, 'version', j.version);
end;
$$;

-- Public job board ---------------------------------------------------------------------

-- Same as before, plus is_strike (strike assignments are always labelled) and
-- the advertising rule. The return type changes, so it's dropped first.
drop function public.list_public_jobs(text);

create function public.list_public_jobs(p_organization_slug text)
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
  published_at timestamptz,
  is_strike boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.title, j.specialty, j.employment_type, j.city, j.state, j.shift,
         j.hours_per_week, j.start_date, j.duration_weeks, j.openings,
         j.public_description, j.published_at, coalesce(t.is_strike, false)
  from public.jobs j
  join public.organizations o on o.id = j.organization_id
  left join public.job_partner_terms t on t.job_id = j.id
  where o.slug = p_organization_slug
    and j.status = 'open'
    and private.job_is_advertised(j.id)
  order by j.published_at desc, j.id
  limit 500;
$$;

revoke all on function public.list_public_jobs(text) from public;
grant execute on function public.list_public_jobs(text) to anon, authenticated, service_role;

-- Website applications: unchanged except that a job the public can't see
-- reports "not found".
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
  v_org public.organizations;
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
  if not found or not private.job_is_advertised(j.id) then
    return jsonb_build_object('status', 'job_not_found');
  end if;
  if j.status <> 'open' then
    return jsonb_build_object('status', 'job_closed');
  end if;
  select * into v_org from public.organizations where id = j.organization_id;

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

  if v_id is null then
    select id into v_id from public.job_applications where job_id = j.id and email = v_email;
    return jsonb_build_object('status', 'duplicate', 'application_id', v_id);
  end if;

  insert into public.application_events (application_id, organization_id, event_type, to_stage, details)
  values (v_id, j.organization_id, 'created', 'applied', jsonb_build_object('source', 'website'));

  insert into public.notification_outbox
    (organization_id, dedupe_key, template, recipient, template_data, application_id)
  values
    (j.organization_id, 'application:' || v_id || ':confirmation',
     'job_application_confirmation', v_email,
     jsonb_build_object('organization_name', v_org.name, 'job_title', j.title),
     v_id);

  if v_org.intake_notification_email is not null then
    insert into public.notification_outbox
      (organization_id, dedupe_key, template, recipient, template_data, application_id)
    values
      (j.organization_id, 'application:' || v_id || ':staff_alert',
       'staff_new_application_alert', v_org.intake_notification_email,
       jsonb_build_object('job_id', j.id, 'job_title', j.title, 'application_id', v_id),
       v_id);
  end if;

  return jsonb_build_object('status', 'created', 'application_id', v_id);
end;
$$;

-- Consent requests -----------------------------------------------------------------------

-- The wording the candidate approves. Version it whenever the text changes.
-- Legal review pending, in particular the strike paragraph.
create or replace function private.consent_wording(
  p_agency text, p_partner text, p_job public.jobs, p_terms public.job_partner_terms
)
returns text
language sql
stable
set search_path = ''
as $$
  select concat_ws(E'\n\n',
    format('I authorize %s to submit my candidate profile to %s for the %s opening in %s, %s%s.',
           p_agency, p_partner, p_job.title, p_job.city, p_job.state,
           case when p_job.start_date is not null
                then ', starting around ' || to_char(p_job.start_date, 'FMMonth FMDD, YYYY') else '' end),
    format('%s, not %s, would be my employer and handles credentialing, payroll, benefits and the contract with the facility.',
           p_partner, p_agency),
    case when coalesce(p_terms.is_strike, false) then
      'This is a strike assignment: it covers work at a facility during a labor strike'
      || case when p_terms.strike_starts_on is not null
              then format(', expected from %s%s', to_char(p_terms.strike_starts_on, 'FMMonth FMDD, YYYY'),
                          case when p_terms.strike_ends_on is not null
                               then ' to ' || to_char(p_terms.strike_ends_on, 'FMMonth FMDD, YYYY') else '' end)
              else '' end
      || '. It may involve crossing a picket line. I am choosing to be submitted for strike work.'
    end,
    format('This authorization covers this one submission. I can ask %s not to submit me by replying to its emails before it does.', p_agency)
  );
$$;

-- Staff ask the candidate to approve one submission. Any earlier pending
-- request for the same application and partner is replaced. The link token is
-- returned to no one: it goes only into the queued email.
create or replace function public.request_submission_consent(p_application_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.job_applications;
  j public.jobs;
  t public.job_partner_terms;
  p public.partners;
  v_org public.organizations;
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_consent public.submission_consents;
  v_text text;
begin
  select * into a from public.job_applications where id = p_application_id for update;
  if not found or not private.has_org_role(a.organization_id) then
    raise exception 'Application not found' using errcode = 'PT404';
  end if;
  if a.stage in ('rejected', 'withdrawn', 'hired') then
    raise exception 'This application is closed' using errcode = 'PT400';
  end if;
  select * into j from public.jobs where id = a.job_id;
  select * into t from public.job_partner_terms where job_id = j.id;
  if t.partner_id is null then
    raise exception 'Link this opening to a partner before asking for consent' using errcode = 'PT400';
  end if;
  select * into p from public.partners where id = t.partner_id;
  if p.status <> 'active' then
    raise exception 'The partner isn''t active, so candidates can''t be submitted to it' using errcode = 'PT400';
  end if;
  if exists (select 1 from public.partner_submissions s where s.application_id = a.id and s.status <> 'withdrawn') then
    raise exception 'This candidate has already been submitted' using errcode = 'PT400';
  end if;
  select * into v_org from public.organizations where id = a.organization_id;

  update public.submission_consents
  set status = 'revoked', revoked_by = (select auth.uid())
  where application_id = a.id and partner_id = p.id and status = 'pending';
  update public.notification_outbox o
  set status = 'cancelled'
  where o.organization_id = a.organization_id and o.template = 'submission_consent_request'
    and o.status = 'pending' and o.application_id = a.id;

  v_text := private.consent_wording(v_org.name, p.name, j, t);
  insert into public.submission_consents (
    organization_id, application_id, partner_id, job_id, email, token_hash, includes_strike,
    consent_text, consent_version, requested_by, expires_at
  ) values (
    a.organization_id, a.id, p.id, j.id, a.email, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    coalesce(t.is_strike, false), v_text,
    case when coalesce(t.is_strike, false) then 'submission-strike-v1' else 'submission-v1' end,
    (select auth.uid()), now() + interval '7 days'
  ) returning * into v_consent;

  insert into public.notification_outbox
    (organization_id, dedupe_key, template, recipient, template_data, application_id)
  values (
    a.organization_id, 'consent:' || v_consent.id, 'submission_consent_request', a.email,
    jsonb_build_object(
      'organization_name', v_org.name, 'partner_name', p.name, 'job_title', j.title,
      'city', j.city, 'state', j.state, 'is_strike', v_consent.includes_strike,
      'expires_at', v_consent.expires_at, 'token', v_token
    ),
    a.id
  );

  insert into public.application_events (application_id, organization_id, event_type, actor_id, details)
  values (a.id, a.organization_id, 'consent_requested', (select auth.uid()),
          jsonb_build_object('consent_id', v_consent.id, 'partner_id', p.id, 'includes_strike', v_consent.includes_strike));

  return jsonb_build_object('consent_id', v_consent.id, 'expires_at', v_consent.expires_at,
                            'includes_strike', v_consent.includes_strike);
end;
$$;

create or replace function public.revoke_submission_consent(p_consent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.submission_consents;
begin
  select * into c from public.submission_consents where id = p_consent_id for update;
  if not found or not private.has_org_role(c.organization_id) then
    raise exception 'Consent request not found' using errcode = 'PT404';
  end if;
  if c.status <> 'pending' then
    raise exception 'Only a pending request can be cancelled' using errcode = 'PT400';
  end if;
  update public.submission_consents set status = 'revoked', revoked_by = (select auth.uid()) where id = c.id;
  update public.notification_outbox set status = 'cancelled'
  where dedupe_key = 'consent:' || c.id and status = 'pending';
  insert into public.application_events (application_id, organization_id, event_type, actor_id, details)
  values (c.application_id, c.organization_id, 'consent_cancelled', (select auth.uid()),
          jsonb_build_object('consent_id', c.id));
  return jsonb_build_object('id', c.id);
end;
$$;

-- The token is removed from a consent email once the outbox is done with it,
-- so admins reading the outbox can't use someone else's link.
create or replace function private.scrub_consent_token()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.template = 'submission_consent_request' and new.status in ('sent', 'failed', 'cancelled') then
    new.template_data := new.template_data - 'token';
  end if;
  return new;
end;
$$;

create trigger notification_outbox_scrub_consent_token
  before update of status on public.notification_outbox
  for each row execute function private.scrub_consent_token();

-- Answering a consent request (service role only: the consent Edge Function) -----------------

-- Finds a request by its link token. Expired pending requests are marked so.
create or replace function private.consent_by_token(p_token text)
returns public.submission_consents
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.submission_consents;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select * into c from public.submission_consents
  where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  for update;
  if found and c.status = 'pending' and c.expires_at <= now() then
    update public.submission_consents set status = 'expired' where id = c.id returning * into c;
  end if;
  return c;
end;
$$;

revoke all on function private.consent_by_token(text) from public;

-- What the consent page shows: the wording and the opening, nothing else
-- about the candidate.
create or replace function public.view_submission_consent(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.submission_consents;
  p public.partners;
  j public.jobs;
begin
  c := private.consent_by_token(p_token);
  if c.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into p from public.partners where id = c.partner_id;
  select * into j from public.jobs where id = c.job_id;
  return jsonb_build_object(
    'status', c.status, 'consent_text', c.consent_text, 'includes_strike', c.includes_strike,
    'partner_name', p.name, 'job_title', j.title, 'city', j.city, 'state', j.state,
    'expires_at', c.expires_at, 'responded_at', c.responded_at
  );
end;
$$;

create or replace function public.respond_submission_consent(p_token text, p_decision text, p_client_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.submission_consents;
begin
  if p_decision not in ('granted', 'declined') then
    raise exception 'Choose approve or decline' using errcode = 'PT400';
  end if;
  c := private.consent_by_token(p_token);
  if c.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if c.status <> 'pending' then
    -- Answering the same way twice is harmless; anything else is final.
    return jsonb_build_object('status', c.status, 'already_answered', true);
  end if;

  update public.submission_consents
  set status = p_decision::public.consent_status, responded_at = now(), response_method = 'email_link',
      response_client_hash = left(p_client_hash, 128)
  where id = c.id
  returning * into c;

  insert into public.application_events (application_id, organization_id, event_type, details)
  values (c.application_id, c.organization_id, 'consent_' || p_decision,
          jsonb_build_object('consent_id', c.id, 'partner_id', c.partner_id, 'includes_strike', c.includes_strike,
                             'consent_version', c.consent_version));
  return jsonb_build_object('status', c.status, 'already_answered', false);
end;
$$;

-- Submitting and attribution ------------------------------------------------------------------

-- Records that Nest submitted the candidate to the opening's partner. Needs a
-- granted consent for this application and partner (one that names the strike
-- for a strike assignment) and the partner's attribution period. Moves the
-- application to "submitted" if it was earlier in the pipeline.
create or replace function public.submit_to_partner(p_application_id uuid, p_partner_candidate_reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.job_applications;
  t public.job_partner_terms;
  p public.partners;
  c public.submission_consents;
  s public.partner_submissions;
  v_ref text := nullif(trim(p_partner_candidate_reference), '');
  v_prior integer;
begin
  select * into a from public.job_applications where id = p_application_id for update;
  if not found or not private.has_org_role(a.organization_id) then
    raise exception 'Application not found' using errcode = 'PT404';
  end if;
  perform private.require_length(v_ref, 100, 'partner reference');
  select * into t from public.job_partner_terms where job_id = a.job_id;
  if t.partner_id is null then
    raise exception 'This opening isn''t linked to a partner' using errcode = 'PT400';
  end if;
  select * into p from public.partners where id = t.partner_id for share;
  if p.status <> 'active' then
    raise exception 'The partner isn''t active' using errcode = 'PT400';
  end if;
  if p.attribution_days is null then
    raise exception 'Record the partner''s attribution period before submitting' using errcode = 'PT400';
  end if;
  if exists (select 1 from public.partner_submissions where application_id = a.id and status <> 'withdrawn') then
    raise exception 'This candidate has already been submitted for this opening' using errcode = 'PT400';
  end if;

  select * into c from public.submission_consents
  where application_id = a.id and partner_id = p.id and status = 'granted'
  order by responded_at desc limit 1;
  if not found then
    raise exception 'The candidate hasn''t approved this submission yet' using errcode = 'PT400';
  end if;
  if coalesce(t.is_strike, false) and not c.includes_strike then
    raise exception 'This is a strike assignment: ask the candidate again so the consent names the strike'
      using errcode = 'PT400';
  end if;

  -- Earlier submissions of the same person to the same partner still inside
  -- their attribution period. Not an error: the partner's rules decide.
  select count(*) into v_prior from public.partner_submissions
  where partner_id = p.id and candidate_email = a.email and status = 'submitted'
    and attribution_expires_on >= current_date;

  insert into public.partner_submissions (
    organization_id, partner_id, job_id, application_id, consent_id, candidate_email,
    partner_candidate_reference, submitted_by, attribution_expires_on
  ) values (
    a.organization_id, p.id, a.job_id, a.id, c.id, a.email, v_ref, (select auth.uid()),
    current_date + p.attribution_days
  ) returning * into s;

  if a.stage in ('applied', 'screening') then
    update public.job_applications set stage = 'submitted', version = version + 1 where id = a.id;
    insert into public.application_events (application_id, organization_id, event_type, from_stage, to_stage, actor_id, details)
    values (a.id, a.organization_id, 'stage_changed', a.stage, 'submitted', (select auth.uid()),
            jsonb_build_object('reason', 'submitted_to_partner'));
  end if;
  insert into public.application_events (application_id, organization_id, event_type, actor_id, details)
  values (a.id, a.organization_id, 'submitted_to_partner', (select auth.uid()),
          jsonb_build_object('submission_id', s.id, 'partner_id', p.id, 'consent_id', c.id,
                             'attribution_expires_on', s.attribution_expires_on, 'prior_live_submissions', v_prior));

  return jsonb_build_object('id', s.id, 'attribution_expires_on', s.attribution_expires_on,
                            'prior_live_submissions', v_prior);
end;
$$;

-- Withdrawn by Nest, or reported by the partner as a duplicate they already had.
create or replace function public.update_partner_submission(
  p_submission_id uuid, p_expected_version integer, p_status public.partner_submission_status, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.partner_submissions;
  v_reason text := nullif(trim(p_reason), '');
begin
  select * into s from public.partner_submissions where id = p_submission_id for update;
  if not found or not private.has_org_role(s.organization_id) then
    raise exception 'Submission not found' using errcode = 'PT404';
  end if;
  if p_expected_version is null or s.version <> p_expected_version then
    raise exception 'Someone else changed this submission. Reload to see the latest version.' using errcode = 'PT409';
  end if;
  if p_status is null or p_status = 'submitted' or s.status <> 'submitted' then
    raise exception 'Only a live submission can be withdrawn or marked as a partner duplicate' using errcode = 'PT400';
  end if;
  if v_reason is null then
    raise exception 'Give a reason' using errcode = 'PT400';
  end if;
  perform private.require_length(v_reason, 500, 'reason');

  update public.partner_submissions set status = p_status, status_reason = v_reason, version = version + 1
  where id = s.id returning * into s;
  insert into public.application_events (application_id, organization_id, event_type, actor_id, details)
  values (s.application_id, s.organization_id, 'partner_submission_' || p_status, (select auth.uid()),
          jsonb_build_object('submission_id', s.id, 'reason', v_reason));
  return jsonb_build_object('id', s.id, 'status', s.status, 'version', s.version);
end;
$$;

-- Grants ------------------------------------------------------------------------------

revoke all on function public.create_partner(uuid, jsonb) from public, anon;
revoke all on function public.update_partner(uuid, integer, jsonb) from public, anon;
revoke all on function public.set_job_terms(uuid, integer, jsonb) from public, anon;
revoke all on function public.request_submission_consent(uuid) from public, anon;
revoke all on function public.revoke_submission_consent(uuid) from public, anon;
revoke all on function public.view_submission_consent(text) from public, anon, authenticated;
revoke all on function public.respond_submission_consent(text, text, text) from public, anon, authenticated;
revoke all on function public.submit_to_partner(uuid, text) from public, anon;
revoke all on function public.update_partner_submission(uuid, integer, public.partner_submission_status, text) from public, anon;

grant execute on function public.create_partner(uuid, jsonb) to authenticated;
grant execute on function public.update_partner(uuid, integer, jsonb) to authenticated;
grant execute on function public.set_job_terms(uuid, integer, jsonb) to authenticated;
grant execute on function public.request_submission_consent(uuid) to authenticated;
grant execute on function public.revoke_submission_consent(uuid) to authenticated;
grant execute on function public.view_submission_consent(text) to service_role;
grant execute on function public.respond_submission_consent(text, text, text) to service_role;
grant execute on function public.submit_to_partner(uuid, text) to authenticated;
grant execute on function public.update_partner_submission(uuid, integer, public.partner_submission_status, text) to authenticated;
