// HTTP-Schnittstelle des Abgleich-Servers (node:http, ohne Framework).
//
//   GET  /status                    → { dienst, version }                 (ohne Anmeldung)
//   POST /anmelden {code, geraet}   → { token, betrieb, mitarbeiter }     (Einladungscode einlösen)
//   GET  /ich                       → { betrieb, mitarbeiter }
//   GET  /abgleich?seit=<rev>       → { rev, mehr, aenderungen[] }
//   POST /abgleich {aenderungen[]}  → { rev, uebernommen, verworfen[] }
//   POST /nummer {beleg, art, jahr} → { nummer }                          (idempotent je Beleg)
//   POST /ausweis {kennung}         → { mitarbeiter: {id, name} }         (NFC-Ausweis; gesperrt → 403)
//   Nur Verwalter:
//   GET  /mitarbeiter               → [{ id, name, rolle, aktiv, geraete[] }]
//   POST /einladung {name, rolle}   → { code, gueltigBis }
//   POST /mitarbeiter/aktiv {id, aktiv}
//   POST /geraet/entfernen {id}
//   POST /mitarbeiter/rechte {id, bereiche: string[] | null}   (null = alle Bereiche)
//   GET  /export                    → gesamter Bestand des Betriebs als JSON
//   POST /vertrag {fassung}         → Zustimmung zum Vertrag zur Auftragsverarbeitung festhalten
//   /kasse/*                        → Barkasse mit TSE (buchbares Modul) — siehe kasse.mjs
//
// Mit MONTIX_VERTRAG=pflicht (zentraler Betrieb) gehen Abgleich und Nummern erst, wenn ein
// Verwalter dem Vertrag zur Auftragsverarbeitung zugestimmt hat. Beim eigenen Server entfällt das.
//
// Alles außer /status und /anmelden mit `Authorization: Bearer <Geräte-Token>`.

import { createServer } from 'node:http';

import { hash, SAMMLUNGEN } from './speicher.mjs';
import { alarmeMelden, AlleinFehler, alleinarbeitWeg, entwarnen } from './alleinarbeit.mjs';
import { erstelleSendmail } from './post.mjs';
import { unterwegsWeg, WegFehler, wegSeite } from './unterwegs.mjs';
import { abgelaufeneAufraeumen, FreigabeFehler, freigabeWeg, teilenOeffentlich } from './freigaben.mjs';
import { erstelleRaeume, RaumFehler } from './raeume.mjs';
import { offeneZahlungenPruefen, PortalFehler, portalOeffentlich, portalWeg } from './portal.mjs';
import { alarmZiele, erstelleExpoPush, nachricht as pushNachricht, pushWeg, tokensVon } from './push.mjs';
import { erstelleMail, MailFehler, pythonHelfer } from './mail.mjs';
import { NachrichtFehler, nachrichtenweg } from './nachrichten.mjs';
import { erstelleZahlung, ZahlFehler } from './zahlung.mjs';
import { erstelleKasse, hatRecht, KassenDatei, KassenFehler } from './kasse.mjs';
import { fehlerMelden } from './fehler.mjs';
import { adresseInfo, erstelleAdresssuche } from './adresse.mjs';
import { darfDispo, erstelleOrtung, fuerFremdfahrer, lagekarteSeite, sendungSeite, TourFehler, tourenWeg } from './touren.mjs';
import { sendungMail } from './mailvorlage.mjs';
import { karteWeg } from './karte.mjs';
import { datenPruefen } from './datenstand.mjs';
import { adressenWeg } from './adressen.mjs';
import { lueckeMelden } from './hilfe.mjs';
import { GERAETE_SEITE, geraeteDb, melden as geraetMelden, liste as geraeteListe } from './geraete.mjs';
import { erstellePartner, PartnerFehler } from './partner.mjs';
// Abo und Postfach nur auf dem zentralen Server; im öffentlichen Paket leere Fassungen — siehe anbieter.mjs.
import { betriebUuid, erstelleAbos, erstellePostfach, KaufFehler } from './anbieter.mjs';
import { aufraeumen as termineAufraeumen, erinnerungenVerschicken, TerminFehler, terminOeffentlich, terminWeg } from './terminmitteilung.mjs';

export const VERSION = 1;
const GRENZE = 8 * 1024 * 1024;

class Fehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

function antwort(res, status, daten) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, range',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(status === 204 ? undefined : JSON.stringify(daten));
}

