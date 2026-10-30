-- Next-assignment planning: what each clinician on assignment does next.
--
--   assignment_endings lists clinicians whose assignment (journey stage
--   started or extended) ends within the next 16 weeks or ended in the last
--   week, with the current pay, the extension bonus on offer and the plan.
--   next_assignment_plans records the plan: extension offered, extending,
--   looking, next one lined up, or not continuing.
--   next_assignment_options ranks open jobs for one clinician: same or
--   related specialty, a start that follows the current end date, pay
--   against what they earn now, and the opportunity score. Strike work is
--   labelled, never promoted.
--   put_forward_for_next_assignment creates the application for the next
--   job from the current one's contact details, and links it to the plan.
--   The next submission still needs the clinician's approval, as always.
--
--   journey_overview stops asking to "Plan the next assignment" once the
--   plan is settled (extending, next one lined up, or not continuing), and
--   gains plan_status.
--
-- Errors: PT400 invalid input, PT404 not found, PT409 stale.

create type public.next_assignment_status as enum (
  'not_started', 'extension_offered', 'extending', 'looking', 'next_lined_up', 'not_continuing'
);

create table public.next_assignment_plans (
  -- The application for the assignment the clinician is on now.
  application_id uuid primary key references public.job_applications (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  status public.next_assignment_status not null default 'not_started',
  -- The application for the next job, once they're put forward.
  next_application_id uuid references public.job_applications (id) on delete set null,
  note text check (char_length(note) <= 1000),
  version integer not null default 1,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

create trigger next_assignment_plans_set_updated_at
  before update on public.next_assignment_plans
  for each row execute function private.set_updated_at();

alter table public.next_assignment_plans enable row level security;
revoke all on public.next_assignment_plans from anon, authenticated;
grant select on public.next_assignment_plans to authenticated;
create policy "Staff read their organization's next-assignment plans"
  on public.next_assignment_plans for select to authenticated using (private.has_org_role(organization_id));

-- Endings ------------------------------------------------------------------------------

create view public.assignment_endings
with (security_invoker = true)
as
select a.id as application_id, a.organization_id, a.full_name, a.inquiry_id,
       s.id as submission_id, s.stage, s.assignment_start_on, s.assignment_end_on,
       s.assignment_end_on - current_date as days_left,
       j.id as job_id, j.title as job_title, j.specialty, j.city, j.state,
       p.id as partner_id, p.name as partner_name,
       -- Same package rule as opportunity_scores: weekly gross when given,
       -- else hourly × hours (36 when unknown) plus the stipends.
       coalesce(t.weekly_gross_cents,
                case when t.hourly_rate_cents is not null
                     then t.hourly_rate_cents * coalesce(j.hours_per_week, 36)
                          + coalesce(t.housing_stipend_weekly_cents, 0) + coalesce(t.meals_stipend_weekly_cents, 0) end)
         as current_weekly_cents,
       t.extension_bonus_cents,
       coalesce(pl.status, 'not_started') as plan_status, pl.note as plan_note, pl.next_application_id,
       pl.version as plan_version, pl.updated_at as plan_updated_at,
       na.job_id as next_job_id
from public.partner_submissions s
join public.job_applications a on a.id = s.application_id
join public.jobs j on j.id = s.job_id
join public.partners p on p.id = s.partner_id
left join public.job_partner_terms t on t.job_id = s.job_id
left join public.next_assignment_plans pl on pl.application_id = a.id
left join public.job_applications na on na.id = pl.next_application_id
where s.status = 'submitted'
  and s.stage in ('started', 'extended')
  and s.assignment_end_on is not null
  and s.assignment_end_on between current_date - 7 and current_date + 112;

grant select on public.assignment_endings to authenticated;
revoke all on public.assignment_endings from anon;

-- Options ------------------------------------------------------------------------------

create or replace function public.next_assignment_options(p_application_id uuid)
returns table (
  job_id uuid,
  title text,
  specialty text,
  city text,
  state text,
  start_date date,
  is_strike boolean,
  is_crisis_rate boolean,
  effective_weekly_cents integer,
  pay_change_pct integer,
  opportunity_score integer,
  fit_score integer,
  fit_reasons text[],
  rank integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with e as (
    select * from public.assignment_endings where application_id = p_application_id
  ),
  rated as (
    select o.*, e.current_weekly_cents, e.assignment_end_on as ends_on,
      case
        when lower(o.specialty) = lower(e.specialty) then 50
        when position(lower(e.specialty) in lower(o.specialty)) > 0 or position(lower(o.specialty) in lower(e.specialty)) > 0 then 30
        else 0
      end as specialty_points,
      case when o.state = e.state then 25 else 15 end as location_points,
      case
        when o.start_date is null then 10
        when o.start_date < e.assignment_end_on - 3 then 0
        when o.start_date <= e.assignment_end_on + 21 then 25
        when o.start_date <= e.assignment_end_on + 60 then 12
        else 5
      end as timing_points
    from public.opportunity_scores o
    join e on e.organization_id = o.organization_id and o.job_id <> e.job_id
  )
  select r.job_id, r.title, r.specialty, r.city, r.state, r.start_date, r.is_strike, r.is_crisis_rate,
         r.effective_weekly_cents,
         case when r.effective_weekly_cents is not null and r.current_weekly_cents > 0
              then round((r.effective_weekly_cents::numeric / r.current_weekly_cents - 1) * 100)::integer end,
         r.score, f.fit, f.reasons,
         round(0.6 * f.fit + 0.4 * r.score)::integer
  from rated r
  cross join lateral (
    select r.specialty_points + r.location_points + r.timing_points as fit,
           array_remove(array[
             case r.specialty_points when 50 then 'Same specialty' when 30 then 'Related specialty' else 'Different specialty' end,
             case when r.location_points = 25 then 'Same state' end,
             case when r.timing_points = 25 then 'Starts as the current one ends'
                  when r.timing_points = 12 then 'Starts within 2 months of the end'
                  when r.timing_points = 0 then 'Starts before the current one ends'
                  when r.timing_points = 5 then 'Starts more than 2 months after the end' end
           ], null) as reasons
  ) f
  order by 14 desc, r.effective_weekly_cents desc nulls last
  limit 50;
$$;

-- Plans ----------------------------------------------------------------------------------

-- p_expected_version is null for the first save.
create or replace function public.set_next_assignment_plan(
  p_application_id uuid,
  p_expected_version integer,
  p_status public.next_assignment_status,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.job_applications;
  pl public.next_assignment_plans;
  v_note text := nullif(trim(p_note), '');
begin
  select * into a from public.job_applications where id = p_application_id;
  if not found or not private.has_org_role(a.organization_id) then
    raise exception 'Application not found' using errcode = 'PT404';
  end if;
  if p_status is null then raise exception 'Choose a status' using errcode = 'PT400'; end if;
  perform private.require_length(v_note, 1000, 'note');

  select * into pl from public.next_assignment_plans where application_id = a.id for update;
  if found then
    if p_expected_version is null or pl.version <> p_expected_version then
      raise exception 'Someone else changed this plan. Reload to see the latest version.' using errcode = 'PT409';
    end if;
    if pl.status = p_status and pl.note is not distinct from v_note then
      raise exception 'Nothing changed' using errcode = 'PT400';
    end if;
    update public.next_assignment_plans set status = p_status, note = v_note, version = version + 1,
      updated_by = (select auth.uid())
    where application_id = a.id returning * into pl;
  else
    if p_expected_version is not null then
      raise exception 'Someone else changed this plan. Reload to see the latest version.' using errcode = 'PT409';
    end if;
    insert into public.next_assignment_plans (application_id, organization_id, status, note, updated_by)
    values (a.id, a.organization_id, p_status, v_note, (select auth.uid()))
    returning * into pl;
  end if;

  insert into public.application_events (application_id, organization_id, event_type, actor_id, details)
  values (a.id, a.organization_id, 'next_assignment_plan', (select auth.uid()),
          jsonb_build_object('status', pl.status));
  return jsonb_build_object('application_id', pl.application_id, 'status', pl.status, 'version', pl.version);
end;
$$;

-- Puts the clinician forward for another open job, copying the contact
-- details from their current application. The plan moves to "looking"
-- unless it was already further along.
create or replace function public.put_forward_for_next_assignment(p_application_id uuid, p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.job_applications;
  j public.jobs;
  v_id uuid;
begin
  select * into a from public.job_applications where id = p_application_id;
  if not found or not private.has_org_role(a.organization_id) then
    raise exception 'Application not found' using errcode = 'PT404';
  end if;
  select * into j from public.jobs where id = p_job_id for share;
  if not found or j.organization_id <> a.organization_id then
    raise exception 'Job not found' using errcode = 'PT404';
  end if;
  if j.id = a.job_id then
    raise exception 'That''s the job they''re on now. Record an extension instead.' using errcode = 'PT400';
  end if;
  if j.status <> 'open' then
    raise exception 'This job isn''t open, so it can''t take applications' using errcode = 'PT400';
  end if;

  insert into public.job_applications (job_id, organization_id, inquiry_id, source, full_name, email, phone, created_by)
  values (j.id, j.organization_id, a.inquiry_id, 'recruiter', a.full_name, a.email, a.phone, (select auth.uid()))
  on conflict (job_id, email) do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'This clinician is already on that job' using errcode = 'PT400';
  end if;
  insert into public.application_events (application_id, organization_id, event_type, to_stage, actor_id, details)
  values (v_id, j.organization_id, 'created', 'applied', (select auth.uid()),
          jsonb_build_object('source', 'recruiter', 'from_application_id', a.id));

  insert into public.next_assignment_plans (application_id, organization_id, status, next_application_id, updated_by)
  values (a.id, a.organization_id, 'looking', v_id, (select auth.uid()))
  on conflict (application_id) do update set
    next_application_id = excluded.next_application_id,
    status = case when public.next_assignment_plans.status in ('not_started', 'extension_offered')
                  then 'looking'::public.next_assignment_status else public.next_assignment_plans.status end,
    version = public.next_assignment_plans.version + 1,
    updated_by = excluded.updated_by;
  return jsonb_build_object('id', v_id, 'job_id', j.id);
end;
$$;

-- Journey overview ------------------------------------------------------------------------

create or replace view public.journey_overview
with (security_invoker = true)
as
with latest_consent as (
  select distinct on (c.application_id, c.partner_id)
         c.application_id, c.partner_id, c.status, c.includes_strike, c.expires_at, c.requested_at
  from public.submission_consents c
  order by c.application_id, c.partner_id, c.requested_at desc
),
live_submission as (
  select distinct on (s.application_id) s.*
  from public.partner_submissions s
  where s.status = 'submitted'
  order by s.application_id, s.submitted_at desc
),
items as (
  select i.application_id,
         count(*) filter (where i.status = 'needed') as missing,
         count(*) filter (where i.status = 'needed' and i.due_on < current_date) as overdue_items,
         min(i.due_on) filter (where i.status = 'needed') as next_item_due
  from public.journey_items i
  group by i.application_id
),
base as (
  select a.id as application_id, a.organization_id, a.job_id, a.full_name, a.stage as application_stage,
         j.title as job_title, j.city, j.state, j.start_date as job_start_date,
         t.partner_id, p.name as partner_name, p.status as partner_status,
         coalesce(t.is_strike, false) as is_strike, coalesce(t.priority, 'normal') as priority,
         lc.status as consent_status, lc.includes_strike as consent_includes_strike, lc.expires_at as consent_expires_at,
         s.id as submission_id, s.stage as journey_stage, s.stage_updated_at, s.submitted_by,
         s.assignment_start_on, s.assignment_end_on, s.version as submission_version,
         coalesce(it.missing, 0) as missing_items, coalesce(it.overdue_items, 0) as overdue_items, it.next_item_due
  from public.job_applications a
  join public.jobs j on j.id = a.job_id
  join public.job_partner_terms t on t.job_id = a.job_id and t.partner_id is not null
  join public.partners p on p.id = t.partner_id
  left join latest_consent lc on lc.application_id = a.id and lc.partner_id = t.partner_id
  left join live_submission s on s.application_id = a.id
  left join items it on it.application_id = a.id
  where a.stage not in ('rejected', 'withdrawn')
    and (s.id is null or s.stage not in ('completed', 'declined', 'cancelled'))
),
actions as (
  select b.*,
    case
      when b.submission_id is null then
        case
          when b.partner_status <> 'active' then 'Partner isn''t active: hold or move the candidate'
          when b.consent_status is null then 'Ask the candidate for approval'
          when b.consent_status = 'pending' and b.consent_expires_at > now() then 'Waiting for the candidate''s approval'
          when b.consent_status = 'granted' and b.is_strike and not b.consent_includes_strike then 'Ask again: approval must name the strike'
          when b.consent_status = 'granted' then 'Record the submission'
          when b.consent_status = 'declined' then 'Candidate declined: close the application'
          else 'Ask for approval again'
        end
      else
        case b.journey_stage
          when 'submitted' then 'Chase ' || b.partner_name || ' for a review'
          when 'partner_review' then 'Chase ' || b.partner_name || ' for a decision'
          when 'interview' then 'Get interview feedback'
          when 'offer' then 'Confirm the offer with the candidate'
          when 'offer_accepted' then 'Start credentialing with ' || b.partner_name
          when 'credentialing' then
            case when b.missing_items > 0 then 'Collect ' || b.missing_items || ' missing item' || case when b.missing_items = 1 then '' else 's' end
                 else 'Confirm clearance with ' || b.partner_name end
          when 'cleared_to_start' then 'Check in before the start date'
          else
            case when b.assignment_end_on is not null and b.assignment_end_on - current_date <= 42
                      and coalesce((select pl.status::text from public.next_assignment_plans pl where pl.application_id = b.application_id), 'not_started')
                      not in ('extending', 'next_lined_up', 'not_continuing')
                 then 'Plan the next assignment' else 'Check in during the assignment' end
        end
    end as next_action,
    case
      when b.submission_id is null then
        case
          when b.consent_status = 'pending' and b.consent_expires_at > now() then b.consent_expires_at::date
          else current_date
        end
      else
        case b.journey_stage
          when 'submitted' then b.stage_updated_at::date + 3
          when 'partner_review' then b.stage_updated_at::date + 5
          when 'interview' then b.stage_updated_at::date + 2
          when 'offer' then b.stage_updated_at::date + 2
          when 'offer_accepted' then b.stage_updated_at::date + 2
          when 'credentialing' then coalesce(b.next_item_due, b.stage_updated_at::date + 5)
          when 'cleared_to_start' then coalesce(b.assignment_start_on - 3, b.stage_updated_at::date + 7)
          else
            case when b.assignment_end_on is not null and b.assignment_end_on - current_date <= 42
                      and coalesce((select pl.status::text from public.next_assignment_plans pl where pl.application_id = b.application_id), 'not_started')
                      not in ('extending', 'next_lined_up', 'not_continuing')
                 then b.assignment_end_on - 28 else b.stage_updated_at::date + 14 end
        end
    end as next_action_due
  from base b
)
select a.*,
       (a.next_action_due < current_date or a.overdue_items > 0) as overdue,
       (select pl.status from public.next_assignment_plans pl where pl.application_id = a.application_id) as plan_status
from actions a;


-- Grants ---------------------------------------------------------------------------------

revoke all on function public.next_assignment_options(uuid) from public, anon;
revoke all on function public.set_next_assignment_plan(uuid, integer, public.next_assignment_status, text) from public, anon;
revoke all on function public.put_forward_for_next_assignment(uuid, uuid) from public, anon;
grant execute on function public.next_assignment_options(uuid) to authenticated;
grant execute on function public.set_next_assignment_plan(uuid, integer, public.next_assignment_status, text) to authenticated;
grant execute on function public.put_forward_for_next_assignment(uuid, uuid) to authenticated;
