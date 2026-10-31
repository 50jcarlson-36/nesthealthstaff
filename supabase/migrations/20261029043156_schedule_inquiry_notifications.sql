-- Retry due notifications every minute. The worker requires a secret header,
-- refuses production dev-mode delivery, and leaves rows pending until configured.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.schedule(
 'nest-inquiry-notifications',
 '* * * * *',
 $job$
 select net.http_post(
   url := 'https://fugzapgjowwwqgymcdbl.supabase.co/functions/v1/process-outbox',
   headers := jsonb_build_object('Content-Type','application/json','x-outbox-secret',decrypted_secret),
   body := '{}'::jsonb,
   timeout_milliseconds := 60000
 )
 from vault.decrypted_secrets where name = 'nest_outbox_processor_secret'
 $job$
);
