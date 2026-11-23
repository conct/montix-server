// Geräte, die mit Montix funktionieren — gesammelt aus der App: Nach einem Testdruck fragt Montix
// „Hat der Testdruck geklappt?“ und meldet die Antwort ohne Namen und ohne Betrieb hierher.
// Öffentlich gezeigt wird ein Gerät erst, wenn es in der Verwaltung freigegeben ist (damit niemand
// beliebigen Text auf die Seite schreibt).
//
//   POST /geraete/meldung {art, hersteller, modell?, verbindung, sprache, papier?, ok, plattform?}
//        (ältere App-Fassungen schicken nur `geraet`; daraus werden Hersteller und Modell geraten)
//   GET  /geraete          → 301 auf die Seite im Design der Website (GERAETE_SEITE)
//   GET  /geraete.json     → die Liste, gelesen von dieser Seite und von llms-full.txt auf feif.space.
//                            Felder oder Hülle {geraete:[…]} nur nach Absprache mit feif.space ändern —
//                            die Seite bliebe sonst still leer.
//
// Gespeichert: Hersteller, Modell und Gerätename (wie getippt), Art, Verbindung, Druckersprache, Zahl der Ja/Nein, erstes
// und letztes Datum. Keine Kennung des Geräts, des Betriebs oder der Person; die IP-Adresse nur
// kurz im Arbeitsspeicher gegen Missbrauch.

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const offen = new Map();
/** Druckereigene Netzwerknamen (Hersteller-Kürzel plus MAC-Adresse) — sagen Kunden nichts. */
const KENNUNGEN = [
  [/^BR[WN][0-9A-F]{12}$/i, 'Brother'],
  [/^NPI[0-9A-F]{6}$/i, 'HP'],
  [/^HP[0-9A-F]{6,12}$/i, 'HP'],
  [/^EPSON[0-9A-F]{6}$/i, 'Epson'],
];
const ERLAUBT = /^[\p{L}\p{N} .,+\-/()_&]+$/u;
const sauber = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Gerätename (wie getippt) in Hersteller und Modell teilen — für ältere App-Fassungen und alte Einträge. */
export function aufteilen(name) {
  const w = sauber(name, 80).replace(/\s+series$/i, '').split(' ').filter(Boolean);
  const k = w.length ? KENNUNGEN.find(([r]) => r.test(w[0])) : null;
  if (k) return { hersteller: k[1], modell: w.slice(1).join(' ') };
  if (w.length === 1) return /\d/.test(w[0]) ? { hersteller: '', modell: w[0] } : { hersteller: w[0], modell: '' };
  return { hersteller: w[0] ?? '', modell: w.slice(1).join(' ') };
}

/** Taugt der Hersteller für die öffentliche Liste? Ein Name, keine Netzwerkkennung, nicht nur Ziffern. */
export function herstellerGueltig(h) {
  const x = sauber(h);
  return x.length >= 2 && ERLAUBT.test(x) && /\p{L}/u.test(x) && !x.split(' ').some((w) => KENNUNGEN.some(([r]) => r.test(w)));
}

export function geraeteDb(ordner) {
  const pfad = ordner === ':memory:' ? ':memory:' : join(ordner, 'geraete.db');
  if (offen.has(pfad) && pfad !== ':memory:') return offen.get(pfad);
  const db = new DatabaseSync(pfad);
  db.exec(`create table if not exists geraet (
    schluessel text primary key, art text not null, geraet text not null, verbindung text not null, sprache text not null,
    papier text, ja integer not null default 0, nein integer not null default 0, erst text not null, zuletzt text not null,
    freigabe text not null default 'neu'
  )`);
  // Hersteller und Modell getrennt (später ergänzt): alte Einträge aus dem gemeldeten Namen füllen.
  const spalten = db.prepare('pragma table_info(geraet)').all().map((c) => c.name);
  if (!spalten.includes('hersteller')) {
    db.exec('alter table geraet add column hersteller text; alter table geraet add column modell text');
    const setzen = db.prepare('update geraet set hersteller = ?, modell = ? where schluessel = ?');
    for (const g of db.prepare('select * from geraet').all()) {
      const t = aufteilen(g.anzeige ?? g.geraet);
      setzen.run(t.hersteller, t.modell, g.schluessel);
    }
  }
  if (pfad !== ':memory:') offen.set(pfad, db);
  return db;
}

