// ════════════════════════════════════════════════════════════════════
//  Gestion des services — invitations agenda automatiques
//
//  Appelée par un « Database Webhook » Supabase sur la table 'commandes'
//  (INSERT + UPDATE). Pour chaque nouvelle demande, envoie aux emails admin
//  (Réglages › Notifications › Emails admin) deux invitations Outlook :
//    1. « Commander »      : le jour même à 9h (la veille à 16h avant 11h ou pour un hôtel)
//    2. « Mise en place »  : 30 min avant (15 min pour un taxi), avec lieu et infos
//  Outlook les place tout seul dans l'agenda (comme une invitation de réunion).
//  Pas d'invitation pour les saisies directes (Julia / Arnaud), pas de mise à jour
//  quand la demande est modifiée. Annulée : retirée des agendas. « Commande passée »
//  (appel de l'appli, type COMMANDE) : le rappel devient « ✅ Commandé ».
//
//  Envoi par Brevo (SMTP, gratuit jusqu'à 300 emails/jour).
//  Secrets à définir dans Supabase (Edge Functions › Secrets) :
//    BREVO_SMTP_LOGIN  identifiant SMTP Brevo (ex. 8a1b2c001@smtp-brevo.com)
//    BREVO_SMTP_KEY    clé SMTP Brevo (commence par « xsmtpsib- »)
//    EXPEDITEUR        adresse d'expéditeur validée dans Brevo
//  SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis automatiquement.
// ════════════════════════════════════════════════════════════════════
import nodemailer from "npm:nodemailer@6.9.16";

type Row = Record<string, any>;
type Ev = { uid: string; start: Wall; minutes: number; title: string; location: string; desc: string; alarm: number; libre?: boolean; sansAlarme?: boolean };
type Wall = { y: number; mo: number; d: number; h: number; mi: number }; // heure de Paris

const TZ = "Europe/Paris";
const TYPE: Record<string, string> = { repas: "Repas", taxi: "Taxi", commande: "Commande", hotel: "Hôtel" };
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

// ── Dates (toujours en heure de Paris, sans conversion) ──────────────
function parseDay(s?: string): Wall | null {
  if (!s) return null;
  let y: number, mo: number, d: number;
  if (s.includes("-")) [y, mo, d] = s.slice(0, 10).split("-").map(Number);
  else { const p = s.split("/").map(Number); [d, mo, y] = p; }
  if (!y || !mo || !d) return null;
  return { y, mo, d, h: 0, mi: 0 };
}
function heureMin(h?: string): number | null {
  const m = (h || "").match(/(\d{1,2})\s*[hH:]\s*(\d{0,2})/);
  return m ? (+m[1]) * 60 + (+(m[2] || 0)) : null;
}
function toDate(w: Wall) { return new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi)); } // « faux UTC » = heure murale
function fromDate(t: Date): Wall { return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes() }; }
function addMin(w: Wall, m: number) { return fromDate(new Date(toDate(w).getTime() + m * 60000)); }
function parisNow(): Wall {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}
const pad = (n: number) => String(n).padStart(2, "0");
const icsWall = (w: Wall) => (String(w.y) + String(pad(w.mo)) + String(pad(w.d)) + "T" + String(pad(w.h)) + String(pad(w.mi)) + "00");
const jourLong = (w: Wall) => { const j = JOURS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]; return (String(j[0].toUpperCase() + j.slice(1)) + " " + String(w.d) + " " + String(MOIS[w.mo - 1])); };
const jourCourt = (w: Wall) => (String(w.d) + "/" + String(pad(w.mo)));

