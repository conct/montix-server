// Eigene Adresssuche aus OpenStreetMap — statt Photon/komoot, damit keine Anschrift den Server
// verlässt. Die Daten liegen in einer SQLite-Datei (Adressen, Straßen, Orte mit Volltextindex),
// erzeugt mit scripts/adressen-erzeugen.py, auf einem eigenen Server geholt mit
//
//   node verwalten.mjs adressen
//
// Ablage: `adressen/adressen.sqlite` neben diesem Modul oder MONTIX_ADRESSEN. Ohne Datei gibt es
// keine Vorschläge und keine Orte für Tour-Stopps (Ankunftszeit dann nur mit Koordinaten am Stopp);
// der Serverstart weist darauf hin.

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { dateiHolen, dateiSenden } from './karte.mjs';

const ORDNER = join(dirname(fileURLToPath(import.meta.url)), 'adressen');
export const adressDatei = () => process.env.MONTIX_ADRESSEN ?? join(ORDNER, 'adressen.sqlite');
export const adressenDa = () => existsSync(adressDatei());

let offen = null;
/** Datei lesend öffnen; nach einem Austausch (neuer Stand) neu öffnen. */
function datenbank() {
  const pfad = adressDatei();
  if (!existsSync(pfad)) {
    offen?.db.close();
    offen = null;
    return null;
  }
  const mtime = statSync(pfad).mtimeMs;
  if (offen && offen.pfad === pfad && offen.mtime === mtime) return offen.db;
  offen?.db.close();
  offen = { pfad, mtime, db: new DatabaseSync(pfad, { readOnly: true }) };
  return offen.db;
}

