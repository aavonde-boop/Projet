// ════════════════════════════════════════════════════════════════════
//  Gestion des services — invitations agenda automatiques
//
//  Appelée par un « Database Webhook » Supabase sur la table `commandes`
//  (INSERT + UPDATE). Pour chaque nouvelle demande, envoie aux emails admin
//  (Réglages › Notifications › Emails admin) deux invitations Outlook :
//    1. « Commander »      : la veille à 10h (ou dans l'heure si c'est trop tard)
//    2. « Mise en place »  : 30 min avant (15 min pour un taxi), avec lieu et infos
//  Outlook les place tout seul dans l'agenda (comme une invitation de réunion).
//  Si la demande est modifiée (date, heure, lieu…), les invitations sont mises
//  à jour ; si elle est annulée, elles sont retirées des agendas.
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
type Ev = { uid: string; start: Wall; minutes: number; title: string; location: string; desc: string; alarm: number };
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
const icsWall = (w: Wall) => `${w.y}${pad(w.mo)}${pad(w.d)}T${pad(w.h)}${pad(w.mi)}00`;
const jourLong = (w: Wall) => { const j = JOURS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]; return `${j[0].toUpperCase() + j.slice(1)} ${w.d} ${MOIS[w.mo - 1]}`; };
const jourCourt = (w: Wall) => `${w.d}/${pad(w.mo)}`;

// ── Contenu des rappels (mêmes règles que le bouton Agenda de l'appli) ─
function titre(c: Row) { return c.type === "commande" ? (c.presta || c.descr || "Commande") : (c.descr || TYPE[c.type] || "Demande"); }
function messageCommande(c: Row, start: Wall) {
  const quand = `${jourLong(start)} ${start.y}${c.heure ? ` à ${c.heure}` : ""}`;
  const L = ["Bonjour,", ""];
  if (c.type === "taxi") {
    L.push("Je souhaiterais réserver un taxi :", `- Date : ${quand}`, `- Départ : ${c.depart || c.lieu || "—"}`, `- Arrivée : ${c.arrivee || "—"}`);
    if (c.pour_qui) L.push(`- Passager : ${c.pour_qui}`);
    if (c.tel) L.push(`- Téléphone du passager : ${c.tel}`);
    if (c.vol) L.push(`- Vol / train : ${c.vol}`);
  } else if (c.type === "hotel") {
    const dd = parseDay(c.date_depart);
    L.push("Je souhaiterais réserver :", `- Arrivée : ${jourLong(start)} ${start.y}`, `- Départ : ${dd ? jourLong(dd) + " " + dd.y : "—"}`);
    if (c.lieu) L.push(`- Ville : ${c.lieu}`);
    L.push(`- Personnes : ${c.nb || 1}`);
    if (c.pour_qui) L.push(`- Au nom de : ${c.pour_qui}`);
  } else if (c.type === "repas") {
    L.push("Je souhaiterais passer la commande suivante :", `- Date : ${quand}`, `- Salle / lieu de livraison : ${c.lieu || "à préciser"}`, `- Nombre de personnes : ${c.nb || 1}`);
    if (c.descr) L.push(`- Repas : ${c.descr}`);
  } else {
    L.push("Je souhaiterais passer la commande suivante :");
    if (c.descr && c.descr !== "Commande") L.push(`- Articles : ${c.descr}`);
    L.push(`- Livraison : ${quand}`);
    if (c.lieu) L.push(`- Lieu de livraison : ${c.lieu}`);
  }
  if (c.comment) L.push(`- Précisions : ${c.comment}`);
  L.push("", "Merci de me confirmer la prise en compte.", "", "Cordialement,");
  return L.join("\n");
}
export function rappels(c: Row, now: Wall = parisNow()): Ev[] {
  const day = parseDay(c.date); if (!day) return [];
  const hm = heureMin(c.heure);
  const start: Wall = { ...day, h: hm !== null ? Math.floor(hm / 60) : 9, mi: hm !== null ? hm % 60 : 0 };
  const t = titre(c);
  const lieu = c.type === "taxi" ? (c.depart || c.lieu || "") : (c.lieu || "");
  const infos = [
    `${TYPE[c.type] || ""} : ${t}`, `Quand : ${jourLong(start)}${c.heure ? " à " + c.heure : ""}`,
    c.type === "taxi" ? `Trajet : ${c.depart || "—"} → ${c.arrivee || "—"}` : (lieu ? `Lieu / salle : ${lieu}` : ""),
    (c.type === "repas" || c.type === "hotel") ? `Personnes : ${c.nb || 1}` : "",
    c.presta ? `Prestataire : ${c.presta}` : "", `Demandé par : ${c.demandeur || "—"}`, c.pour_qui ? `Pour : ${c.pour_qui}` : "",
    c.tel ? `Téléphone : ${c.tel}` : "", c.vol ? `Vol / train : ${c.vol}` : "", c.comment ? `Commentaire : ${c.comment}` : "",
    c.code ? `Code : ${c.code}` : "",
  ].filter(Boolean).join("\n");

  // 1) Commander : la veille à 10h ; si c'est déjà passé, dans l'heure ; jamais après la prestation
  let cmd: Wall = { ...addMin({ ...day, h: 0, mi: 0 }, -24 * 60), h: 10, mi: 0 };
  if (toDate(cmd) < toDate(now)) { cmd = addMin({ ...now, mi: 0 }, 60); }
  if (toDate(cmd) > toDate(start)) cmd = addMin(start, -60);
  const out: Ev[] = [{
    uid: `${c.id}-commande@gestion-commandes`, start: cmd, minutes: 15,
    title: `Commander · ${t} (${jourCourt(start)})`, location: "",
    desc: `À commander auprès de ${c.presta || "du prestataire"}.\n\n${infos}\n\n——— Message prêt à envoyer ———\n${messageCommande(c, start)}`, alarm: 0,
  }];
  // 2) Mise en place
  const avant = c.type === "taxi" ? 15 : 30;
  const lbl = c.type === "taxi" ? "Taxi" : c.type === "hotel" ? "Arrivée hôtel" : c.type === "commande" ? "Livraison" : "Mise en place";
  out.push({
    uid: `${c.id}-miseenplace@gestion-commandes`, start: addMin(start, -avant), minutes: avant + (c.type === "repas" ? 30 : 0),
    title: `${lbl} · ${t}${lieu ? " — " + lieu : ""}`, location: lieu, desc: infos, alarm: 15,
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
  const L = ["BEGIN:VCALENDAR", "PRODID:-//Gestion des services//FR", "VERSION:2.0", "CALSCALE:GREGORIAN", `METHOD:${method}`, ...VTIMEZONE,
    "BEGIN:VEVENT", `UID:${ev.uid}`, `SEQUENCE:${sequence}`, `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${TZ}:${icsWall(ev.start)}`, `DTEND;TZID=${TZ}:${icsWall(addMin(ev.start, ev.minutes))}`,
    fold(`SUMMARY:${esc(ev.title)}`), ev.location ? fold(`LOCATION:${esc(ev.location)}`) : "", fold(`DESCRIPTION:${esc(ev.desc)}`),
    fold(`ORGANIZER;CN=Gestion des services:mailto:${organizer}`),
    ...attendees.map((a) => fold(`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${a}`)),
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`, "TRANSP:OPAQUE", "CLASS:PRIVATE",
    "X-MICROSOFT-CDO-BUSYSTATUS:FREE", "X-MICROSOFT-CDO-INTENDEDSTATUS:FREE",
    ...(method === "REQUEST" ? ["BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${ev.alarm}M`, fold(`DESCRIPTION:${esc(ev.title)}`), "END:VALARM"] : []),
    "END:VEVENT", "END:VCALENDAR"];
  return L.filter(Boolean).join("\r\n") + "\r\n";
}

