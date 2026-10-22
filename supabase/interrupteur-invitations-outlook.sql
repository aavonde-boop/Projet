-- Gestion des commandes : interrupteur « Invitation Outlook »
-- Permet d'activer / désactiver les invitations Outlook depuis
-- l'appli (Réglages › Emails). Remplace uniquement la fonction appelée
-- par le déclencheur existant : rien d'autre ne change.
-- À coller dans Supabase › SQL Editor › New query, puis « Run ».

create or replace function public.notifier_invitations_agenda()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  outlook_actif boolean;
begin
  -- Réglages › Emails › « Invitation Outlook » (clé « mails », champ « outlook »)
  begin
    select coalesce((valeur::text::jsonb ->> 'outlook')::boolean, true)
      into outlook_actif
      from public.parametres where cle = 'mails' limit 1;
  exception when others then
    outlook_actif := true;
  end;
  if outlook_actif is false then
    return coalesce(NEW, OLD);
  end if;

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

select 'OK : interrupteur Outlook installé' as resultat;
