-- Gestion des services : sécurité des données (RLS)
-- À coller dans Supabase › SQL Editor › New query, puis « Run ».
-- Peut être relancé sans risque.
--
-- Après ce script :
--   • admins (Réglages › adminEmails)        : accès complet, comme aujourd'hui
--   • « Mon espace » (bâtiment)               : uniquement son propriétaire
--   • assistantes connectées                  : lisent les demandes, agissent via des fonctions contrôlées
--   • visiteurs sans compte (page publique)   : déposent / suivent / annulent une demande avec son code,
--                                               lisent seulement les listes publiques (assistantes, prestataires…)
-- Le serveur (fonctions, déclencheurs) n'est pas concerné.

-- ── Outils ────────────────────────────────────────────────────────────
create or replace function public.gs_email() returns text
language sql stable as $$ select lower(trim(coalesce(auth.jwt() ->> 'email', ''))) $$;

create or replace function public.gs_param(p_cle text) returns jsonb
language sql stable security definer set search_path = public as $$
  select valeur::text::jsonb from public.parametres where cle = p_cle limit 1
$$;

-- écriture d'un paramètre, quel que soit le type de la colonne « valeur » (json, jsonb ou text)
create or replace function public.gs_param_ecrire(p_cle text, p_val jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  select format_type(a.atttypid, a.atttypmod) into t
    from pg_attribute a where a.attrelid = 'public.parametres'::regclass and a.attname = 'valeur';
  execute format('update public.parametres set valeur = $1::text::%s where cle = $2', t) using p_val::text, p_cle;
  if not found then
    execute format('insert into public.parametres(cle, valeur) values ($2, $1::text::%s)', t) using p_val::text, p_cle;
  end if;
end $$;

create or replace function public.gs_est_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.gs_email() <> '' and (
           coalesce(jsonb_array_length(case when jsonb_typeof(public.gs_param('adminEmails')) = 'array' then public.gs_param('adminEmails') end), 0) = 0
        or exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(public.gs_param('adminEmails')) = 'array' then public.gs_param('adminEmails') else '[]'::jsonb end) e
                   where lower(trim(e)) = public.gs_email()))
$$;

create or replace function public.gs_est_equipe() returns boolean
language sql stable security definer set search_path = public as $$
  select public.gs_est_admin() or (public.gs_email() <> '' and exists (
    select 1 from jsonb_each_text(case when jsonb_typeof(public.gs_param('emails')) = 'object' then public.gs_param('emails') else '{}'::jsonb end) e
    where lower(trim(e.value)) = public.gs_email()))
$$;

-- ── Règles d'accès ────────────────────────────────────────────────────
alter table public.commandes  enable row level security;
alter table public.parametres enable row level security;

do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' and tablename in ('commandes', 'parametres') loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

create policy gs_commandes_admin on public.commandes for all to authenticated
  using ((select public.gs_est_admin())) with check ((select public.gs_est_admin()));
create policy gs_commandes_equipe_lecture on public.commandes for select to authenticated
  using ((select public.gs_est_equipe()));

create policy gs_parametres_publics on public.parametres for select to anon, authenticated
  using (cle in ('assistantes','directeurs','prestatairesRepas','typesRepas','prestatairesTaxi','prestatairesCommande',
                 'prestatairesHotel','emails','adminEmails','yoozMap','loginObligatoire','prestaInfo','marque','equipe','mails'));
create policy gs_parametres_equipe_suivi on public.parametres for select to authenticated
  using (cle = 'suivi' and (select public.gs_est_equipe()));
create policy gs_parametres_admin on public.parametres for all to authenticated
  using (public.gs_est_admin() and (cle <> 'monEspace'
         or coalesce(valeur::text::jsonb ->> 'owner', '') = public.gs_email()
         or (valeur::text::jsonb ->> 'owner' is null and public.gs_email() like '%avonde%')))
  with check (public.gs_est_admin() and (cle <> 'monEspace'
         or coalesce(valeur::text::jsonb ->> 'owner', '') = public.gs_email()
         or (valeur::text::jsonb ->> 'owner' is null and public.gs_email() like '%avonde%')));

-- ── Fonctions pour la page publique et les assistantes ───────────────
-- Déposer une demande (toujours « En attente »)
create or replace function public.gs_nouvelle_demande(r jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cols text; nouveau jsonb;
begin
  if jsonb_typeof(r) <> 'object' then raise exception 'demande invalide'; end if;
  r := r || jsonb_build_object('pris', 'En attente');
  select string_agg(quote_ident(k), ', ') into cols
    from jsonb_object_keys(r) k
   where k not in ('id', 'created_at')
     and exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'commandes' and c.column_name = k);
  execute format('insert into public.commandes (%1$s) select %1$s from jsonb_populate_record(null::public.commandes, $1) returning to_jsonb(commandes.*)', cols)
    into nouveau using r;
  return nouveau;
end $$;