// ── Contenu des rappels (mêmes règles que le bouton Agenda de l'appli) ─
// Titre court et distinctif : type, pour qui, prestataire (Outlook coupe les titres longs)
const cap = (s: string) => { const x = String(s || "").trim().toLowerCase(); return x ? x[0].toUpperCase() + x.slice(1) : ""; };
function court(c: Row) {
  const kind = c.type === "repas" ? (cap(c.descr).slice(0, 14) || "Repas") : c.type === "taxi" ? "Taxi" : c.type === "hotel" ? "Hôtel" : c.type === "coursier" ? "Coursier" : "Commande";
  const noms = String(c.pour_qui || "").split(/[,;\n]+/).map((x: string) => x.trim()).filter(Boolean);
  const qui = c.type === "commande" ? String(c.presta || "") : noms.length ? (String(noms[0]) + String(noms.length > 1 ? (" +" + String(noms.length - 1)) : "")) : String(c.demandeur || "");
  const dj = parseDay(c.date), df = parseDay(c.date_depart);
  const det = c.type === "taxi" ? (c.arrivee ? ("→ " + String(c.arrivee).slice(0, 28)) : String(c.presta || ""))
    : c.type === "hotel" ? (String(c.presta || "") + String(dj && df ? (" (" + String(dj.d) + "→" + String(jourCourt(df)) + ")") : ""))
    : c.type === "commande" ? String(c.descr || "").slice(0, 28) : String(c.presta || "");
  return { kind, qui, det };
}
function titre(c: Row) { return c.type === "commande" ? (c.presta || c.descr || "Commande") : (c.descr || TYPE[c.type] || "Demande"); }
function messageCommande(c: Row, start: Wall) {
  const quand = (String(jourLong(start)) + " " + String(start.y) + String(c.heure ? (" à " + String(c.heure)) : ""));
  const L = ["Bonjour,", ""];
  if (c.type === "taxi") {
    L.push("Je souhaiterais réserver un taxi :", ("- Date : " + String(quand)), ("- Départ : " + String(c.depart || c.lieu || "—")), ("- Arrivée : " + String(c.arrivee || "—")));
    if (c.pour_qui) L.push(("- Passager : " + String(c.pour_qui)));
    if (c.tel) L.push(("- Téléphone du passager : " + String(c.tel)));
    if (c.vol) L.push(("- Vol / train : " + String(c.vol)));
  } else if (c.type === "hotel") {
    const dd = parseDay(c.date_depart);
    L.push("Je souhaiterais réserver :", ("- Arrivée : " + String(jourLong(start)) + " " + String(start.y)), ("- Départ : " + String(dd ? jourLong(dd) + " " + dd.y : "—")));
    if (c.lieu) L.push(("- Ville : " + String(c.lieu)));
    L.push(("- Personnes : " + String(c.nb || 1)));
    if (c.pour_qui) L.push(("- Au nom de : " + String(c.pour_qui)));
  } else if (c.type === "repas") {
    L.push("Je souhaiterais passer la commande suivante :", ("- Date : " + String(quand)), ("- Salle / lieu de livraison : " + String(c.lieu || "à préciser")), ("- Nombre de personnes : " + String(c.nb || 1)));
    if (c.descr) L.push(("- Repas : " + String(c.descr)));
  } else {
    L.push("Je souhaiterais passer la commande suivante :");
    if (c.descr && c.descr !== "Commande") L.push(("- Articles : " + String(c.descr)));
    L.push(("- Livraison : " + String(quand)));
    if (c.lieu) L.push(("- Lieu de livraison : " + String(c.lieu)));
  }
  if (c.comment) L.push(("- Précisions : " + String(c.comment)));
  L.push("", "Merci de me confirmer la prise en compte.", "", "Cordialement,");
  return L.join("\n");
}
export function rappels(c: Row, now: Wall = parisNow()): Ev[] {
  const day = parseDay(c.date); if (!day) return [];
  const hm = heureMin(c.heure);
  const start: Wall = { ...day, h: hm !== null ? Math.floor(hm / 60) : 9, mi: hm !== null ? hm % 60 : 0 };
  const t = titre(c); const k = court(c);
  const lieu = c.type === "taxi" ? (c.depart || c.lieu || "") : (c.lieu || "");
  const infos = [
    (String(TYPE[c.type] || "") + " : " + String(t)), ("Quand : " + String(jourLong(start)) + String(c.heure ? " à " + c.heure : "")),
    c.type === "taxi" ? ("Trajet : " + String(c.depart || "—") + " → " + String(c.arrivee || "—")) : (lieu ? ("Lieu / salle : " + String(lieu)) : ""),
    (c.type === "repas" || c.type === "hotel") ? ("Personnes : " + String(c.nb || 1)) : "",
    c.presta ? ("Prestataire : " + String(c.presta)) : "", ("Demandé par : " + String(c.demandeur || "—")), c.pour_qui ? ("Pour : " + String(c.pour_qui)) : "",
    c.tel ? ("Téléphone : " + String(c.tel)) : "", c.vol ? ("Vol / train : " + String(c.vol)) : "", c.comment ? ("Commentaire : " + String(c.comment)) : "",
    c.code ? ("Code : " + String(c.code)) : "",
  ].filter(Boolean).join("\n");

  // 1) Commander : le jour même à 9h ; la veille à 16h si la prestation est avant 11h ou si c'est un hôtel ;
  //    si c'est déjà passé, dans l'heure ; jamais après la prestation
  let cmd: Wall = { ...day, h: 9, mi: 0 };
  if (start.h < 11 || c.type === "hotel") cmd = { ...addMin({ ...day, h: 0, mi: 0 }, -24 * 60), h: 16, mi: 0 };
  if (toDate(cmd) < toDate(now)) { cmd = addMin({ ...now, mi: 0 }, 60); }
  if (toDate(cmd) > toDate(start)) cmd = addMin(start, -60);
  const out: Ev[] = [{
    uid: (String(c.id) + "-commande@gestion-commandes"), start: cmd, minutes: 15,
    title: (String(k.kind) + " " + String(k.qui) + String(k.det ? (String(c.type === "taxi" ? " " : " · ") + k.det) : "") + String(c.type === "hotel" ? "" : (" (" + String(jourCourt(start)) + ")"))), location: "",
    desc: ("À commander auprès de " + String(c.presta || "du prestataire") + ".\n\n" + String(infos) + "\n\n——— Message prêt à envoyer ———\n" + String(messageCommande(c, start))), alarm: 0, libre: true,
  }];
  // 2) Mise en place
  const avant = c.type === "taxi" ? 15 : 30;
  const lbl = c.type === "hotel" ? "Arrivée hôtel" : c.type === "commande" ? "Livraison" : k.kind;
  out.push({
    uid: (String(c.id) + "-miseenplace@gestion-commandes"), start: addMin(start, -avant), minutes: avant + (c.type === "repas" ? 30 : 0),
    title: (String(c.heure ? (String(c.heure) + " ") : "") + String(lbl) + " " + String(c.type === "commande" ? (c.presta || k.qui) : k.qui) + String(lieu ? (" · " + lieu) : "")), location: lieu, desc: infos, alarm: 15,
  });
  return out;
}

