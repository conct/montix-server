// Geräte, die mit Montix funktionieren — gesammelt aus der App: Nach einem Testdruck fragt Montix
// „Hat der Testdruck geklappt?“ und meldet die Antwort ohne Namen und ohne Betrieb hierher.
// Öffentlich gezeigt wird ein Gerät erst, wenn es in der Verwaltung freigegeben ist (damit niemand
// beliebigen Text auf die Seite schreibt).
//
//   POST /geraete/meldung {art, geraet, verbindung, sprache, papier?, ok, plattform?}
//   GET  /geraete          → Seite „Geräte, die mit Montix funktionieren“
//   GET  /geraete.json     → dieselbe Liste für feif.space
//
// Gespeichert: Gerätename (wie getippt), Art, Verbindung, Druckersprache, Zahl der Ja/Nein, erstes
// und letztes Datum. Keine Kennung des Geräts, des Betriebs oder der Person; die IP-Adresse nur
// kurz im Arbeitsspeicher gegen Missbrauch.

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const offen = new Map();
export function geraeteDb(ordner) {
  const pfad = ordner === ':memory:' ? ':memory:' : join(ordner, 'geraete.db');
  if (offen.has(pfad) && pfad !== ':memory:') return offen.get(pfad);
  const db = new DatabaseSync(pfad);
  db.exec(`create table if not exists geraet (
    schluessel text primary key, art text not null, geraet text not null, verbindung text not null, sprache text not null,
    papier text, ja integer not null default 0, nein integer not null default 0, erst text not null, zuletzt text not null,
    freigabe text not null default 'neu'
  )`);
  if (pfad !== ':memory:') offen.set(pfad, db);
  return db;
}

const ARTEN = { drucker: 'Drucker' };
const VERBINDUNG = { wlan: 'WLAN/LAN', bluetooth: 'Bluetooth LE' };
const SPRACHE = { ipp: 'A4 (IPP)', escpos: 'Bondrucker (ESC/POS)', tspl: 'Etikettendrucker (TSPL)' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function melden(db, k) {
  const art = String(k?.art ?? '');
  const geraet = String(k?.geraet ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const verbindung = String(k?.verbindung ?? '');
  const sprache = String(k?.sprache ?? '');
  if (!ARTEN[art] || !VERBINDUNG[verbindung] || !SPRACHE[sprache] || geraet.length < 2 || typeof k?.ok !== 'boolean') return false;
  if (!/^[\p{L}\p{N} .,+\-/()_&]+$/u.test(geraet)) return false;
  const papier = k.papier === 58 || k.papier === 80 ? String(k.papier) : null;
  const schluessel = [art, geraet.toLowerCase(), verbindung, sprache].join('|');
  const jetzt = new Date().toISOString();
  db.prepare(
    `insert into geraet (schluessel, art, geraet, verbindung, sprache, papier, ja, nein, erst, zuletzt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (schluessel) do update set geraet = excluded.geraet, papier = coalesce(excluded.papier, papier), ja = ja + excluded.ja, nein = nein + excluded.nein, zuletzt = excluded.zuletzt`,
  ).run(schluessel, art, geraet, verbindung, sprache, papier, k.ok ? 1 : 0, k.ok ? 0 : 1, jetzt, jetzt);
  return true;
}

/** Öffentliche Liste: freigegeben und mehr Ja als Nein. */
export function liste(db) {
  return db
    .prepare("select art, geraet, verbindung, sprache, papier, ja, nein, zuletzt from geraet where freigabe = 'frei' and ja > nein order by art, lower(geraet)")
    .all()
    .map((g) => ({ art: g.art, geraet: g.geraet, verbindung: VERBINDUNG[g.verbindung], sprache: SPRACHE[g.sprache], papier: g.papier ? `${g.papier} mm` : null, meldungen: g.ja, zuletzt: g.zuletzt.slice(0, 7) }));
}

export function alleFuerVerwaltung(db) {
  return db.prepare("select * from geraet order by case freigabe when 'neu' then 0 when 'frei' then 1 else 2 end, zuletzt desc").all();
}

export function freigabeSetzen(db, schluessel, freigabe) {
  return db.prepare('update geraet set freigabe = ? where schluessel = ?').run(freigabe, schluessel).changes > 0;
}

export function seite(db) {
  const g = liste(db);
  const zeilen = g.map((x) => `<tr><td><strong>${esc(x.geraet)}</strong></td><td>${esc(x.sprache)}${x.papier ? `, ${esc(x.papier)}` : ''}</td><td>${esc(x.verbindung)}</td></tr>`).join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Geräte, die mit Montix funktionieren</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#111827}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px;border-top:1px solid #e5e7eb}th{color:#6b7280;font-size:13px}p{color:#374151}</style></head>
<body><h1>Geräte, die mit Montix funktionieren</h1><p>Drucker, mit denen Montix-Nutzer erfolgreich gedruckt haben. Fehlt Ihr Gerät, heißt das nicht, dass es nicht geht: In Montix unter Einstellungen → Drucker einrichten und den Testdruck machen.</p>
${g.length ? `<table><tr><th>Gerät</th><th>Art</th><th>Verbindung</th></tr>${zeilen}</table>` : '<p>Die Liste füllt sich gerade.</p>'}</body></html>`;
}
