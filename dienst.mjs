// HTTP-Schnittstelle des Abgleich-Servers (node:http, ohne Framework).
//
//   GET  /status                    → { dienst, version }                 (ohne Anmeldung)
//   POST /anmelden {code, geraet}   → { token, betrieb, mitarbeiter }     (Einladungscode einlösen)
//   GET  /ich                       → { betrieb, mitarbeiter }
//   GET  /abgleich?seit=<rev>       → { rev, mehr, aenderungen[] }
//   POST /abgleich {aenderungen[]}  → { rev, uebernommen, verworfen[] }
//   POST /nummer {beleg, art, jahr} → { nummer }                          (idempotent je Beleg)
//   Nur Verwalter:
//   GET  /mitarbeiter               → [{ id, name, rolle, aktiv, geraete[] }]
//   POST /einladung {name, rolle}   → { code, gueltigBis }
//   POST /mitarbeiter/aktiv {id, aktiv}
//   POST /geraet/entfernen {id}
//   POST /mitarbeiter/rechte {id, bereiche: string[] | null}   (null = alle Bereiche)
//   GET  /export                    → gesamter Bestand des Betriebs als JSON
//   POST /vertrag {fassung}         → Zustimmung zum Vertrag zur Auftragsverarbeitung festhalten
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
import { alarmZiele, erstelleExpoPush, nachricht as pushNachricht, pushWeg, tokensVon } from './push.mjs';
import { erstelleMail, MailFehler, pythonHelfer } from './mail.mjs';
import { NachrichtFehler, nachrichtenweg } from './nachrichten.mjs';
import { erstelleZahlung, ZahlFehler } from './zahlung.mjs';
import { fehlerMelden } from './fehler.mjs';
import { erstelleAdresssuche } from './adresse.mjs';
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
    'access-control-allow-headers': 'authorization, content-type',
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

export function erlaubte(liste, mitarbeiter) {
  return liste.filter((a) => {
    if (a.sammlung === 'schritte') return a.id.startsWith(`${mitarbeiter.id}_`) && (a.geloescht || a.inhalt.mitarbeiter === mitarbeiter.id);
    if (a.sammlung === 'aktionen') return mitarbeiter.rolle === 'verwalter';
    // Firmendaten, Logo und Firmenfarben ändert nur ein Verwalter — sonst trüge ein Monteur einen
    // anderen Absender auf allen Geräten des Betriebs ein.
    if (a.sammlung === 'roh' && FIRMA_ROH.includes(a.id)) return mitarbeiter.rolle === 'verwalter';
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
  const adresseSuchen = erstelleAdresssuche({ holen: adresseHolen });
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return antwort(res, 204);
      const url = new URL(req.url ?? '/', 'http://x');
      // Hinter einem Reverse-Proxy mit Präfix (z. B. /montix) dasselbe Ziel.
      const pfad = url.pathname.replace(/^\/montix(?=\/)/, '');

      if (req.method === 'GET' && pfad === '/status') return antwort(res, 200, { dienst: 'montix-abgleich', version: VERSION });

      if (req.method === 'POST' && pfad === '/anmelden') {
        const { code, geraet } = await koerper(req);
        const ok = speicher.anmelden(code, geraet);
        if (!ok) throw new Fehler(403, 'Einladungscode unbekannt, abgelaufen oder schon benutzt');
        return antwort(res, 200, ok);
      }

      // Öffentliche Seite für den Kunden: wie weit der Monteur ungefähr noch entfernt ist.
      const weg = pfad.match(/^\/weg\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'GET' && weg) {
        const html = wegSeite(speicher, weg[1]);
        res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
        return res.end(html ?? '<!doctype html><meta charset="utf-8"><p>Diese Fahrt gibt es nicht (mehr).</p>');
      }

      // Terminmitteilung: Kunde bestätigt oder lehnt ab — siehe terminmitteilung.mjs.
      // Postfach montix@ mit Verwaltung für den Anbieter — siehe postfach.mjs.
      if (await postfach.weg(req, res, pfad)) return;
      if (pfad.startsWith('/t/') && (await terminOeffentlich(speicher, req, res, pfad, terminGemeldet))) return;

      // Geteilte Mappen (Pläne, Fotos, PDF) für andere Firmen — siehe freigaben.mjs.
      if (pfad.startsWith('/teilen/') && (await teilenOeffentlich(speicher, req, res, pfad, url))) return;

      // Objektraum: Seite eines Teilnehmers (andere Firma, Auftraggeber) — siehe raeume.mjs.
      if (pfad.startsWith('/objekt/') && (await raeume.oeffentlich(speicher, req, res, pfad, url, () => basisVon(req)))) return;

      // Adressvorschläge beim Tippen (auch ohne Anmeldung, auch Einzelplatz) — siehe adresse.mjs.
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
      //   art 'person'  → die eigene Person (Empfänger, Monteur, Privatkonto: dann der ganze Privat-„Betrieb“)
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
      const datenweg = pfad === '/abgleich' || pfad.startsWith('/mail/') || pfad === '/nummer' || pfad.startsWith('/nachricht') || pfad === '/kollegen' || pfad === '/einladung' || pfad === '/empfaenger/einladung' || pfad.startsWith('/freigabe') || pfad === '/raeume' || pfad === '/raum' || pfad.startsWith('/raum/') || pfad.startsWith('/termin/');
      // Privatkonten sind keine Betriebe — dort gibt es keine Auftragsverarbeitung, also keinen AVV.
      if (vertragPflicht && datenweg && wer.betrieb.art !== 'privat' && vertrag?.fassung !== VERTRAG_FASSUNG) {
        throw new Fehler(451, 'Der Betrieb hat dem Vertrag zur Auftragsverarbeitung noch nicht zugestimmt. Ein Verwalter erledigt das unter Einstellungen → Abgleich.');
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
        return antwort(res, 200, speicher.lesen(wer.db, seit));
      }

      if (req.method === 'POST' && pfad === '/abgleich') {
        const { aenderungen } = await koerper(req);
        return antwort(res, 200, speicher.schreiben(wer.db, wer.mitarbeiter.id, erlaubte(pruefeAenderungen(aenderungen), wer.mitarbeiter)));
      }

      if (req.method === 'POST' && pfad === '/nummer') {
        const { beleg, art, jahr, mindestens } = await koerper(req);
        if (typeof beleg !== 'string' || !beleg) throw new Fehler(400, 'beleg fehlt');
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
            const e = speicher.einladen(wer.betrieb.id, name.trim(), rolle ?? 'monteur');
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
          if (r === 'letzter') throw new Fehler(400, 'Der letzte Verwalter kann nicht Monteur werden — erst einen anderen zum Verwalter machen.');
          return antwort(res, 200, { ok: true });
        }
        if (req.method === 'POST' && pfad === '/mitarbeiter/rechte') {
          const { id, bereiche } = await koerper(req);
          const ok =
            bereiche === null ||
            (Array.isArray(bereiche) && bereiche.length <= 60 && bereiche.every((b) => typeof b === 'string' && /^[a-z0-9_-]{1,40}$/i.test(b)));
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
      termineErinnern();
      if (++minuten % 60 === 0) {
        aufraeumen();
        void abos.auffrischen();
      }
    }, 60_000);
    t.unref?.();
    server.on('close', () => clearInterval(t));
  }
  server.pruefeAlarme = pruefeAlarme;
  server.aufraeumen = aufraeumen;
  server.postVerschicken = postVerschicken;
  server.termineErinnern = termineErinnern;
  return server;
}
