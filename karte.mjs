// Karten selbst ausliefern — ohne unpkg.com und ohne Kachelserver von OpenStreetMap.
//
//   GET /karte/leaflet.js, /karte/leaflet.css, /karte/protomaps-leaflet.js  → Bibliotheken (liegen im Repository)
//   GET /karte/karte.pmtiles   → Kartendaten (Protomaps, aus OpenStreetMap), mit Range-Anfragen
//   GET /karte/info            → { kacheln: true|false }  ob dieser Server Kartendaten hat
//
// Die Kartendatei ist mehrere GB groß und steht nicht im Repository. Sie liegt neben diesem
// Modul in `karte/karte.pmtiles` (oder unter MONTIX_KARTE) und entsteht mit dem Programm pmtiles:
//
//   pmtiles extract https://build.protomaps.com/<JJJJMMTT>.pmtiles karte.pmtiles --bbox=5.86,47.27,15.04,55.06 --maxzoom=15
//
// (Ausschnitt Deutschland; für Europa eine größere bbox.) Fehlt die Datei — etwa auf einem eigenen
// Server eines Betriebs —, meldet /karte/info `kacheln: false`, und die Seiten nehmen die Kacheln
// von OpenStreetMap (steht so in der Datenschutzerklärung).

import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORDNER = join(dirname(fileURLToPath(import.meta.url)), 'karte');
const BIBLIOTHEKEN = { 'leaflet.js': 'text/javascript; charset=utf-8', 'leaflet.css': 'text/css; charset=utf-8', 'protomaps-leaflet.js': 'text/javascript; charset=utf-8' };

export const kartenDatei = () => process.env.MONTIX_KARTE ?? join(ORDNER, 'karte.pmtiles');
export const kachelnDa = () => existsSync(kartenDatei());

function senden(req, res, datei, typ, cache) {
  const st = statSync(datei);
  const kopf = {
    'content-type': typ,
    'accept-ranges': 'bytes',
    'cache-control': cache,
    etag: `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`,
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-length, content-range, etag, accept-ranges',
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start;
    let ende;
    if (m[1] === '') {
      start = Math.max(0, st.size - Number(m[2]));
      ende = st.size - 1;
    } else {
      start = Number(m[1]);
      ende = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
    }
    if (start > ende || start >= st.size) {
      res.writeHead(416, { ...kopf, 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...kopf, 'content-range': `bytes ${start}-${ende}/${st.size}`, 'content-length': ende - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return void createReadStream(datei, { start, end: ende }).pipe(res);
  }
  res.writeHead(200, { ...kopf, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(datei).pipe(res);
}

/** true, wenn die Anfrage beantwortet ist. */
export function karteWeg(req, res, pfad) {
  if (!pfad.startsWith('/karte/') || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  const name = pfad.slice('/karte/'.length);
  if (name === 'info') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=300', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ kacheln: kachelnDa() }));
    return true;
  }
  if (BIBLIOTHEKEN[name]) {
    senden(req, res, join(ORDNER, name), BIBLIOTHEKEN[name], 'public, max-age=604800');
    return true;
  }
  if (name === 'karte.pmtiles') {
    if (!kachelnDa()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end('Keine Kartendaten auf diesem Server');
      return true;
    }
    senden(req, res, kartenDatei(), 'application/octet-stream', 'public, max-age=86400');
    return true;
  }
  return false;
}

/**
 * Script-Teil für eine Seite mit Leaflet-Karte `m` (schon erzeugt): eigene Kacheln, wenn der Server
 * sie hat, sonst OpenStreetMap. `basis` ist der Pfad zum Dienst aus Sicht der Seite (z. B. '..').
 */
export function kachelLayerJs(basis) {
  return kachelnDa()
    ? `protomapsL.leafletLayer({url:'${basis}/karte/karte.pmtiles',flavor:'light',lang:'de',attribution:'© OpenStreetMap · Protomaps'}).addTo(m);`
    : `L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:17,attribution:'© OpenStreetMap'}).addTo(m);`;
}
