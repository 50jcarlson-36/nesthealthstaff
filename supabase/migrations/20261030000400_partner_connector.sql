-- Partner connector: how candidate data and progress move between Nest and a
-- partner agency's ATS.
--
--   Out: each partner's submissions (candidate, opening, journey stage and
--   checklist) as JSON or CSV. Staff download it in ward; the partner can pull
--   it from the partner-api function with an API key.
--   In: the partner reports progress, either by posting events to partner-api
--   or by sending a CSV that staff import in ward. Both go through the same
--   update: a journey stage with assignment dates, checklist items by title,
--   and the partner's own candidate reference.
--
-- A partner only ever sees and changes its own submissions. API keys are
-- stored as SHA-256 hashes; the key itself is shown once, when it's created.
-- Every update, applied or not, is logged in partner_events.
--
-- Errors: PT400 invalid input, PT403 not allowed, PT404 not found, PT409 stale.

-- Checklist items can now come from a partner's update.
alter table public.journey_items drop constraint journey_items_source_check;
alter table public.journey_items add constraint journey_items_source_check
  check (source in ('manual', 'partner_requirement', 'partner_update'));

-- API keys ---------------------------------------------------------------------------

create table public.partner_api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  partner_id uuid not null references public.partners (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 100),
  -- The start of the key, so staff can tell keys apart. Not enough to use it.
  key_prefix text not null check (key_prefix ~ '^nhs_pk_[0-9a-f]{8}$'),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id) on delete set null
);

create index partner_api_keys_partner_idx on public.partner_api_keys (partner_id, created_at desc);

-- Partner events ----------------------------------------------------------------------

create table public.partner_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  partner_id uuid not null references public.partners (id) on delete cascade,
  source text not null check (source in ('api', 'csv')),
  -- The partner's id for an API event. Kept only once the event is accepted,
  -- so a rejected event can be fixed and sent again with the same id.
  event_id text check (char_length(event_id) <= 100),
  submission_id uuid references public.partner_submissions (id) on delete set null,
  result text not null check (result in ('applied', 'unchanged', 'stale', 'rejected')),
  error text check (char_length(error) <= 500),
  changes jsonb not null default '{}'::jsonb,
  payload jsonb not null,
  actor_id uuid references public.profiles (id) on delete set null,
  received_at timestamptz not null default now()
);

create unique index partner_events_event_id_idx on public.partner_events (partner_id, event_id) where event_id is not null;
create index partner_events_partner_idx on public.partner_events (partner_id, received_at desc);
create index partner_events_submission_idx on public.partner_events (submission_id, received_at desc);

alter table public.partner_api_keys enable row level security;
alter table public.partner_events enable row level security;
revoke all on public.partner_api_keys, public.partner_events from anon, authenticated;
-- key_hash stays out of reach.
grant select (id, organization_id, partner_id, label, key_prefix, created_by, created_at,
              last_used_at, revoked_at, revoked_by)
  on public.partner_api_keys to authenticated;
grant select on public.partner_events to authenticated;

create policy "Staff read their organization's partner API keys"
  on public.partner_api_keys for select to authenticated using (private.has_org_role(organization_id));
create policy "Staff read their organization's partner events"
  on public.partner_events for select to authenticated using (private.has_org_role(organization_id));

-- Journey stage, shared by staff and partner updates ---------------------------------

create or replace function private.check_journey_stage(
  s public.partner_submissions, p_stage public.journey_stage, p_note text, p_start_on date, p_end_on date
)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_stage is null then
    raise exception 'Choose a stage' using errcode = 'PT400';
  end if;
  perform private.require_length(p_note, 1000, 'note');
  if p_stage in ('declined', 'cancelled') and p_note is null then
    raise exception 'Give a reason when the journey ends this way' using errcode = 'PT400';
  end if;
  if p_stage in ('started', 'extended', 'completed') and coalesce(p_start_on, s.assignment_start_on) is null then
    raise exception 'Give the assignment start date' using errcode = 'PT400';
  end if;
  if coalesce(p_end_on, s.assignment_end_on) < coalesce(p_start_on, s.assignment_start_on) then
    raise exception 'The assignment can''t end before it starts' using errcode = 'PT400';
  end if;
end;
$$;

