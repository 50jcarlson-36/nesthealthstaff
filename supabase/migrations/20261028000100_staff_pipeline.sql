-- Phase 2: staff pipeline. Recruiters and admins move inquiries between stages,
-- add notes and assign a recruiter. Every change goes through a function below;
-- staff still have no direct write grants on inquiries, notes or events.
--
-- Errors use PostgREST's PTxxx SQLSTATEs so clients get a matching HTTP status:
--   PT400  invalid input (message is safe to show)
--   PT404  inquiry doesn't exist or belongs to another organization
--   PT409  expected_version is stale: someone else changed the inquiry first

-- Notes ---------------------------------------------------------------------

create table public.inquiry_notes (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.inquiries (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index inquiry_notes_inquiry_created_idx
  on public.inquiry_notes (inquiry_id, created_at);

alter table public.inquiry_notes enable row level security;
revoke all on public.inquiry_notes from anon, authenticated;
grant select on public.inquiry_notes to authenticated;

create policy "Staff read their organization's inquiry notes"
  on public.inquiry_notes for select to authenticated
  using (private.has_org_role(organization_id));

-- Notes are append-only: there is no edit or delete, so they work as a record
-- of what was said and when.

-- Shared guard ----------------------------------------------------------------

-- Locks the inquiry row and checks the caller is staff of its organization.
-- Another organization's inquiry reports "not found", so ids can't be probed.
-- A null expected version skips the concurrency check (notes don't conflict).
create or replace function private.lock_inquiry_for_staff(
  p_inquiry_id uuid,
  p_expected_version integer
)
returns public.inquiries
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.inquiries;
begin
  select * into r from public.inquiries where id = p_inquiry_id for update;
  if not found or not private.has_org_role(r.organization_id) then
    raise exception 'Inquiry not found' using errcode = 'PT404';
  end if;
  if p_expected_version is not null and r.version <> p_expected_version then
    raise exception 'Someone else changed this inquiry. Reload to see the latest version.'
      using errcode = 'PT409';
  end if;
  return r;
end;
$$;

revoke all on function private.lock_inquiry_for_staff(uuid, integer) from public, anon, authenticated;

-- Stage changes ---------------------------------------------------------------

-- Any stage can move to any other, since recruiters sometimes step back. Closing
-- requires a reason; reopening clears it.
create or replace function public.change_inquiry_stage(
  p_inquiry_id uuid,
  p_expected_version integer,
  p_stage public.inquiry_stage,
  p_closed_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.inquiries;
  v_from public.inquiry_stage;
  v_reason text := nullif(trim(p_closed_reason), '');
begin
  if p_expected_version is null or p_stage is null then
    raise exception 'Stage and version are required' using errcode = 'PT400';
  end if;

  r := private.lock_inquiry_for_staff(p_inquiry_id, p_expected_version);
  v_from := r.stage;

  if v_from = p_stage then
    raise exception 'The inquiry is already in that stage' using errcode = 'PT400';
  end if;
  if p_stage = 'closed' and v_reason is null then
    raise exception 'Give a reason for closing the inquiry' using errcode = 'PT400';
  end if;
  if p_stage <> 'closed' and v_reason is not null then
    raise exception 'Only closed inquiries take a reason' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'Keep the closing reason under 500 characters' using errcode = 'PT400';
  end if;

  update public.inquiries
  set stage = p_stage, closed_reason = v_reason, version = version + 1
  where id = r.id
  returning * into r;

  insert into public.inquiry_events (inquiry_id, organization_id, event_type, from_stage, to_stage, actor_id, details)
  values (r.id, r.organization_id, 'stage_changed', v_from, p_stage, (select auth.uid()),
          jsonb_strip_nulls(jsonb_build_object('closed_reason', v_reason)));

  return jsonb_build_object('id', r.id, 'stage', r.stage, 'closed_reason', r.closed_reason, 'version', r.version);
end;
$$;

-- Assignment ----------------------------------------------------------------

-- The assignee must be staff (admin or recruiter) of the inquiry's own
-- organization. Null unassigns.
create or replace function public.assign_inquiry(
  p_inquiry_id uuid,
  p_expected_version integer,
  p_assignee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.inquiries;
  v_from uuid;
begin
  if p_expected_version is null then
    raise exception 'Version is required' using errcode = 'PT400';
  end if;

  r := private.lock_inquiry_for_staff(p_inquiry_id, p_expected_version);
  v_from := r.assigned_recruiter_id;

  if v_from is not distinct from p_assignee_id then
    raise exception 'The inquiry is already assigned that way' using errcode = 'PT400';
  end if;
  if p_assignee_id is not null and not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = r.organization_id
      and m.user_id = p_assignee_id
      and m.role in ('admin', 'recruiter')
  ) then
    raise exception 'That person isn''t on this agency''s staff' using errcode = 'PT400';
  end if;

  update public.inquiries
  set assigned_recruiter_id = p_assignee_id, version = version + 1
  where id = r.id
  returning * into r;

  insert into public.inquiry_events (inquiry_id, organization_id, event_type, actor_id, details)
  values (r.id, r.organization_id, 'assigned', (select auth.uid()),
          jsonb_build_object('from', v_from, 'to', p_assignee_id));

  return jsonb_build_object('id', r.id, 'assigned_recruiter_id', r.assigned_recruiter_id, 'version', r.version);
end;
$$;

-- Notes ---------------------------------------------------------------------

create or replace function public.add_inquiry_note(
  p_inquiry_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.inquiries;
  v_body text := trim(p_body);
  v_note public.inquiry_notes;
begin
  if v_body is null or v_body = '' then
    raise exception 'Write something before saving the note' using errcode = 'PT400';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'Keep notes under 4,000 characters' using errcode = 'PT400';
  end if;

  r := private.lock_inquiry_for_staff(p_inquiry_id, null);

  insert into public.inquiry_notes (inquiry_id, organization_id, author_id, body)
  values (r.id, r.organization_id, (select auth.uid()), v_body)
  returning * into v_note;

  insert into public.inquiry_events (inquiry_id, organization_id, event_type, actor_id, details)
  values (r.id, r.organization_id, 'note_added', (select auth.uid()),
          jsonb_build_object('note_id', v_note.id));

  return jsonb_build_object('id', v_note.id, 'created_at', v_note.created_at);
end;
$$;

-- Staff directory -------------------------------------------------------------

-- Who can be assigned. Recruiters can't read other people's memberships
-- directly, so this returns just names and roles for staff of one organization.
create or replace function public.organization_staff(p_organization_id uuid)
returns table (user_id uuid, full_name text, role public.org_role)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'PT404';
  end if;
  return query
    select m.user_id, p.full_name, m.role
    from public.organization_memberships m
    join public.profiles p on p.id = m.user_id
    where m.organization_id = p_organization_id
      and m.role in ('admin', 'recruiter')
    order by p.full_name nulls last, m.user_id;
end;
$$;

-- Grants ----------------------------------------------------------------------

revoke all on function public.change_inquiry_stage(uuid, integer, public.inquiry_stage, text) from public, anon;
revoke all on function public.assign_inquiry(uuid, integer, uuid) from public, anon;
revoke all on function public.add_inquiry_note(uuid, text) from public, anon;
revoke all on function public.organization_staff(uuid) from public, anon;

grant execute on function public.change_inquiry_stage(uuid, integer, public.inquiry_stage, text) to authenticated;
grant execute on function public.assign_inquiry(uuid, integer, uuid) to authenticated;
grant execute on function public.add_inquiry_note(uuid, text) to authenticated;
grant execute on function public.organization_staff(uuid) to authenticated;
