-- Gestion des commandes : déclenche la fonction « invitation-agenda »
-- à chaque ajout / modification / suppression dans la table commandes.
-- À coller dans Supabase › SQL Editor › New query, puis « Run ».
-- (Remplace le « Database Webhook » ; la clé utilisée est la clé publique
--  « anon » déjà présente dans l'appli.)

create extension if not exists pg_net with schema extensions;

create or replace function public.notifier_invitations_agenda()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform net.http_post(
    url     := 'https://yvlcmdcnjeoiffrlawti.supabase.co/functions/v1/invitation-agenda',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2bGNtZGNuamVvaWZmcmxhd3RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyODYwNjEsImV4cCI6MjA5MTg2MjA2MX0.-ePViMbJVA0UhC4WY3fYciUcw0gP6yJWau_P1AspdlI'
               ),
    body    := jsonb_build_object(
                 'type',       TG_OP,
                 'table',      TG_TABLE_NAME,
                 'record',     case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end,
                 'old_record', case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end
               ),
    timeout_milliseconds := 5000
  );
  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists invitations_agenda on public.commandes;
create trigger invitations_agenda
  after insert or update or delete on public.commandes
  for each row execute function public.notifier_invitations_agenda();

select 'OK : déclencheur installé' as resultat;