/** Muss zu `normiert` in scripts/adressen-erzeugen.py passen. */
export function normiert(text) {
  let s = String(text ?? '').normalize('NFKC').toLowerCase();
  s = s.replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
  s = s.replace(/[-/,.;:()'"]+/g, ' ');
  s = s.replace(/(strasse|str)(?![\p{L}\p{N}])/gu, 'str');
  s = s.replace(/\b(\d+)\s+([a-z])(?![\p{L}\p{N}])/gu, '$1$2');
  return s.split(/\s+/).filter(Boolean).join(' ');
}

const ohneAkzente = (t) => t.normalize('NFD').replace(/\p{M}/gu, '');

function zeile(e) {
  const strasse = e.art === 0 ? `${e.strasse} ${e.nr}` : e.art === 1 ? e.strasse : '';
  const land = String(e.land ?? 'de').toUpperCase();
  const text = [strasse, [e.plz, e.ort].filter(Boolean).join(' '), land !== 'DE' ? land : ''].filter(Boolean).join(', ');
  return { text, strasse, plz: e.plz ?? '', ort: e.ort ?? '', land, lat: e.lat, lon: e.lon, art: e.art };
}

/**
 * Treffer zu einem Suchtext. `tippen`: das letzte Wort darf unvollständig sein (Vorschläge beim
 * Tippen), sonst müssen alle Wörter ganz passen (Anschrift eines Stopps).
 */
export function suchen(text, { tippen = true, land, grenze = 8 } = {}) {
  const db = datenbank();
  if (!db) return [];
  const woerter = normiert(text).split(' ').filter(Boolean).slice(0, 8);
  if (!woerter.length) return [];
  const match = woerter.map((w, i) => `"${w.replace(/"/g, '')}"${tippen && i === woerter.length - 1 ? '*' : ''}`).join(' ');
  // Je Art getrennt (Markierwort im Index), damit ein Ort nicht hinter tausend Adressen verschwindet.
  const roh = [];
  const abfrage = db.prepare('select e.* from suche join eintrag e on e.id = suche.rowid where suche match ? limit ?');
  // Orte nach Größe (rang: Stadt 0 … Flurname 8), damit „Münch“ München vor Münchsmünster findet.
  const orte = db.prepare('select e.* from suche join eintrag e on e.id = suche.rowid where suche match ? order by e.rang limit ?');
  for (const [marke, n] of [['xort', 30], ['xstr', 80], ['xadr', 300]]) {
    try {
      roh.push(...(marke === 'xort' ? orte : abfrage).all(`${marke} ${match}`, n));
    } catch {
      return [];
    }
  }
  const zahlen = woerter.filter((w) => /^\d/.test(w));
  const exakt = new Set(woerter.map(ohneAkzente));
  const letztes = ohneAkzente(woerter[woerter.length - 1]);
  const punkte = (e) => {
    let p = 0;
    const eigene = ohneAkzente(normiert(`${e.strasse} ${e.nr} ${e.plz} ${e.ort}`)).split(' ');
    for (const w of eigene) if (exakt.has(w) || (tippen && letztes && w.startsWith(letztes))) p += 3;
    if (zahlen.length) {
      if (e.art === 0 && zahlen.some((z) => normiert(e.nr) === z)) p += 10;
      if (zahlen.some((z) => e.plz === z)) p += 6;
    } else {
      // Orte nach Größe (Stadt vor Dorf), dann Straßen, dann Adressen.
      p += e.art === 2 ? 8 - Math.min(e.rang, 8) * 1.5 : e.art === 1 ? 2 : 0;
    }
    if (land && String(e.land).toLowerCase() === String(land).toLowerCase()) p += 5;
    else if (!land && e.land === 'de') p += 1;
    return p;
  };
  const sortiert = roh.map((e) => ({ e, p: punkte(e) })).sort((a, b) => b.p - a.p);
  const gesehen = new Set();
  const aus = [];
  for (const { e } of sortiert) {
    const z = zeile(e);
    if (!z.ort || gesehen.has(z.text)) continue;
    gesehen.add(z.text);
    aus.push(z);
    if (aus.length >= grenze) break;
  }
  // Nichts gefunden, aber eine Hausnummer im Text (die es dort nicht gibt): ohne sie weitersuchen.
  if (!aus.length) {
    const ohne = woerter.filter((w) => !/^\d{1,4}[a-z]?$/.test(w));
    if (ohne.length && ohne.length < woerter.length) return suchen(ohne.join(' '), { tippen, land, grenze });
  }
  return aus;
}

/** Nächste Adressen und Straßen um einen Punkt („Aktuelle Position“). */
export function umgebung(lat, lon, grenze = 8) {
  const db = datenbank();
  if (!db) return [];
  const d = 0.004;
  const k = Math.cos((lat * Math.PI) / 180);
  return db
    .prepare('select * from eintrag where lat between ? and ? and lon between ? and ? and art < 2')
    .all(lat - d, lat + d, lon - d / k, lon + d / k)
    .map((e) => ({ e, m: Math.hypot(e.lat - lat, (e.lon - lon) * k) }))
    .sort((a, b) => a.m - b.m || a.e.art - b.e.art)
    .map(({ e }) => zeile(e))
    .filter((z, i, alle) => z.ort && alle.findIndex((x) => x.text === z.text) === i)
    .slice(0, grenze);
}

/**
 * Koordinate einer Anschrift (Tour-Stopp): erst mit Hausnummer, dann nur Straße, dann nur Ort.
 * Gibt null, wenn nichts passt oder keine Datei da ist.
 */
export function ortVon({ strasse = '', plz = '', ort = '', land } = {}) {
  const ohneNr = strasse.replace(/\s+\d+\s*[a-zA-Z]?(\s*[-–]\s*\d+\s*[a-zA-Z]?)?\s*$/, '');
  const versuche = [`${strasse} ${plz} ${ort}`, `${strasse} ${ort}`, `${ohneNr} ${plz} ${ort}`, `${ohneNr} ${ort}`, `${plz} ${ort}`, ort];
  for (const v of versuche) {
    if (!v.trim()) continue;
    const t = suchen(v, { tippen: false, land, grenze: 1 })[0];
    if (t) return { lat: t.lat, lon: t.lon, genau: t.art === 0 ? 'adresse' : t.art === 1 ? 'strasse' : 'ort' };
  }
  return null;
}

/** Stand der Datei (für /adresse/info und den Serverstart). */
export function adressenStand() {
  const db = datenbank();
  if (!db) return null;
  const m = Object.fromEntries(db.prepare('select schluessel, wert from meta').all().map((z) => [z.schluessel, z.wert]));
  return { stand: m.stand ?? null, laender: (m.laender ?? '').split(',').filter(Boolean) };
}

/** Woher `node verwalten.mjs adressen` die Datei holt. */
export const ADRESSEN_QUELLE = process.env.MONTIX_ADRESSEN_QUELLE ?? 'https://montix.feif.space/adressen/adressen.sqlite';

export function adressenHolen(optionen = {}) {
  return dateiHolen({ quelle: ADRESSEN_QUELLE, ziel: adressDatei(), was: 'Adressdatei', ...optionen });
}

/** GET /adressen/adressen.sqlite — die Datei für eigene Server (OpenStreetMap-Daten, öffentlich). */
export function adressenWeg(req, res, pfad) {
  if (pfad !== '/adressen/adressen.sqlite' || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  if (!adressenDa()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Keine Adressdatei auf diesem Server');
    return true;
  }
  dateiSenden(req, res, adressDatei(), 'application/vnd.sqlite3', 'public, max-age=86400');
  return true;
}