-- Writes a checked stage change, keeps the application's own stage in step
-- and logs it. p_source says where the change came from: ward, api or csv.
create or replace function private.record_journey_stage(
  s public.partner_submissions, p_stage public.journey_stage, p_note text,
  p_start_on date, p_end_on date, p_actor uuid, p_source text
)
returns public.partner_submissions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from public.journey_stage := s.stage;
  v_app public.job_applications;
  v_app_stage public.application_stage;
begin
  update public.partner_submissions set
    stage = p_stage,
    stage_updated_at = case when p_stage <> s.stage then now() else stage_updated_at end,
    stage_note = p_note,
    assignment_start_on = coalesce(p_start_on, assignment_start_on),
    assignment_end_on = coalesce(p_end_on, assignment_end_on),
    version = version + 1
  where id = s.id
  returning * into s;

  select * into v_app from public.job_applications where id = s.application_id for update;
  v_app_stage := case when p_stage in ('offer', 'offer_accepted', 'credentialing', 'cleared_to_start') then 'offered'
                      when p_stage in ('started', 'extended', 'completed') then 'hired'
                      else v_app.stage end;
  if v_app.stage not in ('rejected', 'withdrawn') and v_app_stage <> v_app.stage then
    update public.job_applications set stage = v_app_stage, version = version + 1 where id = v_app.id;
    insert into public.application_events (application_id, organization_id, event_type, from_stage, to_stage, actor_id, details)
    values (v_app.id, v_app.organization_id, 'stage_changed', v_app.stage, v_app_stage, p_actor,
            jsonb_build_object('reason', 'journey_' || p_stage, 'source', p_source));
  end if;

  insert into public.application_events (application_id, organization_id, event_type, actor_id, details)
  values (s.application_id, s.organization_id, 'journey_stage_changed', p_actor,
          jsonb_build_object('submission_id', s.id, 'from', v_from, 'to', p_stage, 'source', p_source,
                             'start_on', s.assignment_start_on, 'end_on', s.assignment_end_on));
  return s;
end;
$$;

-- Same behaviour as before; the checks and the write are now shared.
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
  perform private.check_journey_stage(s, p_stage, v_note, p_start_on, p_end_on);
  if p_stage = s.stage and v_note is not distinct from s.stage_note
     and coalesce(p_start_on, s.assignment_start_on) is not distinct from s.assignment_start_on
     and coalesce(p_end_on, s.assignment_end_on) is not distinct from s.assignment_end_on then
    raise exception 'Nothing changed' using errcode = 'PT400';
  end if;

  s := private.record_journey_stage(s, p_stage, v_note, p_start_on, p_end_on, (select auth.uid()), 'ward');
  return jsonb_build_object('id', s.id, 'stage', s.stage, 'version', s.version);
end;
$$;

-- Export ------------------------------------------------------------------------------

-- A partner's submissions, oldest change first, for the partner's ATS. The
-- candidate's details are left out once a submission is withdrawn or reported
-- as a duplicate. Internal notes and pay terms are never included.
create or replace function private.partner_export(p_partner_id uuid, p_since timestamptz, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with subs as (
    select s.*, greatest(s.updated_at, coalesce(it.updated_at, s.updated_at)) as changed_at, it.items
    from public.partner_submissions s
    left join lateral (
      select max(i.updated_at) as updated_at,
             jsonb_agg(jsonb_build_object('title', i.title, 'owner', i.owner, 'status', i.status, 'due_on', i.due_on)
                       order by i.created_at) as items
      from public.journey_items i
      where i.application_id = s.application_id
    ) it on true
    where s.partner_id = p_partner_id
  ),
  page as (
    select * from subs
    where p_since is null or changed_at >= p_since
    order by changed_at, id
    limit p_limit + 1
  )
  select jsonb_build_object(
    'submissions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'submission_id', r.id,
        'partner_candidate_reference', r.partner_candidate_reference,
        'status', r.status,
        'submitted_at', r.submitted_at,
        'attribution_expires_on', r.attribution_expires_on,
        'stage', r.stage,
        'stage_updated_at', r.stage_updated_at,
        'assignment_start_on', r.assignment_start_on,
        'assignment_end_on', r.assignment_end_on,
        'candidate', case when r.status = 'submitted'
                          then jsonb_build_object('full_name', a.full_name, 'email', a.email, 'phone', a.phone) end,
        'job', jsonb_build_object(
          'id', j.id, 'title', j.title, 'specialty', j.specialty, 'city', j.city, 'state', j.state,
          'shift', j.shift, 'start_date', j.start_date, 'duration_weeks', j.duration_weeks,
          'partner_job_reference', t.partner_reference, 'is_strike', coalesce(t.is_strike, false)),
        'checklist', coalesce(r.items, '[]'::jsonb),
        'updated_at', r.changed_at
      ) order by r.changed_at, r.id)
      from (select * from page order by changed_at, id limit p_limit) r
      join public.job_applications a on a.id = r.application_id
      join public.jobs j on j.id = r.job_id
      left join public.job_partner_terms t on t.job_id = r.job_id
    ), '[]'::jsonb),
    'has_more', (select count(*) from page) > p_limit
  );
