// Mappen mit anderen Firmen teilen (Lagepläne, Leitungs- und Schaltpläne, Fotos, PDF) — per Link
// oder QR-Code. Geteilt wird ein Stand (Kopie), kein Zugriff auf den Betrieb. Die App liefert alles
// fertig (Plan als SVG und PDF); der Server speichert nur und zeichnet nichts.
//
// Angemeldet (Betrieb):
//   POST /freigabe {titel, objekt?, notiz?, ablaufTage|null, pin?, teile:[{name, typ, daten(base64)}], plan?}
//        → { id, link }   (der Link steht nur in der Antwort; gespeichert wird seine Prüfsumme)
//   GET  /freigaben                      → Liste des Betriebs mit Abrufen
//   POST /freigabe/fassung {id, teile, plan?} → neue Fassung, derselbe Link
//   POST /freigabe/widerrufen {id}       → Link sofort tot (wer geteilt hat oder ein Verwalter)
//   POST /freigabe/senden {id, link, email, nachricht?} → Link per E-Mail (der Server prüft, dass der
//        Link zur Freigabe gehört; er kennt ihn selbst nur als Prüfsumme)
// Öffentlich (ohne Anmeldung, noindex):
//   GET  /teilen/<schlüssel>             → Seite mit Plan, Fotos, Downloads (bei PIN: Formular)
//   POST /teilen/<schlüssel>  pin=…      → Seite nach richtiger PIN
//   GET  /teilen/<schlüssel>/datei/<nr>?z=…[&laden=1] → Datei (inline oder zum Herunterladen)
//   GET  /teilen/<schlüssel>/daten?z=…   → JSON für die Übernahme in eine andere Montix-App (Stufe 2)

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { freigabeMail } from './mailvorlage.mjs';

const MB = 1024 * 1024;
export const GRENZE_MAPPE = 25 * MB;
const GRENZE_BETRIEB = 500 * MB;
const MAX_TEILE = 20;
const SPERRE_NACH = 10;
const SPERRE_MIN = 15;
const TYPEN = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
};
const SCHLUESSEL = /^t[A-Za-z0-9_-]{22}$/;
// Gilt für die Dauer des Prozesses: Zugangsmarken nach richtiger PIN (eine Stunde gültig).
const GEHEIM = randomBytes(32);

const hash = (s) => createHash('sha256').update(s).digest('hex');

export class FreigabeFehler extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const tabelle = (db) => {
  db.exec(`create table if not exists freigaben (
    id text primary key, schluessel_hash text unique not null, titel text not null, objekt text, notiz text,
    von text not null, von_name text, erstellt text not null, geaendert text not null, ablauf text, pin_hash text,
    widerrufen text, fassung integer not null default 1, abrufe integer not null default 0, letzter_abruf text,
    fehlversuche integer not null default 0, gesperrt_bis text, plan text)`);
  db.exec(`create table if not exists freigabe_dateien (
    freigabe text not null, fassung integer not null, nr integer not null, name text not null, typ text not null,
    groesse integer not null, daten blob not null, primary key (freigabe, fassung, nr))`);
};

