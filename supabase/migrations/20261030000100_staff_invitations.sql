-- Staff invitations and team management. An agency admin invites someone by
-- email; the staff-invite Edge Function records the invitation through
-- invite_staff and creates the person's login, and the invitation email sends
-- them to ward's ordinary sign-in. Access is granted only when they sign in:
-- ward then calls accept_staff_invitations, which matches pending invitations
-- against the caller's own confirmed auth email, never a client-supplied one.
--
-- Errors use PostgREST's PTxxx SQLSTATEs:
--   PT400  invalid input (message is safe to show)
--   PT403  the caller isn't an admin of the organization
--   PT404  the invitation or member doesn't exist, or belongs to another organization

-- Invitations -------------------------------------------------------------------

create table public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email text not null
    check (char_length(email) <= 254 and email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name text check (full_name is null or char_length(full_name) between 1 and 160),
  role public.org_role not null,
  invited_by uuid references public.profiles (id) on delete set null,
  sent_count integer not null default 1 check (sent_count between 1 and 5),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (accepted_at is null or revoked_at is null)
);

-- One open invitation per person per agency; inviting again resends it.
create unique index staff_invitations_one_open_idx
  on public.staff_invitations (organization_id, email)
  where accepted_at is null and revoked_at is null;
create index staff_invitations_email_idx
  on public.staff_invitations (email)
  where accepted_at is null and revoked_at is null;

create trigger staff_invitations_set_updated_at
  before update on public.staff_invitations
  for each row execute function private.set_updated_at();

alter table public.staff_invitations enable row level security;
revoke all on public.staff_invitations from anon, authenticated;
grant select on public.staff_invitations to authenticated;

create policy "Admins read their organization's invitations"
  on public.staff_invitations for select to authenticated
  using (private.has_org_role(organization_id, array['admin']::public.org_role[]));

-- Shared guard ----------------------------------------------------------------

-- has_org_role reads auth.uid(); invite_staff runs as the service role on
-- behalf of a user the Edge Function has authenticated, so it names the actor.
create or replace function private.require_org_admin(p_organization_id uuid, p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = p_user_id
      and m.role = 'admin'
  ) then
    raise exception 'Only agency admins can manage staff' using errcode = 'PT403';
  end if;
end;
$$;

revoke all on function private.require_org_admin(uuid, uuid) from public;

-- Invite ------------------------------------------------------------------------