$$;

-- For staff to download and send to the partner. Logged, since it carries
-- candidates' contact details.
create or replace function public.export_partner_submissions(p_partner_id uuid, p_since timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.partners;
  v_export jsonb;
begin
  select * into p from public.partners where id = p_partner_id;
  if not found or not private.has_org_role(p.organization_id) then
    raise exception 'Partner not found' using errcode = 'PT404';
  end if;
  v_export := private.partner_export(p.id, p_since, 5000);
  insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
  values (p.organization_id, (select auth.uid()), 'partner_export', 'partners', p.id::text,
          jsonb_build_object('count', jsonb_array_length(v_export -> 'submissions'), 'since', p_since));
  return jsonb_build_object('partner', jsonb_build_object('id', p.id, 'name', p.name)) || v_export;
end;
$$;

-- Partner updates ----------------------------------------------------------------------

create or replace function private.partner_field(p_update jsonb, p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(trim(p_update ->> p_key), '');
$$;

create or replace function private.partner_date(p_update jsonb, p_key text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := private.partner_field(p_update, p_key);
begin
  if v is null then return null; end if;
  if v !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '% must be a date like 2026-12-31', p_key using errcode = 'PT400';
  end if;
  return v::date;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception '% must be a date like 2026-12-31', p_key using errcode = 'PT400';
end;
$$;

-- Applies one update from a partner to one of its own submissions. Raises
-- PT400 or PT404 for anything it can't apply; callers turn that into a
-- rejected result, and the subtransaction undoes any partial change.
--
-- The update is an object with:
--   submission_id or partner_candidate_reference (one live match required)
--   stage, assignment_start_on, assignment_end_on, note
--   items: [{title, status, owner, due_on, note}], matched by title
--   occurred_at: when the partner made the change; an older stage change
--     than the one already recorded is skipped as stale
create or replace function private.apply_partner_update(
  p public.partners, p_update jsonb, p_source text, p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.partner_submissions;
  v_submission_id uuid;
  v_ref text;
  v_stage public.journey_stage;
  v_target public.journey_stage;
  v_note text;
  v_new_note text;
  v_start date;
  v_end date;
  v_occurred timestamptz;
  v_matches integer;
  v_stale boolean := false;
  v_changes jsonb := '{}'::jsonb;
  v_items jsonb;
  it jsonb;
  v_item public.journey_items;
  v_title text;
  v_status public.journey_item_status;
  v_owner public.journey_item_owner;
  v_due date;
  v_item_note text;
  v_items_changed integer := 0;
begin
  if p_update is null or jsonb_typeof(p_update) <> 'object' then
    raise exception 'Each update must be an object' using errcode = 'PT400';
  end if;

  v_ref := private.partner_field(p_update, 'partner_candidate_reference');
  v_note := private.partner_field(p_update, 'note');
  perform private.require_length(v_ref, 100, 'partner candidate reference');
  perform private.require_length(v_note, 1000, 'note');
  begin
    v_submission_id := private.partner_field(p_update, 'submission_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'submission_id isn''t one of ours: use the id from the export' using errcode = 'PT400';
  end;
  begin
    v_stage := replace(replace(lower(private.partner_field(p_update, 'stage')), ' ', '_'), '-', '_')::public.journey_stage;
  exception when invalid_text_representation then
    raise exception 'Unknown stage "%". Use one of: %', private.partner_field(p_update, 'stage'),
      array_to_string(enum_range(null::public.journey_stage)::text[], ', ') using errcode = 'PT400';
  end;
  v_start := private.partner_date(p_update, 'assignment_start_on');
  v_end := private.partner_date(p_update, 'assignment_end_on');
  begin
    v_occurred := private.partner_field(p_update, 'occurred_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'occurred_at must be a timestamp like 2026-12-31T15:00:00Z' using errcode = 'PT400';
  end;

  -- Find the submission, only among this partner's.
  if v_submission_id is not null then
    select * into s from public.partner_submissions
    where id = v_submission_id and partner_id = p.id for update;
    if not found then
      raise exception 'No submission % for this partner', v_submission_id using errcode = 'PT404';
    end if;
  elsif v_ref is not null then
    select count(*) into v_matches from public.partner_submissions
    where partner_id = p.id and status = 'submitted' and lower(partner_candidate_reference) = lower(v_ref);
    if v_matches = 0 then
      raise exception 'No open submission has reference "%"', v_ref using errcode = 'PT404';
    elsif v_matches > 1 then
      raise exception 'More than one submission has reference "%": use submission_id', v_ref using errcode = 'PT400';
    end if;
    select * into s from public.partner_submissions
    where partner_id = p.id and status = 'submitted' and lower(partner_candidate_reference) = lower(v_ref) for update;
  else
    raise exception 'Give submission_id or partner_candidate_reference' using errcode = 'PT400';
  end if;
  if s.status <> 'submitted' then
    raise exception 'This submission was withdrawn or reported as a duplicate' using errcode = 'PT400';
  end if;

  -- Stage and assignment dates.
  if v_stage is not null or v_start is not null or v_end is not null then
    if v_occurred is not null and v_occurred < s.stage_updated_at then
      v_stale := true;
    else
      v_target := coalesce(v_stage, s.stage);
      v_new_note := case
        when v_target <> s.stage then
          coalesce(v_note, case when v_target in ('declined', 'cancelled') then left('Reported by ' || p.name, 1000) end)
        else coalesce(v_note, s.stage_note) end;
      perform private.check_journey_stage(s, v_target, v_new_note, v_start, v_end);
      if v_target <> s.stage or v_new_note is distinct from s.stage_note
         or coalesce(v_start, s.assignment_start_on) is distinct from s.assignment_start_on
         or coalesce(v_end, s.assignment_end_on) is distinct from s.assignment_end_on then
        v_changes := v_changes || jsonb_build_object('stage', jsonb_build_object('from', s.stage, 'to', v_target));
        s := private.record_journey_stage(s, v_target, v_new_note, v_start, v_end, p_actor, p_source);
      end if;
    end if;
  end if;

  -- Checklist items, matched by title.
  v_items := p_update -> 'items';
  if v_items is not null and jsonb_typeof(v_items) <> 'null' then
    if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) > 50 then
      raise exception 'items must be a list of up to 50' using errcode = 'PT400';
    end if;
    for it in select value from jsonb_array_elements(v_items) loop
      if jsonb_typeof(it) <> 'object' then
        raise exception 'Each item must be an object with a title' using errcode = 'PT400';
      end if;
      v_title := private.partner_field(it, 'title');
      if v_title is null then raise exception 'Each item needs a title' using errcode = 'PT400'; end if;
      perform private.require_length(v_title, 200, 'item title');
      v_item_note := private.partner_field(it, 'note');
      perform private.require_length(v_item_note, 1000, 'item note');
      begin
        v_status := lower(private.partner_field(it, 'status'))::public.journey_item_status;
        v_owner := lower(private.partner_field(it, 'owner'))::public.journey_item_owner;
      exception when invalid_text_representation then
        raise exception 'Item "%": status must be needed, received or waived; owner must be nest, partner or candidate', v_title
          using errcode = 'PT400';
      end;
      v_due := private.partner_date(it, 'due_on');

      select * into v_item from public.journey_items
      where application_id = s.application_id and lower(title) = lower(v_title)
      order by created_at limit 1 for update;
      if not found then
        v_status := coalesce(v_status, 'needed');
        insert into public.journey_items (organization_id, application_id, title, owner, status, due_on, note, source,
                                          created_by, completed_by, completed_at)
        values (s.organization_id, s.application_id, v_title, coalesce(v_owner, 'partner'), v_status, v_due,
                coalesce(v_item_note, case when v_status = 'waived' then left('Waived by ' || p.name, 1000) end),
                'partner_update', p_actor,
                case when v_status <> 'needed' then p_actor end,
                case when v_status <> 'needed' then now() end);
        v_items_changed := v_items_changed + 1;
      elsif coalesce(v_status, v_item.status) <> v_item.status
            or (v_due is not null and v_due is distinct from v_item.due_on)
            or (v_owner is not null and v_owner <> v_item.owner)
            or (v_item_note is not null and v_item_note is distinct from v_item.note) then
        v_status := coalesce(v_status, v_item.status);
        update public.journey_items set
          status = v_status,
          owner = coalesce(v_owner, owner),
          due_on = coalesce(v_due, due_on),
          note = coalesce(v_item_note, case when v_status = 'waived' and v_item.status <> 'waived'
                                            then coalesce(note, left('Waived by ' || p.name, 1000)) else note end),
          completed_at = case when v_status = 'needed' then null
                              when v_status <> v_item.status then now() else completed_at end,
          completed_by = case when v_status = 'needed' then null
                              when v_status <> v_item.status then p_actor else completed_by end,
          version = version + 1
        where id = v_item.id;
        v_items_changed := v_items_changed + 1;
      end if;
    end loop;
  end if;
  if v_items_changed > 0 then
    v_changes := v_changes || jsonb_build_object('items', v_items_changed);
  end if;

  -- The partner's own id for the candidate, so later updates can use it.
  if v_ref is not null and v_ref is distinct from s.partner_candidate_reference then
    update public.partner_submissions set partner_candidate_reference = v_ref, version = version + 1 where id = s.id;
    v_changes := v_changes || jsonb_build_object('partner_candidate_reference', v_ref);
  end if;

  if v_changes <> '{}'::jsonb then
    insert into public.application_events (application_id, organization_id, event_type, actor_id, details)
    values (s.application_id, s.organization_id, 'partner_update', p_actor,
            jsonb_build_object('submission_id', s.id, 'partner_id', p.id, 'source', p_source, 'changes', v_changes));
  end if;

  return jsonb_build_object(
    'result', case when v_changes <> '{}'::jsonb then 'applied' when v_stale then 'stale' else 'unchanged' end,
    'submission_id', s.id,
    'changes', v_changes
  );
end;
$$;

-- The same, with anything it can't apply returned as a rejected result.
create or replace function private.try_partner_update(
  p public.partners, p_update jsonb, p_source text, p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.apply_partner_update(p, p_update, p_source, p_actor);
exception
  when sqlstate 'PT400' or sqlstate 'PT404' then
    return jsonb_build_object('result', 'rejected', 'error', left(sqlerrm, 500));
  when check_violation or string_data_right_truncation then
    return jsonb_build_object('result', 'rejected', 'error', 'A value is too long or not allowed');
end;
$$;

-- Staff import a partner's CSV, already turned into update objects by ward.
-- A dry run reports what each row would do and changes nothing.
create or replace function public.import_partner_updates(p_partner_id uuid, p_rows jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.partners;
  v_actor uuid := (select auth.uid());
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
  r record;
  v_counts jsonb;
begin
  select * into p from public.partners where id = p_partner_id;
  if not found or not private.has_org_role(p.organization_id) then
    raise exception 'Partner not found' using errcode = 'PT404';
  end if;
  if p.status not in ('active', 'paused') then
    raise exception 'Updates can only be imported for active or paused partners' using errcode = 'PT400';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'Import between 1 and 500 rows at a time' using errcode = 'PT400';
  end if;

  begin
    for r in select value, ordinality from jsonb_array_elements(p_rows) with ordinality loop
      v_result := private.try_partner_update(p, r.value, 'csv', v_actor);
      v_results := v_results || jsonb_build_array(jsonb_build_object('row', r.ordinality) || v_result);
      if not p_dry_run then
        insert into public.partner_events (organization_id, partner_id, source, submission_id, result, error, changes, payload, actor_id)
        values (p.organization_id, p.id, 'csv', (v_result ->> 'submission_id')::uuid, v_result ->> 'result',
                v_result ->> 'error', coalesce(v_result -> 'changes', '{}'::jsonb), r.value, v_actor);
      end if;
    end loop;
    -- A dry run undoes everything by leaving this block with an error.
    if p_dry_run then
      raise exception 'dry run' using errcode = 'NHDRY';
    end if;
  exception when sqlstate 'NHDRY' then
    null;
  end;

  select jsonb_object_agg(k, (select count(*) from jsonb_array_elements(v_results) x where x ->> 'result' = k))
  into v_counts
  from unnest(array['applied', 'unchanged', 'stale', 'rejected']) k;

  if not p_dry_run then
    insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
    values (p.organization_id, v_actor, 'partner_import', 'partners', p.id::text, v_counts);
  end if;
  return jsonb_build_object('dry_run', p_dry_run, 'counts', v_counts, 'rows', v_results);
end;
$$;

-- API (service role only: called by the partner-api function) ----------------------------

create or replace function private.partner_for_key(p_key_hash text)
returns public.partners
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.partners;
  v_key_id uuid;
begin
  select k.id into v_key_id
  from public.partner_api_keys k
  join public.partners pa on pa.id = k.partner_id
  where k.key_hash = p_key_hash and k.revoked_at is null and pa.status in ('active', 'paused');
  if v_key_id is null then return null; end if;
  -- At most one write a minute per key.
  update public.partner_api_keys set last_used_at = now()
  where id = v_key_id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  select pa.* into p from public.partner_api_keys k join public.partners pa on pa.id = k.partner_id where k.id = v_key_id;
  return p;
end;
$$;

create or replace function public.partner_api_export(p_key_hash text, p_since timestamptz default null, p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.partners := private.partner_for_key(p_key_hash);
  v_export jsonb;
begin
  if p.id is null then return jsonb_build_object('status', 'unauthorized'); end if;
  v_export := private.partner_export(p.id, p_since, least(greatest(coalesce(p_limit, 500), 1), 1000));
  insert into public.audit_events (organization_id, action, target_table, target_id, details)
  values (p.organization_id, 'partner_api_export', 'partners', p.id::text,
          jsonb_build_object('count', jsonb_array_length(v_export -> 'submissions'), 'since', p_since));
  return jsonb_build_object('status', 'ok', 'partner', jsonb_build_object('name', p.name)) || v_export;
end;
$$;

-- One event from the partner's ATS. event_id makes retries safe: an event
-- already accepted returns "duplicate" and changes nothing.
create or replace function public.partner_api_event(p_key_hash text, p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.partners := private.partner_for_key(p_key_hash);
  v_event_id text;
  v_result jsonb;
  v_previous public.partner_events;
begin
  if p.id is null then return jsonb_build_object('status', 'unauthorized'); end if;
  v_event_id := private.partner_field(p_event, 'event_id');
  if v_event_id is null or char_length(v_event_id) > 100 then
    return jsonb_build_object('status', 'ok', 'result', 'rejected',
                              'error', 'Give each event an event_id of up to 100 characters');
  end if;

  select * into v_previous from public.partner_events where partner_id = p.id and event_id = v_event_id;
  if found then
    return jsonb_build_object('status', 'ok', 'result', 'duplicate', 'submission_id', v_previous.submission_id,
                              'original_result', v_previous.result);
  end if;

  begin
    v_result := private.try_partner_update(p, p_event, 'api', null);
    insert into public.partner_events (organization_id, partner_id, source, event_id, submission_id, result, error, changes, payload)
    values (p.organization_id, p.id, 'api',
            case when v_result ->> 'result' <> 'rejected' then v_event_id end,
            (v_result ->> 'submission_id')::uuid, v_result ->> 'result', v_result ->> 'error',
            coalesce(v_result -> 'changes', '{}'::jsonb), p_event);
  exception when unique_violation then
    -- The same event arrived twice at once; the other one was applied.
    return jsonb_build_object('status', 'ok', 'result', 'duplicate');
  end;
  return jsonb_build_object('status', 'ok') || v_result;
end;
$$;

-- API keys (admins) ---------------------------------------------------------------------

-- Returns the key once. Only its hash is stored. Two live keys per partner at
-- most, so one can replace the other without downtime.
create or replace function public.create_partner_api_key(p_partner_id uuid, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.partners;
  v_label text := coalesce(nullif(trim(p_label), ''), 'API key');
  v_key text;
  v_id uuid;
begin
  select * into p from public.partners where id = p_partner_id for update;
  if not found or not private.has_org_role(p.organization_id) then
    raise exception 'Partner not found' using errcode = 'PT404';
  end if;
  if not private.has_org_role(p.organization_id, array['admin']::public.org_role[]) then
    raise exception 'Only agency admins can create API keys' using errcode = 'PT403';
  end if;
  if p.status <> 'active' then
    raise exception 'Make the partner active before giving it an API key' using errcode = 'PT400';
  end if;
  perform private.require_length(v_label, 100, 'label');
  if (select count(*) from public.partner_api_keys where partner_id = p.id and revoked_at is null) >= 2 then
    raise exception 'This partner already has two keys. Revoke one first.' using errcode = 'PT400';
  end if;

  v_key := 'nhs_pk_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.partner_api_keys (organization_id, partner_id, label, key_prefix, key_hash, created_by)
  values (p.organization_id, p.id, v_label, left(v_key, 15), encode(sha256(convert_to(v_key, 'UTF8')), 'hex'),
          (select auth.uid()))
  returning id into v_id;
  insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
  values (p.organization_id, (select auth.uid()), 'partner_api_key_created', 'partner_api_keys', v_id::text,
          jsonb_build_object('partner_id', p.id, 'label', v_label));
  return jsonb_build_object('id', v_id, 'key', v_key, 'key_prefix', left(v_key, 15));
end;
$$;

create or replace function public.revoke_partner_api_key(p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k public.partner_api_keys;
begin
  select * into k from public.partner_api_keys where id = p_key_id for update;
  if not found or not private.has_org_role(k.organization_id) then
    raise exception 'Key not found' using errcode = 'PT404';
  end if;
  if not private.has_org_role(k.organization_id, array['admin']::public.org_role[]) then
    raise exception 'Only agency admins can revoke API keys' using errcode = 'PT403';
  end if;
  if k.revoked_at is not null then
    raise exception 'This key is already revoked' using errcode = 'PT400';
  end if;
  update public.partner_api_keys set revoked_at = now(), revoked_by = (select auth.uid()) where id = k.id;
  insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
  values (k.organization_id, (select auth.uid()), 'partner_api_key_revoked', 'partner_api_keys', k.id::text,
          jsonb_build_object('partner_id', k.partner_id));
  return jsonb_build_object('id', k.id, 'revoked', true);
end;
$$;

-- Grants ---------------------------------------------------------------------------------

revoke all on function private.check_journey_stage(public.partner_submissions, public.journey_stage, text, date, date) from public, anon, authenticated;
revoke all on function private.record_journey_stage(public.partner_submissions, public.journey_stage, text, date, date, uuid, text) from public, anon, authenticated;
revoke all on function private.partner_export(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function private.partner_field(jsonb, text) from public, anon, authenticated;
revoke all on function private.partner_date(jsonb, text) from public, anon, authenticated;
revoke all on function private.apply_partner_update(public.partners, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function private.try_partner_update(public.partners, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function private.partner_for_key(text) from public, anon, authenticated;

revoke all on function public.export_partner_submissions(uuid, timestamptz) from public, anon;
revoke all on function public.import_partner_updates(uuid, jsonb, boolean) from public, anon;
revoke all on function public.create_partner_api_key(uuid, text) from public, anon;
revoke all on function public.revoke_partner_api_key(uuid) from public, anon;
revoke all on function public.partner_api_export(text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.partner_api_event(text, jsonb) from public, anon, authenticated;

grant execute on function public.export_partner_submissions(uuid, timestamptz) to authenticated;
grant execute on function public.import_partner_updates(uuid, jsonb, boolean) to authenticated;
grant execute on function public.create_partner_api_key(uuid, text) to authenticated;
grant execute on function public.revoke_partner_api_key(uuid) to authenticated;
grant execute on function public.partner_api_export(text, timestamptz, integer) to service_role;
grant execute on function public.partner_api_event(text, jsonb) to service_role;