async function koerper(req, grenze = GRENZE) {
  const teile = [];
  let laenge = 0;
  for await (const t of req) {
    laenge += t.length;
    if (laenge > grenze) throw new Fehler(413, 'Zu groß');
    teile.push(t);
  }
  if (!laenge) return {};
  try {
    return JSON.parse(Buffer.concat(teile).toString('utf8'));
  } catch {
    throw new Fehler(400, 'Kein gültiges JSON');
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function pruefeAenderungen(liste) {
  if (!Array.isArray(liste) || liste.length > 2000) throw new Fehler(400, 'aenderungen fehlt oder zu viele');
  return liste.map((a) => {
    if (!SAMMLUNGEN.includes(a?.sammlung)) throw new Fehler(400, `Unbekannte Sammlung: ${a?.sammlung}`);
    if (typeof a.id !== 'string' || !a.id || a.id.length > 120) throw new Fehler(400, 'Ungültige id');
    if (typeof a.geaendert !== 'string' || !ISO.test(a.geaendert)) throw new Fehler(400, 'geaendert muss ein ISO-Zeitpunkt (UTC) sein');
    if (!a.geloescht && (typeof a.inhalt !== 'object' || a.inhalt === null)) throw new Fehler(400, 'inhalt fehlt');
    return { sammlung: a.sammlung, id: a.id, geaendert: a.geaendert, geloescht: !!a.geloescht, inhalt: a.inhalt };
  });
}

/**
 * Bewegung (Schrittzähler): Schritte schreibt jeder nur für sich selbst (id = <mitarbeiter>_<datum>),
 * Aktionen legt nur ein Verwalter an. Anderes wird still übergangen statt abgewiesen — sonst
 * hinge ein Gerät mit einem verbotenen Eintrag bei jedem Abgleich fest.
 */
const FIRMA_ROH = ['firma', 'logo', 'farben'];

/**
 * Warenwirtschaft (src/features/abgleich/rechte.ts): Lieferanten pflegt, wer „Einkauf“ darf
 * (Verwalter immer). Bestellungen ändert außerdem, wer Lager buchen darf — der Wareneingang hält
 * die gelieferten Mengen an der Bestellung fest. „Lager buchen“ hat auch, wer alle Bereiche hat.
 */
export const RECHT_EINKAUF = 'recht:einkauf';
export const RECHT_LAGER = 'recht:lager';
const darfEinkauf = (m) => m.rolle === 'verwalter' || hatRecht(m, RECHT_EINKAUF);
/**
 * Zeiterfassung (src/features/zeiten): Jeder schreibt und liest nur die eigenen Einträge (id beginnt
 * mit der eigenen Mitarbeiter-ID). Verwalter und das Recht „Arbeitszeiten aller“ sehen und
 * korrigieren alle, legen Verträge an und geben Monate frei. Gelöscht wird nie (Aufbewahrung,
 * § 16 ArbZG) — die App storniert stattdessen.
 */
export const RECHT_ZEITEN = 'recht:zeiten';
export const darfAlleZeiten = (m) => m.rolle === 'verwalter' || hatRecht(m, RECHT_ZEITEN);
const eigeneZeit = (a, m) => a.id.startsWith(`${m.id}_`) && (a.geloescht || a.inhalt?.mitarbeiter === m.id);
/** Monat eines Arbeitsblocks bzw. einer Abwesenheit, in deutscher Zeit (wie die App). */
const monatDerZeit = (z) => (z?.art === 'arbeit' ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).format(new Date(z.beginn)) : String(z?.beginn ?? '')).slice(0, 7);
/**
 * Was eine Person ohne „Arbeitszeiten aller“ an `zeiten` schreiben darf: eigene Blöcke und
 * Abwesenheiten, solange der Monat nicht freigegeben ist, und die eigene Bestätigung des Monats —
 * nie den Vertrag und nie eine Freigabe.
 */
function zeitErlaubt(a, m, db) {
  if (a.geloescht) return false;
  if (darfAlleZeiten(m)) return true;
  if (!eigeneZeit(a, m)) return false;
  const z = a.inhalt;
  const gespeichert = (id) => {
    const r = db?.prepare("select inhalt from daten where sammlung = 'zeiten' and id = ? and geloescht = 0").get(id);
    return r ? JSON.parse(r.inhalt) : null;
  };
  if (z.art === 'vertrag') return false;
  if (z.art === 'freigabe') {
    const alt = gespeichert(a.id);
    return !z.freigegeben && !alt?.freigegeben;
  }
  const freigegeben = (monat) => !!gespeichert(`${m.id}_freigabe_${monat}`)?.freigegeben;
  const vorher = gespeichert(a.id);
  return !freigegeben(monatDerZeit(z)) && !(vorher && freigegeben(monatDerZeit(vorher)));
}

/** Lesen: Zeiten anderer nur mit dem Recht; das Verbandbuch (Gesundheitsdaten) nur der Verwalter, sonst die eigenen Einträge. */
export function zeitenFiltern(ergebnis, m) {
  const alleZeiten = darfAlleZeiten(m);
  if (alleZeiten && m.rolle === 'verwalter') return ergebnis;
  return {
    ...ergebnis,
    aenderungen: ergebnis.aenderungen.filter((a) => {
      if (a.sammlung === 'zeiten') return alleZeiten || a.id.startsWith(`${m.id}_`);
      if (a.sammlung === 'verbandbuch') return m.rolle === 'verwalter' || a.id.startsWith(`${m.id}_`) || (!a.geloescht && a.inhalt?.person?.id === m.id);
      return true;
    }),
  };
}
const darfLager = (m) => m.rolle === 'verwalter' || m.bereiche === null || m.bereiche === undefined || hatRecht(m, RECHT_LAGER);

export function erlaubte(liste, mitarbeiter, db) {
  const etikettVorher = db ? db.prepare("select inhalt from daten where sammlung = 'etiketten' and id = ? and geloescht = 0") : null;
  return liste.filter((a) => {
    // Etikettenregister: Ausweiskarten (Kennung → Mitarbeiter) ordnet nur ein Verwalter zu, sperrt
    // oder löscht sie. Ein Mitarbeiter darf eine Ausweiskarte auch nicht zu etwas anderem umdeuten.
    if (a.sammlung === 'etiketten') {
      if (mitarbeiter.rolle === 'verwalter') return true;
      if (!a.geloescht && a.inhalt?.art === 'ausweis') return false;
      const vorher = etikettVorher?.get(a.id);
      return !vorher || JSON.parse(vorher.inhalt)?.art !== 'ausweis';
    }
    if (a.sammlung === 'schritte') return a.id.startsWith(`${mitarbeiter.id}_`) && (a.geloescht || a.inhalt.mitarbeiter === mitarbeiter.id);
    if (a.sammlung === 'aktionen') return mitarbeiter.rolle === 'verwalter';
    if (a.sammlung === 'zeiten') return zeitErlaubt(a, mitarbeiter, db);
    // Fremdfahrer schreiben nur Ereignisse ihrer eigenen Touren, sonst nichts.
    // Eigene Meldungen darf man zurücknehmen (Grabstein): geprüft am gespeicherten Absender.
    const eigeneMeldung = () => (a.geloescht ? (() => {
      const z = db?.prepare("select inhalt from daten where sammlung = 'tourereignisse' and id = ?").get(a.id);
      return !z || JSON.parse(z.inhalt)?.von === mitarbeiter.id;
    })() : a.inhalt?.von === mitarbeiter.id);
    if (mitarbeiter.rolle === 'fremdfahrer' || mitarbeiter.rolle === 'partner') return a.sammlung === 'dateien' || (a.sammlung === 'tourereignisse' && eigeneMeldung());
    // Touren plant die Disposition (Verwalter oder Recht „Disposition“); Fahrer melden nur Ereignisse.
    if (a.sammlung === 'touren') return darfDispo(mitarbeiter);
    if (a.sammlung === 'tourereignisse') return darfDispo(mitarbeiter) || eigeneMeldung();
    if (a.sammlung === 'lieferanten') return darfEinkauf(mitarbeiter);
    if (a.sammlung === 'bestellungen') return darfEinkauf(mitarbeiter) || darfLager(mitarbeiter);
    // Firmendaten, Logo und Firmenfarben ändert nur ein Verwalter — sonst trüge ein Mitarbeiter einen
    // anderen Absender auf allen Geräten des Betriebs ein.
    if (a.sammlung === 'roh' && FIRMA_ROH.includes(a.id)) return mitarbeiter.rolle === 'verwalter';
    // Arbeitsschutz: Gefährdungsbeurteilungen und Nachweise der Leute pflegt der Verwalter (sonst
    // trüge sich jemand selbst einen Staplerschein ein); Unterweisungen darf jeder eintragen.
    if (a.sammlung === 'gefaehrdungen' || a.sammlung === 'nachweise' || a.sammlung === 'gefahrstoffe' || a.sammlung === 'formulare') return mitarbeiter.rolle === 'verwalter';
    // Verbandbuch: jeder trägt ein (Kennung beginnt mit der eigenen ID), ändern nur eigene oder der Verwalter.
    // Unterweisung auf dem eigenen Handy bestätigen: nur für sich selbst (Kennung <eigene ID>_<Unterweisung>);
    // der Verwalter darf eine Bestätigung nur entfernen.
    if (a.sammlung === 'unterweisungsbestaetigungen') return (a.id.startsWith(`${mitarbeiter.id}_`) && (a.geloescht || a.inhalt?.person?.id === mitarbeiter.id)) || (mitarbeiter.rolle === 'verwalter' && !!a.geloescht);
    if (a.sammlung === 'verbandbuch') return mitarbeiter.rolle === 'verwalter' || a.id.startsWith(`${mitarbeiter.id}_`);
    return true;
  });
}

/** Präfix, unter dem der Dienst hinter dem Proxy hängt, aus MONTIX_PRAEFIX. Bei uns leer:
 *  der Dienst hat seit dem Umzug eine eigene Adresse (montix.feif.space) und ist dort die
 *  Wurzel. Gebraucht wird das nur von Betrieben, die ihn unter einem Pfad betreiben. */
const pfadPraefix = () => process.env.MONTIX_PRAEFIX ?? '';

export const VERTRAG_FASSUNG = '2026-11-15';

export function erstelleDienst(
  speicher,
  {
    vertragPflicht = process.env.MONTIX_VERTRAG === 'pflicht',
    ordner = process.env.MONTIX_DATEN ?? './daten',
    // E-Mail an Notfallkontakte bei Alleinarbeits-Alarm; in Tests ein Fänger.
    senden = erstelleSendmail(),
    // Push über Expo; in Tests ein Fänger.
    push = erstelleExpoPush(),
    // Zeitgeber für Alarme (jede Minute, alle Betriebe) — in Tests aus, dort ruft man pruefeAlarme().
    zeitgeber = true,
    // Privatkonten (Alleinarbeit ohne Betrieb): Obergrenze je Adresse und Tag.
    privatJeTag = Number(process.env.MONTIX_PRIVAT_JE_TAG ?? 5),
    // Abruf beim Geodienst für Adressvorschläge; in Tests ein Fänger.
    adresseHolen = fetch,
    // Postfach-Verwaltung (MONTIX_POSTFACH_*); in Tests eigene Werte.
    postfachUmgebung = process.env,
    // Prüfung von Store-Käufen (MONTIX_PLAY_*); in Tests eigene Werte und ein Fänger statt fetch.
    aboUmgebung = process.env,
    aboHolen = fetch,
    // Mail-Client je Mitarbeiter (IMAP/SMTP über mail-helfer.py); in Tests ein Fänger.
    mailHelfer = pythonHelfer,
    // Barkasse: TSE_* als Vorgabe auf einem eigenen Server; in Tests ein Fänger statt https zu fiskaly.
    tseUmgebung = process.env,
    tseAnfrage,
    // Partner-Weiterleitung zu anderen Servern (Touren); in Tests ein Fänger statt fetch.
    fernHolen = fetch,
  } = {},
) {
  const zahlungsweg = erstelleZahlung(speicher.speicherOrt ?? ordner);
  // Zentrales Hosting (AVV-Pflicht) = feste 15 Minuten für die Sammelmail, außer mit Serverpaket.
  const raeume = erstelleRaeume({ ordner: speicher.speicherOrt ?? ordner, senden, push, zentral: vertragPflicht });
  // Öffentliche Adresse des Dienstes (für Links in Mails); ohne Umgebung die zuletzt gesehene.
  let letzteBasis = process.env.MONTIX_OEFFENTLICH ?? 'http://localhost';
  const basisVon = (req) => {
    letzteBasis = process.env.MONTIX_OEFFENTLICH ?? `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers['x-forwarded-host'] ?? req.headers.host}${pfadPraefix(req)}`;
    return letzteBasis;
  };
  const mailWeg = erstelleMail({ ordner: speicher.speicherOrt ?? ordner, helfer: mailHelfer });
  const abos = erstelleAbos({ ordner: speicher.speicherOrt ?? ordner, umgebung: aboUmgebung, holen: aboHolen });
  const postfach = erstellePostfach({ ordner: speicher.speicherOrt ?? ordner, senden, basis: () => letzteBasis, speicher, abos, umgebung: postfachUmgebung });
  /** Stand eines Betriebs: laufendes Store-Abo vor Testbetrieb, sonst das letzte Abo. */
  const betriebStand = (id) => {
    const abo = abos.stand(id);
    if (abo?.aktiv) return abo;
    return postfach.betriebStand(id) ?? abo;
  };
  const kasse = erstelleKasse({ ordner: speicher.speicherOrt ?? ordner, zentral: vertragPflicht, betriebStand, umgebung: tseUmgebung, anfrage: tseAnfrage });
  /** Push an Kollegen und Empfänger, wenn bei einer Person Alarm ist oder sie sich wieder meldet. */
  const alarmPush = (db, a, entwarnung = false) => {
    const ziele = tokensVon(db, alarmZiele(db, a.mitarbeiter));
    const titel = entwarnung ? `Entwarnung: ${a.name}` : `ALARM: ${a.name}`;
    const text = entwarnung ? 'Hat sich wieder gemeldet.' : a.grund === 'notruf' ? 'Notruf bei Alleinarbeit. Bitte sofort kümmern.' : 'Hat sich bei Alleinarbeit nicht gemeldet. Bitte sofort kümmern.';
    void push(ziele.map((t) => pushNachricht(t, titel, text, !entwarnung, '/alleinarbeit')));
  };
  const pruefeAlarme = () => {
    for (const b of speicher.alleBetriebe()) {
      try {
        for (const a of alarmeMelden(b.db, senden, b)) alarmPush(b.db, a);
      } catch (e) {
        console.error('Alarmprüfung', b.id, e);
      }
    }
  };
  /** Antwort eines Kunden auf eine Terminmitteilung: Push an die Zuständigen und an die Person, die mitgeteilt hat. */
  const terminGemeldet = (db, r) => {
    const ziele = [...new Set([r.von, ...JSON.parse(r.zustaendig ?? '[]')])];
    const wer = r.kunde ?? 'Der Kunde';
    const titel = r.status === 'bestaetigt' ? `Termin bestätigt: ${wer}` : `Termin passt nicht: ${wer}`;
    const text = `${r.titel}${r.antwort ? ` – „${r.antwort.slice(0, 120)}“` : ''}`;
    void push(tokensVon(db, ziele).map((t) => pushNachricht(t, titel, text, false, `/calendar/${r.termin}`)));
  };
  const privatZaehler = new Map();
  const fehlerZaehler = new Map();
  const testZaehler = new Map();
  const adressZaehler = new Map();
  const adresseSuchen = erstelleAdresssuche();
  // Touren: Orte der Stopps (eigene Adressdatei) und Fahrzeiten (openrouteservice, wenn MONTIX_ORS_KEY gesetzt).
  const ortung = erstelleOrtung({ holen: adresseHolen });
  const partner = erstellePartner({ speicher, holen: fernHolen });
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return antwort(res, 204);
      const url = new URL(req.url ?? '/', 'http://x');
      // Hinter einem Reverse-Proxy mit Präfix (z. B. /montix) dasselbe Ziel.
      const pfad = url.pathname.replace(/^\/montix(?=\/)/, '');

      if (req.method === 'GET' && pfad === '/status') return antwort(res, 200, { dienst: 'montix-abgleich', version: VERSION });

      // Wer die Adresse im Browser aufruft: Bei uns (zentral) geht es auf die Produktseite; ein
      // eigener Server eines Betriebs zeigt nur einen kurzen Hinweis, wofür die Adresse da ist.
      if ((req.method === 'GET' || req.method === 'HEAD') && (pfad === '/' || pfad === '/montix' || pfad === '/montix/')) {
        if (vertragPflicht) {
          res.writeHead(302, { location: process.env.MONTIX_STARTSEITE ?? 'https://feif.space/apps-software/montix/', 'cache-control': 'no-store' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
        return res.end(
          '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Montix-Server</title>' +
            '<body style="font:17px/1.5 system-ui,sans-serif;max-width:34em;margin:3em auto;padding:0 16px">' +
            '<h1 style="font-size:1.4em">Montix-Server</h1><p>Hier läuft der Abgleich für die Geräte eines Betriebs. Diese Adresse trägt man in der App unter „Einstellungen → Abgleich mit dem Betrieb“ als eigenen Server ein; im Browser gibt es hier nichts zu sehen.</p>' +
            '<p><a href="https://feif.space/apps-software/montix/">Mehr über Montix</a></p></body></html>',
        );
      }

      if (req.method === 'POST' && pfad === '/anmelden') {
        const { code, geraet } = await koerper(req);
        const ok = speicher.anmelden(code, geraet);
        if (!ok) throw new Fehler(403, 'Einladungscode unbekannt, abgelaufen oder schon benutzt');
        return antwort(res, 200, ok);
      }

      // Öffentliche Seite für den Kunden: wie weit der Mitarbeiter ungefähr noch entfernt ist.
      const weg = pfad.match(/^\/weg\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'GET' && weg) {
        const html = wegSeite(speicher, weg[1]);
        res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
        return res.end(html ?? '<!doctype html><meta charset="utf-8"><p>Diese Fahrt gibt es nicht (mehr).</p>');
      }

      // Karten selbst ausgeliefert (Bibliotheken und Kacheln) — siehe karte.mjs.
      if (karteWeg(req, res, pfad)) return;
      if (adressenWeg(req, res, pfad)) return;

      // Geräte, die mit Montix funktionieren (Testdruck-Rückmeldungen) — siehe geraete.mjs.
      if (req.method === 'POST' && pfad === '/geraete/meldung') {
        const wo = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        const schluessel = `g|${new Date().toISOString().slice(0, 10)}|${wo}`;
        const n = adressZaehler.get(schluessel) ?? 0;
        if (n >= 50) throw new Fehler(429, 'Heute schon viele Meldungen von hier.');
        adressZaehler.set(schluessel, n + 1);
        const ok = geraetMelden(geraeteDb(speicher.speicherOrt ?? ordner), await koerper(req));
        return antwort(res, ok ? 200 : 400, ok ? { ok: true } : { fehler: 'Angaben unvollständig' });
      }
      // Hilfe ohne eigenen Text, gemeldet aus dem Hilfemodus der App — siehe hilfe.mjs.
      if (req.method === 'POST' && pfad === '/hilfe/luecke') {
        const wo = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        const schluessel = `h|${new Date().toISOString().slice(0, 10)}|${wo}`;
        const n = adressZaehler.get(schluessel) ?? 0;
        if (n >= 100) throw new Fehler(429, 'Heute schon viele Meldungen von hier.');
        adressZaehler.set(schluessel, n + 1);
        const ok = lueckeMelden(geraeteDb(speicher.speicherOrt ?? ordner), await koerper(req), senden);
        return antwort(res, ok ? 200 : 400, ok ? { ok: true } : { fehler: 'Angaben unvollständig' });
      }
      if (req.method === 'GET' && pfad === '/geraete.json') return antwort(res, 200, { geraete: geraeteListe(geraeteDb(speicher.speicherOrt ?? ordner)) });
      // Die Seite dazu steht im Design der Website auf feif.space und liest /geraete.json.
      if ((req.method === 'GET' || req.method === 'HEAD') && (pfad === '/geraete' || pfad === '/geraete/')) {
        res.writeHead(301, { location: GERAETE_SEITE });
        return res.end();
      }

      // Touren: öffentliche Seite für den Empfänger einer Lieferung — siehe touren.mjs.
      const sendung = pfad.match(/^\/sendung\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'GET' && sendung) {
        const html = await sendungSeite(speicher, ortung, sendung[1]);
        res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
        return res.end(html ?? '<!doctype html><meta charset="utf-8"><p>Diese Sendung gibt es nicht (mehr).</p>');
      }

      // Touren: Karte aller Fahrzeuge über einen Einmal-Link der Disposition — siehe touren.mjs.
      const lk = pfad.match(/^\/lagekarte\/([A-Za-z0-9_-]+)(\/lage)?$/);
      if (req.method === 'GET' && lk) {
        const r = await lagekarteSeite(speicher, ortung, lk[1], !!lk[2]);
        if (r?.json) return antwort(res, 200, r.json);
        if (!r) {
          if (lk[2]) return antwort(res, 404, { fehler: 'Link abgelaufen' });
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
          return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:17px system-ui;margin:2em">Dieser Kartenlink ist abgelaufen. In Montix die Karte noch einmal öffnen.</p>');
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
        return res.end(r.html);
      }

      // Terminmitteilung: Kunde bestätigt oder lehnt ab — siehe terminmitteilung.mjs.
      // Postfach montix@ mit Verwaltung für den Anbieter — siehe postfach.mjs.
      if (await postfach.weg(req, res, pfad)) return;
      if (pfad.startsWith('/t/') && (await terminOeffentlich(speicher, req, res, pfad, terminGemeldet))) return;

      // Geteilte Mappen (Pläne, Fotos, PDF) für andere Firmen — siehe freigaben.mjs.
      if (pfad.startsWith('/teilen/') && (await teilenOeffentlich(speicher, req, res, pfad, url))) return;

      // Objektraum: Seite eines Teilnehmers (andere Firma, Auftraggeber) — siehe raeume.mjs.
      if (pfad.startsWith('/objekt/') && (await raeume.oeffentlich(speicher, req, res, pfad, url, () => basisVon(req)))) return;

      // Kundenportal: Seite des Kunden — siehe portal.mjs.
      if (pfad.startsWith('/kunde/') && (await portalOeffentlich(speicher, req, res, pfad, url, push, { basis: basisVon(req), zahlung: zahlungsweg }))) return;

      // Adressvorschläge beim Tippen (auch ohne Anmeldung, auch Einzelplatz) — siehe adresse.mjs.
      if (req.method === 'GET' && pfad === '/adresse/info') return antwort(res, 200, adresseInfo());
      if (req.method === 'GET' && pfad === '/adresse') {
        const wo = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        const schluessel = `${new Date().toISOString().slice(0, 10)}|${wo}`;
        const n = adressZaehler.get(schluessel) ?? 0;
        if (n >= 2000) throw new Fehler(429, 'Heute gab es von hier schon sehr viele Adressvorschläge.');
        if (adressZaehler.size > 10000) adressZaehler.clear();
        adressZaehler.set(schluessel, n + 1);
        try {
          return antwort(res, 200, await adresseSuchen(url.searchParams.get('q'), url.searchParams.get('lat'), url.searchParams.get('lon')));
        } catch (e) {
          throw new Fehler(e.status ?? 502, e.status ? e.message : 'Adressvorschläge gerade nicht erreichbar.');
        }
      }

      // Fehler melden aus der App (auch ohne Anmeldung) — siehe fehler.mjs.
      if (req.method === 'POST' && pfad === '/fehler') {
        const wo = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        const schluessel = `${new Date().toISOString().slice(0, 10)}|${wo}`;
        const n = fehlerZaehler.get(schluessel) ?? 0;
        if (n >= 20) throw new Fehler(429, 'Heute kamen von hier schon viele Meldungen. Bitte morgen noch einmal oder per E-Mail an mail@feif.space.');
        if (fehlerZaehler.size > 10000) fehlerZaehler.clear();
        fehlerZaehler.set(schluessel, n + 1);
        const t = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const angemeldet = t ? speicher.pruefe(t) : null;
        try {
          return antwort(res, 200, fehlerMelden(await koerper(req), angemeldet || null, senden));
        } catch (e) {
          throw new Fehler(e.status ?? 400, e.message);
        }
      }

      // Privatkonto nur für die Alleinarbeit (Einzelplatz): sofort angemeldet, ohne Einladung.
      if (req.method === 'POST' && pfad === '/privat') {
        const wo = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        const schluessel = `${new Date().toISOString().slice(0, 10)}|${wo}`;
        const n = privatZaehler.get(schluessel) ?? 0;
        if (n >= privatJeTag) throw new Fehler(429, 'Heute wurden von hier schon genug Konten angelegt. Bitte morgen noch einmal.');
        if (privatZaehler.size > 10000) privatZaehler.clear();
        privatZaehler.set(schluessel, n + 1);
        const { name, geraet } = await koerper(req);
        if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Fehler(400, 'Bitte einen Namen angeben');
        return antwort(res, 200, speicher.privatAnlegen(name.trim(), geraet));
      }

      // Testbetrieb direkt aus der App: Betrieb anlegen, das Gerät ist gleich als Verwalter angemeldet.
      // Nur auf dem zentralen Server (Vertragspflicht), höchstens drei je Adresse und Tag.
      if (req.method === 'POST' && pfad === '/testbetrieb') {
        if (!vertragPflicht) throw new Fehler(404, 'Unbekannter Weg');
        const wo = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        const schluessel = `${new Date().toISOString().slice(0, 10)}|${wo}`;
        const n = testZaehler.get(schluessel) ?? 0;
        if (n >= 3) throw new Fehler(429, 'Heute wurden von hier schon genug Testbetriebe angelegt. Bitte morgen noch einmal oder an mail@feif.space schreiben.');
        if (testZaehler.size > 10000) testZaehler.clear();
        const { betrieb, name, email, geraet } = await koerper(req);
        const b = typeof betrieb === 'string' ? betrieb.trim() : '';
        const nm = typeof name === 'string' ? name.trim() : '';
        const em = typeof email === 'string' ? email.trim() : '';
        if (!b || b.length > 120) throw new Fehler(400, 'Bitte den Namen des Betriebs angeben');
        if (!nm || nm.length > 80) throw new Fehler(400, 'Bitte Ihren Namen angeben');
        if (em && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(em)) throw new Fehler(400, 'Die E-Mail-Adresse sieht nicht richtig aus');
        testZaehler.set(schluessel, n + 1);
        const id = speicher.betriebAnlegen(b);
        const e = speicher.einladen(id, nm, 'verwalter', 1);
        const konto = speicher.anmelden(e.code, typeof geraet === 'string' ? geraet.slice(0, 80) : 'Gerät');
        const test = postfach.testbetriebMerken(id, { name: nm, betrieb: b, email: em });
        return antwort(res, 200, { ...konto, test });
      }

      // Meldungen der Stores über Abos (Verlängerung, Kündigung, Erstattung) — siehe abo.mjs.
      if (req.method === 'POST' && pfad === '/kauf/apple-meldung') {
        try {
          return antwort(res, 200, abos.appleMeldung(await koerper(req)));
        } catch (e) {
          throw new Fehler(e.status ?? 400, e.message);
        }
      }
      if (req.method === 'POST' && pfad === '/kauf/play-meldung') {
        const geheim = aboUmgebung.MONTIX_PLAY_MELDUNG;
        if (!geheim || url.searchParams.get('schluessel') !== geheim) throw new Fehler(401, 'Nicht berechtigt');
        try {
          return antwort(res, 200, await abos.playMeldung(await koerper(req)));
        } catch (e) {
          throw new Fehler(e.status ?? 400, e.message);
        }
      }

      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const wer = token && speicher.pruefe(token);
      if (!wer) throw new Fehler(401, 'Gerät nicht angemeldet');

      const vertrag = speicher.vertrag(wer.db);

      // Abo aus dem Store prüfen und dem Betrieb gutschreiben. Seit dem Preis je Mitarbeiter
      // (16.11.2026) bucht jeder Mitarbeiter sein Einzel Plus selbst; die Plätze addieren sich.
      if (req.method === 'POST' && pfad === '/kauf/pruefen') {
        if (wer.mitarbeiter.rolle === 'empfaenger') throw new Fehler(403, 'Empfänger buchen nicht für den Betrieb.');
        const { store, token: kaufToken, jws } = await koerper(req);
        try {
          const r = store === 'play' ? await abos.playPruefen(String(kaufToken ?? ''), wer.betrieb.id) : store === 'apple' ? abos.applePruefen(String(jws ?? ''), wer.betrieb.id) : null;
          if (!r) throw new KaufFehler('Unbekannter Store.');
          if (r.status === 'aktiv') postfach.testGebucht(wer.betrieb.id);
          return antwort(res, 200, { ...r, stand: betriebStand(wer.betrieb.id) });
        } catch (e) {
          throw new Fehler(e.status ?? 400, e.message);
        }
      }
      if (req.method === 'GET' && pfad === '/ich') {
        return antwort(res, 200, {
          betrieb: wer.betrieb,
          mitarbeiter: wer.mitarbeiter,
          vertrag: { pflicht: vertragPflicht, fassung: VERTRAG_FASSUNG, stand: vertrag },
          // Testbetrieb bis …, gebucht oder null (nur auf dem zentralen Server bekannt).
          stand: betriebStand(wer.betrieb.id),
          // Kennung des Betriebs für Store-Käufe (Apple appAccountToken; bei Play die Betriebskennung selbst).
          kaufkennung: betriebUuid(wer.betrieb.id),
          pruefschluessel: speicher.oeffentlicherSchluessel,
          rechte: speicher.signierteRechte(wer.betrieb.id, wer.roh),
          // Buchbare Module: ob die Barkasse für diesen Betrieb freigeschaltet ist (sonst mit Grund).
          // Barkasse: Betrieb freigeschaltet, ist DIESES Gerät eine Kasse, darf die Person kassieren.
          module: { kasse: kasse.status(wer, hash(token).slice(0, 12)) },
        });
      }

      if (req.method === 'POST' && pfad === '/vertrag') {
        if (wer.mitarbeiter.rolle !== 'verwalter') throw new Fehler(403, 'Zustimmen kann nur ein Verwalter des Betriebs');
        const { fassung } = await koerper(req);
        if (fassung !== VERTRAG_FASSUNG) throw new Fehler(409, `Bitte der aktuellen Fassung (${VERTRAG_FASSUNG}) zustimmen`);
        return antwort(res, 200, speicher.vertragZustimmen(wer.db, fassung, wer.mitarbeiter));
      }

      // Löschen aus der App (Play: Kontolöschung in der App).
      //   art 'geraet'  → nur dieses Gerät abmelden
      //   art 'person'  → die eigene Person (Empfänger, Mitarbeiter, Privatkonto: dann der ganze Privat-„Betrieb“)
      //   art 'betrieb' → ganzer Betrieb, nur Verwalter, mit Namen zur Bestätigung
      if (req.method === 'POST' && pfad === '/konto/loeschen') {
        const { art, bestaetigung } = await koerper(req);
        if (art === 'geraet') {
          speicher.geraetAbmelden(wer.db, token);
          return antwort(res, 200, { geloescht: 'geraet' });
        }
        if (art === 'person') {
          if (wer.betrieb.art === 'privat') {
            speicher.betriebLoeschen(wer.betrieb.id);
            return antwort(res, 200, { geloescht: 'konto' });
          }
          if (wer.mitarbeiter.rolle === 'verwalter') {
            const andere = wer.db.prepare("select count(*) as n from mitarbeiter where rolle = 'verwalter' and aktiv = 1 and id != ?").get(wer.mitarbeiter.id).n;
            if (!andere) throw new Fehler(409, 'Sie sind der einzige Verwalter. Erst einen anderen Verwalter bestimmen oder den ganzen Betrieb löschen.');
          }
          speicher.personLoeschen(wer.db, wer.mitarbeiter.id);
          return antwort(res, 200, { geloescht: 'person' });
        }
        if (art === 'betrieb') {
          if (wer.mitarbeiter.rolle !== 'verwalter' || wer.betrieb.art === 'privat') throw new Fehler(403, 'Den Betrieb löschen kann nur ein Verwalter');
          if (String(bestaetigung ?? '').trim() !== wer.betrieb.name) throw new Fehler(400, 'Zur Bestätigung bitte den Namen des Betriebs genau eintippen');
          speicher.betriebLoeschen(wer.betrieb.id);
          return antwort(res, 200, { geloescht: 'betrieb' });
        }
        throw new Fehler(400, 'art ist geraet, person oder betrieb');
      }

      // Empfänger (Angehörige) und Privatkonten dürfen nur die Alleinarbeit: Alarme sehen bzw. selbst
      // allein arbeiten, Empfänger einladen, Notfallkontakte pflegen. Kein Abgleich, keine Kundendaten.
      const empfaenger = wer.mitarbeiter.rolle === 'empfaenger';
      const nurAllein = empfaenger || wer.betrieb.art === 'privat';
      const alleinWeg = pfad.startsWith('/alleinarbeit') || pfad.startsWith('/push/') || pfad === '/notfallkontakte' || (pfad.startsWith('/empfaenger') && !empfaenger);
      if (nurAllein && !alleinWeg) {
        throw new Fehler(403, empfaenger ? 'Dieses Gerät empfängt nur Alarme der Alleinarbeit.' : 'Dieses Konto ist nur für die Alleinarbeit.');
      }
      if (empfaenger && pfad.startsWith('/empfaenger')) throw new Fehler(403, 'Nur für die Person selbst');
      // Fremdfahrer (Subunternehmer, ohne eigene Lizenz): nur Touren, Abgleich (gefiltert), Nachrichten, Push.
      // Partnerbetriebe (Rolle 'partner', Verbund Server zu Server) genauso, dazu /ich für die Prüfung.
      const gastRolle = wer.mitarbeiter.rolle === 'fremdfahrer' || wer.mitarbeiter.rolle === 'partner';
      if (gastRolle && !(pfad === '/abgleich' || pfad === '/ich' || pfad.startsWith('/touren/') || pfad === '/touren' || pfad.startsWith('/push/') || pfad.startsWith('/nachricht') || pfad === '/kollegen')) {
        throw new Fehler(403, 'Fremdfahrer sehen nur ihre Touren.');
      }

      // Empfänger für die eigene Person auflisten und entfernen (Einladen: unten, nach der AVV-Prüfung).
      if (pfad === '/empfaenger' && req.method === 'GET') return antwort(res, 200, speicher.empfaengerListe(wer.db, wer.mitarbeiter.id));
      if (pfad === '/empfaenger/entfernen' && req.method === 'POST') {
        const { id } = await koerper(req);
        if (!speicher.empfaengerEntfernen(wer.db, wer.mitarbeiter.id, String(id ?? ''))) throw new Fehler(404, 'Unbekannter Empfänger');
        return antwort(res, 200, { ok: true });
      }

      // Kartenzahlung (Stripe Terminal) über das Konto des Betriebs — siehe zahlung.mjs.
      try {
        const z = await zahlungsweg(req.method, pfad, wer, () => koerper(req));
        if (z !== undefined) return antwort(res, 200, z);
      } catch (e) {
        if (e instanceof ZahlFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // Auch Einladungen erst nach Zustimmung: Sonst könnte ein Betrieb Geräte anmelden und
      // (etwa über die Alleinarbeit, die bewusst ausgenommen ist) Daten verarbeiten, ohne je zuzustimmen.
      const datenweg = pfad === '/abgleich' || pfad === '/ausweis' || pfad.startsWith('/mail/') || pfad === '/nummer' || pfad.startsWith('/nachricht') || pfad === '/kollegen' || pfad === '/einladung' || pfad === '/empfaenger/einladung' || pfad.startsWith('/freigabe') || pfad === '/raeume' || pfad === '/raum' || pfad.startsWith('/raum/') || pfad.startsWith('/termin/') || (pfad.startsWith('/kasse/') && pfad !== '/kasse/status');
      // Privatkonten sind keine Betriebe — dort gibt es keine Auftragsverarbeitung, also keinen AVV.
      if (vertragPflicht && datenweg && wer.betrieb.art !== 'privat' && vertrag?.fassung !== VERTRAG_FASSUNG) {
        throw new Fehler(451, 'Der Betrieb hat dem Vertrag zur Auftragsverarbeitung noch nicht zugestimmt. Ein Verwalter erledigt das unter Einstellungen → Abgleich.');
      }

      // Barkasse mit TSE (buchbares Modul) — siehe kasse.mjs.
      try {
        const k = await kasse.weg(req.method, pfad, url, wer, () => koerper(req), hash(token).slice(0, 12));
        if (k instanceof KassenDatei) {
          res.writeHead(200, {
            'content-type': k.typ,
            'content-length': k.daten.length,
            'content-disposition': `attachment; filename="${k.name}"`,
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'content-disposition',
          });
          return res.end(k.daten);
        }
        if (k !== undefined) return antwort(res, 200, k);
      } catch (e) {
        if (e instanceof KassenFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // Alleinarbeit (Totmannschalter) — siehe alleinarbeit.mjs. Arbeitsschutz: läuft auch ohne
      // Zustimmung zum AVV weiter, ein Alarm darf nicht an einer Formalie hängen.
      try {
        if (pfad === '/empfaenger/einladung' && req.method === 'POST') {
          const { name } = await koerper(req);
          if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Fehler(400, 'Bitte einen Namen angeben');
          return antwort(res, 200, speicher.empfaengerEinladen(wer.betrieb.id, wer.mitarbeiter.id, name.trim()));
        }
        const melden = (art, eintrag) => {
          if (art === 'entwarnung') {
            entwarnen(wer.db, eintrag, senden, wer.betrieb);
            alarmPush(wer.db, eintrag, true);
          } else for (const n of alarmeMelden(wer.db, senden, wer.betrieb)) alarmPush(wer.db, n);
        };
        const a = await alleinarbeitWeg(req.method, pfad, wer, () => koerper(req), melden, senden);
        if (a !== undefined) return antwort(res, 200, a);
      } catch (e) {
        if (e instanceof AlleinFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // Unterwegs zum Kunden — siehe unterwegs.mjs. Der Link nimmt die öffentliche Adresse des Dienstes.
      try {
        const basis = process.env.MONTIX_OEFFENTLICH ?? `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers['x-forwarded-host'] ?? req.headers.host}${pfadPraefix(req)}`;
        const u = await unterwegsWeg(req.method, pfad, wer, () => koerper(req), basis);
        if (u !== undefined) return antwort(res, 200, u);
      } catch (e) {
        if (e instanceof WegFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // „Andere Firmen“: Fremdfahrer und Partnerbetriebe einladen, auflisten, sperren — auch für die
      // Disposition (in einer Spedition laden Disponenten die Subunternehmer ein), aber nur diese Rollen.
      if (pfad === '/touren/gaeste' || pfad === '/touren/einladung' || pfad === '/touren/gast/aktiv') {
        if (!darfDispo({ ...wer.mitarbeiter, bereiche: wer.roh?.bereiche ?? null })) throw new Fehler(403, 'Nur für Verwalter und Disposition');
        if (req.method === 'GET' && pfad === '/touren/gaeste') return antwort(res, 200, speicher.gaesteListe(wer.db));
        if (req.method === 'POST' && pfad === '/touren/einladung') {
          const { name, rolle, id } = await koerper(req);
          if (!['fremdfahrer', 'partner'].includes(rolle)) throw new Fehler(400, 'Rolle ist fremdfahrer oder partner');
          // Neuer Code für einen schon eingeladenen Gast: über seinen Namen (einladen() findet ihn).
          const vorhanden = id ? speicher.gaesteListe(wer.db).find((g) => g.id === id) : null;
          const n = vorhanden?.name ?? (typeof name === 'string' ? name.trim() : '');
          if (!n || n.length > 80) throw new Fehler(400, 'Name fehlt');
          const e = speicher.einladen(wer.betrieb.id, n, vorhanden?.rolle ?? rolle);
          return antwort(res, 200, { code: e.code, gueltigBis: e.gueltigBis, id: e.mitarbeiter });
        }
        if (req.method === 'POST' && pfad === '/touren/gast/aktiv') {
          const { id, aktiv } = await koerper(req);
          if (!speicher.gaesteListe(wer.db).some((g) => g.id === id)) throw new Fehler(404, 'Unbekannt');
          speicher.mitarbeiterAktiv(wer.db, id, !!aktiv);
          return antwort(res, 200, { ok: true });
        }
      }

      // Touren an Partnerbetriebe übernehmen (Verbund Server zu Server) — siehe partner.mjs.
      try {
        const pw = await partner.weg(req.method, pfad, wer, () => koerper(req));
        if (pw !== undefined) return antwort(res, 200, pw);
      } catch (e) {
        if (e instanceof PartnerFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // Touren für Speditionen — siehe touren.mjs.
      try {
        const tw = await tourenWeg(req.method, pfad, url, wer, () => koerper(req), basisVon(req), senden, ortung, sendungMail);
        if (tw !== undefined) return antwort(res, 200, tw);
      } catch (e) {
        if (e instanceof TourFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // Termine dem Kunden mitteilen — siehe terminmitteilung.mjs.
      try {
        const tm = await terminWeg(req.method, pfad, wer, () => koerper(req), basisVon(req), senden);
        if (tm !== undefined) return antwort(res, 200, tm);
      } catch (e) {
        if (e instanceof TerminFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // Mappen teilen — siehe freigaben.mjs. Link mit der öffentlichen Adresse des Dienstes.
      try {
        const basis = process.env.MONTIX_OEFFENTLICH ?? `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers['x-forwarded-host'] ?? req.headers.host}${pfadPraefix(req)}`;
        const fg = freigabeWeg(req.method, pfad, wer, (grenze) => koerper(req, grenze), basis, senden);
        if (fg !== undefined) return antwort(res, 200, await fg);
      } catch (e) {
        if (e instanceof FreigabeFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // Objektraum (Betrieb) — siehe raeume.mjs.
      try {
        const rw = raeume.weg(req.method, pfad, url, wer, (grenze) => koerper(req, grenze), basisVon(req));
        if (rw !== undefined) return antwort(res, 200, await rw);
      } catch (e) {
        if (e instanceof RaumFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // Kundenportal (Betrieb) — siehe portal.mjs.
      try {
        const pw = portalWeg(req.method, pfad, url, wer, (grenze) => koerper(req, grenze), basisVon(req));
        if (pw !== undefined) return antwort(res, 200, await pw);
      } catch (e) {
        if (e instanceof PortalFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // Push-Token dieses Geräts — siehe push.mjs.
      const pw = pushWeg(req.method, pfad, wer, () => koerper(req), hash(token));
      if (pw !== undefined) {
        try {
          return antwort(res, 200, await pw);
        } catch (e) {
          throw new Fehler(e.status ?? 500, e.message);
        }
      }

      // E-Mail je Mitarbeiter — siehe mail.mjs.
      try {
        const m = await mailWeg(req.method, pfad, url, wer, () => koerper(req));
        if (m !== undefined) return antwort(res, 200, m);
      } catch (e) {
        if (e instanceof MailFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      // Nachrichten zwischen Mitarbeitern — siehe nachrichten.mjs.
      try {
        const nachPost = (ziele, von, text) => void push(tokensVon(wer.db, ziele).map((t) => pushNachricht(t, `Nachricht von ${von}`, text)));
        const n = await nachrichtenweg(req.method, pfad, url, wer, () => koerper(req), nachPost);
        if (n !== undefined) return antwort(res, 200, n);
      } catch (e) {
        if (e instanceof NachrichtFehler) throw new Fehler(e.status, e.message);
        throw e;
      }

      if (req.method === 'GET' && pfad === '/abgleich') {
        const seit = Number(url.searchParams.get('seit') ?? 0);
        if (!Number.isInteger(seit) || seit < 0) throw new Fehler(400, 'seit muss eine Zahl sein');
        const gelesen = speicher.lesen(wer.db, seit);
        if (wer.mitarbeiter.rolle === 'fremdfahrer' || wer.mitarbeiter.rolle === 'partner') return antwort(res, 200, fuerFremdfahrer(gelesen, wer.mitarbeiter.id, wer.db));
        return antwort(res, 200, zeitenFiltern(gelesen, { ...wer.mitarbeiter, bereiche: wer.roh?.bereiche ?? null }));
      }

      if (req.method === 'POST' && pfad === '/abgleich') {
        const { aenderungen } = await koerper(req);
        // Mit den Freigaben der Person (bereiche), für die Rechte der Warenwirtschaft.
        const person = { ...wer.mitarbeiter, bereiche: wer.roh?.bereiche ?? null };
        return antwort(res, 200, speicher.schreiben(wer.db, wer.mitarbeiter.id, erlaubte(pruefeAenderungen(aenderungen), person, wer.db)));
      }

      // Mitarbeiterausweis am geteilten Gerät: Karte → Person. Gesperrte Karten und Personen lehnt
      // der Server ab; das Gerät fragt hier, wenn es Netz hat, sonst gilt sein abgeglichenes Register.
      if (req.method === 'POST' && pfad === '/ausweis') {
        const { kennung } = await koerper(req);
        const r = speicher.ausweis(wer.db, kennung);
        if (r === 'unbekannt') throw new Fehler(404, 'Diese Karte ist keinem Mitarbeiter zugeordnet.');
        if (r === 'gesperrt') throw new Fehler(403, 'Diese Karte ist gesperrt.');
        if (r === 'inaktiv') throw new Fehler(403, 'Diese Person ist im Betrieb gesperrt.');
        return antwort(res, 200, { mitarbeiter: r });
      }

      if (req.method === 'POST' && pfad === '/nummer') {
        const { beleg, art, jahr, mindestens } = await koerper(req);
        if (typeof beleg !== 'string' || !beleg) throw new Fehler(400, 'beleg fehlt');
        // Kassenbelege bekommen ihre Nummer nur zusammen mit dem Beleg (kasse.mjs) — sonst entstünden Lücken.
        if (String(art).startsWith('kassenbeleg')) throw new Fehler(400, 'Kassenbelege werden über /kasse/beleg nummeriert');
        if (Number.isInteger(mindestens) && mindestens > 0) speicher.nummernMindestens(wer.db, art, jahr, mindestens);
        try {
          return antwort(res, 200, { nummer: speicher.nummer(wer.db, beleg, art, jahr) });
        } catch (e) {
          throw new Fehler(400, e.message);
        }
      }

      if (['/mitarbeiter', '/einladung', '/mitarbeiter/aktiv', '/mitarbeiter/rechte', '/mitarbeiter/daten', '/geraet/entfernen', '/export'].includes(pfad)) {
        if (wer.mitarbeiter.rolle !== 'verwalter') throw new Fehler(403, 'Nur für Verwalter');
        if (req.method === 'GET' && pfad === '/export') return antwort(res, 200, speicher.export(wer.db, wer.betrieb.id));
        if (req.method === 'GET' && pfad === '/mitarbeiter') return antwort(res, 200, speicher.mitarbeiterListe(wer.db));
        if (req.method === 'POST' && pfad === '/einladung') {
          const { name, rolle } = await koerper(req);
          if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Fehler(400, 'Name fehlt');
          try {
            const e = speicher.einladen(wer.betrieb.id, name.trim(), rolle ?? 'mitarbeiter');
            return antwort(res, 200, { code: e.code, gueltigBis: e.gueltigBis });
          } catch (e) {
            throw new Fehler(400, e.message);
          }
        }
        if (req.method === 'POST' && pfad === '/mitarbeiter/aktiv') {
          const { id, aktiv } = await koerper(req);
          if (id === wer.mitarbeiter.id && !aktiv) throw new Fehler(400, 'Sich selbst sperren geht nicht');
          if (!speicher.mitarbeiterAktiv(wer.db, id, !!aktiv)) throw new Fehler(404, 'Unbekannter Mitarbeiter');
          return antwort(res, 200, { ok: true });
        }
        if (req.method === 'POST' && pfad === '/mitarbeiter/daten') {
          const d = await koerper(req);
          const r = speicher.mitarbeiterDaten(wer.db, d.id, d);
          if (r === 'unbekannt') throw new Fehler(404, 'Unbekannter Mitarbeiter');
          if (r === 'letzter') throw new Fehler(400, 'Der letzte Verwalter kann nicht Mitarbeiter werden — erst einen anderen zum Verwalter machen.');
          return antwort(res, 200, { ok: true });
        }
        if (req.method === 'POST' && pfad === '/mitarbeiter/rechte') {
          const { id, bereiche } = await koerper(req);
          const ok =
            bereiche === null ||
            (Array.isArray(bereiche) && bereiche.length <= 60 && bereiche.every((b) => typeof b === 'string' && /^(recht:)?[a-z0-9_-]{1,40}$/i.test(b)));
          if (!ok) throw new Fehler(400, 'bereiche ist eine Liste von Bereichskennungen oder null');
          if (!speicher.rechteSetzen(wer.db, id, bereiche)) throw new Fehler(404, 'Unbekannter Mitarbeiter');
          return antwort(res, 200, { ok: true });
        }
        if (req.method === 'POST' && pfad === '/geraet/entfernen') {
          const { id } = await koerper(req);
          if (!speicher.geraetEntfernen(wer.db, id)) throw new Fehler(404, 'Unbekanntes Gerät');
          return antwort(res, 200, { ok: true });
        }
      }

      throw new Fehler(404, 'Unbekannter Weg');
    } catch (e) {
      const status = e instanceof Fehler ? e.status : 500;
      if (status === 500) console.error(e);
      antwort(res, status, { fehler: status === 500 ? 'Interner Fehler' : e.message });
    }
  });
  // Objektraum: gesammelte Neuigkeiten, höchstens eine Mail je Teilnehmer und 15 Minuten (geprüft jede Minute).
  const postVerschicken = (jetzt = new Date()) => {
    for (const b of speicher.alleBetriebe()) {
      try {
        raeume.postVerschicken(b.db, b, letzteBasis, jetzt);
      } catch (e) {
        console.error('Raum-Post', b.id, e);
      }
    }
  };
  // Terminerinnerungen an Kunden, etwa 24 Stunden vor Beginn.
  const termineErinnern = (jetzt = Date.now()) => {
    for (const b of speicher.alleBetriebe()) {
      try {
        erinnerungenVerschicken(b.db, b, senden, letzteBasis, jetzt);
      } catch (e) {
        console.error('Terminerinnerung', b.id, e);
      }
    }
  };
  // Abgelaufene Freigaben: Dateien löschen (die Zeile bleibt für „Meine Freigaben“ mit Abrufen).
  const aufraeumen = () => {
    try {
      postfach.aufraeumen();
    } catch (e) {
      console.error('Aufräumen Postfach', e);
    }
    for (const b of speicher.alleBetriebe()) {
      try {
        abgelaufeneAufraeumen(b.db);
        raeume.aufraeumen(b.db);
        termineAufraeumen(b.db);
      } catch (e) {
        console.error('Aufräumen', b.id, e);
      }
    }
  };
  if (zeitgeber) {
    aufraeumen();
    let minuten = 0;
    const t = setInterval(() => {
      pruefeAlarme();
      postVerschicken();
      void partner.weiterleiten();
      termineErinnern();
      // Online-Zahlungen im Kundenportal, deren Kunde nicht zurückgekehrt ist (alle 10 Minuten).
      if ((minuten + 1) % 10 === 0) void offeneZahlungenPruefen(speicher, zahlungsweg, push).catch((e) => console.error('Zahlungen prüfen', e));
      if (++minuten % 60 === 0) {
        aufraeumen();
        void abos.auffrischen();
        void postfach.rechnungenLauf?.();
        // Eigener Server: neue Karten-/Adressdaten? Einmal am Tag (und nachts zum automatischen Holen stündlich).
        const h = new Date().getHours();
        if (!vertragPflicht && (minuten % 1440 === 60 || (process.env.MONTIX_DATEN_AUTO === 'an' && h >= 2 && h < 5))) void datenPruefen();
      }
    }, 60_000);
    t.unref?.();
    server.on('close', () => clearInterval(t));
  }
  server.pruefeAlarme = pruefeAlarme;
  server.partnerWeiterleiten = partner.weiterleiten;
  server.aufraeumen = aufraeumen;
  server.postVerschicken = postVerschicken;
  server.termineErinnern = termineErinnern;
  server.offeneZahlungenPruefen = () => offeneZahlungenPruefen(speicher, zahlungsweg, push);
  return server;
}