// ── Supabase ─────────────────────────────────────────────────────────
async function adminEmails(): Promise<string[]> {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(`${url}/rest/v1/parametres?cle=eq.adminEmails&select=valeur`, { headers: { apikey: key!, Authorization: `Bearer ${key}` } });
  const rows = await r.json();
  const v = rows?.[0]?.valeur;
  const list = Array.isArray(v) ? v : (typeof v === "string" ? JSON.parse(v || "[]") : []);
  return [...new Set(list.map((x: string) => String(x).trim()).filter((x: string) => /@/.test(x)))] as string[];
}

const CHAMPS = ["date", "heure", "lieu", "descr", "nb", "depart", "arrivee", "presta", "pour_qui", "comment", "date_depart", "vol", "tel", "type"];
export function decide(type: string, rec: Row, old?: Row): "REQUEST" | "CANCEL" | null {
  if (type === "INSERT") return rec.pris === "Annulé" ? null : "REQUEST";
  if (type === "UPDATE" && old) {
    if (rec.pris === "Annulé" && old.pris !== "Annulé") return "CANCEL";
    if (rec.pris === "Annulé") return null;
    if (old.pris === "Annulé") return "REQUEST"; // demande réactivée
    if (CHAMPS.some((k) => String(rec[k] ?? "") !== String(old[k] ?? ""))) return "REQUEST";
  }
  if (type === "DELETE" && old) return "CANCEL"; // supprimée (corbeille)
  return null;
}

Deno.serve(async (req) => {
  try {
    const p = await req.json();
    const rec: Row = p.record || p.old_record || {};
    const method = decide(p.type, p.record || {}, p.old_record);
    if (!method) return new Response(JSON.stringify({ ok: true, skipped: true }), { headers: { "Content-Type": "application/json" } });
    const row = method === "CANCEL" && p.type === "DELETE" ? p.old_record : rec;

    const login = Deno.env.get("BREVO_SMTP_LOGIN")!, key = Deno.env.get("BREVO_SMTP_KEY")!, user = Deno.env.get("EXPEDITEUR")!;
    if (!login || !key || !user) return new Response(JSON.stringify({ ok: false, error: "Secrets Brevo manquants" }), { status: 200 });
    const to = await adminEmails();
    if (!to.length) return new Response(JSON.stringify({ ok: false, error: "Aucun email admin dans les réglages" }), { status: 200 });

    const now = parisNow();
    const evs = rappels(row, now);
    const seq = Math.floor(Date.now() / 1000) - 1760000000; // croissant : chaque mise à jour remplace la précédente
    // Port 465 (SSL) : les ports 25 et 587 sont bloqués dans les Edge Functions Supabase
    const transport = nodemailer.createTransport({ host: "smtp-relay.brevo.com", port: 465, secure: true, auth: { user: login, pass: key } });
    for (const ev of evs) {
      const content = ics(ev, method, user, to, seq);
      await transport.sendMail({
        from: `"Gestion des services" <${user}>`, to,
        subject: method === "CANCEL" ? `Annulé : ${ev.title}` : ev.title,
        text: method === "CANCEL" ? "Cette demande a été annulée : le rappel est retiré de votre agenda." : ev.desc,
        icalEvent: { method, filename: "invitation.ics", content },
      });
    }
    return new Response(JSON.stringify({ ok: true, method, envoyes: evs.length, a: to }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});