/** Typ prüfen (Anfang der Datei), SVG ohne Skripte. */
function pruefeDatei(typ, b) {
  const ok =
    (typ === 'image/jpeg' && b[0] === 0xff && b[1] === 0xd8) ||
    (typ === 'image/png' && b.subarray(0, 4).toString('latin1') === '\x89PNG') ||
    (typ === 'image/webp' && b.subarray(8, 12).toString('latin1') === 'WEBP') ||
    (typ === 'application/pdf' && b.subarray(0, 5).toString('latin1') === '%PDF-') ||
    (typ === 'text/csv' && !b.includes(0)) ||
    (typ === 'audio/mp4' && b.subarray(4, 8).toString('latin1') === 'ftyp') ||
    (typ === 'audio/webm' && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ||
    (typ === 'audio/wav' && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') ||
    (typ === 'audio/mpeg' && (b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) ||
    (typ === 'image/svg+xml' && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(b.subarray(0, 200).toString('utf8')) && !/<script|\son[a-z]+\s*=|javascript:/i.test(b.toString('utf8')));
  if (!ok) throw new FreigabeFehler(400, 'Datei passt nicht zu ihrem Typ');
}

function teileLesen(teile) {
  if (!Array.isArray(teile) || !teile.length) throw new FreigabeFehler(400, 'Die Mappe ist leer');
  if (teile.length > MAX_TEILE) throw new FreigabeFehler(400, `Höchstens ${MAX_TEILE} Teile je Mappe`);
  let summe = 0;
  return teile.map((t, nr) => {
    if (!TYPEN[t?.typ]) throw new FreigabeFehler(400, 'Nur Bilder, SVG, PDF, CSV und Tonaufnahmen');
    const daten = Buffer.from(String(t.daten ?? ''), 'base64');
    if (!daten.length) throw new FreigabeFehler(400, 'Leere Datei');
    pruefeDatei(t.typ, daten);
    summe += daten.length;
    if (summe > GRENZE_MAPPE) throw new FreigabeFehler(413, 'Die Mappe ist größer als 25 MB');
    const name = String(t.name ?? `teil-${nr + 1}`).replace(/[\r\n/\\"]/g, ' ').slice(0, 120);
    return { nr, name, typ: t.typ, daten };
  });
}

const planJson = (p) => {
  if (p === undefined || p === null) return null;
  const s = JSON.stringify(p);
  if (s.length > 2 * MB) throw new FreigabeFehler(413, 'Plan zu groß');
  return s;
};

const ablaufAus = (tage, jetzt) => {
  if (tage === null || tage === undefined) return null; // unbefristet (Objektakte)
  const n = Number(tage);
  if (!Number.isInteger(n) || n < 1 || n > 3660) throw new FreigabeFehler(400, 'Ablauf in Tagen (1–3660) oder unbefristet');
  return new Date(jetzt.getTime() + n * 86400000).toISOString();
};

function dateienSchreiben(db, id, fassung, teile) {
  const ins = db.prepare('insert into freigabe_dateien values (?, ?, ?, ?, ?, ?, ?)');
  for (const t of teile) ins.run(id, fassung, t.nr, t.name, t.typ, t.daten.length, t.daten);
}

function platzPruefen(db, neu) {
  const belegt = db.prepare('select coalesce(sum(groesse), 0) n from freigabe_dateien').get().n;
  if (belegt + neu > GRENZE_BETRIEB) throw new FreigabeFehler(413, 'Der Speicher für Freigaben ist voll (500 MB). Alte Freigaben widerrufen.');
}

const zeile = (db, f) => ({
  id: f.id,
  titel: f.titel,
  objekt: f.objekt,
  von: f.von_name,
  erstellt: f.erstellt,
  geaendert: f.geaendert,
  ablauf: f.ablauf,
  pin: !!f.pin_hash,
  widerrufen: f.widerrufen,
  fassung: f.fassung,
  abrufe: f.abrufe,
  letzterAbruf: f.letzter_abruf,
  teile: db.prepare('select nr, name, typ, groesse from freigabe_dateien where freigabe = ? and fassung = ? order by nr').all(f.id, f.fassung).map((d) => ({ ...d })),
});

// Höchstens so viele Mails je Betrieb und Tag (gegen Missbrauch als Versanddienst).
const MAILS_JE_TAG = 100;
const mailZaehler = new Map();

export function freigabeWeg(methode, pfad, wer, koerper, basis, senden) {
  if (pfad !== '/freigaben' && !pfad.startsWith('/freigabe')) return undefined;
  const { db, mitarbeiter } = wer;
  tabelle(db);
  return (async () => {
    const jetzt = new Date();
    if (methode === 'GET' && pfad === '/freigaben') {
      return db.prepare('select * from freigaben order by erstellt desc').all().map((f) => zeile(db, f));
    }
    if (methode !== 'POST') throw new FreigabeFehler(404, 'Unbekannter Weg');
    const k = (await koerper(GRENZE_MAPPE * 1.4 + MB)) ?? {};

    if (pfad === '/freigabe') {
      const titel = String(k.titel ?? '').trim().slice(0, 120);
      if (!titel) throw new FreigabeFehler(400, 'Bitte einen Titel angeben');
      const pin = k.pin ? String(k.pin) : '';
      if (pin && !/^\d{4,8}$/.test(pin)) throw new FreigabeFehler(400, 'Die PIN hat 4 bis 8 Ziffern');
      const teile = teileLesen(k.teile);
      platzPruefen(db, teile.reduce((s, t) => s + t.daten.length, 0));
      const schluessel = `t${randomBytes(16).toString('base64url').slice(0, 22)}`;
      const id = `fg_${randomBytes(6).toString('hex')}`;
      const iso = jetzt.toISOString();
      db.prepare(
        `insert into freigaben (id, schluessel_hash, titel, objekt, notiz, von, von_name, erstellt, geaendert, ablauf, pin_hash, plan)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        hash(schluessel),
        titel,
        String(k.objekt ?? '').trim().slice(0, 200) || null,
        String(k.notiz ?? '').trim().slice(0, 2000) || null,
        mitarbeiter.id,
        mitarbeiter.name,
        iso,
        iso,
        ablaufAus(k.ablaufTage, jetzt),
        pin ? hash(`${id}|${pin}`) : null,
        planJson(k.plan),
      );
      dateienSchreiben(db, id, 1, teile);
      return { id, link: `${basis}/teilen/${schluessel}` };
    }

    const f = db.prepare('select * from freigaben where id = ?').get(String(k.id ?? ''));
    if (!f) throw new FreigabeFehler(404, 'Unbekannte Freigabe');
    const darf = f.von === mitarbeiter.id || mitarbeiter.rolle === 'verwalter';

    if (pfad === '/freigabe/fassung') {
      if (!darf) throw new FreigabeFehler(403, 'Nur wer geteilt hat oder ein Verwalter');
      if (f.widerrufen) throw new FreigabeFehler(410, 'Die Freigabe ist widerrufen');
      const teile = teileLesen(k.teile);
      platzPruefen(db, teile.reduce((s, t) => s + t.daten.length, 0));
      const fassung = f.fassung + 1;
      dateienSchreiben(db, f.id, fassung, teile);
      db.prepare('update freigaben set fassung = ?, geaendert = ?, plan = coalesce(?, plan) where id = ?').run(fassung, jetzt.toISOString(), planJson(k.plan), f.id);
      return { ok: true, fassung };
    }
    if (pfad === '/freigabe/senden') {
      if (f.widerrufen || (f.ablauf && Date.parse(f.ablauf) < Date.now())) throw new FreigabeFehler(410, 'Die Freigabe ist nicht mehr gültig');
      const schluessel = String(k.link ?? '').split('/teilen/')[1] ?? '';
      if (!SCHLUESSEL.test(schluessel) || hash(schluessel) !== f.schluessel_hash) throw new FreigabeFehler(400, 'Der Link gehört nicht zu dieser Freigabe');
      const email = String(k.email ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new FreigabeFehler(400, 'Die E-Mail-Adresse ist ungültig');
      const tag = `${wer.betrieb.id}|${jetzt.toISOString().slice(0, 10)}`;
      const n = (mailZaehler.get(tag) ?? 0) + 1;
      if (n > MAILS_JE_TAG) throw new FreigabeFehler(429, 'Heute wurden schon genug Mails verschickt');
      if (mailZaehler.size > 5000) mailZaehler.clear();
      mailZaehler.set(tag, n);
      senden?.(
        [{ email }],
        freigabeMail(
          { titel: f.titel, objekt: f.objekt, nachricht: String(k.nachricht ?? '').trim().slice(0, 2000) || null, link: `${basis}/teilen/${schluessel}`, pin: !!f.pin_hash, ablauf: f.ablauf },
          wer.betrieb,
        ),
      );
      return { ok: true };
    }
    if (pfad === '/freigabe/widerrufen') {
      if (!darf) throw new FreigabeFehler(403, 'Nur wer geteilt hat oder ein Verwalter');
      // Dateien sofort weg — ein widerrufener Link soll nichts mehr auf dem Server halten.
      db.prepare('delete from freigabe_dateien where freigabe = ?').run(f.id);
      db.prepare('update freigaben set widerrufen = ?, plan = null where id = ?').run(jetzt.toISOString(), f.id);
      return { ok: true };
    }
    throw new FreigabeFehler(404, 'Unbekannter Weg');
  })();
}

// ——— öffentlich ———

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const groesse = (n) => (n >= MB ? `${(n / MB).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const datum = (iso) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });

function finden(speicher, schluessel) {
  if (!SCHLUESSEL.test(schluessel)) return null;
  const h = hash(schluessel);
  for (const b of speicher.alleBetriebe()) {
    tabelle(b.db);
    const f = b.db.prepare('select * from freigaben where schluessel_hash = ?').get(h);
    if (f) return { b, f };
  }
  return null;
}

const marke = (f, bis) => `${bis}.${createHmac('sha256', GEHEIM).update(`${f.id}|${bis}`).digest('base64url').slice(0, 22)}`;
function markeGilt(f, z) {
  const [bis, sig] = String(z ?? '').split('.');
  if (!bis || !sig || Number(bis) < Date.now()) return false;
  const soll = Buffer.from(marke(f, bis).split('.')[1]);
  const ist = Buffer.from(sig);
  return soll.length === ist.length && timingSafeEqual(soll, ist);
}

const KOPF = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const seiteRahmen = (titel, inhalt) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(titel)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;background:#f4f6f8;color:#111827}main{max-width:960px;margin:0 auto}
.karte{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 4px #0001;margin-bottom:16px}h1{font-size:24px;margin:4px 0 8px}h2{font-size:17px;margin:0 0 10px}
small,.grau{color:#6b7280}img{max-width:100%;height:auto;border:1px solid #e5e7eb;border-radius:8px;background:#fff}
a.knopf{display:inline-block;margin:6px 8px 0 0;padding:10px 16px;background:#208aef;color:#fff;text-decoration:none;border-radius:8px;font-weight:700}
a.neben{background:#fff;color:#208aef;border:1px solid #208aef}input{font-size:20px;padding:10px;width:10em;border:1px solid #d1d5db;border-radius:8px}
button{font-size:16px;padding:11px 18px;background:#208aef;color:#fff;border:0;border-radius:8px;font-weight:700}
@media print{body{background:#fff;padding:0}.karte{box-shadow:none;padding:0}a.knopf,.nicht-drucken{display:none}}</style></head>
<body><main>${inhalt}</main></body></html>`;

const weg = (res, status, text) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...KOPF });
  res.end(seiteRahmen('Montix', `<div class="karte"><h1>${esc(text)}</h1><p class="grau">Bitte bei der Firma nachfragen, die den Link geschickt hat.</p></div>`));
};

/** Abgelaufene Freigaben: Dateien und Plan löschen (spätestens eine Stunde nach Ablauf, im Takt des Dienstes). */
export function abgelaufeneAufraeumen(db, jetzt = new Date()) {
  tabelle(db);
  const iso = jetzt.toISOString();
  db.prepare('delete from freigabe_dateien where freigabe in (select id from freigaben where ablauf is not null and ablauf < ?)').run(iso);
  db.prepare('update freigaben set plan = null where ablauf is not null and ablauf < ? and plan is not null').run(iso);
}

function nichtMehr(f) {
  if (f.widerrufen) return 'Diese Freigabe wurde zurückgezogen.';
  if (f.ablauf && Date.parse(f.ablauf) < Date.now()) return 'Diese Freigabe ist abgelaufen.';
  return null;
}

function mappeSeite(b, f, schluessel, z) {
  const dateien = b.db.prepare('select nr, name, typ, groesse from freigabe_dateien where freigabe = ? and fassung = ? order by nr').all(f.id, f.fassung);
  const url = (nr, laden) => `${esc(schluessel)}/datei/${nr}?z=${esc(z)}${laden ? '&amp;laden=1' : ''}`;
  const teile = dateien
    .map((d) => {
      const bildTyp = d.typ.startsWith('image/');
      const tonTyp = d.typ.startsWith('audio/');
      return `<div class="karte"><h2>${esc(d.name)}</h2>${bildTyp ? `<p><img src="${url(d.nr)}" alt="${esc(d.name)}"></p>` : ''}${tonTyp ? `<p><audio controls preload="none" src="${url(d.nr)}" style="width:100%"></audio></p>` : ''}
<a class="knopf" href="${url(d.nr, true)}">Herunterladen (${d.typ === 'application/pdf' ? 'PDF' : tonTyp ? 'Aufnahme' : d.typ.split('/')[1].toUpperCase().replace('SVG+XML', 'SVG')}, ${groesse(d.groesse)})</a>${d.typ === 'application/pdf' ? `<a class="knopf neben" href="${url(d.nr)}">Ansehen</a>` : ''}</div>`;
    })
    .join('\n');
  return seiteRahmen(
    `${f.titel} – ${b.name}`,
    `<div class="karte"><small>${esc(b.name)} hat Ihnen diese Unterlagen freigegeben</small><h1>${esc(f.titel)}</h1>
${f.objekt ? `<p>${esc(f.objekt)}</p>` : ''}${f.notiz ? `<p>${esc(f.notiz).replace(/\n/g, '<br>')}</p>` : ''}
<p class="grau">Stand ${datum(f.geaendert)}${f.fassung > 1 ? ` · Fassung ${f.fassung}` : ''}${f.ablauf ? ` · abrufbar bis ${datum(f.ablauf)}` : ''}</p>
<p class="grau nicht-drucken">Zum Drucken die Datei herunterladen oder diese Seite drucken.</p></div>
${teile}
<p class="grau"><small>Geteilt mit Montix. Die Unterlagen gehören ${esc(b.name)}; bitte nur für den vereinbarten Zweck verwenden.</small></p>`,
  );
}

const pinSeite = (b, f, fehler) =>
  seiteRahmen(
    `${f.titel} – ${b.name}`,
    `<div class="karte"><small>${esc(b.name)}</small><h1>${esc(f.titel)}</h1><p>Diese Unterlagen sind mit einer PIN geschützt. Die PIN bekommen Sie von ${esc(b.name)}.</p>
${fehler ? `<p style="color:#b91c1c;font-weight:700">${esc(fehler)}</p>` : ''}
<form method="post"><p><input name="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="8" aria-label="PIN" autofocus></p><button type="submit">Öffnen</button></form></div>`,
  );

async function formular(req) {
  let s = '';
  for await (const t of req) {
    s += t;
    if (s.length > 1024) break;
  }
  return new URLSearchParams(s);
}

function abruf(db, f) {
  db.prepare('update freigaben set abrufe = abrufe + 1, letzter_abruf = ? where id = ?').run(new Date().toISOString(), f.id);
}

/** Öffentliche Wege unter /teilen/… — gibt true zurück, wenn beantwortet. */
export async function teilenOeffentlich(speicher, req, res, pfad, url) {
  const m = pfad.match(/^\/teilen\/([A-Za-z0-9_-]+)(?:\/(datei)\/(\d+)|\/(daten))?$/);
  if (!m) return false;
  const [, schluessel, datei, nr, daten] = m;
  const treffer = finden(speicher, schluessel);
  if (!treffer) {
    weg(res, 404, 'Diese Freigabe gibt es nicht.');
    return true;
  }
  const { b, f } = treffer;
  const tot = nichtMehr(f);
  if (tot) {
    weg(res, 410, tot);
    return true;
  }

  if (datei || daten) {
    if (req.method !== 'GET') return weg(res, 405, 'Nicht erlaubt'), true;
    const z = url.searchParams.get('z');
    if (f.pin_hash && !markeGilt(f, z)) {
      weg(res, 403, 'Bitte die Seite neu öffnen und die PIN eingeben.');
      return true;
    }
    if (daten) {
      const teile = b.db.prepare('select nr, name, typ, groesse from freigabe_dateien where freigabe = ? and fassung = ? order by nr').all(f.id, f.fassung);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...KOPF, 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ format: 'montix-mappe/1', absender: b.name, titel: f.titel, objekt: f.objekt, notiz: f.notiz, stand: f.geaendert, fassung: f.fassung, plan: f.plan ? JSON.parse(f.plan) : null, teile }));
      return true;
    }
    const d = b.db.prepare('select * from freigabe_dateien where freigabe = ? and fassung = ? and nr = ?').get(f.id, f.fassung, Number(nr));
    if (!d) return weg(res, 404, 'Diese Datei gibt es nicht.'), true;
    const endung = TYPEN[d.typ];
    const name = /\.[a-z0-9]{2,4}$/i.test(d.name) ? d.name : `${d.name}.${endung}`;
    res.writeHead(200, {
      'content-type': d.typ,
      'content-length': d.groesse,
      'content-disposition': `${url.searchParams.get('laden') ? 'attachment' : 'inline'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      // Hochgeladenes nie als Seite mit Skript ausführen (SVG, PDF im Browser).
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      ...KOPF,
    });
    res.end(Buffer.from(d.daten));
    return true;
  }

  // Die Seite selbst
  const html = () => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...KOPF });
  if (!f.pin_hash) {
    abruf(b.db, f);
    html();
    res.end(mappeSeite(b, f, schluessel, marke(f, Date.now() + 3600000)));
    return true;
  }
  if (req.method === 'GET') {
    html();
    res.end(pinSeite(b, f));
    return true;
  }
  if (req.method !== 'POST') return weg(res, 405, 'Nicht erlaubt'), true;
  if (f.gesperrt_bis && Date.parse(f.gesperrt_bis) > Date.now()) {
    html();
    res.end(pinSeite(b, f, 'Zu viele falsche Versuche. Bitte in 15 Minuten noch einmal.'));
    return true;
  }
  const pin = String((await formular(req)).get('pin') ?? '').trim();
  if (hash(`${f.id}|${pin}`) !== f.pin_hash) {
    const n = f.fehlversuche + 1;
    const sperre = n >= SPERRE_NACH ? new Date(Date.now() + SPERRE_MIN * 60000).toISOString() : null;
    b.db.prepare('update freigaben set fehlversuche = ?, gesperrt_bis = ? where id = ?').run(sperre ? 0 : n, sperre, f.id);
    html();
    res.end(pinSeite(b, f, sperre ? 'Zu viele falsche Versuche. Bitte in 15 Minuten noch einmal.' : 'Die PIN stimmt nicht.'));
    return true;
  }
  b.db.prepare('update freigaben set fehlversuche = 0, gesperrt_bis = null where id = ?').run(f.id);
  abruf(b.db, f);
  html();
  res.end(mappeSeite(b, f, schluessel, marke(f, Date.now() + 3600000)));
  return true;
}