-- Called by the staff-invite Edge Function only (service role). Inviting
-- someone who already has an open invitation updates it and sends it again,
-- up to five times; after that the admin revokes it and starts over.
create or replace function public.invite_staff(
  p_actor_id uuid,
  p_organization_id uuid,
  p_email text,
  p_full_name text,
  p_role public.org_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := nullif(trim(coalesce(p_full_name, '')), '');
  v_org public.organizations;
  v_inviter text;
  v_invitation public.staff_invitations;
  v_status text;
begin
  perform private.require_org_admin(p_organization_id, p_actor_id);

  if v_email = '' or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address' using errcode = 'PT400';
  end if;
  if v_name is not null and char_length(v_name) > 160 then
    raise exception 'Keep the name under 160 characters' using errcode = 'PT400';
  end if;
  if p_role is null then
    raise exception 'Choose a role' using errcode = 'PT400';
  end if;

  select * into v_org from public.organizations where id = p_organization_id;

  if exists (
    select 1
    from public.organization_memberships m
    join auth.users u on u.id = m.user_id
    where m.organization_id = p_organization_id and lower(u.email) = v_email
  ) then
    raise exception 'That person is already on your staff' using errcode = 'PT400';
  end if;

  select * into v_invitation
  from public.staff_invitations
  where organization_id = p_organization_id and email = v_email
    and accepted_at is null and revoked_at is null
  for update;

  if found then
    if v_invitation.sent_count >= 5 then
      raise exception 'This invitation has been sent five times. Revoke it and invite again.'
        using errcode = 'PT400';
    end if;
    update public.staff_invitations
    set role = p_role,
        full_name = coalesce(v_name, full_name),
        invited_by = p_actor_id,
        sent_count = sent_count + 1,
        expires_at = now() + interval '14 days'
    where id = v_invitation.id
    returning * into v_invitation;
    v_status := 'resent';
  else
    insert into public.staff_invitations
      (organization_id, email, full_name, role, invited_by, expires_at)
    values (p_organization_id, v_email, v_name, p_role, p_actor_id, now() + interval '14 days')
    returning * into v_invitation;
    v_status := 'created';
  end if;

  select full_name into v_inviter from public.profiles where id = p_actor_id;

  -- The email carries no sign-in token: it sends the person to ward, where
  -- they request an ordinary magic link for this address.
  insert into public.notification_outbox
    (organization_id, dedupe_key, template, recipient, template_data)
  values (
    p_organization_id,
    'staff_invitation:' || v_invitation.id || ':' || v_invitation.sent_count,
    'staff_invitation',
    v_email,
    jsonb_build_object(
      'organization_name', v_org.name,
      'role', v_invitation.role,
      'inviter_name', v_inviter,
      'expires_at', v_invitation.expires_at
    )
  );

  insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
  values (p_organization_id, p_actor_id, 'staff_invitation_' || v_status, 'staff_invitations', v_invitation.id::text,
          jsonb_build_object('role', v_invitation.role, 'sent_count', v_invitation.sent_count));

  return jsonb_build_object(
    'status', v_status,
    'invitation_id', v_invitation.id,
    'email', v_invitation.email,
    'expires_at', v_invitation.expires_at
  );
end;
$$;

create or replace function public.revoke_staff_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.staff_invitations;
begin
  select * into v_invitation from public.staff_invitations where id = p_invitation_id for update;
  if not found or not private.has_org_role(v_invitation.organization_id, array['admin']::public.org_role[]) then
    raise exception 'Invitation not found' using errcode = 'PT404';
  end if;
  if v_invitation.accepted_at is not null then
    raise exception 'This invitation was already accepted. Remove the person from the team instead.'
      using errcode = 'PT400';
  end if;
  if v_invitation.revoked_at is not null then
    raise exception 'This invitation was already revoked' using errcode = 'PT400';
  end if;

  update public.staff_invitations
  set revoked_at = now(), revoked_by = (select auth.uid())
  where id = v_invitation.id;

  -- An invitation email still waiting in the outbox is no longer true.
  update public.notification_outbox
  set status = 'cancelled'
  where organization_id = v_invitation.organization_id
    and dedupe_key like 'staff_invitation:' || v_invitation.id || ':%'
    and status = 'pending';

  insert into public.audit_events (organization_id, actor_id, action, target_table, target_id)
  values (v_invitation.organization_id, (select auth.uid()), 'staff_invitation_revoked',
          'staff_invitations', v_invitation.id::text);

  return jsonb_build_object('id', v_invitation.id);
end;
$$;

-- Accept ------------------------------------------------------------------------

-- Ward calls this after every sign-in. The address comes from auth.users for
-- the signed-in user, so only someone who completed a magic link for that
-- address can accept. An existing membership keeps its current role.
create or replace function public.accept_staff_invitations()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email text;
  v_invitation public.staff_invitations;
  v_accepted integer := 0;
begin
  select lower(u.email) into v_email
  from auth.users u
  where u.id = v_user_id and u.email_confirmed_at is not null;
  if v_email is null then
    return jsonb_build_object('accepted', 0);
  end if;

  for v_invitation in
    select * from public.staff_invitations
    where email = v_email and accepted_at is null and revoked_at is null and expires_at > now()
    order by created_at
    for update
  loop
    insert into public.organization_memberships (organization_id, user_id, role, created_by)
    values (v_invitation.organization_id, v_user_id, v_invitation.role, v_invitation.invited_by)
    on conflict (organization_id, user_id) do nothing;

    update public.staff_invitations
    set accepted_at = now(), accepted_by = v_user_id
    where id = v_invitation.id;

    -- The name the admin typed, unless the person already has one.
    update public.profiles
    set full_name = v_invitation.full_name
    where id = v_user_id and full_name is null and v_invitation.full_name is not null;

    insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
    values (v_invitation.organization_id, v_user_id, 'staff_invitation_accepted', 'staff_invitations',
            v_invitation.id::text, jsonb_build_object('role', v_invitation.role));

    v_accepted := v_accepted + 1;
  end loop;

  return jsonb_build_object('accepted', v_accepted);
end;
$$;

-- Team management ---------------------------------------------------------------

-- Admin view of the team, with sign-in emails. organization_staff stays the
-- recruiter-safe directory (names and roles only).
create or replace function public.organization_members(p_organization_id uuid)
returns table (
  user_id uuid,
  full_name text,
  email text,
  role public.org_role,
  joined_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_organization_id, array['admin']::public.org_role[]) then
    raise exception 'Organization not found' using errcode = 'PT404';
  end if;
  return query
    select m.user_id, p.full_name, u.email::text, m.role, m.created_at, u.last_sign_in_at
    from public.organization_memberships m
    join public.profiles p on p.id = m.user_id
    join auth.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
    order by p.full_name nulls last, u.email;
end;
$$;

-- Locks the organization's memberships so two admins can't each demote or
-- remove the other and leave the agency with no admin.
create or replace function private.lock_membership_for_admin(p_organization_id uuid, p_user_id uuid)
returns public.organization_memberships
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.organization_memberships;
begin
  if not private.has_org_role(p_organization_id, array['admin']::public.org_role[]) then
    raise exception 'Organization not found' using errcode = 'PT404';
  end if;
  perform 1 from public.organization_memberships
  where organization_id = p_organization_id
  order by id
  for update;
  select * into r from public.organization_memberships
  where organization_id = p_organization_id and user_id = p_user_id;
  if not found then
    raise exception 'That person isn''t on your staff' using errcode = 'PT404';
  end if;
  return r;
end;
$$;

revoke all on function private.lock_membership_for_admin(uuid, uuid) from public;

create or replace function public.change_staff_role(
  p_organization_id uuid,
  p_user_id uuid,
  p_role public.org_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.organization_memberships;
begin
  if p_role is null then
    raise exception 'Choose a role' using errcode = 'PT400';
  end if;
  r := private.lock_membership_for_admin(p_organization_id, p_user_id);
  if r.role = p_role then
    raise exception 'They already have that role' using errcode = 'PT400';
  end if;
  if r.role = 'admin' and not exists (
    select 1 from public.organization_memberships
    where organization_id = p_organization_id and role = 'admin' and user_id <> p_user_id
  ) then
    raise exception 'The agency needs at least one admin' using errcode = 'PT400';
  end if;

  update public.organization_memberships set role = p_role where id = r.id;

  insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
  values (p_organization_id, (select auth.uid()), 'staff_role_changed', 'organization_memberships',
          r.id::text, jsonb_build_object('user_id', p_user_id, 'from', r.role, 'to', p_role));

  return jsonb_build_object('user_id', p_user_id, 'role', p_role);
end;
$$;

-- Removing someone ends their access at once (every policy reads
-- memberships) and unassigns their inquiries in this agency. Their login
-- remains, since it may belong to another agency too.
create or replace function public.remove_staff_member(p_organization_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.organization_memberships;
  v_actor uuid := (select auth.uid());
  v_unassigned integer;
begin
  if p_user_id = v_actor then
    raise exception 'You can''t remove yourself. Ask another admin.' using errcode = 'PT400';
  end if;
  r := private.lock_membership_for_admin(p_organization_id, p_user_id);

  delete from public.organization_memberships where id = r.id;

  with unassigned as (
    update public.inquiries
    set assigned_recruiter_id = null, version = version + 1
    where organization_id = p_organization_id and assigned_recruiter_id = p_user_id
    returning id
  ), logged as (
    insert into public.inquiry_events (inquiry_id, organization_id, event_type, actor_id, details)
    select id, p_organization_id, 'assigned', v_actor,
           jsonb_build_object('from', p_user_id, 'to', null, 'reason', 'staff_removed')
    from unassigned
    returning 1
  )
  select count(*) into v_unassigned from logged;

  insert into public.audit_events (organization_id, actor_id, action, target_table, target_id, details)
  values (p_organization_id, v_actor, 'staff_removed', 'organization_memberships', r.id::text,
          jsonb_build_object('user_id', p_user_id, 'role', r.role, 'unassigned_inquiries', v_unassigned));

  return jsonb_build_object('user_id', p_user_id, 'unassigned_inquiries', v_unassigned);
end;
$$;

-- Grants ----------------------------------------------------------------------

revoke all on function public.invite_staff(uuid, uuid, text, text, public.org_role) from public, anon, authenticated;
revoke all on function public.revoke_staff_invitation(uuid) from public, anon;
revoke all on function public.accept_staff_invitations() from public, anon;
revoke all on function public.organization_members(uuid) from public, anon;
revoke all on function public.change_staff_role(uuid, uuid, public.org_role) from public, anon;
revoke all on function public.remove_staff_member(uuid, uuid) from public, anon;

grant execute on function public.invite_staff(uuid, uuid, text, text, public.org_role) to service_role;
grant execute on function public.revoke_staff_invitation(uuid) to authenticated;
grant execute on function public.accept_staff_invitations() to authenticated;
grant execute on function public.organization_members(uuid) to authenticated;
grant execute on function public.change_staff_role(uuid, uuid, public.org_role) to authenticated;
grant execute on function public.remove_staff_member(uuid, uuid) to authenticated;
