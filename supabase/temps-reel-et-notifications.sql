-- Gestion des services : mise à jour en direct + notifications iPhone / PC
-- À coller dans Supabase › SQL Editor › New query, puis « Run ».
-- Peut être relancé sans risque.

-- 1) Temps réel : Supabase prévient l'appli dès qu'une demande ou un réglage change
do $$
begin
  begin alter publication supabase_realtime add table public.commandes; exception when others then null; end;
  begin alter publication supabase_realtime add table public.parametres; exception when others then null; end;
end $$;

-- 2) Notifications : tables lues et écrites uniquement par le serveur
create table if not exists public.push_config (
  id int primary key,
  cle_publique text not null,
  jwk jsonb not null,
  cree timestamptz not null default now()
);
create table if not exists public.push_abonnements (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  email text,
  appareil text,
  maj timestamptz not null default now()
);
create table if not exists public.push_envois (
  commande_id text primary key,
  envoye timestamptz not null default now()
);
alter table public.push_config      enable row level security;
alter table public.push_abonnements enable row level security;
alter table public.push_envois      enable row level security;
revoke all on public.push_config, public.push_abonnements, public.push_envois from anon, authenticated;

-- 3) Déclencheur : nouvelle demande « En attente » → fonction « notifier-push »
create extension if not exists pg_net with schema extensions;

create or replace function public.notifier_push()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if NEW.pris = 'En attente' and (TG_OP = 'INSERT' or OLD.pris is distinct from 'En attente') then
    begin
      perform net.http_post(
        url     := 'https://yvlcmdcnjeoiffrlawti.supabase.co/functions/v1/notifier-push',
        headers := jsonb_build_object(
                     'Content-Type',  'application/json',
                     'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2bGNtZGNuamVvaWZmcmxhd3RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyODYwNjEsImV4cCI6MjA5MTg2MjA2MX0.-ePViMbJVA0UhC4WY3fYciUcw0gP6yJWau_P1AspdlI'
                   ),
        body    := jsonb_build_object(
                     'type',       TG_OP,
                     'record',     jsonb_build_object('id', NEW.id),
                     'old_record', case when TG_OP = 'UPDATE' then jsonb_build_object('pris', OLD.pris) else null end
                   ),
        timeout_milliseconds := 5000
      );
    exception when others then null; -- une notification ratée ne doit jamais bloquer une demande
    end;
  end if;
  return NEW;
end;
$$;

drop trigger if exists notifier_push on public.commandes;
create trigger notifier_push
  after insert or update of pris on public.commandes
  for each row execute function public.notifier_push();

select 'OK : temps réel et notifications installés' as resultat;
