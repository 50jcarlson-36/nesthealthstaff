# Nest Health Staff backend

Supabase backend for Nest Health Staff, a travel-nursing staffing service that connects clinicians, healthcare facilities, recruiters and assignment housing.

| Host | Audience |
|---|---|
| `nesthealthstaff.com` | Public website. The existing Sites frontend; its source isn't in this repo yet. |
| `staff.nesthealthstaff.com` | Clinician portal: applicants and their own profiles (planned) |
| `employers.nesthealthstaff.com` | Facility portal: hospitals managing staff and approving applicants (planned) |
| `ward.nesthealthstaff.com` | Agency back office: admins and recruiters (planned) |

## What's here

- `supabase/migrations/`: schema, Row Level Security and database functions.
- `supabase/functions/intake`: public intake endpoint. It takes the live website's `/api/leads` payload.
- `supabase/functions/process-outbox`: notification worker with retries.
- `supabase/functions/_shared`: validation, templates, email adapters and the outbox loop. These are pure TypeScript, unit-tested in Node.
- `tests/`: unit tests, plus integration tests that run as real `anon` and `authenticated` roles against a local stack.
- `docs/API.md`: endpoint contract and the frontend integration notes.
- `docs/DEPLOYMENT.md`: local setup, production deployment, email, DNS, backups and recovery.
- `docs/STATUS.md`: what works, what's blocked, and what's next.

## Quick start

```bash
npm install
npm run db:start && npm run db:reset
cp supabase/functions/.env.example supabase/functions/.env.local
npm run functions:serve   # in another terminal
npm test
```

This repository is public. Never commit credentials, `.env` files or real applicant data.