// ── iCalendar (RFC 5545 / iMIP) ──────────────────────────────────────
const esc = (s: string) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line: string) {
  const enc = new TextEncoder(); const out: string[] = []; let cur = ""; let len = 0;
  for (const ch of line) { const b = enc.encode(ch).length; if (len + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; len = 0; } cur += ch; len += b; }
  out.push(cur); return out.join("\r\n ");
}
const VTIMEZONE = ["BEGIN:VTIMEZONE", "TZID:Europe/Paris",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE"];
export function ics(ev: Ev, method: "REQUEST" | "CANCEL", organizer: string, attendees: string[], sequence: number) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const L = ["BEGIN:VCALENDAR", "PRODID:-//Gestion des services//FR", "VERSION:2.0", "CALSCALE:GREGORIAN", ("METHOD:" + String(method)), ...VTIMEZONE,
    "BEGIN:VEVENT", ("UID:" + String(ev.uid)), ("SEQUENCE:" + String(sequence)), ("DTSTAMP:" + String(stamp)),
    ("DTSTART;TZID=" + String(TZ) + ":" + String(icsWall(ev.start))), ("DTEND;TZID=" + String(TZ) + ":" + String(icsWall(addMin(ev.start, ev.minutes)))),
    fold(("SUMMARY:" + String(esc(ev.title)))), ev.location ? fold(("LOCATION:" + String(esc(ev.location)))) : "", fold(("DESCRIPTION:" + String(esc(ev.desc)))),
    fold(("ORGANIZER;CN=Gestion des services:mailto:" + String(organizer))),
    // Rappel « Commander » : déjà accepté et affiché « Disponible » ; les autres rappels ne changent pas
    ...attendees.map((a) => fold(("ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=" + String(ev.libre ? "ACCEPTED" : "NEEDS-ACTION") + ";RSVP=FALSE:mailto:" + String(a)))),
    ("STATUS:" + String(method === "CANCEL" ? "CANCELLED" : "CONFIRMED")), ("TRANSP:" + String(ev.libre ? "TRANSPARENT" : "OPAQUE")), "CLASS:PUBLIC",
    "X-MICROSOFT-CDO-BUSYSTATUS:FREE", "X-MICROSOFT-CDO-INTENDEDSTATUS:FREE",
    ...(method === "REQUEST" && !ev.sansAlarme ? ["BEGIN:VALARM", "ACTION:DISPLAY", ("TRIGGER:-PT" + String(ev.alarm) + "M"), fold(("DESCRIPTION:" + String(esc(ev.title)))), "END:VALARM"] : []),
    "END:VEVENT", "END:VCALENDAR"];
  return L.filter(Boolean).join("\r\n") + "\r\n";
}

