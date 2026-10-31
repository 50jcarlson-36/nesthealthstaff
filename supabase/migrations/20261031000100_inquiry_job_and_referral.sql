-- The website's inquiry form also sends the job the visitor was looking at
-- (jobId) and the referral code from the link they followed (?ref=). Until now
-- intake dropped both. Now:
--   * a clinician inquiry about an advertised, open job also becomes a website
--     application on that job, linked to the inquiry;
--   * the referral code is kept on the inquiry and on that application.
-- A job the public has never seen (a draft, another agency's, a partner's that
-- isn't advertised) is ignored, so the inquiry stays a general one and nothing
-- about the job leaks. A closed job is remembered on the inquiry but gets no
-- application.

alter table public.inquiries
  add column job_id uuid references public.jobs (id) on delete set null,
  add column referral_code text check (referral_code ~ '^[A-Za-z0-9_-]{1,64}$');

alter table public.job_applications
  add column referral_code text check (referral_code ~ '^[A-Za-z0-9_-]{1,64}$');

create index inquiries_job_idx on public.inquiries (job_id) where job_id is not null;
create index inquiries_referral_idx on public.inquiries (organization_id, referral_code) where referral_code is not null;

-- Same contract as before, plus "application_id" when an application was
-- created or already existed for this person and job.
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
  v_referral text := nullif(trim(p_inquiry ->> 'referral_code'), '');
  v_job public.jobs;
  v_fingerprint text;
  v_existing uuid;
  v_inquiry public.inquiries;
  v_application uuid;
  v_new_application boolean := false;
begin
  select * into v_org from public.organizations where slug = p_organization_slug;
  if not found then
    raise exception 'Unknown intake organization' using errcode = 'P0002';
  end if;

  -- Only clinicians apply, and only to this agency's advertised jobs.
  if v_type = 'clinician' and p_inquiry ->> 'job_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_job from public.jobs
    where id = (p_inquiry ->> 'job_id')::uuid and organization_id = v_org.id
    for share;
    if found and (v_job.published_at is null or not private.job_is_advertised(v_job.id)) then
      v_job := null;
    end if;
  end if;
  if v_referral is not null and v_referral !~ '^[A-Za-z0-9_-]{1,64}$' then
    v_referral := null;
  end if;

  -- Same person + type + content => same fingerprint. The job counts, so
  -- inquiries about two different jobs are two inquiries.
  v_fingerprint := encode(sha256(convert_to(
    concat_ws('|', v_type, v_email,
      p_inquiry ->> 'full_name', p_inquiry ->> 'phone', p_inquiry ->> 'specialty',
      p_inquiry ->> 'preferred_location', p_inquiry ->> 'timeline',
      p_inquiry ->> 'organization_name', p_inquiry ->> 'staffing_type',
      p_inquiry ->> 'headcount', p_inquiry ->> 'desired_start_date',
      p_inquiry ->> 'desired_end_date', p_inquiry ->> 'staffing_requirements',
      p_inquiry ->> 'housing_assistance_requested', v_job.id),
    'UTF8')), 'hex');

  -- Serialize submissions for one email so the duplicate checks below are race-free.
  perform pg_advisory_xact_lock(hashtextextended(v_org.id::text || ':' || v_email, 0));

  -- A retried request with the same Idempotency-Key returns the original result.
  if p_idempotency_key is not null then
    select id into v_existing from public.inquiries
    where organization_id = v_org.id and idempotency_key = p_idempotency_key;
    if found then
      return private.inquiry_result('duplicate', v_existing);
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
    return private.inquiry_result('duplicate', v_existing);
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
    idempotency_key, submission_fingerprint, job_id, referral_code
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
    p_idempotency_key, v_fingerprint, v_job.id, v_referral
  )
  returning * into v_inquiry;

  insert into public.inquiry_events (inquiry_id, organization_id, event_type, to_stage, details)
  values (v_inquiry.id, v_org.id, 'submitted', 'new',
          jsonb_strip_nulls(jsonb_build_object('source', v_inquiry.source, 'job_id', v_job.id,
                                               'referral_code', v_referral)));

  -- An open job: apply them, unless they already applied (then link nothing new).
  if v_job.id is not null and v_job.status = 'open' then
    insert into public.job_applications (
      job_id, organization_id, inquiry_id, source, full_name, email, phone,
      consent_given_at, consent_version, referral_code
    ) values (
      v_job.id, v_org.id, v_inquiry.id, 'website', v_inquiry.full_name, v_email, v_inquiry.phone,
      v_inquiry.consent_given_at, v_inquiry.consent_version, v_referral
    )
    on conflict (job_id, email) do nothing
    returning id into v_application;

    if v_application is not null then
      v_new_application := true;
      insert into public.application_events (application_id, organization_id, event_type, to_stage, details)
      values (v_application, v_org.id, 'created', 'applied',
              jsonb_build_object('source', 'website', 'inquiry_id', v_inquiry.id));
    end if;
  end if;

  -- One confirmation per submission: the job's when they applied, otherwise
  -- the inquiry's. Notification payloads carry no contact details beyond the
  -- recipient address; templates link staff to the authenticated dashboard.
  if v_new_application then
    insert into public.notification_outbox
      (organization_id, dedupe_key, template, recipient, template_data, application_id)
    values
      (v_org.id, 'application:' || v_application || ':confirmation',
       'job_application_confirmation', v_email,
       jsonb_build_object('organization_name', v_org.name, 'job_title', v_job.title),
       v_application);
  else
    insert into public.notification_outbox
      (organization_id, dedupe_key, template, recipient, template_data, inquiry_id)
    values
      (v_org.id, 'inquiry:' || v_inquiry.id || ':confirmation',
       case v_type when 'clinician' then 'clinician_inquiry_confirmation'
                   else 'facility_inquiry_confirmation' end,
       v_email,
       jsonb_build_object('organization_name', v_org.name),
       v_inquiry.id);
  end if;

  if v_org.intake_notification_email is not null then
    if v_new_application then
      insert into public.notification_outbox
        (organization_id, dedupe_key, template, recipient, template_data, application_id)
      values
        (v_org.id, 'application:' || v_application || ':staff_alert',
         'staff_new_application_alert', v_org.intake_notification_email,
         jsonb_build_object('job_id', v_job.id, 'job_title', v_job.title, 'application_id', v_application),
         v_application);
    else
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
  end if;

  return private.inquiry_result('created', v_inquiry.id);
end;
$$;

-- {"status", "inquiry_id", "application_id"?}: the application on the
-- inquiry's job for the same person, whether this inquiry created it or not.
create or replace function private.inquiry_result(p_status text, p_inquiry_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'status', p_status,
    'inquiry_id', i.id,
    'application_id', (select a.id from public.job_applications a where a.job_id = i.job_id and a.email = i.email)))
  from public.inquiries i
  where i.id = p_inquiry_id;
$$;

revoke all on function private.inquiry_result(text, uuid) from public;
