// Barkasse mit TSE (KassenSichV, § 146a AO) — buchbares Modul `kasse`. Kern aus CHOOZY
// (server/kassenverkauf.js, server/kassenabschluss.js), Signatur über die Cloud-TSE fiskaly SIGN DE v2
// (tse/).
//
// JEDES GERÄT, DAS BARGELD ERFASST, IST EINE EIGENE KASSE. Die Pflicht hängt am Aufzeichnungssystem;
// bei einer App ist das das einzelne Gerät. Darum:
//   - Der Betrieb hat EINE TSS bei fiskaly (API-Key, Secret, TSS-ID; der Verwalter trägt sie ein,
//     das Secret liegt verschlüsselt in der Datei des Betriebs und verlässt den Server nie).
//   - Jede Kasse hat eine Kassen-ID (z. B. K1), einen Namen und ihren EIGENEN fiskaly-Client
//     (client_id). Ein Verwalter weist sie genau einem angemeldeten Gerät zu. Nur dieses Gerät sieht
//     und benutzt die Barkasse; ohne Kasse bleibt Bargeld eine Zahlung am Beleg wie bisher.
//   - Belegnummern (KB-<Kasse>-<Jahr>-0001) und Kassenabschlüsse (Z-Nummer) laufen JE KASSE;
//     jeder Beleg trägt die Kassen-ID (DSFinV-K kennt die Kasse).
//   - Auf dem zentralen Server bucht der Betrieb eine Anzahl Kassen (der Anbieter setzt sie, siehe
//     module.mjs); mehr Kassen zuweisen als gebucht → 403. Auf einem eigenen Server ohne Grenze.
//
//   GET  /kasse/status                 → { verfuegbar, grund?, gebucht, kasse: {id,name}|null, tse }   (immer)
//   Nur wenn für den Betrieb verfügbar (sonst 403 mit Grund):
//   Mit einer diesem Gerät zugewiesenen Kasse:
//   POST /kasse/beleg {id?, positionen[], zahlart, gegebenCent?, beginn?}  → Beleg mit Nummer und TSE-Daten
//   GET  /kasse/belege?von&bis&kasse   → Belege (JJJJ-MM-TT nach deutscher Zeit; Vorgabe 31 Tage)
//   GET  /kasse/abschluesse?kasse      → Abschlüsse
//   Verwalter:
//   POST /kasse/storno {nummer, grund?, id?}  → Gegenbuchung an der Kasse des Belegs (eigener KB-Beleg, negativ, signiert)
//   POST /kasse/abschluss {kasse?}     → Kassenabschluss (Z-Bon) einer Kasse (ohne Angabe: die dieses Geräts)
//   GET/POST /kasse/recht {wer}        → wer die Barkasse benutzen darf: 'alle' | 'ausgewaehlte' | 'niemand'
//   GET  /kasse/kassen                 → Kassen des Betriebs mit Gerät
//   POST /kasse/kassen {id?, name, clientId, geraet}  → Kasse anlegen/ändern und einem Gerät zuweisen
//                                         (geraet: Kurzkennung aus /mitarbeiter oder 'dieses')
//   POST /kasse/kassen/aufloesen {id}  → Kasse außer Betrieb (Belege bleiben, die ID wird nicht wieder vergeben)
//   GET  /kasse/tse                    → Zugang zur TSS (ohne Secret)
//   POST /kasse/tse {apiKey, apiSecret?, tssId, basis?} | {entfernen: true}
//   POST /kasse/tse/probe {kasse?}     → Probelauf über 1,00 € ohne Buchung
//   GET  /kasse/dsfinvk?von&bis&kasse  → DSFinV-K-Export (ZIP) der Abschlüsse im Zeitraum (dsfinvk/export.mjs)
//
// WER KASSIEREN DARF legt die Verwaltung fest (Nutzer, 17.11.2026): 'alle' (Vorgabe), 'ausgewaehlte'
// (Verwalter und Personen mit dem Recht RECHT_KASSE in ihrer Freigabeliste, wie das Bildschirmfoto-
// Recht) oder 'niemand'. Gebucht wird nur, wenn BEIDES zutrifft: Das Gerät ist eine Kasse UND die
// angemeldete Person darf. Weitere Kassenrechte je Person (kassenRechte unten): stornieren (an der
// eigenen Kasse), Kassenabschluss, Export und Einsicht, Kassen einrichten — die letzten drei von
// jedem Gerät. Verwalter haben alle; Rechte VERGEBEN kann nur ein Verwalter.
// STORNO (mit Pflicht-Grund) nur Verwalter (von jedem Gerät aus) — oder wer das eigene Recht
// RECHT_STORNO hat (z. B. Außendienst), dann nur an seiner Kasse (Gerät = Kasse des Belegs).
// Nutzer, 17.11.2026. Gebucht wird an der Kasse des Belegs.
//
// Position: { text, menge, preisCent (Einzelpreis brutto in Cent), satz (19|7|0), artikel?, art?,
// leergut?, faktor? }. art 'pfand' = Pfand auf ausgegebenes Leergut, 'leergut' = Leergut zurück
// (negative Menge, Pfand wird ausgezahlt bzw. verrechnet); leergut = Leergutart, faktor =
// Basiseinheiten je Gebinde (Kiste = 20 Flaschen) — für den Lagerbestand in der App.
// Pfand ist kein Teil des Warenpreises, folgt aber umsatzsteuerlich der Ware (eigene Position mit
// deren Satz, siehe src/features/belege/pfand.ts). Ein Beleg darf negativ sein, wenn das nur am
// zurückgenommenen Leergut liegt (Pfandauszahlung); sonst bleiben Rückgaben ein Storno.
//
// Grundsätze (wie CHOOZY):
// - Nummer in DERSELBEN Transaktion, in der der Beleg gespeichert wird — lückenlos auch bei
//   Abstürzen. Danach wird signiert; bis dahin steht tse_status 'ausstehend'.
// - TSE-Status 'signiert' | 'keine' | 'ausfall'. Bei Ausfall wird trotzdem gebucht und der Fehler
//   am Beleg festgehalten (der Bon weist den Ausfall aus, der Betrieb dokumentiert ihn).
// - Belege und Abschlüsse sind unveränderlich (Trigger in SQLite). Storno nur als Gegenbuchung.
// - Abschlüsse klammern die Belege einer Kasse über die laufende Zeilennummer (lfd), nicht über
//   die Uhrzeit: Der nächste beginnt genau hinter dem letzten Beleg des vorigen.

import { randomUUID } from 'node:crypto';

