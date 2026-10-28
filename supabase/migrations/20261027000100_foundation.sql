-- Foundation: organizations (agency tenants), staff memberships, user profiles, audit log.
--
-- Authorization rule for every table in this project: access is derived from rows in
-- organization_memberships (written only by trusted server code), never from JWT
-- metadata or client-supplied organization ids.

-- Helper functions live in a schema that PostgREST does not expose.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create type public.org_role as enum ('admin', 'recruiter');

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Organizations -------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 63),
  name text not null check (char_length(name) between 1 and 200),
  -- Shared inbox that receives new-inquiry alerts. Null disables staff alerts.
  intake_notification_email text
    check (intake_notification_email is null
           or (char_length(intake_notification_email) <= 254
               and intake_notification_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function private.set_updated_at();

-- Profiles ------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text check (full_name is null or char_length(full_name) <= 160),
  phone text check (phone is null or char_length(phone) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- Every auth user gets a profile. Only the display name is copied from user
-- metadata; roles and memberships are never read from it.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 160), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Memberships ---------------------------------------------------------------

create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.org_role not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index organization_memberships_user_id_idx
  on public.organization_memberships (user_id);

create trigger organization_memberships_set_updated_at
  before update on public.organization_memberships
  for each row execute function private.set_updated_at();

-- Security definer so policies can consult memberships without recursing
-- through the memberships table's own RLS.
create or replace function private.has_org_role(
  p_organization_id uuid,
  p_roles public.org_role[] default array['admin', 'recruiter']::public.org_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;

revoke all on function private.has_org_role(uuid, public.org_role[]) from public;
grant execute on function private.has_org_role(uuid, public.org_role[]) to authenticated;

create or replace function private.shares_org_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships mine
    join public.organization_memberships theirs
      on theirs.organization_id = mine.organization_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_user_id
  );
$$;

revoke all on function private.shares_org_with(uuid) from public;
grant execute on function private.shares_org_with(uuid) to authenticated;

-- Audit log -----------------------------------------------------------------

create table public.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (char_length(action) <= 100),
  target_table text check (char_length(target_table) <= 100),
  target_id text check (char_length(target_id) <= 100),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_org_created_idx
  on public.audit_events (organization_id, created_at desc);

-- Row Level Security --------------------------------------------------------
-- Supabase grants table privileges to anon/authenticated by default. Revoke them
-- and grant back only what each policy needs, so RLS is not the only barrier.

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.audit_events enable row level security;

revoke all on public.organizations, public.profiles,
  public.organization_memberships, public.audit_events
  from anon, authenticated;

grant select on public.organizations to authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
grant select on public.organization_memberships to authenticated;
grant select on public.audit_events to authenticated;

create policy "Staff read their organizations"
  on public.organizations for select to authenticated
  using (private.has_org_role(id));

create policy "Users read their own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "Staff read profiles of colleagues"
  on public.profiles for select to authenticated
  using (private.shares_org_with(id));

-- Column grants limit this to full_name and phone.
create policy "Users update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "Users read their own memberships"
  on public.organization_memberships for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Admins read their organization's memberships"
  on public.organization_memberships for select to authenticated
  using (private.has_org_role(organization_id, array['admin']::public.org_role[]));

-- Membership writes go through server code only; there are no insert, update
-- or delete policies, so nobody can grant themselves a role.

create policy "Admins read their organization's audit events"
  on public.audit_events for select to authenticated
  using (private.has_org_role(organization_id, array['admin']::public.org_role[]));
