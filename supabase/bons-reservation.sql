-- Gestion des services : espace de stockage des bons de réservation d'hôtel.
-- À coller une seule fois dans Supabase › SQL Editor, puis « Run ».
-- Les fichiers sont privés : seuls les administrateurs connectés peuvent les déposer, les lire ou les retirer.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bons', 'bons', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "bons_admin_lecture" on storage.objects;
drop policy if exists "bons_admin_depot" on storage.objects;
drop policy if exists "bons_admin_maj" on storage.objects;
drop policy if exists "bons_admin_retrait" on storage.objects;

create policy "bons_admin_lecture" on storage.objects for select to authenticated
  using (bucket_id = 'bons' and public.gs_est_admin());
create policy "bons_admin_depot" on storage.objects for insert to authenticated
  with check (bucket_id = 'bons' and public.gs_est_admin());
create policy "bons_admin_maj" on storage.objects for update to authenticated
  using (bucket_id = 'bons' and public.gs_est_admin()) with check (bucket_id = 'bons' and public.gs_est_admin());
create policy "bons_admin_retrait" on storage.objects for delete to authenticated
  using (bucket_id = 'bons' and public.gs_est_admin());
