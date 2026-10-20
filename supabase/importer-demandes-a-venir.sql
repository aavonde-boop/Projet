-- Gestion des commandes : envoie les rappels agenda (Commander + Mise en place)
-- pour toutes les demandes À VENIR déjà enregistrées (non annulées).
-- À coller une seule fois dans Supabase › SQL Editor, puis « Run ».
-- Résultat : le nombre de demandes importées (2 rappels chacune).
-- Sans risque de doublon : une demande déjà dans l'agenda est simplement mise à jour.

select count(*) as demandes_importees
from (
  select net.http_post(
    url     := 'https://yvlcmdcnjeoiffrlawti.supabase.co/functions/v1/invitation-agenda',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2bGNtZGNuamVvaWZmcmxhd3RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyODYwNjEsImV4cCI6MjA5MTg2MjA2MX0.-ePViMbJVA0UhC4WY3fYciUcw0gP6yJWau_P1AspdlI'
               ),
    body    := jsonb_build_object('type', 'INSERT', 'table', 'commandes', 'record', to_jsonb(c), 'old_record', null),
    timeout_milliseconds := 15000
  )
  from public.commandes c
  where c.pris is distinct from 'Annulé'
    and case when left(c.date::text, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then left(c.date::text, 10)::date >= current_date
             else false end
) envois;
