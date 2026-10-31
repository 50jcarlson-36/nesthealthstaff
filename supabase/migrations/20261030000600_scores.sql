-- Opportunity score, fit score, wage options and incentives.
--
--   opportunity_scores rates every open job from 0 to 100 on three parts,
--   each with plain reasons:
--     need (0–40): partner priority, crisis rate, how soon it starts,
--       openings still unfilled and whether anyone is in play for it;
--     pay (0–40): the effective weekly package against the median of the
--       agency's open jobs in the same specialty (or all open jobs, when the
--       specialty has fewer than three with pay);
--     incentives (0–20): Nest's own incentive and the partner's bonuses.
--   It also suggests an incentive where need is high and pay or incentives
--   are weak, so recruiters know where a push would fill a position.
--   Strike work doesn't change the score: it's flagged, never promoted.
--
--   matching_openings(inquiry) rates open jobs for a clinician inquiry
--   (fit, 0–100: specialty, location, timing, housing) and ranks them by
--   fit and opportunity together. Sorted by pay, the same list shows the
--   clinician's best wage options.
--
-- Both run with the caller's rights, so staff only see their own agency.

-- Opportunity score --------------------------------------------------------------------

create view public.opportunity_scores
with (security_invoker = true)
as
with base as (
  select j.id as job_id, j.organization_id, j.title, j.specialty, j.city, j.state, j.start_date,
         j.duration_weeks, j.openings, j.hours_per_week,
         t.partner_id, coalesce(t.priority, 'normal') as priority, coalesce(t.is_strike, false) as is_strike,
         coalesce(t.is_crisis_rate, false) as is_crisis_rate,
         t.housing_stipend_weekly_cents,
         -- Weekly gross is the whole weekly package when the partner gives it;
         -- otherwise it's built from the hourly rate and the stipends.
         coalesce(t.weekly_gross_cents,
                  case when t.hourly_rate_cents is not null
                       then t.hourly_rate_cents * coalesce(j.hours_per_week, 36)
                            + coalesce(t.housing_stipend_weekly_cents, 0) + coalesce(t.meals_stipend_weekly_cents, 0) end)
          as weekly_package_cents,
         coalesce(t.sign_on_bonus_cents, 0) + coalesce(t.completion_bonus_cents, 0) + coalesce(t.nest_incentive_cents, 0)
          as one_time_cents,
         t.nest_incentive_cents, t.sign_on_bonus_cents, t.completion_bonus_cents, t.extension_bonus_cents,
         (select count(*) from public.job_applications a where a.job_id = j.id and a.stage = 'hired') as hired,
         (select count(*) from public.job_applications a where a.job_id = j.id and a.stage in ('screening', 'submitted', 'offered')) as in_play
  from public.jobs j
  left join public.job_partner_terms t on t.job_id = j.id
  where j.status = 'open'
),
priced as (
  select b.*,
         -- One-time bonuses spread over the assignment (13 weeks when unknown).
         case when b.weekly_package_cents is not null
              then b.weekly_package_cents + round(b.one_time_cents::numeric / coalesce(b.duration_weeks, 13))::integer end
           as effective_weekly_cents
  from base b
),
medians as (
  select p.job_id,
         (select percentile_cont(0.5) within group (order by q.effective_weekly_cents)
          from priced q where q.organization_id = p.organization_id and lower(q.specialty) = lower(p.specialty)
            and q.effective_weekly_cents is not null) as specialty_median,
         (select count(*) from priced q where q.organization_id = p.organization_id and lower(q.specialty) = lower(p.specialty)
            and q.effective_weekly_cents is not null) as specialty_count,
         (select percentile_cont(0.5) within group (order by q.effective_weekly_cents)
          from priced q where q.organization_id = p.organization_id and q.effective_weekly_cents is not null) as all_median,
         (select count(*) from priced q where q.organization_id = p.organization_id and q.effective_weekly_cents is not null) as all_count
  from priced p
),
parts as (
  select p.*,
         case when m.specialty_count >= 3 then m.specialty_median when m.all_count >= 3 then m.all_median end as median_cents,
         case when m.specialty_count >= 3 then 'specialty' when m.all_count >= 3 then 'all' end as compared_with,
         least(40,
           case p.priority when 'critical' then 20 when 'high' then 12 else 4 end
           + case when p.is_crisis_rate then 8 else 0 end
           + case when p.start_date is null then 0
                  when p.start_date - current_date <= 14 then 8
                  when p.start_date - current_date <= 30 then 4 else 0 end
           + case when p.openings - p.hired >= 2 then 4 else 0 end
           + case when p.in_play = 0 then 4 else 0 end
         ) as need_score,
         least(20,
           case when coalesce(p.nest_incentive_cents, 0) > 0 then 8 else 0 end
           + case when coalesce(p.sign_on_bonus_cents, 0) > 0 then 5 else 0 end
           + case when coalesce(p.completion_bonus_cents, 0) > 0 then 4 else 0 end
           + case when coalesce(p.extension_bonus_cents, 0) > 0 then 3 else 0 end
         ) as incentive_score
  from priced p
  join medians m on m.job_id = p.job_id
),
scored as (
  select x.*,
         case when x.effective_weekly_cents is null then 0
              when x.median_cents is null then 20
              -- The median scores 20; 20% above scores 40, 20% below scores 0.
              else greatest(0, least(40, round(20 + (x.effective_weekly_cents / x.median_cents - 1) * 100)))::integer
         end as pay_score,
         case when x.effective_weekly_cents is not null and x.median_cents is not null
              then round((x.effective_weekly_cents / x.median_cents - 1) * 100)::integer end as pay_vs_median_pct
  from parts x
)
select s.job_id, s.organization_id, s.title, s.specialty, s.city, s.state, s.start_date, s.duration_weeks,
       s.partner_id, s.priority, s.is_strike, s.is_crisis_rate,
       s.weekly_package_cents, s.effective_weekly_cents, s.median_cents::integer as median_weekly_cents,
       s.compared_with, s.pay_vs_median_pct, s.housing_stipend_weekly_cents,
       s.need_score, s.pay_score, s.incentive_score,
       s.need_score + s.pay_score + s.incentive_score as score,
       array_remove(array[
         case s.priority when 'critical' then 'Partner marked it critical' when 'high' then 'Partner marked it high priority' end,
         case when s.is_crisis_rate then 'Crisis rate' end,
         case when s.start_date - current_date <= 14 then 'Starts within 2 weeks'
              when s.start_date - current_date <= 30 then 'Starts within a month' end,
         case when s.openings - s.hired >= 2 then (s.openings - s.hired) || ' openings unfilled' end,
         case when s.in_play = 0 then 'No candidates in play yet' end
       ], null) as need_reasons,
       case
         when s.effective_weekly_cents is null then 'No pay on file'
         when s.median_cents is null then 'Not enough open jobs with pay to compare'
         when s.pay_vs_median_pct >= 0 then s.pay_vs_median_pct || '% above the ' ||
           case s.compared_with when 'specialty' then 'specialty' else 'agency' end || ' median'
         else (-s.pay_vs_median_pct) || '% below the ' ||
           case s.compared_with when 'specialty' then 'specialty' else 'agency' end || ' median'
       end as pay_reason,
       array_remove(array[
         case when coalesce(s.nest_incentive_cents, 0) > 0 then 'Nest incentive' end,
         case when coalesce(s.sign_on_bonus_cents, 0) > 0 then 'Sign-on bonus' end,
         case when coalesce(s.completion_bonus_cents, 0) > 0 then 'Completion bonus' end,
         case when coalesce(s.extension_bonus_cents, 0) > 0 then 'Extension bonus' end
       ], null) as incentive_reasons,
       case
         when s.need_score >= 24 and s.effective_weekly_cents is null
           then 'High need: add the pay package so candidates can compare it.'
         when s.need_score >= 24 and s.pay_score < 20
           then 'High need and below-median pay: consider a Nest incentive, or ask the partner about a crisis rate.'
         when s.need_score >= 24 and s.incentive_score = 0
           then 'High need and no incentives: consider a Nest incentive to fill it.'
       end as suggestion
