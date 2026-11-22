// Hilfe ohne eigenen Text — gemeldet aus der App: Tippt jemand im Hilfemodus auf einen Punkt, für
// den es nur den allgemeinen Ersatztext gibt, schickt die App Seite, Kennung, Beschriftung und
// Sprache hierher. Neue Lücken gehen einmal per E-Mail an den Support (höchstens MAIL_JE_TAG am
// Tag), alle stehen in der Verwaltung (postfach.mjs) und lassen sich dort als erledigt abhaken.
//
//   POST /hilfe/luecke {id, titel, pfad, sprache, plattform?, fassung?} → { ok: true }
//
// Gespeichert: nur diese Angaben, Zahl der Meldungen, erstes und letztes Datum. Keine Kennung von
// Gerät, Betrieb oder Person; der Pfad nur als Muster ohne Kennungen (die App schickt `/clients/[id]`,
// pfadMuster fängt Ältere ab); die IP-Adresse nur kurz im Arbeitsspeicher gegen Missbrauch.
// Gelöscht: abgehakte 90 Tage, offene ein Jahr nach der letzten Meldung.

import { ANBIETER } from './mailvorlage.mjs';

const MAIL_JE_TAG = 20;
/** Löschfristen ab der letzten Meldung: abgehakte nach 90 Tagen, offene nach einem Jahr. */
const TAGE_ERLEDIGT = 90;
const TAGE_OFFEN = 365;
const vor = (tage) => new Date(Date.now() - tage * 86400000).toISOString();

/** Kennungen in Pfaden unkenntlich machen: Teile mit Ziffern oder lang wie eine ID werden „[id]“. */
export const pfadMuster = (p) => p.split('/').map((t) => (/\d/.test(t) || t.length > 24 ? '[id]' : t)).join('/');
const kurz = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function hilfeTabelle(db) {
  db.exec(`create table if not exists hilfeluecke (
    schluessel text primary key, id text not null, titel text not null, pfad text not null, sprache text not null,
    plattform text, fassung text, anzahl integer not null default 0, erst text not null, zuletzt text not null,
    erledigt integer not null default 0
  )`);
  db.prepare('delete from hilfeluecke where (erledigt = 1 and zuletzt < ?) or (erledigt = 0 and zuletzt < ?)').run(vor(TAGE_ERLEDIGT), vor(TAGE_OFFEN));
  return db;
}

let mailTag = '';
let mailZahl = 0;

/** Nimmt eine Meldung an. Neu (oder nach „erledigt“ wieder aufgetaucht) → E-Mail an den Support. */
export function lueckeMelden(db, k, senden) {
  const id = kurz(k?.id, 120);
  const titel = kurz(k?.titel, 120);
  const pfad = pfadMuster(kurz(k?.pfad, 120));
  const sprache = /^[a-z]{2}$/.test(String(k?.sprache)) ? String(k.sprache) : '';
  if (!id || !titel || !pfad.startsWith('/') || !sprache) return false;
  hilfeTabelle(db);
  const schluessel = `${pfad}|${id}`;
  const vorher = db.prepare('select erledigt from hilfeluecke where schluessel = ?').get(schluessel);
  const jetzt = new Date().toISOString();
  db.prepare(
    `insert into hilfeluecke (schluessel, id, titel, pfad, sprache, plattform, fassung, anzahl, erst, zuletzt) values (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     on conflict (schluessel) do update set anzahl = anzahl + 1, zuletzt = excluded.zuletzt, titel = excluded.titel, sprache = excluded.sprache, erledigt = 0`,
  ).run(schluessel, id, titel, pfad, sprache, kurz(k?.plattform, 20) || null, kurz(k?.fassung, 40) || null, jetzt, jetzt);
  const neu = !vorher || vorher.erledigt === 1;
  if (neu && senden) {
    const tag = jetzt.slice(0, 10);
    if (tag !== mailTag) {
      mailTag = tag;
      mailZahl = 0;
    }
    if (mailZahl < MAIL_JE_TAG) {
      mailZahl += 1;
      const zeilen = [
        vorher ? 'Eine als erledigt abgehakte Hilfe-Lücke ist wieder aufgetaucht.' : 'Im Hilfemodus wurde ein Punkt ohne eigenen Hilfetext angetippt.',
        '',
        `Beschriftung: ${titel} (Sprache ${sprache})`,
        `Kennung: ${id}`,
        `Seite: ${pfad}`,
      ];
      if (k?.plattform) zeilen.push(`Plattform: ${kurz(k.plattform, 20)}`);
      if (k?.fassung) zeilen.push(`Fassung: ${kurz(k.fassung, 40)}`);
      zeilen.push('', 'Alle Lücken: Verwaltung → Betriebe → Hilfe ohne eigenen Text.');
      const text = zeilen.join('\n');
      try {
        senden([{ name: 'Montix Support', email: ANBIETER.support }], { betreff: `Montix-Hilfe fehlt: ${titel}`, text });
      } catch {
        // Mail geht nicht — die Lücke steht trotzdem in der Verwaltung.
      }
    }
  }
  return true;
}

export function lueckenListe(db) {
  return hilfeTabelle(db).prepare('select * from hilfeluecke order by erledigt, zuletzt desc limit 300').all();
}

export function lueckeErledigt(db, schluessel) {
  hilfeTabelle(db).prepare('update hilfeluecke set erledigt = 1 where schluessel = ?').run(String(schluessel));
}