import { dsfinvkDateien, zip } from './dsfinvk/export.mjs';
import { erstelleGeheim } from './geheim.mjs';
import { modulAnzahl } from './module.mjs';
import { naechsteNummer } from './speicher.mjs';
import { STANDARD_BASIS } from './tse/fiskaly.mjs';
import { tseMit, zugangAus } from './tse/index.mjs';

export const SAETZE = [19, 7, 0];
const MAX_POSITIONEN = 200;
const MAX_CENT = 10_000_000; // 100.000 € je Position bzw. Beleg — darüber eher ein Tippfehler
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KASSEN_ID = /^[A-Z0-9]{1,8}$/;
/** Recht in der Freigabeliste eines Mitarbeiters (wie in der App src/features/abgleich/rechte.ts). */
export const RECHT_KASSE = 'recht:barkasse';
/** Eigenes Recht: an der eigenen Kasse stornieren (mit Pflicht-Grund). */
export const RECHT_STORNO = 'recht:barkasse-storno';
/** Eigenes Recht: Kassenabschluss (Z-Bon) für eine wählbare Kasse ziehen, von jedem Gerät. */
export const RECHT_ABSCHLUSS = 'recht:barkasse-abschluss';
/** Eigenes Recht: DSFinV-K-Export, Belege und Abschlüsse aller Kassen einsehen. */
export const RECHT_EXPORT = 'recht:barkasse-export';
/** Eigenes Recht: Kassen anlegen/zuweisen/auflösen, TSE-Zugang, Probelauf. Rechte vergeben bleibt beim Verwalter. */
export const RECHT_EINRICHTEN = 'recht:barkasse-einrichten';
export const KASSE_WER = ['alle', 'ausgewaehlte', 'niemand'];

/** Steht ein Zusatzrecht in der Freigabeliste (bereiche als JSON-Text oder Liste)? */
export function hatRecht(mitarbeiter, recht) {
  try {
    const b = typeof mitarbeiter.bereiche === 'string' ? JSON.parse(mitarbeiter.bereiche) : mitarbeiter.bereiche;
    return Array.isArray(b) && b.includes(recht);
  } catch {
    return false;
  }
}

/**
 * Die Kassenrechte einer Person (Nutzer, 17.11.2026: vollständige Rechtevergabe, z. B. für eine
 * Bürohilfe). Verwalter haben alle; alle anderen nur, was ein Verwalter bei der Person einschaltet.
 * Kassieren richtet sich zusätzlich nach der Betriebseinstellung `wer` (alle / ausgewählte /
 * niemand — bei „niemand“ kassiert auch kein Verwalter). Rechte VERGEBEN kann nur ein Verwalter.
 * @param {string} wer  Betriebseinstellung für das Kassieren
 * @param {{ rolle: string, bereiche?: string | string[] | null }} m  Mitarbeiter (Zeile aus der Datenbank)
 */
export function kassenRechte(wer, m) {
  const v = m.rolle === 'verwalter';
  return {
    kassieren: wer !== 'niemand' && (v || wer === 'alle' || hatRecht(m, RECHT_KASSE)),
    stornieren: v || hatRecht(m, RECHT_STORNO),
    abschluss: v || hatRecht(m, RECHT_ABSCHLUSS),
    export: v || hatRecht(m, RECHT_EXPORT),
    einrichten: v || hatRecht(m, RECHT_EINRICHTEN),
  };
}
export const darfKassieren = (wer, m) => kassenRechte(wer, m).kassieren;
export const darfStornieren = (wer, m) => kassenRechte(wer, m).stornieren;

/** Antwort als Datei statt JSON (DSFinV-K-Export); dienst.mjs schreibt sie unverändert hinaus. */
export class KassenDatei {
  constructor(name, typ, daten) {
    this.name = name;
    this.typ = typ;
    this.daten = daten;
  }
}

/**
 * Firmendaten des Betriebs für den Export: wie die App sie abgleicht (Sammlung 'roh', id 'firma',
 * inhalt.daten = JSON der Firma aus src/features/company/store.ts). Ohne: Name des Betriebs.
 */
export function firmaFuerExport(db, betriebName) {
  let f = null;
  try {
    const z = db.prepare("select inhalt from daten where sammlung = 'roh' and id = 'firma' and geloescht = 0").get();
    f = z ? JSON.parse(JSON.parse(z.inhalt).daten) : null;
  } catch {
    f = null;
  }
  const a = f?.party?.address ?? {};
  return {
    name: f?.party?.name?.trim() || betriebName,
    strasse: a.line1 ?? '',
    plz: a.postcode ?? '',
    ort: a.city ?? '',
    land: a.countryCode && a.countryCode !== 'DE' ? '' : 'DEU',
    stnr: f?.steuernummer ?? '',
    ustid: f?.party?.vatId ?? '',
  };
}

export class KassenFehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

/**
 * Ist die Barkasse für diesen Betrieb freigeschaltet? (Ob DIESES Gerät eine Kasse ist, steht an der Kasse.)
 * - Privatkonten (nur Alleinarbeit): nie.
 * - Eigener Server eines Betriebs: immer, ohne Grenze (gebucht null).
 * - Zentraler Server: nur mit gebuchten Kassen (Anzahl, vom Anbieter gesetzt) und nicht mit
 *   Einzel Plus (Abo über genau einen Platz) — die Barkasse gibt es ab Team-Abo bzw. Stufe Betrieb.
 */
export function kasseFreigabe({ zentral, art, gebucht, stand }) {
  if (art === 'privat') return { verfuegbar: false, grund: 'Die Barkasse gibt es nur für Betriebe.' };
  if (!zentral) return { verfuegbar: true, gebucht: null };
  // Technisch braucht die Barkasse nur einen Server (Belegnummern, Signatur, Aufbewahrung) – das
  // hat jeder Betrieb mit Abgleich, auch Einzel Plus (ein Platz). Eine Stufen-Sperre gibt es darum
  // nicht (Nutzer, 17.11.2026); auf unserem Server zählt nur die Buchung je Kasse.
  if (!gebucht) return { verfuegbar: false, grund: 'Die Barkasse ist für diesen Betrieb nicht gebucht. Buchen (je Kasse) über mail@feif.space.' };
  return { verfuegbar: true, gebucht };
}

// ---------- Zeit nach deutscher Uhr ----------

