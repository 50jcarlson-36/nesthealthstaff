# Development, deployment and recovery

## Local development

You need Docker and Node 20 or later. Local Supabase uses ports **553xx** so it can run beside other local Supabase projects on the default 543xx ports.

```bash
npm install
npm run db:start            # local Postgres, Auth, Storage, Edge Runtime, Studio (http://127.0.0.1:55323)
npm run db:reset            # apply supabase/migrations + supabase/seed.sql (synthetic data only)
cp supabase/functions/.env.example supabase/functions/.env.local   # then fill both secrets
npm run functions:serve     # intake, apply, process-outbox and staff-invite at http://127.0.0.1:55321/functions/v1/*
npm test                    # unit tests + integration tests against the local stack
```

The integration tests refuse to run unless `supabase status` reports a loopback API URL. They create synthetic `@example.com` users and organizations.

## Deploying to the hosted project (`fugzapgjowwwqgymcdbl`)

**Steps 1–5 and 7 were done on 2026-10-28** with the owner's approval. The hosted database was empty beforehand. **Steps 6 and 8 aren't done.**

- **Step 6:** the outbox secret was generated without being shown. Rotate it with `supabase secrets set OUTBOX_PROCESSOR_SECRET=...` to a value you also store in Vault.
- **Step 8:** no synthetic submission has been sent to production.

STATUS.md has the verification results. The CLI can run these steps from this repo (`npx supabase link --project-ref fugzapgjowwwqgymcdbl`, then `db push`, `db query --linked`, `db advisors --linked`).

1. **Inspect** the hosted project: tables, policies, functions, storage buckets and auth settings. Use the read-only Supabase MCP in `.mcp.json`, or `supabase db diff --linked`.
2. **Link and push migrations:** `npx supabase link --project-ref fugzapgjowwwqgymcdbl`, then `npx supabase db push`. `db push` applies migrations only; it does not load `seed.sql`.
3. **Create the production organization.** Use real values, run once in the SQL editor:
   ```sql
   insert into public.organizations (slug, name, intake_notification_email)
   values ('nest-health-staff', 'Nest Health Staff', '<recruiting inbox>');
   ```
4. **Set function secrets:**
   ```bash
   npx supabase secrets set \
     INTAKE_ORGANIZATION_SLUG=nest-health-staff \
     INTAKE_IP_HASH_SECRET=$(openssl rand -hex 32) \
     OUTBOX_PROCESSOR_SECRET=$(openssl rand -hex 32) \
     ALLOWED_ORIGINS=https://nesthealthstaff.com,https://www.nesthealthstaff.com,https://nest-health-staff.steelfurymx.chatgpt.site \
     PUBLIC_SITE_URL=https://nesthealthstaff.com \
     CLINICIAN_PORTAL_URL=https://staff.nesthealthstaff.com \
     FACILITY_PORTAL_URL=https://employers.nesthealthstaff.com \
     ADMIN_PORTAL_URL=https://ward.nesthealthstaff.com \
     EMAIL_PROVIDER=dev
   ```
   Keep `EMAIL_PROVIDER=dev` until Resend is set up (see below).
5. **Deploy functions:** `npx supabase functions deploy intake apply process-outbox staff-invite consent`. `config.toml` already disables JWT verification for all five; each function does its own checks (`staff-invite` identifies the caller with `auth.getUser`). `staff-invite` accepts requests only from `ADMIN_PORTAL_URL`, which defaults to `https://ward.nesthealthstaff.com`. `apply` uses the same `INTAKE_ORGANIZATION_SLUG`, `INTAKE_IP_HASH_SECRET` and `ALLOWED_ORIGINS` as `intake`.
6. **Schedule the outbox worker** with `pg_cron` and `pg_net` (enable both extensions in the dashboard). Store the secret in Vault rather than in the job text:
   ```sql
   select vault.create_secret('<OUTBOX_PROCESSOR_SECRET>', 'outbox_processor_secret');
   select cron.schedule('process-outbox', '* * * * *', $$
     select net.http_post(
       url := 'https://fugzapgjowwwqgymcdbl.supabase.co/functions/v1/process-outbox',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-outbox-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'outbox_processor_secret')),
       body := '{}'::jsonb);
   $$);
   ```
7. **Run the security and performance advisors** (Dashboard → Advisors) and resolve anything actionable.
8. **Smoke test** with a synthetic submission, then delete it.

## Auth URLs for the portals

Set these in Dashboard → Authentication → URL Configuration:

- **Site URL:** `https://nesthealthstaff.com`
- **Redirect URLs:**
  - `https://staff.nesthealthstaff.com/**` (clinician portal)
  - `https://employers.nesthealthstaff.com/**` (facility portal)
  - `https://ward.nesthealthstaff.com/**` (agency back office)

Hostnames do not grant access; RLS does. Someone who signs in on any portal gets only what their memberships allow.

**Public signups are off** (since 2026-10-29). Ward never creates accounts: staff logins are created by the `staff-invite` function through the admin API, which works with signups off. A future clinician portal that lets people register will need signups back on, or its own server-side account creation.

**Trap: only `[auth] enable_signup` turns signups off.** In the CLI config, `[auth.email] enable_signup` is the on/off switch for the whole Email provider. Setting it to `false` disables magic-link sign-in for everyone, existing staff included (`email_provider_disabled`). That happened briefly on 2026-10-29 and was reverted. Keep it `true`.

