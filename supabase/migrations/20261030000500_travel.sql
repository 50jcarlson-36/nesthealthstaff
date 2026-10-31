-- Location and travel: where an opening is, what the federal per diem allows
-- there, and the practical steps of getting a clinician to the assignment.
--
--   job_internal_details gains the facility's street address and ZIP code.
--   Like the facility name, they're internal: the public listing shows only
--   the city and state.
--   per_diem_rates caches GSA per diem rates (public federal data), filled by
--   the travel-data function, so each location is fetched once a month at most.
--   add_travel_checklist adds the standard travel steps to a candidate's
--   journey checklist. It records that each step is done, never a document.
--
-- Nest stores no candidate home address: commute directions are built in the
-- browser from an origin the recruiter types, and never saved.
--
-- Errors: PT400 invalid input, PT404 not found, PT409 stale.

alter table public.job_internal_details
  add column facility_address text check (char_length(facility_address) <= 200),
  add column facility_zip text check (facility_zip ~ '^\d{5}$');

-- Travel steps can now be on the checklist.
alter table public.journey_items drop constraint journey_items_source_check;
alter table public.journey_items add constraint journey_items_source_check
  check (source in ('manual', 'partner_requirement', 'partner_update', 'travel'));

-- Per diem cache -----------------------------------------------------------------------

create table public.per_diem_rates (
  id uuid primary key default gen_random_uuid(),
  -- Federal fiscal year: October through September, named for the year it ends.
  fiscal_year integer not null check (fiscal_year between 2020 and 2100),
  -- What was looked up: "zip:78701" or "city:TX:austin".
  lookup_key text not null check (lookup_key ~ '^(zip:\d{5}|city:[A-Z]{2}:[a-z0-9 .''-]{1,100})$'),
  state text not null check (state ~ '^[A-Z]{2}$'),
  -- GSA's name for the area, or "Standard Rate" when the location has no special rate.
  gsa_location text not null check (char_length(gsa_location) between 1 and 200),
  county text check (char_length(county) <= 200),
  is_standard boolean not null,
  -- Maximum nightly lodging in whole dollars, January to December.
  lodging_by_month integer[] not null check (array_length(lodging_by_month, 1) = 12),
  -- Meals and incidental expenses per full day, in whole dollars.
  meals_daily integer not null check (meals_daily between 0 and 1000),
  fetched_at timestamptz not null default now(),
  unique (fiscal_year, lookup_key)
);

alter table public.per_diem_rates enable row level security;
revoke all on public.per_diem_rates from anon, authenticated;
grant select on public.per_diem_rates to authenticated;
-- Public federal rates: any signed-in staff member may read them.
create policy "Staff read per diem rates"
  on public.per_diem_rates for select to authenticated using (true);

-- Facility location ----------------------------------------------------------------------

create or replace function public.set_job_location(
  p_job_id uuid,
  p_expected_version integer,
  p_facility_address text,
  p_facility_zip text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.jobs;
  d public.job_internal_details;
  v_address text := nullif(trim(p_facility_address), '');
  v_zip text := nullif(trim(p_facility_zip), '');
begin
  if p_expected_version is null then
    raise exception 'Version is required' using errcode = 'PT400';
  end if;
  r := private.lock_job_for_staff(p_job_id, p_expected_version);
  perform private.require_length(v_address, 200, 'facility address');
  if v_zip is not null and v_zip !~ '^\d{5}$' then
    raise exception 'Give a 5-digit ZIP code' using errcode = 'PT400';
  end if;
  select * into d from public.job_internal_details where job_id = r.id for update;
  if v_address is not distinct from d.facility_address and v_zip is not distinct from d.facility_zip then
    raise exception 'Nothing changed' using errcode = 'PT400';
  end if;

  update public.job_internal_details set facility_address = v_address, facility_zip = v_zip where job_id = r.id;
  update public.jobs set version = version + 1 where id = r.id returning * into r;
  insert into public.job_events (job_id, organization_id, event_type, actor_id, details)
  values (r.id, r.organization_id, 'updated', (select auth.uid()),
          jsonb_build_object('fields', jsonb_build_array('facility_address', 'facility_zip')));
  return jsonb_build_object('id', r.id, 'version', r.version);
end;
$$;

-- Travel checklist ----------------------------------------------------------------------

-- The standard travel steps, due relative to the opening's start date. Steps
-- already on the checklist (by title) aren't added again.
create or replace function public.add_travel_checklist(p_application_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.job_applications;
  v_start date;
  v_added integer;
begin
  select * into a from public.job_applications where id = p_application_id;
  if not found or not private.has_org_role(a.organization_id) then
    raise exception 'Application not found' using errcode = 'PT404';
  end if;
  select start_date into v_start from public.jobs where id = a.job_id;

  insert into public.journey_items (organization_id, application_id, title, owner, due_on, source, created_by)
  select a.organization_id, a.id, s.title, s.owner::public.journey_item_owner,
         v_start - s.days_before_start, 'travel', (select auth.uid())
  from (values
    (1, 'License valid in the assignment state (or compact privilege)', 'partner', 21),
    (2, 'Stipend eligibility (tax home) confirmed by the partner', 'partner', 14),
    (3, 'Housing arranged', 'candidate', 14),
    (4, 'Travel to the assignment planned', 'candidate', 7),
    (5, 'Commute and parking planned', 'candidate', 7),
    (6, 'First-day details sent (address, time, who to ask for)', 'partner', 3)
  ) as s (position, title, owner, days_before_start)
  where not exists (
    select 1 from public.journey_items i where i.application_id = a.id and lower(i.title) = lower(s.title)
  )
  order by s.position;
  get diagnostics v_added = row_count;
  return jsonb_build_object('added', v_added);
end;
$$;

-- Grants ---------------------------------------------------------------------------------

revoke all on function public.set_job_location(uuid, integer, text, text) from public, anon;
revoke all on function public.add_travel_checklist(uuid) from public, anon;
grant execute on function public.set_job_location(uuid, integer, text, text) to authenticated;
grant execute on function public.add_travel_checklist(uuid) to authenticated;