-- Suivre une demande avec son code (informations limitées)
create or replace function public.gs_suivre(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(c) - 'tel' - 'pour_qui' - 'comment' - 'vol' - 'prix' - 'paie' - 'yooz'
    from public.commandes c where upper(c.code) = upper(trim(p_code)) and coalesce(trim(p_code), '') <> '' limit 1
$$;

-- Annuler sa demande (avec son code, tant qu'elle est en attente)
create or replace function public.gs_annuler(p_id text, p_code text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.commandes set pris = 'Annulé'
   where id::text = p_id and upper(code) = upper(trim(p_code)) and coalesce(trim(p_code), '') <> '' and pris = 'En attente';
  return found;
end $$;

-- Compléter le suivi d'une demande (champs autorisés seulement)
create or replace function public.gs_suivi_maj(p_id text, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare s jsonb; cur jsonb; k text; v jsonb;
begin
  if not exists (select 1 from public.commandes where id::text = p_id) then return; end if;
  perform 1 from public.parametres where cle = 'suivi' for update;
  s := coalesce(public.gs_param('suivi'), '{}'::jsonb);
  cur := coalesce(s -> p_id, '{}'::jsonb);
  for k, v in select * from jsonb_each(p_patch) loop
    if k in ('mailAlerte', 'email', 'recu', 'recuBy', 'retard', 'fait', 'faitBy', 'cmd') then
      if v is null or v = 'null'::jsonb or v = '""'::jsonb then cur := cur - k; else cur := cur || jsonb_build_object(k, v); end if;
    end if;
  end loop;
  if cur = '{}'::jsonb then s := s - p_id; else s := s || jsonb_build_object(p_id, cur); end if;
  perform public.gs_param_ecrire('suivi', s);
end $$;

-- Ajouter au journal
create or replace function public.gs_journal(p_entrees jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare j jsonb; n jsonb;
begin
  if jsonb_typeof(p_entrees) <> 'array' or jsonb_array_length(p_entrees) > 20 then return; end if;
  perform 1 from public.parametres where cle = 'journal' for update;
  j := coalesce(public.gs_param('journal'), '[]'::jsonb);
  if jsonb_typeof(j) <> 'array' then j := '[]'::jsonb; end if;
  n := p_entrees || j;
  select coalesce(jsonb_agg(x order by i), '[]'::jsonb) into n from jsonb_array_elements(n) with ordinality t(x, i) where i <= 500;
  perform public.gs_param_ecrire('journal', n);
end $$;

-- Statistiques de connexion
create or replace function public.gs_connexion(p_nom text) returns void
language plpgsql security definer set search_path = public as $$
declare cx jsonb; e text := public.gs_email(); u jsonb; jour text := to_char(now() at time zone 'Europe/Paris', 'YYYY-MM-DD'); jours jsonb;
begin
  if e = '' then return; end if;
  perform 1 from public.parametres where cle = 'connexions' for update;
  cx := coalesce(public.gs_param('connexions'), '{}'::jsonb);
  u := coalesce(cx -> 'users' -> e, jsonb_build_object('first', now(), 'jours', '[]'::jsonb));
  jours := coalesce(u -> 'jours', '[]'::jsonb);
  if not jours ? jour then jours := jours || to_jsonb(jour); end if;
  if jsonb_array_length(jours) > 180 then
    select jsonb_agg(x order by i) into jours from jsonb_array_elements(jours) with ordinality t(x, i) where i > jsonb_array_length(jours) - 180;
  end if;
  u := u || jsonb_build_object('nom', left(coalesce(p_nom, ''), 80), 'last', now(), 'admin', public.gs_est_admin(), 'jours', jours);
  cx := jsonb_set(cx || jsonb_build_object('users', coalesce(cx -> 'users', '{}'::jsonb), 'via', coalesce(cx -> 'via', '{}'::jsonb), 'depuis', coalesce(cx -> 'depuis', to_jsonb(now()))), array['users', e], u);
  perform public.gs_param_ecrire('connexions', cx);
end $$;

create or replace function public.gs_via(p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare cx jsonb;
begin
  if coalesce(trim(p_code), '') = '' or length(p_code) > 20 then return; end if;
  perform 1 from public.parametres where cle = 'connexions' for update;
  cx := coalesce(public.gs_param('connexions'), '{}'::jsonb);
  cx := cx || jsonb_build_object('users', coalesce(cx -> 'users', '{}'::jsonb), 'depuis', coalesce(cx -> 'depuis', to_jsonb(now())),
                                 'via', coalesce(cx -> 'via', '{}'::jsonb) || jsonb_build_object(p_code, case when public.gs_email() = '' then '-' else public.gs_email() end));
  perform public.gs_param_ecrire('connexions', cx);
end $$;

revoke all on function public.gs_param(text), public.gs_param_ecrire(text, jsonb) from public, anon, authenticated;
grant execute on function public.gs_email(), public.gs_est_admin(), public.gs_est_equipe(),
  public.gs_nouvelle_demande(jsonb), public.gs_suivre(text), public.gs_annuler(text, text),
  public.gs_suivi_maj(text, jsonb), public.gs_journal(jsonb), public.gs_connexion(text), public.gs_via(text)
  to anon, authenticated;

select 'OK : accès sécurisés' as resultat;