from scored s;

grant select on public.opportunity_scores to authenticated;

-- Fit and wage options --------------------------------------------------------------------

-- Open jobs rated for one clinician inquiry, best first. Returns nothing for
-- an inquiry the caller can't see.
create or replace function public.matching_openings(p_inquiry_id uuid)
returns table (
  job_id uuid,
  title text,
  specialty text,
  city text,
  state text,
  start_date date,
  is_strike boolean,
  is_crisis_rate boolean,
  weekly_package_cents integer,
  effective_weekly_cents integer,
  pay_vs_median_pct integer,
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
  with i as (
    select q.organization_id, lower(trim(q.specialty)) as specialty, q.preferred_location as place,
           q.timeline, q.housing_assistance_requested as wants_housing
    from public.inquiries q
    where q.id = p_inquiry_id and q.inquiry_type = 'clinician'
  ),
  rated as (
    select o.*,
      case
        when i.specialty is null then 20
        when lower(o.specialty) = i.specialty then 50
        when position(i.specialty in lower(o.specialty)) > 0 or position(lower(o.specialty) in i.specialty) > 0 then 30
        when exists (
          select 1 from regexp_split_to_table(i.specialty, '[^a-z0-9]+') w
          where char_length(w) >= 3 and lower(o.specialty) ~ ('\m' || w || '\M')
        ) then 30
        else 0
      end as specialty_points,
      case
        when i.place is null or i.place ~* '\m(anywhere|any|open|flexible)\M' then 20
        when position(lower(o.city) in lower(i.place)) > 0 then 30
        when i.place ~ ('(^|[^A-Za-z])' || o.state || '([^A-Za-z]|$)') then 25
        else 5
      end as location_points,
      case
        when i.timeline is null or i.timeline = 'exploring' then 8
        when o.start_date is null then 10
        when i.timeline = 'asap' and o.start_date - current_date <= 45 then 15
        when i.timeline = 'within_1_3_months' and o.start_date - current_date between 21 and 100 then 15
        when i.timeline = 'within_3_6_months' and o.start_date - current_date between 80 and 190 then 15
        else 5
      end as timing_points,
      case
        when not i.wants_housing then 5
        when coalesce(o.housing_stipend_weekly_cents, 0) > 0 then 5
        else 0
      end as housing_points,
      i.specialty as wanted_specialty, i.place, i.timeline, i.wants_housing
    from public.opportunity_scores o
    join i on i.organization_id = o.organization_id
  )
  select r.job_id, r.title, r.specialty, r.city, r.state, r.start_date, r.is_strike, r.is_crisis_rate,
         r.weekly_package_cents, r.effective_weekly_cents, r.pay_vs_median_pct, r.score,
         f.fit, f.reasons,
         round(0.6 * f.fit + 0.4 * r.score)::integer
  from rated r
  cross join lateral (
    select r.specialty_points + r.location_points + r.timing_points + r.housing_points as fit,
           array_remove(array[
             case r.specialty_points when 50 then 'Same specialty' when 30 then 'Related specialty'
                                     when 20 then 'Specialty not given' else 'Different specialty' end,
             case r.location_points when 30 then 'In their preferred city' when 25 then 'In their preferred state'
                                    when 20 then 'Open to anywhere' else 'Outside their preferred location' end,
             case when r.timing_points = 15 then 'Start date fits their timing'
                  when r.timing_points = 5 then 'Start date doesn''t fit their timing' end,
             case when r.wants_housing and r.housing_points = 0 then 'Wants housing help; no housing stipend on file'
                  when r.wants_housing then 'Wants housing help; housing stipend offered' end
           ], null) as reasons
  ) f
  order by 15 desc, r.effective_weekly_cents desc nulls last
  limit 50;
$$;

revoke all on function public.matching_openings(uuid) from public, anon;
grant execute on function public.matching_openings(uuid) to authenticated;