// ── Supabase ─────────────────────────────────────────────────────────
async function adminEmails(): Promise<string[]> {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch((String(url) + "/rest/v1/parametres?cle=eq.adminEmails&select=valeur"), { headers: { apikey: key!, Authorization: ("Bearer " + String(key)) } });
  const rows = await r.json();
  const v = rows?.[0]?.valeur;
  const list = Array.isArray(v) ? v : (typeof v === "string" ? JSON.parse(v || "[]") : []);
  return [...new Set(list.map((x: string) => String(x).trim()).filter((x: string) => /@/.test(x)))] as string[];
}

async function sbGet(path: string) {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch((String(url) + "/rest/v1/" + String(path)), { headers: { apikey: key!, Authorization: ("Bearer " + String(key)) } });
  return await r.json();
}
async function suiviDe(id: any): Promise<Row> {
  const rows = await sbGet("parametres?cle=eq.suivi&select=valeur");
  let v = rows?.[0]?.valeur; if (typeof v === "string") { try { v = JSON.parse(v); } catch (_) { v = {}; } }
  return (v && v[String(id)]) || {};
}
function passee(c: Row, now: Wall) {
  const day = parseDay(c.date); if (!day) return true;
  const hm = heureMin(c.heure);
  const fin = c.type === "hotel" ? (parseDay(c.date_depart) || day) : { ...day, h: hm !== null ? Math.floor(hm / 60) : 23, mi: hm !== null ? hm % 60 : 59 };
  return toDate(fin) < toDate(now);
}
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Content-Type": "application/json" };
const CHAMPS = ["date", "heure", "lieu", "descr", "nb", "depart", "arrivee", "presta", "pour_qui", "comment", "date_depart", "vol", "tel", "type"];
export function decide(type: string, rec: Row, old?: Row): "REQUEST" | "CANCEL" | null {
  if (type === "INSERT") return rec.pris === "En attente" ? "REQUEST" : null; // saisie directe (« OUI ») et repas récurrents (« En cours ») : rien
  if (type === "UPDATE" && old) {
    if (rec.pris === "Annulé" && old.pris !== "Annulé") return "CANCEL";
    if (rec.pris === "Annulé") return null;
    if (old.pris === "Annulé") return "REQUEST"; // demande réactivée
    // modifications : plus de mise à jour envoyée
  }
  if (type === "DELETE" && old) return "CANCEL"; // supprimée (corbeille)
  return null;
}

