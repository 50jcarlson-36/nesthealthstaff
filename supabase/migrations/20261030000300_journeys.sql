-- Candidate journeys: where each candidate stands with a partner, what's
-- still missing, and what should happen next.
--
--   partner_submissions gains a journey stage and assignment dates, moved on
--   by recruiters as the partner reports progress.
--   journey_items is the checklist per application: things needed, who owns
--   them (Nest, the partner or the candidate), and when they're due. It
--   records that an item exists and its status, never the document itself.
--   partner_requirements are each partner's standard items, copied onto the
--   checklist when a candidate is submitted.
--   journey_overview computes the next action, its due date and whether the
--   journey is overdue, for every open application on a partner opening.
--
-- Errors: PT400 invalid input, PT403 not allowed, PT404 not found, PT409 stale.

create type public.journey_stage as enum (
  'submitted', 'partner_review', 'interview', 'offer', 'offer_accepted', 'credentialing',
  'cleared_to_start', 'started', 'extended', 'completed', 'declined', 'cancelled'
);
create type public.journey_item_owner as enum ('nest', 'partner', 'candidate');
create type public.journey_item_status as enum ('needed', 'received', 'waived');

-- Journey stage on a submission ---------------------------------------------------

alter table public.partner_submissions
  add column stage public.journey_stage not null default 'submitted',
  add column stage_updated_at timestamptz not null default now(),
  add column stage_note text check (char_length(stage_note) <= 1000),
  add column assignment_start_on date,
  add column assignment_end_on date,
  add constraint partner_submissions_assignment_dates_check
    check (assignment_end_on is null or assignment_start_on is null or assignment_end_on >= assignment_start_on);

-- Partner requirements ---------------------------------------------------------------

create table public.partner_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  partner_id uuid not null references public.partners (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  owner public.journey_item_owner not null default 'candidate',
  -- Due this many days before the assignment starts, when the start is known.
  due_days_before_start integer check (due_days_before_start between 0 and 120),
  position integer not null default 0
);

create index partner_requirements_partner_idx on public.partner_requirements (partner_id, position);

-- Checklist -----------------------------------------------------------------------------

