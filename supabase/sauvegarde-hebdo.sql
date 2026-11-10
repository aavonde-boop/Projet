-- Gestion des services : sauvegarde automatique chaque lundi à 7 h (heure de Paris).
-- À coller une seule fois dans Supabase › SQL Editor, puis « Run »,
-- APRÈS avoir créé la fonction « sauvegarde-hebdo » (Edge Functions).
-- Les administrateurs reçoivent un email avec le fichier de sauvegarde en pièce jointe.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Supprime l'ancienne planification si elle existe (on peut relancer ce script sans risque)
select cron.unschedule(jobid) from cron.job where jobname = 'sauvegarde-hebdo';

-- Lundi 5 h UTC = 6 h l'hiver / 7 h l'été à Paris
select cron.schedule(
  'sauvegarde-hebdo',
  '0 5 * * 1',
  $$
  select net.http_post(
    url     := 'https://yvlcmdcnjeoiffrlawti.supabase.co/functions/v1/sauvegarde-hebdo',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2bGNtZGNuamVvaWZmcmxhd3RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyODYwNjEsImV4cCI6MjA5MTg2MjA2MX0.-ePViMbJVA0UhC4WY3fYciUcw0gP6yJWau_P1AspdlI'
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Pour tester tout de suite (envoie une sauvegarde maintenant), décommentez la ligne suivante :
-- select net.http_post(url := 'https://yvlcmdcnjeoiffrlawti.supabase.co/functions/v1/sauvegarde-hebdo', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2bGNtZGNuamVvaWZmcmxhd3RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyODYwNjEsImV4cCI6MjA5MTg2MjA2MX0.-ePViMbJVA0UhC4WY3fYciUcw0gP6yJWau_P1AspdlI'), body := '{}'::jsonb);
