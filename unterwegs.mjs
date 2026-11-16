// Unterwegs zum Kunden: Der Monteur tippt „Losfahren“, der Kunde bekommt einen Link und sieht dort,
// wie weit der Monteur ungefähr noch entfernt ist — gerundet, ohne Karte und ohne genauen Ort
// (Schutz des Mitarbeiters). Kollegen sehen in der App, wer gerade wohin unterwegs ist.
//
//   POST /unterwegs/start {termin, kunde, ziel?, ort?} → { id, link }   ziel = Ort des Kunden, wenn bekannt
//   POST /unterwegs/ort   {ort}                        → aktualisiert (die App schickt das bei offener App)
//   POST /unterwegs/ende                               → angekommen / abgebrochen
//   GET  /unterwegs                                    → Fahrten im Betrieb (Kollegen)
//   GET  /weg/<schluessel>                             → öffentliche Seite für den Kunden (ohne Anmeldung)
//
// Gespeichert wird nur die letzte Position, kein Verlauf; 24 Stunden nach dem Ende gelöscht.

import { randomBytes } from 'node:crypto';

const AUFBEWAHRUNG_MS = 24 * 3600 * 1000;

export class WegFehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

function tabelle(db) {
  db.exec(`
    create table if not exists unterwegs (
      mitarbeiter text primary key, name text not null, schluessel text unique not null, termin text,
      kunde text, ziel text, ort text, beginn text not null, aktualisiert text not null, ende text
    );
  `);
}

const ortOk = (o) => o && Number.isFinite(o.lat) && Number.isFinite(o.lon) && Math.abs(o.lat) <= 90 && Math.abs(o.lon) <= 180;
const ortJson = (o) => (ortOk(o) ? JSON.stringify({ lat: o.lat, lon: o.lon, genau: Number.isFinite(o.genau) ? o.genau : undefined }) : null);

function abstandM(a, b) {
  const rad = (g) => (g * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Gerundete Entfernung — genauer muss es der Kunde nicht wissen. */
export function entfernungText(m) {
  if (m < 300) return 'gleich da';
  if (m < 1000) return 'weniger als 1 km';
  if (m < 10000) return `etwa ${Math.round(m / 1000)} km`;
  return `etwa ${Math.round(m / 5000) * 5} km`;
}

const zeile = (z) => {
  const ziel = z.ziel ? JSON.parse(z.ziel) : null;
  const ort = z.ort ? JSON.parse(z.ort) : null;
  return {
    mitarbeiter: z.mitarbeiter,
    name: z.name,
    termin: z.termin,
    kunde: z.kunde,
    beginn: z.beginn,
    aktualisiert: z.aktualisiert,
    ende: z.ende,
    ...(ziel && ort ? { entfernung: Math.round(abstandM(ort, ziel)) } : {}),
  };
};

function aufraeumen(db) {
  db.prepare('delete from unterwegs where ende is not null and ende < ?').run(new Date(Date.now() - AUFBEWAHRUNG_MS).toISOString());
}

export async function unterwegsWeg(methode, pfad, wer, koerper, basis) {
  if (pfad !== '/unterwegs' && !pfad.startsWith('/unterwegs/')) return undefined;
  const db = wer.db;
  tabelle(db);
  aufraeumen(db);
  const iso = new Date().toISOString();
  const ich = wer.mitarbeiter;
  if (methode === 'GET' && pfad === '/unterwegs') return db.prepare('select * from unterwegs where ende is null order by beginn').all().map(zeile);
  if (methode !== 'POST') return undefined;
  const k = (await koerper()) ?? {};
  if (pfad === '/unterwegs/start') {
    const schluessel = `w${randomBytes(12).toString('base64url')}`;
    db.prepare(
      `insert into unterwegs values (?, ?, ?, ?, ?, ?, ?, ?, ?, null)
       on conflict (mitarbeiter) do update set name = excluded.name, schluessel = excluded.schluessel, termin = excluded.termin, kunde = excluded.kunde,
         ziel = excluded.ziel, ort = excluded.ort, beginn = excluded.beginn, aktualisiert = excluded.aktualisiert, ende = null`,
    ).run(ich.id, ich.name, schluessel, String(k.termin ?? '').slice(0, 80) || null, String(k.kunde ?? '').slice(0, 120) || null, ortJson(k.ziel), ortJson(k.ort), iso, iso);
    return { link: `${basis}/weg/${schluessel}` };
  }
  if (pfad === '/unterwegs/ort') {
    const o = ortJson(k.ort);
    if (!o) throw new WegFehler(400, 'ort fehlt');
    const r = db.prepare('update unterwegs set ort = ?, aktualisiert = ? where mitarbeiter = ? and ende is null').run(o, iso, ich.id);
    if (!r.changes) throw new WegFehler(409, 'Keine Fahrt begonnen');
    return { ok: true };
  }
  if (pfad === '/unterwegs/ende') {
    db.prepare('update unterwegs set ende = ?, ort = null where mitarbeiter = ? and ende is null').run(iso, ich.id);
    return { ok: true };
  }
  return undefined;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Öffentliche Seite für den Kunden — ohne Skript, lädt sich alle 30 Sekunden neu. */
export function wegSeite(speicher, schluessel) {
  if (!/^w[A-Za-z0-9_-]{16}$/.test(schluessel)) return null;
  for (const b of speicher.alleBetriebe()) {
    tabelle(b.db);
    const z = b.db.prepare('select * from unterwegs where schluessel = ?').get(schluessel);
    if (!z) continue;
    const vorname = esc(String(z.name).split(/\s+/)[0]);
    const ziel = z.ziel ? JSON.parse(z.ziel) : null;
    const ort = z.ort ? JSON.parse(z.ort) : null;
    const vorMin = Math.max(0, Math.round((Date.now() - Date.parse(z.aktualisiert)) / 60000));
    const status = z.ende
      ? `<h1>${vorname} ist angekommen.</h1>`
      : `<h1>${vorname} ist unterwegs zu Ihnen.</h1>${ziel && ort ? `<p class="gross">Noch ${esc(entfernungText(abstandM(ort, ziel)))}</p>` : '<p class="gross">Auf dem Weg</p>'}<p>Zuletzt aktualisiert ${vorMin === 0 ? 'gerade eben' : `vor ${vorMin} Min.`} · Luftlinie, die Fahrt kann länger dauern.</p>`;
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${z.ende ? '' : '<meta http-equiv="refresh" content="30">'}<title>${esc(b.name)} – unterwegs</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f4f6f8;color:#111827}main{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px #0001}h1{font-size:22px}.gross{font-size:30px;font-weight:800;margin:8px 0}p{color:#374151}small{color:#6b7280}</style></head>
<body><main><small>${esc(b.name)}${z.kunde ? ` · Termin bei ${esc(z.kunde)}` : ''}</small>${status}<small>Montix zeigt nur eine ungefähre Entfernung, keinen Standort. Die Seite ist 24 Stunden nach der Ankunft nicht mehr erreichbar.</small></main></body></html>`;
  }
  return null;
}