create table public.journey_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  application_id uuid not null references public.job_applications (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  owner public.journey_item_owner not null,
  status public.journey_item_status not null default 'needed',
  due_on date,
  note text check (char_length(note) <= 1000),
  source text not null default 'manual' check (source in ('manual', 'partner_requirement')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_by uuid references public.profiles (id) on delete set null,
  completed_at timestamptz,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  check ((status = 'needed') = (completed_at is null))
);

create index journey_items_application_idx on public.journey_items (application_id, created_at);
create index journey_items_open_due_idx on public.journey_items (organization_id, due_on) where status = 'needed';

create trigger journey_items_set_updated_at
  before update on public.journey_items
  for each row execute function private.set_updated_at();

alter table public.partner_requirements enable row level security;
alter table public.journey_items enable row level security;
revoke all on public.partner_requirements, public.journey_items from anon, authenticated;
grant select on public.partner_requirements, public.journey_items to authenticated;

create policy "Staff read their organization's partner requirements"
  on public.partner_requirements for select to authenticated using (private.has_org_role(organization_id));
create policy "Staff read their organization's journey items"
  on public.journey_items for select to authenticated using (private.has_org_role(organization_id));

-- A submission starts the partner's standard checklist. Items already on the
-- application with the same title aren't added twice.
create or replace function private.copy_partner_requirements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date;
begin
  select start_date into v_start from public.jobs where id = new.job_id;
  insert into public.journey_items (organization_id, application_id, title, owner, due_on, source, created_by)
  select new.organization_id, new.application_id, r.title, r.owner,
         case when v_start is not null and r.due_days_before_start is not null
              then v_start - r.due_days_before_start end,
         'partner_requirement', new.submitted_by
  from public.partner_requirements r
  where r.partner_id = new.partner_id
    and not exists (
      select 1 from public.journey_items i
      where i.application_id = new.application_id and lower(i.title) = lower(r.title)
    )
  order by r.position;
  return new;
end;
$$;

create trigger partner_submissions_copy_requirements
  after insert on public.partner_submissions
  for each row execute function private.copy_partner_requirements();

-- Functions -------------------------------------------------------------------------------

-- Replaces a partner's standard requirements. Admins only, like the rest of the
-- partner's terms. Doesn't touch checklists that were already created.
create or replace function public.set_partner_requirements(p_partner_id uuid, p_requirements jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.partners;
  r jsonb;
  v_position integer := 0;
  v_title text;
begin
  select * into p from public.partners where id = p_partner_id for update;
  if not found or not private.has_org_role(p.organization_id) then
    raise exception 'Partner not found' using errcode = 'PT404';
  end if;
  if not private.has_org_role(p.organization_id, array['admin']::public.org_role[]) then
    raise exception 'Only agency admins can change partner requirements' using errcode = 'PT403';
  end if;
  if p_requirements is null or jsonb_typeof(p_requirements) <> 'array' or jsonb_array_length(p_requirements) > 50 then
    raise exception 'Give up to 50 requirements' using errcode = 'PT400';
  end if;

  delete from public.partner_requirements where partner_id = p.id;
  for r in select value from jsonb_array_elements(p_requirements) loop
    v_title := nullif(trim(r ->> 'title'), '');
    if v_title is null or char_length(v_title) > 200 then
      raise exception 'Each requirement needs a title under 200 characters' using errcode = 'PT400';
    end if;
    begin
      insert into public.partner_requirements (organization_id, partner_id, title, owner, due_days_before_start, position)
      values (p.organization_id, p.id, v_title,
              coalesce(nullif(r ->> 'owner', ''), 'candidate')::public.journey_item_owner,
              nullif(r ->> 'due_days_before_start', '')::integer, v_position);
    exception when invalid_text_representation or check_violation then
      raise exception 'Check requirement "%": owner or due days is invalid', v_title using errcode = 'PT400';
    end;
    v_position := v_position + 1;
  end loop;

  insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
  values (p.organization_id, (select auth.uid()), 'partner_requirements_set', 'partners', p.id::text,
          jsonb_build_object('count', v_position));
  return jsonb_build_object('count', v_position);
end;
$$;

-- Moves a submission through the partner's process. Assignment dates are
-- optional and kept when not given; the stage note replaces the last one.
create or replace function public.update_journey_stage(
  p_submission_id uuid,
  p_expected_version integer,
  p_stage public.journey_stage,
  p_note text default null,
  p_start_on date default null,
  p_end_on date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.partner_submissions;
  v_note text := nullif(trim(p_note), '');
  v_from public.journey_stage;
  v_app public.job_applications;
  v_app_stage public.application_stage;
begin
  select * into s from public.partner_submissions where id = p_submission_id for update;
  if not found or not private.has_org_role(s.organization_id) then
    raise exception 'Submission not found' using errcode = 'PT404';
  end if;
  if p_expected_version is null or s.version <> p_expected_version then
    raise exception 'Someone else changed this submission. Reload to see the latest version.' using errcode = 'PT409';
  end if;
  if s.status <> 'submitted' then
    raise exception 'This submission was withdrawn or reported as a duplicate' using errcode = 'PT400';
  end if;
  if p_stage is null then
    raise exception 'Choose a stage' using errcode = 'PT400';
  end if;
  perform private.require_length(v_note, 1000, 'note');
  if p_stage in ('declined', 'cancelled') and v_note is null then
    raise exception 'Give a reason when the journey ends this way' using errcode = 'PT400';
  end if;
  if p_stage in ('started', 'extended', 'completed') and coalesce(p_start_on, s.assignment_start_on) is null then
    raise exception 'Give the assignment start date' using errcode = 'PT400';
  end if;
  if coalesce(p_end_on, s.assignment_end_on) < coalesce(p_start_on, s.assignment_start_on) then
    raise exception 'The assignment can''t end before it starts' using errcode = 'PT400';
  end if;
  if p_stage = s.stage and v_note is not distinct from s.stage_note
     and coalesce(p_start_on, s.assignment_start_on) is not distinct from s.assignment_start_on
     and coalesce(p_end_on, s.assignment_end_on) is not distinct from s.assignment_end_on then
    raise exception 'Nothing changed' using errcode = 'PT400';
  end if;

  v_from := s.stage;
  update public.partner_submissions set
    stage = p_stage,
    stage_updated_at = case when p_stage <> s.stage then now() else stage_updated_at end,
    stage_note = v_note,
    assignment_start_on = coalesce(p_start_on, assignment_start_on),
    assignment_end_on = coalesce(p_end_on, assignment_end_on),
    version = version + 1
  where id = s.id
  returning * into s;

  -- Keep the application's own stage in step with the milestones it has.
  select * into v_app from public.job_applications where id = s.application_id for update;
  v_app_stage := case when p_stage in ('offer', 'offer_accepted', 'credentialing', 'cleared_to_start') then 'offered'
                      when p_stage in ('started', 'extended', 'completed') then 'hired'
                      else v_app.stage end;
  if v_app.stage not in ('rejected', 'withdrawn') and v_app_stage <> v_app.stage then
    update public.job_applications set stage = v_app_stage, version = version + 1 where id = v_app.id;
    insert into public.application_events (application_id, organization_id, event_type, from_stage, to_stage, actor_id, details)
    values (v_app.id, v_app.organization_id, 'stage_changed', v_app.stage, v_app_stage, (select auth.uid()),
            jsonb_build_object('reason', 'journey_' || p_stage));
  end if;

  insert into public.application_events (application_id, organization_id, event_type, actor_id, details)
  values (s.application_id, s.organization_id, 'journey_stage_changed', (select auth.uid()),
          jsonb_build_object('submission_id', s.id, 'from', v_from, 'to', p_stage,
                             'start_on', s.assignment_start_on, 'end_on', s.assignment_end_on));
  return jsonb_build_object('id', s.id, 'stage', s.stage, 'version', s.version);
end;
$$;

create or replace function public.add_journey_item(
  p_application_id uuid,
  p_title text,
  p_owner public.journey_item_owner,
  p_due_on date default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.job_applications;
  v_title text := nullif(trim(p_title), '');
  v_note text := nullif(trim(p_note), '');
  v_id uuid;
begin
  select * into a from public.job_applications where id = p_application_id;
  if not found or not private.has_org_role(a.organization_id) then
    raise exception 'Application not found' using errcode = 'PT404';
  end if;
  if v_title is null then raise exception 'Say what''s needed' using errcode = 'PT400'; end if;
  perform private.require_length(v_title, 200, 'item');
  perform private.require_length(v_note, 1000, 'note');
  if p_owner is null then raise exception 'Choose who owns it' using errcode = 'PT400'; end if;

  insert into public.journey_items (organization_id, application_id, title, owner, due_on, note, created_by)
  values (a.organization_id, a.id, v_title, p_owner, p_due_on, v_note, (select auth.uid()))
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function public.set_journey_item_status(
  p_item_id uuid,
  p_expected_version integer,
  p_status public.journey_item_status,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.journey_items;
  v_note text := nullif(trim(p_note), '');
begin
  select * into i from public.journey_items where id = p_item_id for update;
  if not found or not private.has_org_role(i.organization_id) then
    raise exception 'Item not found' using errcode = 'PT404';
  end if;
  if p_expected_version is null or i.version <> p_expected_version then
    raise exception 'Someone else changed this item. Reload to see the latest version.' using errcode = 'PT409';
  end if;
  if p_status is null or p_status = i.status then
    raise exception 'Nothing changed' using errcode = 'PT400';
  end if;
  perform private.require_length(v_note, 1000, 'note');
  if p_status = 'waived' and v_note is null then
    raise exception 'Say why it isn''t needed' using errcode = 'PT400';
  end if;

  update public.journey_items set
    status = p_status,
    note = coalesce(v_note, note),
    completed_at = case when p_status = 'needed' then null else now() end,
    completed_by = case when p_status = 'needed' then null else (select auth.uid()) end,
    version = version + 1
  where id = i.id
  returning * into i;
  return jsonb_build_object('id', i.id, 'status', i.status, 'version', i.version);
end;
$$;

-- Overview ---------------------------------------------------------------------------------

-- One row per open application on a partner opening. Runs with the caller's
-- rights, so staff see only their own agency. The next action and its due
-- date follow from the stage, the consent and the checklist; a journey is
-- overdue when that date has passed or a needed item is past due.
create view public.journey_overview
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
                 then b.assignment_end_on - 28 else b.stage_updated_at::date + 14 end
        end
    end as next_action_due
  from base b
)
select *,
       (next_action_due < current_date or overdue_items > 0) as overdue
from actions;

grant select on public.journey_overview to authenticated;

-- Grants ------------------------------------------------------------------------------------

revoke all on function public.set_partner_requirements(uuid, jsonb) from public, anon;
revoke all on function public.update_journey_stage(uuid, integer, public.journey_stage, text, date, date) from public, anon;
revoke all on function public.add_journey_item(uuid, text, public.journey_item_owner, date, text) from public, anon;
revoke all on function public.set_journey_item_status(uuid, integer, public.journey_item_status, text) from public, anon;

grant execute on function public.set_partner_requirements(uuid, jsonb) to authenticated;
grant execute on function public.update_journey_stage(uuid, integer, public.journey_stage, text, date, date) to authenticated;
grant execute on function public.add_journey_item(uuid, text, public.journey_item_owner, date, text) to authenticated;
grant execute on function public.set_journey_item_status(uuid, integer, public.journey_item_status, text) to authenticated;