export const GERAETE_SEITE = 'https://feif.space/apps-software/montix/geraete/';

const ARTEN = { drucker: 'Drucker' };
const VERBINDUNG = { wlan: 'WLAN/LAN', bluetooth: 'Bluetooth LE' };
const SPRACHE = { ipp: 'A4 (IPP)', escpos: 'Bondrucker (ESC/POS)', tspl: 'Etikettendrucker (TSPL)' };

/** Meldung aus der App: `hersteller` und `modell` (neuere Fassungen) oder nur `geraet` (ältere). */
export function melden(db, k) {
  const art = String(k?.art ?? '');
  const verbindung = String(k?.verbindung ?? '');
  const sprache = String(k?.sprache ?? '');
  const geteilt = k?.hersteller !== undefined ? { hersteller: sauber(k.hersteller), modell: sauber(k.modell) } : aufteilen(k?.geraet);
  const geraet = sauber(k?.geraet ?? `${geteilt.hersteller} ${geteilt.modell}`, 80);
  if (!ARTEN[art] || !VERBINDUNG[verbindung] || !SPRACHE[sprache] || geraet.length < 2 || typeof k?.ok !== 'boolean') return false;
  if (!ERLAUBT.test(geraet) || [geteilt.hersteller, geteilt.modell].some((x) => x && !ERLAUBT.test(x))) return false;
  const papier = k.papier === 58 || k.papier === 80 ? String(k.papier) : null;
  const schluessel = [art, geraet.toLowerCase(), verbindung, sprache].join('|');
  const jetzt = new Date().toISOString();
  // Hersteller und Modell, die in der Verwaltung schon stehen, überschreibt eine neue Meldung nicht.
  db.prepare(
    `insert into geraet (schluessel, art, geraet, verbindung, sprache, papier, ja, nein, erst, zuletzt, hersteller, modell) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (schluessel) do update set geraet = excluded.geraet, papier = coalesce(excluded.papier, papier), ja = ja + excluded.ja, nein = nein + excluded.nein, zuletzt = excluded.zuletzt,
       hersteller = case when coalesce(hersteller, '') = '' then excluded.hersteller else hersteller end,
       modell = case when coalesce(modell, '') = '' then excluded.modell else modell end`,
  ).run(schluessel, art, geraet, verbindung, sprache, papier, k.ok ? 1 : 0, k.ok ? 0 : 1, jetzt, jetzt, geteilt.hersteller, geteilt.modell);
  return true;
}

/** Öffentliche Liste: freigegeben, mehr Ja als Nein und mit Hersteller (das Modell ist freiwillig). */
export function liste(db) {
  return db
    .prepare("select art, hersteller, modell, verbindung, sprache, papier, ja, nein, zuletzt from geraet where freigabe = 'frei' and ja > nein order by art, lower(hersteller), lower(modell)")
    .all()
    .filter((g) => herstellerGueltig(g.hersteller))
    .map((g) => ({
      art: g.art,
      hersteller: g.hersteller,
      modell: g.modell || null,
      geraet: [g.hersteller, g.modell].filter(Boolean).join(' '),
      verbindung: VERBINDUNG[g.verbindung],
      sprache: SPRACHE[g.sprache],
      papier: g.papier ? `${g.papier} mm` : null,
      meldungen: g.ja,
      zuletzt: g.zuletzt.slice(0, 7),
    }));
}

export function alleFuerVerwaltung(db) {
  return db.prepare("select * from geraet order by case freigabe when 'neu' then 0 when 'frei' then 1 else 2 end, zuletzt desc").all();
}

/** Hersteller und Modell aus der Verwaltung. Hersteller ungültig oder falsche Zeichen → false. */
export function herstellerSetzen(db, schluessel, hersteller, modell) {
  const h = sauber(hersteller);
  const m = sauber(modell);
  if (!herstellerGueltig(h) || (m && !ERLAUBT.test(m))) return false;
  return db.prepare('update geraet set hersteller = ?, modell = ? where schluessel = ?').run(h, m, schluessel).changes > 0;
}

export function freigabeSetzen(db, schluessel, freigabe) {
  return db.prepare('update geraet set freigabe = ? where schluessel = ?').run(freigabe, schluessel).changes > 0;
}