const TEILE = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** Abstand der deutschen Uhr zu UTC in Minuten zu einem Zeitpunkt. */
function berlinVersatz(ms) {
  const t = Object.fromEntries(TEILE.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return (Date.UTC(+t.year, +t.month - 1, +t.day, +t.hour, +t.minute, +t.second) - Math.floor(ms / 1000) * 1000) / 60000;
}
export const berlinJahr = (ms = Date.now()) => Number(TEILE.formatToParts(new Date(ms)).find((p) => p.type === 'year').value);
/** 'JJJJ-MM-TT' → Beginn dieses Tages in Deutschland als ISO (UTC). */
export function tagesbeginn(tag) {
  const utc = Date.parse(`${tag}T00:00:00Z`);
  return new Date(utc - berlinVersatz(utc - 2 * 3600000) * 60000).toISOString();
}
const TAG = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Rechnen ----------

const ganz = (n) => Number.isInteger(n);

/** Pfand (ausgegeben) und Leergut (zurückgenommen) — alles andere ist Ware oder Leistung. */
export const POSITIONSARTEN = ['pfand', 'leergut'];

/** Positionen prüfen und aufbereiten. */
export function positionenPruefen(liste) {
  if (!Array.isArray(liste) || !liste.length) throw new KassenFehler(400, 'Bitte mindestens eine Position erfassen.');
  if (liste.length > MAX_POSITIONEN) throw new KassenFehler(400, `Höchstens ${MAX_POSITIONEN} Positionen je Beleg.`);
  return liste.map((p, i) => {
    const text = typeof p?.text === 'string' ? p.text.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
    if (!text) throw new KassenFehler(400, `Position ${i + 1}: Bezeichnung fehlt.`);
    const menge = Math.round(Number(p.menge) * 1000) / 1000;
    if (!Number.isFinite(menge) || menge === 0 || Math.abs(menge) > 100000) throw new KassenFehler(400, `Position ${i + 1}: ungültige Menge.`);
    if (!ganz(p.preisCent) || Math.abs(p.preisCent) > MAX_CENT) throw new KassenFehler(400, `Position ${i + 1}: Einzelpreis in Cent (ganze Zahl) angeben.`);
    const satz = Number(p.satz);
    if (!SAETZE.includes(satz)) throw new KassenFehler(400, `Position ${i + 1}: USt-Satz ist 19, 7 oder 0.`);
    const artikel = typeof p.artikel === 'string' && p.artikel.length <= 80 ? p.artikel : undefined;
    const art = POSITIONSARTEN.includes(p.art) ? p.art : undefined;
    const leergut = art && typeof p.leergut === 'string' && p.leergut.length <= 80 ? p.leergut : undefined;
    const faktor = Number(p.faktor);
    const mitFaktor = !art && Number.isFinite(faktor) && faktor > 0 && faktor !== 1 && faktor <= 100000;
    return {
      text,
      menge,
      preisCent: p.preisCent,
      satz,
      betragCent: Math.round(menge * p.preisCent),
      ...(artikel ? { artikel } : {}),
      ...(art ? { art } : {}),
      ...(leergut ? { leergut } : {}),
      ...(mitFaktor ? { faktor: Math.round(faktor * 1000) / 1000 } : {}),
    };
  });
}

/**
 * Summe eines neuen Belegs: über 0 € — oder darunter, wenn alle negativen Positionen
 * zurückgenommenes Leergut sind (Pfandauszahlung, z. B. Kunde bringt nur Leergut).
 */
export function summeErlaubt(positionen) {
  const summe = positionen.reduce((s, p) => s + p.betragCent, 0);
  if (summe > 0) return true;
  if (summe === 0) return false;
  return positionen.every((p) => p.betragCent >= 0 || p.art === 'leergut');
}

/** Steuer je Satz aus den Positionen (brutto, netto, USt in Cent), Satz absteigend. */
export function steuerJeSatz(positionen) {
  const brutto = new Map();
  for (const p of positionen) brutto.set(p.satz, (brutto.get(p.satz) ?? 0) + p.betragCent);
  return [...brutto.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([satz, b]) => {
      const netto = Math.round((b * 100) / (100 + satz));
      return { satz, bruttoCent: b, nettoCent: netto, ustCent: b - netto };
    });
}

// ---------- Speicher ----------

const BELEG_FEST = ['lfd', 'id', 'kasse', 'nummer', 'art', 'storno_von', 'grund', 'erstellt', 'beginn', 'mitarbeiter', 'mitarbeiter_name', 'zahlart', 'positionen', 'steuer', 'summe_cent', 'gegeben_cent'];

function tabellen(db) {
  db.exec(`
    create table if not exists kasse_tse (
      id integer primary key check (id = 1), api_key text not null, api_secret text not null,
      tss_id text not null, basis text, geaendert text not null, von text
    );
    create table if not exists kasse_einstellungen (schluessel text primary key, wert text not null);
    create table if not exists kasse_kassen (
      id text primary key, name text not null, client_id text not null, geraet text unique,
      erstellt text not null, geaendert text not null, aufgeloest text
    );
    create table if not exists kasse_belege (
      lfd integer primary key autoincrement,
      id text unique not null,
      kasse text not null,
      nummer text unique not null,
      art text not null,
      storno_von text unique,
      grund text,
      erstellt text not null,
      beginn text,
      mitarbeiter text not null,
      mitarbeiter_name text not null,
      zahlart text not null,
      positionen text not null,
      steuer text not null,
      summe_cent integer not null,
      gegeben_cent integer,
      tse_status text not null,
      tse_client text, tse_serie text, tse_zaehler integer, tse_transaktion integer, tse_pruefwert text,
      tse_start text, tse_ende text, tse_algo text, tse_schluessel text, tse_pruefcode text,
      tse_vorgang text, tse_fehler text
    );
    create index if not exists kasse_belege_kasse on kasse_belege (kasse, lfd);
    create trigger if not exists kasse_belege_bleiben before delete on kasse_belege
      begin select raise(abort, 'Kassenbelege werden nicht gelöscht – Storno nur als Gegenbuchung'); end;
    create trigger if not exists kasse_belege_fest before update of ${BELEG_FEST.join(', ')} on kasse_belege
      begin select raise(abort, 'Kassenbelege sind unveränderlich'); end;
    create trigger if not exists kasse_belege_tse before update on kasse_belege when old.tse_status != 'ausstehend'
      begin select raise(abort, 'Kassenbelege sind unveränderlich, auch die TSE-Angaben'); end;
    create table if not exists kasse_abschluesse (
      kasse text not null, z_nummer integer not null, von text, bis text not null, von_lfd integer not null,
      bis_lfd integer not null, erstellt text not null, mitarbeiter text, mitarbeiter_name text, summen text not null,
      primary key (kasse, z_nummer)
    );
    create trigger if not exists kasse_abschluesse_bleiben before delete on kasse_abschluesse
      begin select raise(abort, 'Kassenabschlüsse werden nicht gelöscht'); end;
    create trigger if not exists kasse_abschluesse_fest before update on kasse_abschluesse
      begin select raise(abort, 'Kassenabschlüsse sind unveränderlich'); end;
  `);
}

function inTransaktion(db, f) {
  db.exec('begin immediate');
  try {
    const r = f();
    db.exec('commit');
    return r;
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}

/** Beleg für die App (ohne interne Spalten). */
function belegAus(db, z) {
  const storno = z.art === 'beleg' ? db.prepare('select nummer from kasse_belege where storno_von = ?').get(z.nummer)?.nummer ?? null : null;
  const kasse = db.prepare('select id, name from kasse_kassen where id = ?').get(z.kasse);
  return {
    nummer: z.nummer,
    kasse: { id: z.kasse, name: kasse?.name ?? z.kasse },
    art: z.art,
    stornoVon: z.storno_von,
    storniertDurch: storno,
    grund: z.grund,
    erstellt: z.erstellt,
    beginn: z.beginn,
    mitarbeiter: z.mitarbeiter_name,
    zahlart: z.zahlart,
    positionen: JSON.parse(z.positionen),
    steuer: JSON.parse(z.steuer),
    summeCent: z.summe_cent,
    gegebenCent: z.gegeben_cent,
    rueckgeldCent: z.gegeben_cent != null ? z.gegeben_cent - z.summe_cent : null,
    tse: {
      status: z.tse_status,
      client: z.tse_client,
      seriennummer: z.tse_serie,
      signaturzaehler: z.tse_zaehler,
      transaktionsnummer: z.tse_transaktion,
      pruefwert: z.tse_pruefwert,
      start: z.tse_start,
      ende: z.tse_ende,
      algorithmus: z.tse_algo,
      qr_code_data: z.tse_pruefcode,
      vorgangsdaten: z.tse_vorgang,
      fehler: z.tse_fehler,
    },
  };
}

/** Summen eines Abschlusses aus seinen Belegen. */
export function summenAus(belege) {
  const s = { anzahl: belege.length, belege: 0, stornos: 0, umsatzCent: 0, stornoCent: 0, jeZahlart: { bar: 0, unbar: 0 }, jeSatz: [], tse: { signiert: 0, keine: 0, ausfall: 0, ausstehend: 0 }, ersterBeleg: null, letzterBeleg: null };
  const saetze = new Map();
  for (const b of belege) {
    if (b.art === 'storno') {
      s.stornos += 1;
      s.stornoCent += b.summe_cent;
    } else s.belege += 1;
    s.umsatzCent += b.summe_cent;
    s.jeZahlart[b.zahlart] = (s.jeZahlart[b.zahlart] ?? 0) + b.summe_cent;
    s.tse[b.tse_status] = (s.tse[b.tse_status] ?? 0) + 1;
    for (const st of JSON.parse(b.steuer)) {
      const a = saetze.get(st.satz) ?? { satz: st.satz, bruttoCent: 0, nettoCent: 0, ustCent: 0 };
      a.bruttoCent += st.bruttoCent;
      a.nettoCent += st.nettoCent;
      a.ustCent += st.ustCent;
      saetze.set(st.satz, a);
    }
  }
  s.jeSatz = [...saetze.values()].sort((a, b) => b.satz - a.satz);
  s.ersterBeleg = belege[0]?.nummer ?? null;
  s.letzterBeleg = belege.at(-1)?.nummer ?? null;
  return s;
}

const abschlussAus = (z) => ({ kasse: z.kasse, zNummer: z.z_nummer, von: z.von, bis: z.bis, erstellt: z.erstellt, mitarbeiter: z.mitarbeiter_name, summen: JSON.parse(z.summen) });

// ---------- Dienst ----------

/**
 * @param {{ ordner: string, zentral: boolean, betriebStand: (id: string) => any, umgebung?: Record<string,string|undefined>, anfrage?: Function }} o
 *   umgebung: TSE_* (ohne Client) als Vorgabe, nur auf einem eigenen Server; anfrage: in Tests ein Fänger statt https.
 */
export function erstelleKasse({ ordner, zentral, betriebStand, umgebung = process.env, anfrage }) {
  const geheim = erstelleGeheim(ordner, 'kasse-schluessel.bin');
  const tseOptionen = anfrage ? { anfrage } : {};
  // TSE je Kasse merken (Anmeldetoken bei fiskaly), neu bauen, wenn sich Zugang oder Client ändern.
  const tseCache = new Map();

  /** Zugang zur TSS des Betriebs: aus seiner Datenbank, auf einem eigenen Server ersatzweise aus der Umgebung. */
  function zugang(db) {
    const z = db.prepare('select * from kasse_tse where id = 1').get();
    if (z) return { quelle: 'betrieb', stempel: z.geaendert, e: { apiKey: z.api_key, apiSecret: geheim.entschluesseln(z.api_secret), tssId: z.tss_id, basis: z.basis || undefined } };
    // Auf dem zentralen Server nie aus der Umgebung — sonst hätte jeder Betrieb unsere TSE.
    const env = zentral ? null : zugangAus(umgebung);
    return env ? { quelle: 'umgebung', stempel: 'umgebung', e: env } : null;
  }

  function tseFuer(betriebId, db, kasse) {
    const z = zugang(db);
    if (!z || !kasse?.client_id) return null;
    const schluessel = `${betriebId}|${kasse.id}`;
    const stempel = `${z.stempel}|${kasse.client_id}`;
    const alt = tseCache.get(schluessel);
    if (alt && alt.stempel === stempel) return alt.tse;
    const tse = tseMit({ ...z.e, clientId: kasse.client_id }, tseOptionen);
    tseCache.set(schluessel, { stempel, tse });
    return tse;
  }

  const freigabe = (wer) => kasseFreigabe({ zentral, art: wer.betrieb.art, gebucht: modulAnzahl(wer.db, 'kasse'), stand: zentral ? betriebStand(wer.betrieb.id) : null });
  const kasseVon = (db, geraet) => (geraet ? db.prepare('select * from kasse_kassen where geraet = ? and aufgeloest is null').get(geraet) : undefined);
  const kasseMitId = (db, id) => db.prepare('select * from kasse_kassen where id = ?').get(String(id ?? ''));
  const aktiveKassen = (db) => db.prepare('select count(*) as n from kasse_kassen where aufgeloest is null').get().n;

  const kasseWer = (db) => db.prepare("select wert from kasse_einstellungen where schluessel = 'wer'").get()?.wert ?? 'alle';
  const rechteVon = (wer) => kassenRechte(kasseWer(wer.db), wer.roh ?? wer.mitarbeiter);

  /**
   * Stand für die App (auch in /ich): Betrieb freigeschaltet? Ist dieses Gerät eine Kasse? Darf die
   * Person kassieren? `benutzbar` = beides; nur dann wird an diesem Gerät kassiert.
   */
  function status(wer, geraet) {
    const keine = { kassieren: false, stornieren: false, abschluss: false, export: false, einrichten: false };
    if (wer.betrieb.art === 'privat' || wer.mitarbeiter.rolle === 'empfaenger') return { verfuegbar: false, kasse: null, darf: false, benutzbar: false, stornieren: false, rechte: keine };
    tabellen(wer.db);
    const f = freigabe(wer);
    const k = f.verfuegbar ? kasseVon(wer.db, geraet) : undefined;
    const z = f.verfuegbar ? zugang(wer.db) : null;
    const r = f.verfuegbar ? rechteVon(wer) : keine;
    // stornieren: Verwalter überall; mit RECHT_STORNO nur an dieser Kasse.
    const st = f.verfuegbar && (wer.mitarbeiter.rolle === 'verwalter' || (!!k && r.stornieren));
    return { ...f, kasse: k ? { id: k.id, name: k.name } : null, darf: r.kassieren, benutzbar: !!k && r.kassieren, stornieren: st, rechte: r, tse: { eingerichtet: !!(z && k), zugang: !!z, quelle: z?.quelle ?? null } };
  }

  /** Signieren mit drei Ausgängen — siehe CHOOZY kassenverkauf.js `signieren`. */
  async function signieren(tse, vorgang) {
    if (!tse) return { status: 'keine', daten: null, fehler: null };
    try {
      const daten = await tse.signiere(vorgang);
      if (!daten?.pruefwert) throw new Error('TSE ohne Prüfwert');
      return { status: 'signiert', daten, fehler: null };
    } catch (e) {
      console.error('[kasse] TSE hat nicht signiert:', vorgang.belegId, e?.message);
      return { status: 'ausfall', daten: null, fehler: String(e?.message ?? e).slice(0, 300) };
    }
  }

  /** Beleg speichern (Nummer der Kasse in derselben Transaktion), dann signieren und die TSE-Werte eintragen. */
  async function buchen(wer, kasse, { id, art, stornoVon = null, grund = null, zahlart, positionen, gegebenCent = null, beginn = null, pruefen }) {
    const db = wer.db;
    const vorhanden = db.prepare('select * from kasse_belege where id = ?').get(id);
    if (vorhanden && vorhanden.tse_status !== 'ausstehend') return belegAus(db, vorhanden);
    const steuer = steuerJeSatz(positionen);
    const summe = positionen.reduce((s, p) => s + p.betragCent, 0);
    const zeile =
      vorhanden ??
      inTransaktion(db, () => {
        pruefen?.();
        const nummer = naechsteNummer(db, `kasse:${id}`, `kassenbeleg:${kasse.id}`, berlinJahr());
        db.prepare(
          `insert into kasse_belege (id, kasse, nummer, art, storno_von, grund, erstellt, beginn, mitarbeiter, mitarbeiter_name, zahlart, positionen, steuer, summe_cent, gegeben_cent, tse_status)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ausstehend')`,
        ).run(id, kasse.id, nummer, art, stornoVon, grund, new Date().toISOString(), beginn, wer.mitarbeiter.id, wer.mitarbeiter.name, zahlart, JSON.stringify(positionen), JSON.stringify(steuer), summe, gegebenCent);
        return db.prepare('select * from kasse_belege where id = ?').get(id);
      });
    const tse = tseFuer(wer.betrieb.id, db, kasse);
    const s = await signieren(tse, {
      belegId: zeile.nummer,
      art: zahlart,
      umsatz: zeile.summe_cent / 100,
      steuerBrutto: JSON.parse(zeile.steuer).map((x) => [x.satz, x.bruttoCent / 100]),
    });
    const d = s.daten ?? {};
    db.prepare(
      `update kasse_belege set tse_status = ?, tse_client = ?, tse_serie = ?, tse_zaehler = ?, tse_transaktion = ?, tse_pruefwert = ?, tse_start = ?, tse_ende = ?,
       tse_algo = ?, tse_schluessel = ?, tse_pruefcode = ?, tse_vorgang = ?, tse_fehler = ? where nummer = ? and tse_status = 'ausstehend'`,
    ).run(s.status, tse ? kasse.client_id : null, d.seriennummer ?? null, d.signaturzaehler ?? null, d.transaktionsnummer ?? null, d.pruefwert ?? null, d.start ?? null, d.ende ?? null, d.algorithmus ?? null, d.schluessel ?? null, d.pruefcode ?? null, d.vorgangsdaten ?? null, s.fehler, zeile.nummer);
    return belegAus(db, db.prepare('select * from kasse_belege where nummer = ?').get(zeile.nummer));
  }

  const kennung = (id) => {
    if (id === undefined || id === null || id === '') return randomUUID();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new KassenFehler(400, 'Ungültige Kennung des Belegs.');
    return id;
  };

  function tseStand(wer) {
    const z = zugang(wer.db);
    const roh = wer.db.prepare('select api_key, tss_id, basis, geaendert, von from kasse_tse where id = 1').get();
    if (!rechteVon(wer).einrichten) return { zugang: !!z, quelle: z?.quelle ?? null };
    return {
      zugang: !!z,
      quelle: z?.quelle ?? null,
      secretGesetzt: !!roh,
      basis: roh?.basis || STANDARD_BASIS,
      ...(roh ? { apiKey: roh.api_key, tssId: roh.tss_id, geaendert: roh.geaendert, von: roh.von } : {}),
    };
  }

  function kassenListe(db) {
    const geraete = new Map(
      db
        .prepare('select substr(g.token_hash, 1, 12) as kurz, g.name, m.name as mitarbeiter from geraete g left join mitarbeiter m on m.id = g.mitarbeiter')
        .all()
        .map((g) => [g.kurz, g]),
    );
    return db
      .prepare('select * from kasse_kassen order by aufgeloest is not null, id')
      .all()
      .map((k) => ({
        id: k.id,
        name: k.name,
        clientId: k.client_id,
        geraet: k.geraet ? { id: k.geraet, name: geraete.get(k.geraet)?.name ?? 'abgemeldetes Gerät', mitarbeiter: geraete.get(k.geraet)?.mitarbeiter ?? null } : null,
        erstellt: k.erstellt,
        aufgeloest: k.aufgeloest,
        belege: db.prepare('select count(*) as n from kasse_belege where kasse = ?').get(k.id).n,
      }));
  }

  /**
   * Kasse, auf die sich ein lesender Aufruf bezieht: die eigene, oder mit `alleSehen` (Recht Export,
   * bei Abschlüssen auch Recht Abschluss) jede. null = alle Kassen.
   */
  function kasseFuerLesen(wer, eigene, gewuenscht, alleSehen) {
    if (gewuenscht && gewuenscht !== (eigene?.id ?? '')) {
      if (!alleSehen) throw new KassenFehler(403, 'Andere Kassen sieht nur, wer das Recht „Barkasse: Export und Einsicht“ hat, oder ein Verwalter.');
      const k = kasseMitId(wer.db, gewuenscht);
      if (!k) throw new KassenFehler(404, 'Diese Kasse gibt es nicht.');
      return k;
    }
    if (eigene) return eigene;
    if (alleSehen) return null;
    throw new KassenFehler(403, 'Dieses Gerät ist keine Kasse. Ein Verwalter weist die Kasse unter Barkasse → Kassen zu.');
  }

  /** Bearbeitet /kasse/*; undefined, wenn der Pfad nicht dazugehört. `geraet` = Kurzkennung dieses Geräts. */
  async function weg(methode, pfad, url, wer, koerper, geraet) {
    if (pfad !== '/kasse' && !pfad.startsWith('/kasse/')) return undefined;
    const db = wer.db;
    tabellen(db);
    if (methode === 'GET' && pfad === '/kasse/status') return status(wer, geraet);
    const f = freigabe(wer);
    if (!f.verfuegbar) throw new KassenFehler(403, f.grund);
    const verwalter = wer.mitarbeiter.rolle === 'verwalter';
    const eigene = kasseVon(db, geraet);
    const nurKasse = () => {
      if (!eigene) throw new KassenFehler(403, 'Dieses Gerät ist keine Kasse. Erst mit zugewiesener Kasse (eigene TSE) wird es zur elektronischen Kasse; ein Verwalter weist sie unter Barkasse → Kassen zu.');
      return eigene;
    };
    const nurVerwalter = (was) => {
      if (!verwalter) throw new KassenFehler(403, `${was} nur ein Verwalter.`);
    };
    const r = rechteVon(wer);
    const NAME = { kassieren: 'Barkasse benutzen', stornieren: 'Barkasse stornieren', abschluss: 'Kassenabschluss', export: 'Export und Einsicht', einrichten: 'Kassen einrichten' };
    /** Prüft ein Kassenrecht der angemeldeten Person (Verwalter haben alle). */
    const braucht = (recht, was) => {
      if (!r[recht]) throw new KassenFehler(403, `${was} nur ein Verwalter oder wer das Recht „${NAME[recht]}“ hat (Benutzerverwaltung).`);
    };

    if (methode === 'POST' && pfad === '/kasse/beleg') {
      const kasse = nurKasse();
      if (!r.kassieren) throw new KassenFehler(403, 'Sie dürfen die Barkasse nicht benutzen. Das legt ein Verwalter in der Benutzerverwaltung fest.');
      const b = await koerper();
      const positionen = positionenPruefen(b.positionen);
      const summe = positionen.reduce((s, p) => s + p.betragCent, 0);
      if (!summeErlaubt(positionen)) throw new KassenFehler(400, 'Die Summe muss über 0 € liegen. Rückgaben bitte als Storno des ursprünglichen Belegs; nur zurückgenommenes Leergut darf zu einer Auszahlung führen.');
      if (Math.abs(summe) > MAX_CENT) throw new KassenFehler(400, 'Die Summe ist unplausibel hoch.');
      if (b.zahlart !== 'bar' && b.zahlart !== 'unbar') throw new KassenFehler(400, 'Zahlart ist bar oder unbar.');
      let gegeben = null;
      if (b.gegebenCent !== undefined && b.gegebenCent !== null) {
        if (summe <= 0 || b.zahlart !== 'bar' || !ganz(b.gegebenCent) || b.gegebenCent < summe || b.gegebenCent > MAX_CENT) throw new KassenFehler(400, 'Gegeben: ganze Cent, bar und mindestens die Summe.');
        gegeben = b.gegebenCent;
      }
      const beginn = typeof b.beginn === 'string' && !Number.isNaN(Date.parse(b.beginn)) ? new Date(b.beginn).toISOString() : null;
      return buchen(wer, kasse, { id: kennung(b.id), art: 'beleg', zahlart: b.zahlart, positionen, gegebenCent: gegeben, beginn });
    }

    if (methode === 'POST' && pfad === '/kasse/storno') {
      const b = await koerper();
      const nummer = String(b.nummer ?? '');
      const orig = db.prepare('select * from kasse_belege where nummer = ?').get(nummer);
      if (!orig) throw new KassenFehler(404, 'Diesen Kassenbeleg gibt es nicht.');
      if (!verwalter) {
        if (!r.stornieren) throw new KassenFehler(403, 'Stornieren dürfen nur Verwalter oder Personen mit dem Recht „Barkasse stornieren“.');
        if (!eigene || eigene.id !== orig.kasse) throw new KassenFehler(403, `Mit dem Recht „Barkasse stornieren“ nur an der eigenen Kasse (der Beleg gehört zur Kasse ${orig.kasse}).`);
      }
      // Ein Grund ist Pflicht: Ein Storno ohne Begründung sieht später aus wie ein Griff in die Kasse.
      if (typeof b.grund !== 'string' || b.grund.trim().length < 3) throw new KassenFehler(400, 'Bitte einen Grund für das Storno angeben (mindestens 3 Zeichen).');
      if (orig.art === 'storno') throw new KassenFehler(400, 'Ein Storno lässt sich nicht stornieren.');
      // Gegenbuchung an der Kasse des Belegs (gleicher Nummernkreis, gleicher TSE-Client).
      const kasse = kasseMitId(db, orig.kasse);
      if (!kasse || kasse.aufgeloest) throw new KassenFehler(409, `Die Kasse ${orig.kasse} ist aufgelöst; dort lässt sich nichts mehr buchen.`);
      const id = kennung(b.id);
      const schon = () => db.prepare('select nummer, id from kasse_belege where storno_von = ?').get(nummer);
      const s = schon();
      if (s && s.id !== id) throw new KassenFehler(409, `Schon storniert durch ${s.nummer}.`);
      const positionen = JSON.parse(orig.positionen).map((p) => ({ ...p, menge: -p.menge, betragCent: -p.betragCent }));
      const grund = typeof b.grund === 'string' ? b.grund.trim().slice(0, 200) || null : null;
      return buchen(wer, kasse, {
        id,
        art: 'storno',
        stornoVon: nummer,
        grund,
        zahlart: orig.zahlart,
        positionen,
        // In der Transaktion noch einmal: Zwei Geräte stornieren nicht denselben Beleg.
        pruefen: () => {
          const x = schon();
          if (x) throw new KassenFehler(409, `Schon storniert durch ${x.nummer}.`);
        },
      });
    }

    if (methode === 'GET' && pfad === '/kasse/belege') {
      const kasse = kasseFuerLesen(wer, eigene, url.searchParams.get('kasse'), r.export);
      const von = url.searchParams.get('von');
      const bis = url.searchParams.get('bis');
      if ((von && !TAG.test(von)) || (bis && !TAG.test(bis))) throw new KassenFehler(400, 'von und bis als JJJJ-MM-TT.');
      const ab = von ? tagesbeginn(von) : new Date(Date.now() - 31 * 86400000).toISOString();
      const vor = bis ? tagesbeginn(new Date(Date.parse(`${bis}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) : '9999';
      const zeilen = kasse
        ? db.prepare('select * from kasse_belege where kasse = ? and erstellt >= ? and erstellt < ? order by lfd desc limit 1000').all(kasse.id, ab, vor)
        : db.prepare('select * from kasse_belege where erstellt >= ? and erstellt < ? order by lfd desc limit 1000').all(ab, vor);
      return zeilen.map((z) => belegAus(db, z));
    }

    if (methode === 'POST' && pfad === '/kasse/abschluss') {
      // Verwalteraufgabe (Nutzer, 17.11.2026): von jedem Gerät aus, mit Wahl der Kasse.
      braucht('abschluss', 'Den Kassenabschluss macht');
      const b = await koerper();
      const kasse = b.kasse ? kasseMitId(db, b.kasse) : eigene;
      if (!kasse) throw new KassenFehler(b.kasse ? 404 : 400, b.kasse ? 'Diese Kasse gibt es nicht.' : 'Bitte die Kasse wählen, die abgeschlossen werden soll.');
      return inTransaktion(db, () => {
        const letzter = db.prepare('select * from kasse_abschluesse where kasse = ? order by z_nummer desc limit 1').get(kasse.id);
        const vonLfd = letzter?.bis_lfd ?? 0;
        const bisLfd = Math.max(vonLfd, db.prepare('select coalesce(max(lfd), 0) as n from kasse_belege where kasse = ?').get(kasse.id).n);
        const belege = db.prepare('select * from kasse_belege where kasse = ? and lfd > ? and lfd <= ? order by lfd').all(kasse.id, vonLfd, bisLfd);
        const z = (letzter?.z_nummer ?? 0) + 1;
        const jetzt = new Date().toISOString();
        db.prepare('insert into kasse_abschluesse values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(kasse.id, z, letzter?.bis ?? null, jetzt, vonLfd, bisLfd, jetzt, wer.mitarbeiter.id, wer.mitarbeiter.name, JSON.stringify(summenAus(belege)));
        return abschlussAus(db.prepare('select * from kasse_abschluesse where kasse = ? and z_nummer = ?').get(kasse.id, z));
      });
    }

    if (methode === 'GET' && pfad === '/kasse/abschluesse') {
      const kasse = kasseFuerLesen(wer, eigene, url.searchParams.get('kasse'), r.export || r.abschluss);
      const zeilen = kasse
        ? db.prepare('select * from kasse_abschluesse where kasse = ? order by z_nummer desc limit 400').all(kasse.id)
        : db.prepare('select * from kasse_abschluesse order by erstellt desc limit 400').all();
      return zeilen.map(abschlussAus);
    }

    if (pfad === '/kasse/recht') {
      if (methode === 'POST') {
        nurVerwalter('Wer kassieren darf, legt');
        const { wer: w } = await koerper();
        if (!KASSE_WER.includes(w)) throw new KassenFehler(400, "wer ist 'alle', 'ausgewaehlte' oder 'niemand'.");
        db.prepare("insert into kasse_einstellungen values ('wer', ?) on conflict (schluessel) do update set wert = excluded.wert").run(w);
      }
      return { wer: kasseWer(db), recht: RECHT_KASSE };
    }

    if (methode === 'GET' && pfad === '/kasse/dsfinvk') {
      braucht('export', 'Den Export für das Finanzamt holt');
      const von = url.searchParams.get('von');
      const bis = url.searchParams.get('bis');
      if (!von || !bis || !TAG.test(von) || !TAG.test(bis) || von > bis) throw new KassenFehler(400, 'Zeitraum als von und bis (JJJJ-MM-TT) angeben.');
      const kasseId = url.searchParams.get('kasse');
      if (kasseId && !kasseMitId(db, kasseId)) throw new KassenFehler(404, 'Diese Kasse gibt es nicht.');
      // Abschlüsse, die im Zeitraum gezogen wurden (Buchungstag nach deutscher Zeit).
      const ab = tagesbeginn(von);
      const vor = tagesbeginn(new Date(Date.parse(`${bis}T12:00:00Z`) + 86400000).toISOString().slice(0, 10));
      const abschluesse = db
        .prepare(`select * from kasse_abschluesse where bis >= ? and bis < ?${kasseId ? ' and kasse = ?' : ''} order by kasse, z_nummer`)
        .all(...(kasseId ? [ab, vor, kasseId] : [ab, vor]));
      if (!abschluesse.length) throw new KassenFehler(404, 'In diesem Zeitraum gibt es keinen Kassenabschluss. Der Export besteht aus Abschlüssen – erst einen Kassenabschluss machen.');
      // Stammdaten der TSE (Zertifikat …) je Kasse, wenn erreichbar; sonst gilt, was an den Belegen steht.
      const stamm = new Map();
      for (const id of new Set(abschluesse.map((a) => a.kasse))) {
        const tse = tseFuer(wer.betrieb.id, db, kasseMitId(db, id));
        if (tse) stamm.set(id, await tse.stammdaten().catch(() => ({})));
      }
      const { dateien } = dsfinvkDateien({ db, abschluesse, firma: firmaFuerExport(db, wer.betrieb.name), stamm, version: 'Montix' });
      return new KassenDatei(`DSFinV-K_${kasseId ?? 'alle-Kassen'}_${von}_${bis}.zip`, 'application/zip', zip(dateien));
    }

    if (methode === 'GET' && pfad === '/kasse/kassen') {
      // Zum Ansehen (Kassenwahl beim Abschluss, Export) reicht eines dieser Rechte.
      if (!r.einrichten && !r.abschluss && !r.export) braucht('einrichten', 'Die Kassen sieht');
      return { gebucht: f.gebucht, kassen: kassenListe(db) };
    }

    if (methode === 'POST' && pfad === '/kasse/kassen') {
      braucht('einrichten', 'Kassen weist');
      const b = await koerper();
      const name = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : '';
      const clientId = typeof b.clientId === 'string' ? b.clientId.trim() : '';
      const ziel = b.geraet === 'dieses' ? geraet : String(b.geraet ?? '');
      if (!name) throw new KassenFehler(400, 'Bitte einen Namen für die Kasse angeben, z. B. „Kasse Transporter 1“.');
      if (!UUID.test(clientId)) throw new KassenFehler(400, 'Die Client-ID ist eine UUID — für jede Kasse einen eigenen Client im fiskaly-Dashboard anlegen.');
      if (!/^[0-9a-f]{12}$/.test(ziel ?? '') || !db.prepare('select 1 from geraete where substr(token_hash, 1, 12) = ?').get(ziel)) throw new KassenFehler(400, 'Unbekanntes Gerät.');
      let id = typeof b.id === 'string' && b.id.trim() ? b.id.trim().toUpperCase() : null;
      if (id && !KASSEN_ID.test(id)) throw new KassenFehler(400, 'Kassen-ID: bis zu 8 Buchstaben oder Ziffern, z. B. K1.');
      const vorhanden = id ? kasseMitId(db, id) : null;
      if (vorhanden?.aufgeloest) throw new KassenFehler(409, `Die Kasse ${id} ist aufgelöst; ihre ID wird nicht wieder vergeben.`);
      const belegt = db.prepare('select id from kasse_kassen where geraet = ? and aufgeloest is null').get(ziel);
      if (belegt && belegt.id !== id) throw new KassenFehler(409, `Dieses Gerät ist schon die Kasse ${belegt.id}.`);
      const doppelt = db.prepare('select id from kasse_kassen where client_id = ? and aufgeloest is null').get(clientId);
      if (doppelt && doppelt.id !== id) throw new KassenFehler(409, `Diese Client-ID gehört schon zur Kasse ${doppelt.id}. Jede Kasse braucht ihren eigenen Client.`);
      const jetzt = new Date().toISOString();
      if (vorhanden) {
        db.prepare('update kasse_kassen set name = ?, client_id = ?, geraet = ?, geaendert = ? where id = ?').run(name, clientId, ziel, jetzt, id);
      } else {
        if (f.gebucht !== null && aktiveKassen(db) >= f.gebucht) throw new KassenFehler(403, `Gebucht ${f.gebucht === 1 ? 'ist 1 Kasse' : `sind ${f.gebucht} Kassen`}. Für eine weitere Kasse bitte nachbuchen (mail@feif.space).`);
        if (!id) {
          let n = db.prepare('select count(*) as n from kasse_kassen').get().n + 1;
          while (kasseMitId(db, `K${n}`)) n += 1;
          id = `K${n}`;
        }
        db.prepare('insert into kasse_kassen values (?, ?, ?, ?, ?, ?, null)').run(id, name, clientId, ziel, jetzt, jetzt);
      }
      return { gebucht: f.gebucht, kassen: kassenListe(db) };
    }

    if (methode === 'POST' && pfad === '/kasse/kassen/aufloesen') {
      braucht('einrichten', 'Kassen löst');
      const { id } = await koerper();
      const k = kasseMitId(db, id);
      if (!k || k.aufgeloest) throw new KassenFehler(404, 'Diese Kasse gibt es nicht (mehr).');
      db.prepare('update kasse_kassen set geraet = null, aufgeloest = ? where id = ?').run(new Date().toISOString(), k.id);
      return { gebucht: f.gebucht, kassen: kassenListe(db) };
    }

    if (methode === 'GET' && pfad === '/kasse/tse') return tseStand(wer);

    if (methode === 'POST' && pfad === '/kasse/tse') {
      braucht('einrichten', 'Die TSE richtet');
      const b = await koerper();
      if (b.entfernen === true) {
        db.prepare('delete from kasse_tse').run();
        return tseStand(wer);
      }
      const alt = db.prepare('select api_secret from kasse_tse where id = 1').get();
      const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
      const secret = typeof b.apiSecret === 'string' ? b.apiSecret.trim() : '';
      const tssId = typeof b.tssId === 'string' ? b.tssId.trim() : '';
      const basis = typeof b.basis === 'string' && b.basis.trim() ? b.basis.trim().replace(/\/+$/, '') : null;
      if (!apiKey || apiKey.length > 200) throw new KassenFehler(400, 'API-Key fehlt.');
      if (!secret && !alt) throw new KassenFehler(400, 'API-Secret fehlt.');
      if (secret.length > 400) throw new KassenFehler(400, 'API-Secret ist zu lang.');
      if (!UUID.test(tssId)) throw new KassenFehler(400, 'Die TSS-ID ist eine UUID (aus dem fiskaly-Dashboard).');
      if (basis && (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(basis) || basis.length > 200)) throw new KassenFehler(400, 'Die Adresse beginnt mit https://');
      db.prepare(
        `insert into kasse_tse values (1, ?, ?, ?, ?, ?, ?) on conflict (id) do update set api_key = excluded.api_key, api_secret = excluded.api_secret,
         tss_id = excluded.tss_id, basis = excluded.basis, geaendert = excluded.geaendert, von = excluded.von`,
      ).run(apiKey, secret ? geheim.verschluesseln(secret) : alt.api_secret, tssId, basis && basis !== STANDARD_BASIS ? basis : null, new Date().toISOString(), wer.mitarbeiter.name);
      return tseStand(wer);
    }

    if (methode === 'POST' && pfad === '/kasse/tse/probe') {
      braucht('einrichten', 'Den Probelauf startet');
      const b = await koerper();
      const kasse = b.kasse ? kasseMitId(db, b.kasse) : eigene;
      if (!kasse || kasse.aufgeloest) throw new KassenFehler(409, 'Für den Probelauf eine Kasse wählen (ihr Client signiert).');
      const tse = tseFuer(wer.betrieb.id, db, kasse);
      if (!tse) throw new KassenFehler(409, 'Es ist noch kein Zugang zur TSE eingerichtet.');
      // Bucht nichts: kein Beleg, keine Nummer. Die TSE sieht aber eine echte Transaktion.
      try {
        const d = await tse.signiere({ belegId: `probe-${Date.now().toString(36)}`, art: 'bar', umsatz: 1, steuerBrutto: [[19, 1]] });
        const fehlend = ['seriennummer', 'signaturzaehler', 'transaktionsnummer', 'pruefwert'].filter((k) => !d[k]);
        return {
          ok: fehlend.length === 0,
          kasse: kasse.id,
          fehlend,
          seriennummer: d.seriennummer,
          signaturzaehler: d.signaturzaehler,
          transaktionsnummer: d.transaktionsnummer,
          start: d.start,
          ende: d.ende,
          algorithmus: d.algorithmus,
          vorgangsdaten: d.vorgangsdaten,
          qr_code_data: d.pruefcode,
        };
      } catch (e) {
        throw new KassenFehler(502, `Probelauf gescheitert: ${e?.message ?? e}`);
      }
    }

    throw new KassenFehler(404, 'Unbekannter Weg');
  }

  return { weg, status };
}
