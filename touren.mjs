// Touren für Speditionen (Modul „Touren“, docs/ideen.md „Touren für Speditionen“).
//
// Touren und Ereignisse kommen über den normalen Abgleich (Sammlungen `touren` und
// `tourereignisse`); dieser Teil ergänzt, was der Abgleich nicht kann:
//
//   POST /touren/ort         {tour, ort}            → letzte Position der Tour (Verlauf je Minute)
//   GET  /touren/lage                               → laufende und heutige Touren mit Status, Position, ETA
//   GET  /touren/verlauf?tour=<id>                  → gefahrene Strecke (Disposition)
//   POST /touren/link        {tour, stopp}          → Link für den Empfänger (/sendung/<schluessel>)
//   POST /touren/benachrichtigen {tour, stopp, email, name?} → Link per E-Mail an den Empfänger
//   GET  /sendung/<schluessel>                      → öffentliche Seite für den Empfänger (ohne Konto)
//   POST /touren/kartenlink                         → Einmal-Link zur Karte aller Fahrzeuge (Disposition, 12 h)
//   GET  /lagekarte/<schluessel>[/lage]              → schlanke Kartenseite dazu (App öffnet sie als Fenster)
//
// Positionen kommen heute vom Handy des Fahrers (bei offener App, ab Fassung 9 auch im
// Hintergrund während der Tour); später zusätzlich aus einer Telematik (Adapter je Anbieter).
// Ankunftszeit: Luftlinie × 1,3 bei Lkw-Durchschnitt, mit MONTIX_ORS_KEY über openrouteservice
// (Profil driving-hgv) für den nächsten Abschnitt.

import { createHash, randomBytes } from 'node:crypto';

import { hatRecht } from './kasse.mjs';
import { kachelLayerJs, kachelnDa } from './karte.mjs';

export const RECHT_DISPO = 'recht:dispo';
export const darfDispo = (m) => m.rolle === 'verwalter' || hatRecht(m, RECHT_DISPO);

/** Lkw im Schnitt (Autobahn und Landstraße gemischt), km/h. */
const LKW_KMH = 60;
const UMWEG = 1.3;
const STANDZEIT_MIN = 20;
/** Verlauf: höchstens eine Position je Minute und Tour. */
const VERLAUF_ABSTAND_MS = 60_000;
/** Empfänger-Link: so lange nach der Zustellung noch erreichbar (Zustellnachweis). */
const NACHWEIS_TAGE = 30;
/** Positionen (Verlauf und letzte) werden nach dieser Frist gelöscht; steht so in der Datenschutzerklärung. */
export const ORTE_TAGE = 30;
/** Empfänger-Links: nach dieser Frist ab Erstellung gelöscht (der Nachweis gilt ohnehin nur 30 Tage nach Zustellung). */
export const LINK_TAGE = 90;
/** Kartenlink der Disposition (App → Fenster über der App): so lange gültig. */
const KARTENLINK_STUNDEN = 12;
/** Karte für den Empfänger erst, wenn der Lkw zu ihm unterwegs ist und höchstens so weit weg. */
const KARTE_AB_M = 25_000;

export class TourFehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

function tabellen(db) {
  db.exec(`
    create table if not exists tour_orte (tour text not null, mitarbeiter text, zeit text not null, lat real not null, lon real not null, genau real);
    create index if not exists tour_orte_tour on tour_orte (tour, zeit);
    create table if not exists tour_letzte (tour text primary key, mitarbeiter text, zeit text not null, lat real not null, lon real not null, genau real, quelle text);
    create table if not exists tour_links (pruef text primary key, tour text not null, stopp text not null, erstellt text not null, gesendet text);
    create table if not exists geocode (adresse text primary key, lat real, lon real, zeit text not null);
    create table if not exists tour_karten (pruef text primary key, mitarbeiter text not null, erstellt text not null, bis text not null);
  `);
}

/** Alte Positionen und Links löschen — bei jedem Zugriff, ohne eigenen Aufräumlauf (wie bei Nachrichten). */
function aufraeumen(db) {
  const vor = (tage) => new Date(Date.now() - tage * 86400_000).toISOString();
  db.prepare('delete from tour_orte where zeit < ?').run(vor(ORTE_TAGE));
  db.prepare('delete from tour_letzte where zeit < ?').run(vor(ORTE_TAGE));
  db.prepare('delete from tour_links where erstellt < ?').run(vor(LINK_TAGE));
  db.prepare('delete from tour_karten where bis < ?').run(new Date().toISOString());
}

