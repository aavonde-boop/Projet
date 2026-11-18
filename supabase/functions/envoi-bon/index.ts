// Gestion des services : envoi du bon de réservation d'hôtel (PDF de l'hôtel en pièce jointe).
// Appelée depuis la fiche d'une réservation d'hôtel, par un administrateur connecté.
// Secrets nécessaires (les mêmes que « invitation-agenda ») :
//   BREVO_SMTP_LOGIN, BREVO_SMTP_KEY, EXPEDITEUR, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
import nodemailer from "npm:nodemailer@6.9.16";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Content-Type": "application/json" };
const rep = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: CORS });

async function sbGet(path: string) {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(String(url) + "/rest/v1/" + path, { headers: { apikey: key!, Authorization: "Bearer " + String(key) } });
  if (!r.ok) throw new Error("Lecture impossible (" + r.status + ")");
  return await r.json();
}
async function adminEmails(): Promise<string[]> {
  const rows = await sbGet("parametres?cle=eq.adminEmails&select=valeur");
  let v = rows && rows[0] ? rows[0].valeur : [];
  if (typeof v === "string") { try { v = JSON.parse(v); } catch (_) { v = []; } }
  return (Array.isArray(v) ? v : []).map((x: unknown) => String(x).trim().toLowerCase()).filter((x: string) => /@/.test(x));
}
function esc(s: unknown) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function jour(s: unknown) {
  const t = String(s || "");
  let d: Date | null = null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/), fr = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (iso) d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12);
  else if (fr) d = new Date(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]), 12);
  if (!d) return t;
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // 1. Seul un administrateur connecté peut envoyer
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
    const u = await fetch(String(url) + "/auth/v1/user", { headers: { apikey: anon!, Authorization: req.headers.get("Authorization") || "" } });
    const me = u.ok ? await u.json() : null;
    const moi = String((me && me.email) || "").toLowerCase();
    if (!moi || !(await adminEmails()).includes(moi)) return rep({ ok: false, error: "Réservé aux administrateurs connectés" }, 403);

    const login = Deno.env.get("BREVO_SMTP_LOGIN"), key = Deno.env.get("BREVO_SMTP_KEY"), from = Deno.env.get("EXPEDITEUR");
    if (!login || !key || !from) return rep({ ok: false, error: "Secrets Brevo manquants" });

    // 2. Contrôle de la demande
    const p = await req.json();
    const dest = (Array.isArray(p.to) ? p.to : []).map((x: unknown) => String(x).trim()).filter((x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    if (!dest.length) return rep({ ok: false, error: "Aucun destinataire valide" });
    if (dest.length > 10) return rep({ ok: false, error: "10 destinataires au maximum" });
    const f = p.fichier || {};
    if (!f.base64 || !f.nom) return rep({ ok: false, error: "Bon de réservation manquant" });
    if (String(f.base64).length > 14000000) return rep({ ok: false, error: "Fichier trop lourd (10 Mo maximum)" });
    const rows = await sbGet("commandes?id=eq." + encodeURIComponent(String(p.id)) + "&select=*");
    const c = rows && rows[0];
    if (!c) return rep({ ok: false, error: "Réservation introuvable" });

    // 3. Email
    const hotel = String(c.presta || c.descr || "Hôtel");
    const qui = String(c.pour_qui || "");
    const debut = jour(c.date), fin = c.date_depart ? jour(c.date_depart) : "";
    const lignes: [string, string][] = [["Hôtel", hotel], ["Voyageur(s)", qui], ["Arrivée", debut], ["Départ", fin], ["Ville", String(c.lieu || "")], ["Code de suivi", String(c.code || "")]];
    const mot = String(p.message || "").trim();
    const tableau = lignes.filter((l) => l[1]).map((l) => "<tr><td style=\"padding:6px 14px 6px 0;color:#6b7280;\">" + esc(l[0]) + "</td><td style=\"padding:6px 0;font-weight:600;color:#111827;\">" + esc(l[1]) + "</td></tr>").join("");
    const html = "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;max-width:560px;\">" +
      "<p>Bonjour,</p>" +
      "<p>Veuillez trouver ci-joint le bon de réservation de l’hôtel" + (qui ? " pour <b>" + esc(qui) + "</b>" : "") + ".</p>" +
      (mot ? "<p style=\"background:#f8fafc;border-left:3px solid #2b5f87;padding:8px 12px;\">" + esc(mot).replace(/\n/g, "<br>") + "</p>" : "") +
      "<table style=\"border-collapse:collapse;margin:12px 0;\">" + tableau + "</table>" +
      "<p>Bon séjour,<br>Les services généraux</p></div>";
    const texte = "Bonjour,\n\nVeuillez trouver ci-joint le bon de réservation de l’hôtel" + (qui ? " pour " + qui : "") + ".\n\n" + (mot ? mot + "\n\n" : "") +
      lignes.filter((l) => l[1]).map((l) => l[0] + " : " + l[1]).join("\n") + "\n\nBon séjour,\nLes services généraux";
    const transport = nodemailer.createTransport({ host: "smtp-relay.brevo.com", port: 465, secure: true, auth: { user: login, pass: key } });
    await transport.sendMail({
      from: "Gestion des services <" + from + ">",
      to: dest.join(", "),
      replyTo: moi,
      subject: "Bon de réservation – " + hotel + " – " + debut + (qui ? " – " + qui : ""),
      text: texte,
      html,
      attachments: [{ filename: String(f.nom).replace(/[\\/:*?"<>|]+/g, "_"), content: String(f.base64), encoding: "base64", contentType: String(f.type || "application/pdf") }],
    });
    return rep({ ok: true, destinataires: dest.length });
  } catch (e) {
    return rep({ ok: false, error: String((e && (e as Error).message) || e) }, 500);
  }
});
