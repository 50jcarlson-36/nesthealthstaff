-- Synthetic development data only. Never load real applicant records here.
-- Applied by `supabase db reset` against the local stack, never the hosted project.

insert into public.organizations (slug, name, intake_notification_email)
values ('nest-health-staff-dev', 'Nest Health Staff (development)', 'recruiting-alerts@example.com')
on conflict (slug) do nothing;
