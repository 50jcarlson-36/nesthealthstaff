-- Emails for website job applications, queued through the notification outbox
-- the same way intake does it:
--   job_application_confirmation  to the applicant
--   staff_new_application_alert   to the organization's intake_notification_email
--                                 (skipped when that's null)
-- Only a newly created website application queues them. Duplicates, closed or
-- unknown jobs, and rate-limited requests queue nothing. Recruiter-added
-- applications send nothing either: the clinician didn't apply themselves.

alter table public.notification_outbox
  add column application_id uuid references public.job_applications (id) on delete set null;

create index notification_outbox_application_idx
  on public.notification_outbox (application_id) where application_id is not null;

-- Same signature and grants as before; only the outbox inserts are new.
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
  if not found then
    return jsonb_build_object('status', 'job_not_found');
  end if;
  if j.status <> 'open' then
    return jsonb_build_object('status', 'job_closed');
  end if;
  select * into v_org from public.organizations where id = j.organization_id;

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

  -- Queued in the same transaction, so a saved application always has its
  -- emails and a failed save never sends one. Payloads hold the public job
  -- title and ids only: no applicant details, facility or rates.
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

