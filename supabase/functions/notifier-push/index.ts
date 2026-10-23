// ════════════════════════════════════════════════════════════════════
//  Gestion des services — notifications sur iPhone / PC (Web Push)
//  Fonction Supabase « notifier-push ».
//  - action "cle"        : renvoie la clé publique (créée au 1er appel)
//  - action "abonner"    : enregistre l'appareil d'un admin connecté
//  - action "desabonner" : retire l'appareil
//  - action "test"       : envoie une notification d'essai à l'appareil
//  - appel du déclencheur (type INSERT / UPDATE sur commandes) :
//    nouvelle demande « En attente » → notification aux admins
//  Aucune clé à saisir : les clés VAPID sont générées et gardées dans
//  la table push_config (lisible uniquement par le serveur).
// ════════════════════════════════════════════════════════════════════

const SB = Deno.env.get("SUPABASE_URL")!;
const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUJET = "mailto:notifications@gestion-des-services.fr";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const TYPES: Record<string, string> = { repas: "Repas", taxi: "Taxi", coursier: "Coursier", commande: "Commande", hotel: "Hôtel" };

type Row = Record<string, any>;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ── base64url ──────────────────────────────────────────────────────
function b64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const txt = (s: string) => new TextEncoder().encode(s);

// ── accès base (clé serveur) ────────────────────────────────────────
async function db(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(SB + "/rest/v1/" + path, {
    ...init,
    headers: { apikey: SRV, Authorization: "Bearer " + SRV, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error("db " + path + " " + r.status + " " + t);
  return t ? JSON.parse(t) : null;
}

// ── clés VAPID (créées une seule fois) ──────────────────────────────
async function vapid(): Promise<{ pub: string; key: CryptoKey }> {
  const rows = await db("push_config?id=eq.1&select=cle_publique,jwk");
  let pub: string, jwk: JsonWebKey;
  if (rows && rows[0] && rows[0].jwk) { pub = rows[0].cle_publique; jwk = rows[0].jwk; }
  else {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
    await db("push_config?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ id: 1, cle_publique: pub, jwk }) });
    const again = await db("push_config?id=eq.1&select=cle_publique,jwk"); // si deux appels simultanés : on garde la 1re
    pub = again[0].cle_publique; jwk = again[0].jwk;
  }
  const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"], ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { pub, key };
}
async function vapidHeader(endpoint: string, v: { pub: string; key: CryptoKey }): Promise<string> {
  const aud = new URL(endpoint).origin;
  const h = b64u(txt(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64u(txt(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUJET })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, txt(h + "." + p));
  return "vapid t=" + h + "." + p + "." + b64u(sig) + ", k=" + v.pub;
}

// ── chiffrement du message (RFC 8291, aes128gcm) ────────────────────
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
export async function chiffrer(p256dh: string, auth: string, message: string): Promise<Uint8Array> {
  const uaPub = unb64u(p256dh), secret = unb64u(auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(secret, ecdh, concat(txt("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, txt("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, txt("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(txt(message), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  return concat(head, asPub, ct);
}

// ── envoi à une liste d'appareils ───────────────────────────────────
async function envoyer(abos: Row[], msg: Row): Promise<{ ok: number; ko: number }> {
  const v = await vapid(); let ok = 0, ko = 0;
  for (const a of abos) {
    try {
      const body = await chiffrer(a.p256dh, a.auth, JSON.stringify(msg));
      const r = await fetch(a.endpoint, {
        method: "POST",
        headers: { Authorization: await vapidHeader(a.endpoint, v), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" },
        body,
      });
      if (r.status === 404 || r.status === 410) { await db("push_abonnements?endpoint=eq." + encodeURIComponent(a.endpoint), { method: "DELETE" }); ko++; }
      else if (r.ok) ok++; else { ko++; console.error("push", r.status, await r.text()); }
    } catch (e) { ko++; console.error("push", e); }
  }
  return { ok, ko };
}

// ── utilisateur connecté (admin) ────────────────────────────────────
async function adminConnecte(req: Request): Promise<string | null> {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const r = await fetch(SB + "/auth/v1/user", { headers: { apikey: ANON || SRV, Authorization: "Bearer " + tok } });
  if (!r.ok) return null;
  const u = await r.json(); const email = String(u.email || "").toLowerCase();
  if (!email) return null;
  const p = await db("parametres?cle=eq.adminEmails&select=valeur");
  let list: unknown = p && p[0] ? p[0].valeur : [];
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { list = []; } }
  return Array.isArray(list) && list.map((x) => String(x).toLowerCase().trim()).includes(email) ? email : null;
}

function texte(c: Row): Row {
  const d = String(c.date || "");
  const jour = /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(8, 10) + "/" + d.slice(5, 7) : d.slice(0, 5);
  const quoi = c.type === "commande" ? (c.presta || c.descr || "Commande") : (c.descr || "");
  return {
    title: "Nouvelle demande · " + (TYPES[c.type] || "Demande"),
    body: [jour + (c.heure ? " " + c.heure : ""), quoi, c.demandeur || ""].filter(Boolean).join(" · "),
    url: "./index.html", tag: "demande-" + c.id,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const p: Row = req.method === "GET" ? { action: "cle" } : await req.json().catch(() => ({}));

    if (p.action === "cle") return json({ cle: (await vapid()).pub });

    if (p.action === "abonner" || p.action === "desabonner" || p.action === "test") {
      const email = await adminConnecte(req);
      if (!email) return json({ ok: false, error: "Réservé aux administrateurs connectés" }, 403);
      const s = p.subscription || {};
      if (p.action === "desabonner") {
        await db("push_abonnements?endpoint=eq." + encodeURIComponent(String(p.endpoint || s.endpoint || "")), { method: "DELETE" });
        return json({ ok: true });
      }
      if (p.action === "abonner") {
        if (!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ ok: false, error: "Abonnement incomplet" }, 400);
        await db("push_abonnements?on_conflict=endpoint", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, email, appareil: String(p.appareil || "").slice(0, 120), maj: new Date().toISOString() }),
        });
        return json({ ok: true });
      }
      const mine = await db("push_abonnements?email=eq." + encodeURIComponent(email) + "&select=endpoint,p256dh,auth" + (p.endpoint ? "&endpoint=eq." + encodeURIComponent(p.endpoint) : ""));
      return json({ ok: true, ...(await envoyer(mine || [], { title: "Notifications activées ✓", body: "Vous serez prévenu ici des nouvelles demandes.", url: "./index.html", tag: "test" })) });
    }

    // Appel du déclencheur : on relit la demande en base (on ne fait pas confiance au contenu reçu)
    if ((p.type === "INSERT" || p.type === "UPDATE") && p.record && p.record.id) {
      const rows = await db("commandes?id=eq." + encodeURIComponent(String(p.record.id)) + "&select=*");
      const c = rows && rows[0];
      if (!c || c.pris !== "En attente") return json({ ok: true, skipped: true });
      if (p.type === "UPDATE" && p.old_record && p.old_record.pris === "En attente") return json({ ok: true, skipped: true });
      // une seule notification par demande
      const deja = await db("push_envois?commande_id=eq." + encodeURIComponent(String(c.id)) + "&select=commande_id");
      if (deja && deja.length) return json({ ok: true, skipped: true });
      await db("push_envois", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ commande_id: String(c.id) }) });
      const abos = await db("push_abonnements?select=endpoint,p256dh,auth");
      return json({ ok: true, ...(await envoyer(abos || [], texte(c))) });
    }
    return json({ ok: true, skipped: true });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