// ── Remise à jour unique de l'agenda (bouton Réglages › Emails, admin connecté) ──
async function resync(req: Request, now: Wall) {
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
  const u = await fetch((String(url) + "/auth/v1/user"), { headers: { apikey: anon!, Authorization: (req.headers.get("Authorization") || "") } });
  const me = u.ok ? await u.json() : null;
  const to = await adminEmails();
  const email = String((me && me.email) || "").toLowerCase();
  if (!email || !to.map((x) => x.toLowerCase()).includes(email)) return new Response(JSON.stringify({ ok: false, error: "Réservé aux administrateurs connectés" }), { headers: CORS });
  const login = Deno.env.get("BREVO_SMTP_LOGIN")!, key = Deno.env.get("BREVO_SMTP_KEY")!, user = Deno.env.get("EXPEDITEUR")!;
  if (!login || !key || !user) return new Response(JSON.stringify({ ok: false, error: "Secrets Brevo manquants" }), { headers: CORS });
  const rows: Row[] = (await sbGet("commandes?select=*")) || [];
  const srows = await sbGet("parametres?cle=eq.suivi&select=valeur");
  let suivi = srows?.[0]?.valeur; if (typeof suivi === "string") { try { suivi = JSON.parse(suivi); } catch (_) { suivi = {}; } }
  suivi = suivi || {};
  const transport = nodemailer.createTransport({ host: "smtp-relay.brevo.com", port: 465, secure: true, auth: { user: login, pass: key } });
  const seq = Math.floor(Date.now() / 1000) - 1760000000;
  let renvoyes = 0, retires = 0, mails = 0;
  for (const row of rows) {
    if (mails >= 120) break; // limite d'envoi Brevo
    if (row.pris === "Annulé" || passee(row, now)) continue;
    const s = suivi[String(row.id)] || {};
    const sans = !!(s.direct || s.recurrent || /^repas r[ée]current$/i.test(String(row.comment || "")));
    let evs = rappels(row, now);
    const method = sans ? "CANCEL" : "REQUEST";
    if (!sans && s.cmd) evs = evs.map((e) => e.uid.includes("-commande@") ? { ...e, title: ("✅ " + String(e.title)), desc: ("Commande passée.\n\n" + String(e.desc)), sansAlarme: true } : e);
    for (const ev of evs) {
      await transport.sendMail({
        from: ("\"Gestion des services\" <" + String(user) + ">"), to,
        subject: method === "CANCEL" ? ("Retiré : " + String(ev.title)) : ev.title,
        text: method === "CANCEL" ? "Rappel retiré de votre agenda (saisie directe ou repas récurrent)." : ev.desc,
        icalEvent: { method, filename: "invitation.ics", content: ics(ev, method, user, to, seq) },
      });
      mails++;
    }
    if (sans) retires++; else renvoyes++;
  }
  return new Response(JSON.stringify({ ok: true, renvoyes, retires, mails }), { headers: CORS });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const p = await req.json();
    const now = parisNow();
    if (p.type === "RESYNC") return await resync(req, now);
    let rec: Row = p.record || p.old_record || {};
    let method = p.type === "COMMANDE" ? "REQUEST" : decide(p.type, p.record || {}, p.old_record);
    const skip = (why: string) => new Response(JSON.stringify({ ok: true, skipped: why }), { headers: CORS });
    if (!method) return skip("rien à envoyer");
    if (p.type === "COMMANDE") { // l'appli signale « Commande passée » : on relit tout côté serveur
      const rows = await sbGet(("commandes?id=eq." + encodeURIComponent(String(rec.id || "")) + "&select=*"));
      rec = rows?.[0]; if (!rec) return skip("introuvable");
      if (rec.pris === "Annulé") return skip("annulée");
    }
    const row = method === "CANCEL" && p.type === "DELETE" ? p.old_record : rec;
    if (passee(row, now)) return skip("prestation passée");
    if (p.type !== "INSERT") { const s = await suiviDe(row.id); if (s.direct) return skip("saisie directe"); if (s.recurrent) return skip("repas récurrent"); if (p.type === "COMMANDE" && !s.cmd) return skip("pas commandée"); }

    const login = Deno.env.get("BREVO_SMTP_LOGIN")!, key = Deno.env.get("BREVO_SMTP_KEY")!, user = Deno.env.get("EXPEDITEUR")!;
    if (!login || !key || !user) return new Response(JSON.stringify({ ok: false, error: "Secrets Brevo manquants" }), { status: 200 });
    const to = await adminEmails();
    if (!to.length) return new Response(JSON.stringify({ ok: false, error: "Aucun email admin dans les réglages" }), { status: 200 });

    let evs = rappels(row, now);
    if (p.type === "COMMANDE") evs = evs.filter((e) => e.uid.includes("-commande@")).map((e) => ({ ...e, title: ("✅ " + String(e.title)), desc: ("Commande passée.\n\n" + String(e.desc)), sansAlarme: true }));
    const seq = Math.floor(Date.now() / 1000) - 1760000000; // croissant : chaque mise à jour remplace la précédente
    // Port 465 (SSL) : les ports 25 et 587 sont bloqués dans les Edge Functions Supabase
    const transport = nodemailer.createTransport({ host: "smtp-relay.brevo.com", port: 465, secure: true, auth: { user: login, pass: key } });
    for (const ev of evs) {
      const content = ics(ev, method, user, to, seq);
      await transport.sendMail({
        from: ("\"Gestion des services\" <" + String(user) + ">"), to,
        subject: method === "CANCEL" ? ("Annulé : " + String(ev.title)) : ev.title,
        text: method === "CANCEL" ? "Cette demande a été annulée : le rappel est retiré de votre agenda." : ev.desc,
        icalEvent: { method, filename: "invitation.ics", content },
      });
    }
    return new Response(JSON.stringify({ ok: true, method, envoyes: evs.length, a: to }), { headers: CORS });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});
