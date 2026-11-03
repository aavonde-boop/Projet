-- Gestion des services : préférences des directeurs
-- À coller dans Supabase › SQL Editor › New query, puis « Run ». Peut être relancé sans risque.
--
-- Une assistante connectée ne reçoit que les fiches des directeurs auxquels elle est rattachée
-- (Réglages › Directeurs), plus les conseils « Que commander ? ». Julia et Arnaud voient tout.

create or replace function public.gs_directeurs_info() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; moi text[]; fiches jsonb := '{}'::jsonb; k text; f jsonb;
begin
  if public.gs_email() = '' then return null; end if;
  select valeur::text::jsonb into v from public.parametres where cle = 'directeursInfo' limit 1;
  if v is null then return jsonb_build_object('fiches', '{}'::jsonb, 'guide', '[]'::jsonb); end if;
  if public.gs_est_admin() then return v; end if;
  -- noms de l'assistante connectée (Réglages › Équipe : nom → email)
  select coalesce(array_agg(lower(trim(e.key))), '{}') into moi
    from jsonb_each_text(case when jsonb_typeof(public.gs_param('emails')) = 'object' then public.gs_param('emails') else '{}'::jsonb end) e
   where lower(trim(e.value)) = public.gs_email();
  for k, f in select * from jsonb_each(coalesce(v -> 'fiches', '{}'::jsonb)) loop
    if exists (select 1 from jsonb_array_elements_text(coalesce(f -> 'assistantes', '[]'::jsonb)) a where lower(trim(a)) = any(moi)) then
      fiches := fiches || jsonb_build_object(k, f);
    end if;
  end loop;
  return jsonb_build_object('fiches', fiches, 'guide', coalesce(v -> 'guide', '[]'::jsonb));
end $$;

grant execute on function public.gs_directeurs_info() to authenticated;

select 'OK : préférences des directeurs' as resultat;