**Auth emails go through Resend SMTP** (since 2026-10-29): `smtp.resend.com:465`, user `resend`, from `Nest Health Staff <no-reply@nesthealthstaff.com>`, using a sending-only Resend key named `supabase-auth-smtp`, separate from the outbox key. The Auth email limit is 30 an hour (the built-in sender allowed 2).

To change these settings, pull the production config into a scratch folder as described below. The SMTP password is required for `config diff` and `config push` to read the file: write it as `pass = "env(RESEND_SMTP_KEY)"` and supply the key only through that variable, from a file the owner saves. Never put it in the file or in chat. Without it, the CLI fails to read the config, and its output can look like "0 differences".

## Subdomains (DNS and hosting)

Checked 2026-10-28:

| Host | DNS | Serves |
|---|---|---|
| `nesthealthstaff.com` | Cloudflare (registrar and nameservers) | Sites frontend, HTTPS `200` |
| `www.nesthealthstaff.com` | CNAME `custom-domains.chatgpt.site` | Same site, HTTPS `200`. It doesn't redirect to the apex. |
| `staff.` / `employers.` | **No records** | Nothing yet |
| `ward.` | **No record yet**. It's created by `wrangler deploy` (see below). | Nothing until deployed |

To bring up a portal subdomain:

1. Deploy the portal frontend to its host. None exist yet.
2. In Cloudflare DNS, add the record the host asks for, usually a CNAME such as `staff → <host target>`. Then add the custom domain on the host side, so it issues the certificate.
3. Check it with `curl -I https://staff.nesthealthstaff.com`. Only then mark it live in STATUS.md.

Don't point a portal subdomain at the marketing site as a placeholder. Auth emails and staff alerts already link to these hosts, so a wrong target would send people to the wrong page.

## Ward portal (Cloudflare Workers)

**Deployed on 2026-10-28** (Worker `nest-ward`; see STATUS.md). `apps/ward` is a static React app served by Workers static assets; there is no Worker script. `wrangler.jsonc` binds the custom domain `ward.nesthealthstaff.com`, so the first deploy creates its DNS record and certificate in the Cloudflare zone.

1. Finish the hosted Supabase steps above, so production has the ward redirect URL and at least one staff membership.
2. Create `apps/ward/.env.production` with the hosted project's URL and **publishable** key. Never use a secret or service-role key here.
3. `cd apps/ward && npx wrangler login && npm run deploy`. Deploying needs Cloudflare access to the `nesthealthstaff.com` account.
4. Verify that `curl -I https://ward.nesthealthstaff.com` returns `200` with the `Content-Security-Policy` and `X-Robots-Tag` headers from `public/_headers`. Then sign in with a real staff account.

Staff accounts are created by an admin only: the sign-in form uses `shouldCreateUser: false`. To add someone, an admin uses ward's **Team** page (see API.md, "Staff invitations"). The invitee gets an email, signs in at ward with "Email me a sign-in link", and gets access then. Don't use the Supabase dashboard's **Invite**: its link uses the implicit flow, which ward's PKCE sign-in rejects.

Deploy ward only from a clean working tree (`git status` shows nothing under `apps/ward`), so unreviewed edits aren't shipped.

To change the hosted Auth URLs without pushing local settings, pull the production config into a scratch folder (`supabase config pull --workdir <dir> --project-ref fugzapgjowwwqgymcdbl`). Edit only the fields you mean to change, run `config diff`, then run `config push` from the same folder. Never push the repo's `supabase/config.toml`: it holds local `127.0.0.1` URLs.

The CSP in `public/_headers` names the hosted project `fugzapgjowwwqgymcdbl`. Update it if the project changes.

## Email (Resend)

The status is **Available, not connected**: Resend's API supports an `Idempotency-Key` header, which expires after 24 hours (checked 2026-10-28). There is no account, API key or verified sender yet. To connect it:

1. Create a Resend account and add a sending subdomain, for example `notifications.nesthealthstaff.com`.
2. Add the SPF, DKIM and DMARC records Resend generates to Cloudflare, then wait until Resend shows the domain as verified.
3. Run `supabase secrets set EMAIL_PROVIDER=resend RESEND_API_KEY=… EMAIL_FROM="Nest Health Staff <hello@notifications.nesthealthstaff.com>"`.
4. Submit a test inquiry with your own address and confirm it arrives. Only then report production email as working.

Auth emails (sign-in links, invitations) are configured separately, under Dashboard → Authentication → SMTP. They can use the same Resend domain.

## Backups and recovery

- **Backups:** daily backups depend on the hosted plan. Point-in-time recovery is a paid add-on. Check what the project's plan includes before launch.
- **Schema recovery:** the migrations in this repo rebuild the schema from scratch with `supabase db push` against a new project.
- **Data recovery:** restore a dashboard backup into a new project, then repoint the function secrets and the frontend environment. Never restore over production without a fresh backup of its current state.
- **Lost notifications:** provider outages don't lose submissions. Rows stay `pending`, or end as `failed` after 5 attempts. To retry failed rows, run `update notification_outbox set status='pending', attempts=0, next_attempt_at=now() where status='failed' and …`.
- **Retention:** rate-limit rows are only useful for one window. Schedule `delete from intake_rate_limits where window_start < now() - interval '1 day'`. A policy for inquiry retention and deletion is still an owner decision.
