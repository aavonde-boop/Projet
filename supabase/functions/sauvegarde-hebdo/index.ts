// Gestion des services : sauvegarde automatique hebdomadaire.
// Envoie chaque lundi, aux administrateurs (Réglages › adminEmails), un fichier .json
// contenant toutes les demandes et tous les réglages. Ce fichier peut être réimporté en cas de problème.
// Secrets nécessaires (les mêmes que « invitation-agenda ») :
//   BREVO_SMTP_LOGIN, BREVO_SMTP_KEY, EXPEDITEUR, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import nodemailer from "npm:nodemailer@6.9.16";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Content-Type": "application/json" };

async function sbGet(path: string) {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(String(url) + "/rest/v1/" + path, { headers: { apikey: key!, Authorization: "Bearer " + String(key) } });
  if (!r.ok) throw new Error("Lecture impossible : " + path + " (" + r.status + ")");
  return await r.json();
}

function destinataires(params: any[]): string[] {
  const row = params.find((p) => p.cle === "adminEmails");
  let v = row ? row.valeur : [];
  if (typeof v === "string") { try { v = JSON.parse(v); } catch (_) { v = []; } }
  const list = Array.isArray(v) ? v : [];
  return [...new Set(list.map((x: any) => String(x).trim()).filter((x: string) => /@/.test(x)))] as string[];
}

function deuxChiffres(n: number) { return n < 10 ? "0" + n : String(n); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const login = Deno.env.get("BREVO_SMTP_LOGIN"), key = Deno.env.get("BREVO_SMTP_KEY"), from = Deno.env.get("EXPEDITEUR");
    if (!login || !key || !from) return new Response(JSON.stringify({ ok: false, error: "Secrets Brevo manquants" }), { headers: CORS });
    const commandes = await sbGet("commandes?select=*&order=id.asc");
    const parametres = await sbGet("parametres?select=*");
    const to = destinataires(parametres);
    if (!to.length) return new Response(JSON.stringify({ ok: false, error: "Aucun administrateur" }), { headers: CORS });
    const d = new Date();
    const jour = d.getFullYear() + "-" + deuxChiffres(d.getMonth() + 1) + "-" + deuxChiffres(d.getDate());
    const contenu = JSON.stringify({ application: "Gestion des services", date: d.toISOString(), commandes, parametres }, null, 1);
    const actives = commandes.filter((c: any) => c.pris !== "Annulé").length;
    const transport = nodemailer.createTransport({ host: "smtp-relay.brevo.com", port: 465, secure: true, auth: { user: login, pass: key } });
    await transport.sendMail({
      from: "Gestion des services <" + from + ">",
      to: to.join(", "),
      subject: "Sauvegarde hebdomadaire – Gestion des services – " + jour,
      text: "Bonjour,\n\nVeuillez trouver ci-joint la sauvegarde complète de Gestion des services au " + jour + ".\n\n" +
        "• " + commandes.length + " demandes enregistrées (dont " + actives + " non annulées)\n" +
        "• " + parametres.length + " réglages\n\n" +
        "Conservez ce fichier : il permet de tout restaurer en cas de problème.\n\nGestion des services",
      attachments: [{ filename: "sauvegarde-gestion-services-" + jour + ".json", content: contenu, contentType: "application/json" }],
    });
    return new Response(JSON.stringify({ ok: true, demandes: commandes.length, destinataires: to.length }), { headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e && (e as Error).message) || e) }), { status: 500, headers: CORS });
  }
});