const pruefsumme = (s) => createHash('sha256').update(s).digest('base64url');
const ortOk = (o) => o && Number.isFinite(o.lat) && Number.isFinite(o.lon) && Math.abs(o.lat) <= 90 && Math.abs(o.lon) <= 180 && !(o.lat === 0 && o.lon === 0);

export function abstandM(a, b) {
  const rad = (g) => (g * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------------------------
// Daten aus dem Abgleich lesen

function tourLesen(db, id) {
  const z = db.prepare("select inhalt from daten where sammlung = 'touren' and id = ? and geloescht = 0").get(id);
  return z ? JSON.parse(z.inhalt) : null;
}

function ereignisseLesen(db, tourId) {
  return db
    .prepare("select inhalt from daten where sammlung = 'tourereignisse' and geloescht = 0 and json_extract(inhalt, '$.tourId') = ?")
    .all(tourId)
    .map((z) => JSON.parse(z.inhalt))
    .sort((a, b) => String(a.zeit).localeCompare(String(b.zeit)));
}

function tourenVon(db, datum) {
  return db
    .prepare("select inhalt from daten where sammlung = 'touren' and geloescht = 0 and (json_extract(inhalt, '$.datum') = ? or json_extract(inhalt, '$.status') = 'laeuft')")
    .all(datum)
    .map((z) => JSON.parse(z.inhalt));
}

// ---------------------------------------------------------------------------------------------
// Status aus den Ereignissen (gleiche Regeln wie src/features/touren/status.ts)

/**
 * Stand einer Tour: je Stopp offen → angekommen → in Arbeit → erledigt (Quittung oder Abweichung
 * und Abfahrt), dazu Tourstatus, Pause und Störung. Ereignisse sind die Wahrheit.
 */
export function stand(tour, ereignisse) {
  const stopps = new Map((tour.stopps ?? []).map((s) => [s.id, { zustand: 'offen', ankunft: null, abfahrt: null, quittung: null, abweichung: null, gescannt: 0 }]));
  let laeuft = false;
  let fertig = false;
  let pause = false;
  let stoerung = null;
  let beginn = null;
  for (const e of ereignisse) {
    const s = e.stoppId ? stopps.get(e.stoppId) : null;
    switch (e.art) {
      case 'tour_start':
        laeuft = true;
        beginn ??= e.zeit;
        break;
      case 'tour_ende':
        fertig = true;
        laeuft = false;
        break;
      case 'pause_start':
        pause = true;
        break;
      case 'pause_ende':
        pause = false;
        break;
      case 'stoerung':
        stoerung = e.grund || e.bemerkung || 'Störung';
        break;
      case 'stoerung_ende':
        stoerung = null;
        break;
      case 'angekommen':
        if (s) Object.assign(s, { zustand: 'angekommen', ankunft: e.zeit });
        break;
      case 'arbeit_start':
        if (s) s.zustand = 'in_arbeit';
        break;
      case 'arbeit_ende':
        if (s && s.zustand !== 'erledigt') s.zustand = 'in_arbeit';
        break;
      case 'gescannt':
        if (s) s.gescannt += Array.isArray(e.codes) ? e.codes.length : 1;
        break;
      case 'quittung':
        if (s) Object.assign(s, { zustand: 'erledigt', quittung: { name: e.name ?? '', unterschrift: e.unterschrift ?? null, zeit: e.zeit } });
        break;
      case 'abweichung':
        if (s) Object.assign(s, { zustand: 'erledigt', abweichung: e.grund || e.bemerkung || 'Abweichung' });
        break;
      case 'abfahrt':
        if (s) Object.assign(s, { abfahrt: e.zeit, zustand: 'erledigt' });
        break;
      default:
        break;
    }
  }
  const reihe = (tour.stopps ?? []).map((st) => ({ ...st, ...stopps.get(st.id) }));
  const naechster = reihe.find((s) => s.zustand !== 'erledigt') ?? null;
  const status = fertig || tour.status === 'fertig' ? 'fertig' : laeuft || tour.status === 'laeuft' ? (stoerung ? 'stoerung' : pause ? 'pause' : reihe.some((s) => s.ankunft && !s.abfahrt) ? 'beim_kunden' : 'faehrt') : 'geplant';
  return { status, beginn, pause, stoerung, stopps: reihe, naechster, erledigt: reihe.filter((s) => s.zustand === 'erledigt').length };
}

// ---------------------------------------------------------------------------------------------
// Orte der Stopps (Koordinaten aus der App, sonst über Photon) und Ankunftszeit

function adressText(s) {
  const a = s.adresse ?? {};
  return typeof a === 'string' ? a : [a.line1, [a.postalCode ?? a.plz, a.city ?? a.ort].filter(Boolean).join(' '), a.countryCode && a.countryCode !== 'DE' ? a.countryCode : ''].filter(Boolean).join(', ');
}

export function erstelleOrtung({ holen = fetch, photon = process.env.MONTIX_PHOTON ?? 'https://photon.komoot.io', orsSchluessel = process.env.MONTIX_ORS_KEY } = {}) {
  async function geocode(db, text) {
    if (!text || text.length < 4) return null;
    tabellen(db);
    const z = db.prepare('select lat, lon from geocode where adresse = ?').get(text);
    if (z) return z.lat == null ? null : { lat: z.lat, lon: z.lon };
    let ort = null;
    try {
      const r = await holen(`${photon}/api/?q=${encodeURIComponent(text)}&limit=1&lang=de`);
      const j = r.ok ? await r.json() : null;
      const c = j?.features?.[0]?.geometry?.coordinates;
      if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) ort = { lat: c[1], lon: c[0] };
    } catch {
      return null; // ohne Netz: beim nächsten Mal noch einmal versuchen
    }
    db.prepare('insert or replace into geocode values (?, ?, ?, ?)').run(text, ort?.lat ?? null, ort?.lon ?? null, new Date().toISOString());
    return ort;
  }

  async function stoppOrt(db, s) {
    if (ortOk(s.ort)) return s.ort;
    return geocode(db, adressText(s));
  }

  /** Fahrzeit in Sekunden: openrouteservice (Lkw), sonst Luftlinie × Umweg bei Lkw-Schnitt. */
  const routenCache = new Map();
  async function fahrzeit(von, nach) {
    const schaetzung = (abstandM(von, nach) * UMWEG) / ((LKW_KMH * 1000) / 3600);
    if (!orsSchluessel) return schaetzung;
    const k = [von.lat, von.lon, nach.lat, nach.lon].map((x) => x.toFixed(3)).join(',');
    const c = routenCache.get(k);
    if (c && Date.now() - c.zeit < 5 * 60_000) return c.sek;
    try {
      const r = await holen('https://api.openrouteservice.org/v2/directions/driving-hgv', {
        method: 'POST',
        headers: { authorization: orsSchluessel, 'content-type': 'application/json' },
        body: JSON.stringify({ coordinates: [[von.lon, von.lat], [nach.lon, nach.lat]] }),
      });
      const sek = r.ok ? (await r.json())?.routes?.[0]?.summary?.duration : null;
      if (!Number.isFinite(sek)) return schaetzung;
      routenCache.set(k, { sek, zeit: Date.now() });
      if (routenCache.size > 5000) routenCache.clear();
      return sek;
    } catch {
      return schaetzung;
    }
  }

  /**
   * Voraussichtliche Ankunft je offenem Stopp: ab der letzten Position (sonst ab dem zuletzt
   * erledigten Stopp) Abschnitt für Abschnitt, plus Standzeit an jedem Stopp davor.
   */
  async function ankunftszeiten(db, tour, st, letzte) {
    const standzeit = (Number(tour.standzeitMin) > 0 ? Number(tour.standzeitMin) : STANDZEIT_MIN) * 60_000;
    const ergebnis = {};
    if (st.status === 'geplant' || st.status === 'fertig') return ergebnis;
    let ort = letzte && Date.now() - Date.parse(letzte.zeit) < 2 * 3600_000 ? { lat: letzte.lat, lon: letzte.lon } : null;
    if (!ort) {
      const zuletzt = [...st.stopps].reverse().find((s) => s.zustand === 'erledigt');
      ort = zuletzt ? await stoppOrt(db, zuletzt) : null;
    }
    let uhr = Date.now();
    for (const s of st.stopps) {
      if (s.zustand === 'erledigt') continue;
      const ziel = await stoppOrt(db, s);
      if (s.zustand === 'angekommen' || s.zustand === 'in_arbeit') {
        ergebnis[s.id] = s.ankunft;
        uhr = Math.max(uhr, Date.parse(s.ankunft ?? new Date().toISOString()) + standzeit);
        ort = ziel ?? ort;
        continue;
      }
      if (!ort || !ziel) break;
      uhr += (await fahrzeit(ort, ziel)) * 1000;
      ergebnis[s.id] = new Date(uhr).toISOString();
      uhr += standzeit;
      ort = ziel;
    }
    return ergebnis;
  }

  return { geocode, stoppOrt, fahrzeit, ankunftszeiten };
}

// ---------------------------------------------------------------------------------------------
// Wege mit Anmeldung

const heute = () => new Date().toISOString().slice(0, 10);

function letztePosition(db, tourId) {
  return db.prepare('select * from tour_letzte where tour = ?').get(tourId) ?? null;
}

async function lageEintrag(db, ortung, tour) {
  const st = stand(tour, ereignisseLesen(db, tour.id));
  const letzte = letztePosition(db, tour.id);
  const eta = await ankunftszeiten(db, ortung, tour, st, letzte);
  const stopps = await Promise.all(
    st.stopps.map(async (s) => {
      const ort = await ortung.stoppOrt(db, s);
      const ankunft = eta[s.id] ?? null;
      const bis = s.fenster?.bis ? Date.parse(`${tour.datum}T${s.fenster.bis}:00`) : null;
      return {
        id: s.id,
        name: s.name,
        art: s.art,
        zustand: s.zustand,
        fenster: s.fenster ?? null,
        ankunft,
        abfahrt: s.abfahrt,
        verspaetet: !!(ankunft && bis && s.zustand !== 'erledigt' && Date.parse(ankunft) > bis),
        ort,
        standMin: s.ankunft && s.abfahrt ? Math.round((Date.parse(s.abfahrt) - Date.parse(s.ankunft)) / 60000) : null,
      };
    }),
  );
  return {
    id: tour.id,
    name: tour.name,
    datum: tour.datum,
    fahrer: tour.fahrerName ?? '',
    fahrerId: tour.fahrerId ?? null,
    fahrzeug: tour.kennzeichen ?? '',
    verkehrsmittel: tour.verkehrsmittel ?? 'lkw',
    status: st.status,
    stoerung: st.stoerung,
    erledigt: st.erledigt,
    gesamt: st.stopps.length,
    naechster: st.naechster?.id ?? null,
    position: letzte ? { lat: letzte.lat, lon: letzte.lon, zeit: letzte.zeit, quelle: letzte.quelle ?? 'handy' } : null,
    verspaetet: stopps.some((s) => s.verspaetet),
    stopps,
  };
}

async function ankunftszeiten(db, ortung, tour, st, letzte) {
  return ortung.ankunftszeiten(db, tour, st, letzte);
}

export async function tourenWeg(methode, pfad, url, wer, koerper, basis, senden, ortung, mail) {
  if (!pfad.startsWith('/touren')) return undefined;
  const db = wer.db;
  tabellen(db);
  aufraeumen(db);
  const ich = { ...wer.mitarbeiter, bereiche: wer.roh?.bereiche ?? null };
  const dispo = darfDispo(ich);
  // Eigene Tour: Disposition alle; Fahrer und Fremdfahrer ihre; Partnerbetriebe die ihnen übergebenen.
  const eigene = (tour) => tour && (dispo || tour.fahrerId === ich.id || tour.partnerId === ich.id);

  if (methode === 'POST' && pfad === '/touren/ort') {
    const k = (await koerper()) ?? {};
    const tour = tourLesen(db, String(k.tour ?? ''));
    if (!tour) throw new TourFehler(404, 'Unbekannte Tour');
    if (!eigene(tour)) throw new TourFehler(403, 'Nicht Ihre Tour');
    const orte = (Array.isArray(k.orte) ? k.orte : [k.ort]).filter(ortOk).slice(-500);
    if (!orte.length) throw new TourFehler(400, 'ort fehlt');
    const vorher = db.prepare('select max(zeit) as z from tour_orte where tour = ?').get(tour.id)?.z;
    let letzteZeit = vorher ? Date.parse(vorher) : 0;
    for (const o of orte) {
      const zeit = o.zeit && Number.isFinite(Date.parse(o.zeit)) ? new Date(Math.min(Date.parse(o.zeit), Date.now())).toISOString() : new Date().toISOString();
      if (Date.parse(zeit) - letzteZeit >= VERLAUF_ABSTAND_MS) {
        db.prepare('insert into tour_orte values (?, ?, ?, ?, ?, ?)').run(tour.id, ich.id, zeit, o.lat, o.lon, Number.isFinite(o.genau) ? o.genau : null);
        letzteZeit = Date.parse(zeit);
      }
      const alt = letztePosition(db, tour.id);
      if (!alt || alt.zeit <= zeit) {
        db.prepare('insert or replace into tour_letzte values (?, ?, ?, ?, ?, ?, ?)').run(tour.id, ich.id, zeit, o.lat, o.lon, Number.isFinite(o.genau) ? o.genau : null, String(o.quelle ?? 'handy').slice(0, 20));
      }
    }
    return { ok: true };
  }

  if (methode === 'GET' && pfad === '/touren/lage') {
    const datum = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('datum') ?? '') ? url.searchParams.get('datum') : heute();
    const touren = tourenVon(db, datum).filter(eigene);
    return { datum, touren: await Promise.all(touren.map((t) => lageEintrag(db, ortung, t))) };
  }

  if (methode === 'POST' && pfad === '/touren/kartenlink') {
    if (!dispo) throw new TourFehler(403, 'Nur für die Disposition');
    const schluessel = `k${randomBytes(18).toString('base64url')}`;
    const jetzt = new Date();
    db.prepare('insert into tour_karten values (?, ?, ?, ?)').run(pruefsumme(schluessel), ich.id, jetzt.toISOString(), new Date(jetzt.getTime() + KARTENLINK_STUNDEN * 3600_000).toISOString());
    return { link: `${basis}/lagekarte/${schluessel}`, stunden: KARTENLINK_STUNDEN };
  }

  if (methode === 'GET' && pfad === '/touren/verlauf') {
    const tour = tourLesen(db, url.searchParams.get('tour') ?? '');
    if (!eigene(tour)) throw new TourFehler(404, 'Unbekannte Tour');
    return { orte: db.prepare('select zeit, lat, lon from tour_orte where tour = ? order by zeit').all(tour.id) };
  }

  if (methode === 'POST' && (pfad === '/touren/link' || pfad === '/touren/benachrichtigen')) {
    const k = (await koerper()) ?? {};
    const tour = tourLesen(db, String(k.tour ?? ''));
    if (!eigene(tour)) throw new TourFehler(404, 'Unbekannte Tour');
    const stopp = (tour.stopps ?? []).find((s) => s.id === k.stopp);
    if (!stopp) throw new TourFehler(404, 'Unbekannter Stopp');
    // Ein Link je Stopp; ein neuer Aufruf erzeugt einen neuen (der alte gilt weiter, bis die Tour gelöscht ist).
    const schluessel = `s${randomBytes(16).toString('base64url')}`;
    db.prepare('insert into tour_links values (?, ?, ?, ?, null)').run(pruefsumme(schluessel), tour.id, stopp.id, new Date().toISOString());
    const link = `${basis}/sendung/${schluessel}`;
    if (pfad === '/touren/link') return { link };
    const email = String(k.email ?? stopp.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TourFehler(400, 'Keine gültige E-Mail-Adresse');
    senden([{ name: String(k.name ?? stopp.name ?? ''), email }], mail({ empfaenger: stopp.name, sendung: stopp.sendung, datum: tour.datum, fenster: stopp.fenster, link }, wer.betrieb));
    db.prepare('update tour_links set gesendet = ? where pruef = ?').run(new Date().toISOString(), pruefsumme(schluessel));
    return { link, gesendet: true };
  }

  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Öffentliche Seite für den Empfänger

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uhrzeit = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
const datumText = (iso) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });

/** Zeitfenster um die erwartete Ankunft: auf 5 Minuten gerundet, ±15 Minuten. */
function fensterText(iso) {
  const t = Date.parse(iso);
  const r = (x) => new Date(Math.round(x / 300_000) * 300_000).toISOString();
  return `zwischen ${uhrzeit(r(t - 15 * 60_000))} und ${uhrzeit(r(t + 15 * 60_000))} Uhr`;
}

const MITTEL = { lkw: 'Lkw', bahn: 'Bahn', schiff: 'Schiff' };

export async function sendungSeite(speicher, ortung, schluessel) {
  if (!/^s[A-Za-z0-9_-]{20,24}$/.test(schluessel)) return null;
  const pruef = pruefsumme(schluessel);
  for (const b of speicher.alleBetriebe()) {
    tabellen(b.db);
    const l = b.db.prepare('select * from tour_links where pruef = ?').get(pruef);
    if (!l) continue;
    const tour = tourLesen(b.db, l.tour);
    if (!tour) return null;
    const st = stand(tour, ereignisseLesen(b.db, tour.id));
    const s = st.stopps.find((x) => x.id === l.stopp);
    if (!s) return null;
    if (s.zustand === 'erledigt' && s.abfahrt && Date.now() - Date.parse(s.abfahrt) > NACHWEIS_TAGE * 86400_000) return null;
    const letzte = b.db.prepare('select * from tour_letzte where tour = ?').get(tour.id);
    const eta = await ortung.ankunftszeiten(b.db, tour, st, letzte);
    const index = st.stopps.findIndex((x) => x.id === s.id);
    const davor = st.stopps.slice(0, index).filter((x) => x.zustand !== 'erledigt').length;
    const ziel = await ortung.stoppOrt(b.db, s);
    const frisch = letzte && Date.now() - Date.parse(letzte.zeit) < 15 * 60_000;
    const karte = st.status === 'faehrt' && davor === 0 && s.zustand === 'offen' && frisch && ziel && abstandM(letzte, ziel) < KARTE_AB_M && !st.pause;

    let kopf;
    if (s.zustand === 'erledigt') kopf = s.abweichung ? `<h1>Zustellung nicht wie geplant</h1><p class="gross klein">${esc(s.abweichung)}</p>` : '<h1>Zugestellt</h1>';
    else if (s.zustand === 'angekommen' || s.zustand === 'in_arbeit') kopf = '<h1>Das Fahrzeug ist bei Ihnen angekommen.</h1>';
    else if (st.status === 'geplant') kopf = `<h1>Ihre Lieferung ist für den ${esc(datumText(`${tour.datum}T12:00:00Z`))} geplant.</h1>${s.fenster?.von ? `<p class="gross">${esc(s.fenster.von)}–${esc(s.fenster.bis ?? '')} Uhr</p>` : ''}`;
    else if (st.pause) kopf = `<h1>Unterwegs zu Ihnen</h1><p>Der Fahrer macht gerade eine Pause.</p>${eta[s.id] ? `<p class="gross">${esc(fensterText(eta[s.id]))}</p>` : ''}`;
    else kopf = `<h1>${davor === 0 ? 'Ihre Lieferung ist als Nächstes dran.' : davor === 1 ? 'Noch 1 Stopp vor Ihnen.' : `Noch ${davor} Stopps vor Ihnen.`}</h1>${eta[s.id] ? `<p class="gross">${esc(fensterText(eta[s.id]))}</p><p>Voraussichtlich – Verkehr und Wartezeiten können es verschieben.</p>` : ''}`;
    if (st.stoerung && s.zustand !== 'erledigt') kopf += `<p class="warn">Verzögerung: ${esc(st.stoerung)}</p>`;

    // Sendung über mehrere Abschnitte (Lkw, Bahn, Schiff): alle Stopps mit derselben Sendungsnummer.
    let abschnitte = '';
    if (s.sendung) {
      const alle = b.db
        .prepare("select inhalt from daten where sammlung = 'touren' and geloescht = 0 and inhalt like ?")
        .all(`%${String(s.sendung).replace(/[%_]/g, '')}%`)
        .map((z) => JSON.parse(z.inhalt));
      const zeilen = [];
      for (const t of alle) {
        const tst = stand(t, ereignisseLesen(b.db, t.id));
        for (const x of tst.stopps.filter((y) => y.sendung === s.sendung)) zeilen.push({ t, x, zeit: x.ankunft ?? x.abfahrt ?? `${t.datum}T00:00:00Z` });
      }
      if (zeilen.length > 1) {
        zeilen.sort((a, c) => a.zeit.localeCompare(c.zeit));
        abschnitte = `<h2>Sendung ${esc(s.sendung)}</h2><ol class="weg">${zeilen
          .map(({ t, x }) => `<li class="${x.zustand === 'erledigt' ? 'ok' : ''}"><b>${esc(MITTEL[t.verkehrsmittel] ?? 'Lkw')}</b> · ${esc(x.name)}${x.ankunft ? ` · ${esc(datumText(x.ankunft))} ${esc(uhrzeit(x.ankunft))}` : ''}${x.zustand === 'erledigt' ? ' ✓' : ''}</li>`)
          .join('')}</ol>`;
      }
    }

    const nachweis =
      s.quittung && !s.abweichung
        ? `<h2>Zustellnachweis</h2><p>${esc(datumText(s.quittung.zeit))}, ${esc(uhrzeit(s.quittung.zeit))} Uhr${s.quittung.name ? ` · angenommen von ${esc(s.quittung.name)}` : ''}</p>${
            typeof s.quittung.unterschrift === 'string' && /^data:image\/(png|svg\+xml);base64,/.test(s.quittung.unterschrift) ? `<img class="unterschrift" alt="Unterschrift" src="${esc(s.quittung.unterschrift)}">` : ''
          }`
        : '';

    const kartenTeil = karte
      ? `<div id="karte"></div><link rel="stylesheet" href="../karte/leaflet.css"><script src="../karte/leaflet.js"></script>${kachelnDa() ? '<script src="../karte/protomaps-leaflet.js"></script>' : ''}
<script>(function(){var m=L.map('karte',{zoomControl:false,attributionControl:true});${kachelLayerJs('..')}var a=[${letzte.lat},${letzte.lon}],z=[${ziel.lat},${ziel.lon}];L.circleMarker(a,{radius:9,color:'#1d4ed8',fillOpacity:1}).addTo(m).bindTooltip('Fahrzeug');L.circleMarker(z,{radius:9,color:'#16a34a',fillOpacity:1}).addTo(m).bindTooltip('Sie');m.fitBounds([a,z],{padding:[30,30]});})();</script>`
      : '';

    const offen = s.zustand !== 'erledigt';
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${offen ? '<meta http-equiv="refresh" content="60">' : ''}<title>${esc(b.name)} – Ihre Lieferung</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:20px;background:#f4f6f8;color:#111827}main{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:22px;box-shadow:0 1px 4px #0001}h1{font-size:22px;margin:8px 0}h2{font-size:16px;margin:20px 0 6px}.gross{font-size:26px;font-weight:800;margin:6px 0}.klein{font-size:18px}p{color:#374151;margin:6px 0}small{color:#6b7280}.warn{color:#b45309;font-weight:600}#karte{height:260px;border-radius:10px;margin:14px 0}.weg{padding-left:20px;color:#374151}.weg li{margin:4px 0}.weg li.ok{color:#15803d}.unterschrift{max-width:100%;height:90px;object-fit:contain;border:1px solid #e5e7eb;border-radius:8px;background:#fff}</style></head>
<body><main><small>${esc(b.name)}${s.sendung ? ` · Sendung ${esc(s.sendung)}` : ''}${s.name ? ` · ${esc(s.name)}` : ''}</small>${kopf}${kartenTeil}${abschnitte}${nachweis}
<p><small>${offen ? 'Die Seite aktualisiert sich jede Minute. Die Karte erscheint erst, wenn das Fahrzeug zu Ihnen unterwegs ist.' : `Diese Seite bleibt ${NACHWEIS_TAGE} Tage nach der Zustellung erreichbar.`}</small></p></main></body></html>`;
  }
  return null;
}

/**
 * Fremdfahrer (Subunternehmer, Rolle 'fremdfahrer'): bekommen beim Abgleich nur ihre eigenen
 * Touren, deren Ereignisse und die Firmendaten fürs Aussehen — nichts sonst vom Betrieb.
 */
export function fuerFremdfahrer(ergebnis, mitarbeiterId, db) {
  // Fremdfahrer: Touren mit fahrerId; Partnerbetriebe (Rolle 'partner'): Touren mit partnerId.
  const meine = new Set(
    db
      .prepare("select id from daten where sammlung = 'touren' and geloescht = 0 and (json_extract(inhalt, '$.fahrerId') = ? or json_extract(inhalt, '$.partnerId') = ?)")
      .all(mitarbeiterId, mitarbeiterId)
      .map((z) => z.id),
  );
  return {
    ...ergebnis,
    aenderungen: ergebnis.aenderungen.filter(
      (a) =>
        (a.sammlung === 'touren' && (a.geloescht || meine.has(a.id))) ||
        // Nachrichten und Dateien bleiben über ihre eigenen Wege; hier nur Touren, Meldungen, Firmenaussehen.
        (a.sammlung === 'tourereignisse' && (a.geloescht || meine.has(a.inhalt?.tourId) || a.inhalt?.von === mitarbeiterId)) ||
        (a.sammlung === 'roh' && ['firma', 'logo', 'farben'].includes(a.id)),
    ),
  };
}

/**
 * Karte aller Fahrzeuge für die Disposition, ohne Anmeldung über einen Einmal-Link (12 h). Die App
 * öffnet sie als Fenster über der App (Custom Tab), statt die ganze Browser-Fassung zu laden.
 * Gilt nur, solange die Person, die den Link geholt hat, aktiv ist und Disposition darf.
 * Antwort: { html } für die Seite, { json } für die Lage, null wenn unbekannt oder abgelaufen.
 */
export async function lagekarteSeite(speicher, ortung, schluessel, nurLage) {
  if (!/^k[A-Za-z0-9_-]{20,30}$/.test(schluessel)) return null;
  const pruef = pruefsumme(schluessel);
  for (const b of speicher.alleBetriebe()) {
    tabellen(b.db);
    const k = b.db.prepare('select * from tour_karten where pruef = ?').get(pruef);
    if (!k) continue;
    if (k.bis < new Date().toISOString()) return null;
    const m = b.db.prepare('select id, rolle, aktiv, bereiche from mitarbeiter where id = ?').get(k.mitarbeiter);
    if (!m || !m.aktiv || !darfDispo({ rolle: m.rolle, bereiche: m.bereiche ? JSON.parse(m.bereiche) : null })) return null;
    if (nurLage) {
      const touren = await Promise.all(tourenVon(b.db, heute()).map((t) => lageEintrag(b.db, ortung, t)));
      return {
        json: {
          stand: new Date().toISOString(),
          touren: touren.map((x) => {
            const n = x.stopps.find((y) => y.id === x.naechster);
            return { name: x.name, fahrer: x.fahrer, fahrzeug: x.fahrzeug, status: x.status, verspaetet: x.verspaetet, stoerung: x.stoerung ?? null, erledigt: x.erledigt, gesamt: x.gesamt, position: x.position, naechster: n ? { name: n.name, ankunft: n.ankunft } : null };
          }),
        },
      };
    }
    const kacheln = kachelnDa();
    return {
      html: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(b.name)} – Lage</title>
<link rel="stylesheet" href="../karte/leaflet.css"><script src="../karte/leaflet.js"></script>${kacheln ? '<script src="../karte/protomaps-leaflet.js"></script>' : ''}
<style>html,body{margin:0;height:100%;font-family:system-ui,sans-serif}#karte{position:absolute;inset:0 0 0 0}#kopf{position:absolute;z-index:1000;top:8px;left:8px;right:8px;display:flex;gap:8px;align-items:center;background:#fffffff0;border-radius:10px;padding:8px 12px;box-shadow:0 1px 4px #0003;font-size:14px}#kopf b{flex:1}.leer{position:absolute;z-index:1000;bottom:16px;left:16px;right:16px;background:#fff;border-radius:10px;padding:10px 12px;box-shadow:0 1px 4px #0003;font-size:14px}.leaflet-tooltip{font-size:13px}</style></head>
<body><div id="karte"></div><div id="kopf"><b>${esc(b.name)}</b><span id="stand">…</span></div><div id="leer" class="leer" hidden>Noch keine Position gemeldet – sie kommt, sobald ein Fahrer die Tour beginnt.</div>
<script>(function(){
var m=L.map('karte',{zoomControl:false}).setView([51.1,10.4],6);L.control.zoom({position:'bottomright'}).addTo(m);
${kachelLayerJs('..')}
var g=L.layerGroup().addTo(m),erst=true;
var F={geplant:'#8A929C',faehrt:'#208AEF',beim_kunden:'#7B4FD6',pause:'#E0A100',stoerung:'#C0392B',fertig:'#2E7D32'};
var T={geplant:'Geplant',faehrt:'Unterwegs',beim_kunden:'Beim Kunden',pause:'Pause',stoerung:'Störung',fertig:'Fertig'};
function e(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function uhr(i){return new Date(i).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}
function laden(){fetch(location.pathname.replace(/[/]$/,'')+'/lage',{cache:'no-store'}).then(function(r){if(!r.ok)throw r.status;return r.json()}).then(function(d){
g.clearLayers();var p=[];
d.touren.forEach(function(x){if(!x.position)return;var q=[x.position.lat,x.position.lon];p.push(q);
var z=['<b>'+e(x.fahrer||x.name)+'</b>'+(x.fahrzeug?' · '+e(x.fahrzeug):''),e(T[x.status]||x.status)+(x.verspaetet?' · verspätet':'')+' · '+x.erledigt+'/'+x.gesamt+' Stopps'];
if(x.stoerung)z.push('Störung: '+e(x.stoerung));
if(x.naechster)z.push('Nächster: '+e(x.naechster.name)+(x.naechster.ankunft?' · ca. '+uhr(x.naechster.ankunft):''));
z.push('Position '+uhr(x.position.zeit));
L.circleMarker(q,{radius:10,weight:3,color:x.verspaetet?F.stoerung:'#fff',fillColor:F[x.status]||'#208AEF',fillOpacity:.95}).bindTooltip(z.join('<br>'),{direction:'top'}).addTo(g);});
document.getElementById('leer').hidden=p.length>0;
document.getElementById('stand').textContent='Stand '+uhr(d.stand);
if(erst&&p.length){erst=false;if(p.length===1)m.setView(p[0],12);else m.fitBounds(L.latLngBounds(p),{padding:[40,40],maxZoom:13});}
}).catch(function(s){document.getElementById('stand').textContent=s===404?'Link abgelaufen':'keine Verbindung';});}
laden();setInterval(laden,30000);
})();</script></body></html>`,
    };
  }
  return null;
}
