// Alleinarbeit (Totmannschalter) — Arbeitsschutz für Mitarbeiter, die allein arbeiten (Keller,
// Schacht, Dachboden). Wer beginnt, nennt ein Intervall; bis zur Frist muss er „Alles in Ordnung“
// bestätigen. Bleibt das aus oder drückt er „Notruf“, steht bei allen Kollegen des Betriebs ein
// Alarm. Die Frist überwacht der Server — so kommt der Alarm auch, wenn das Handy ausfällt.
// Ersetzt keinen Notruf (112).
//
//   GET  /alleinarbeit                        → [{ mitarbeiter, name, beginn, frist, intervall, status, grund?, alarm?, ort?, kuemmert? }]
//   POST /alleinarbeit/start  {minuten, ort?} → eigener Eintrag
//   POST /alleinarbeit/ok     {ort?}          → Frist verlängert
//   POST /alleinarbeit/notruf {ort?}          → sofort Alarm
//   POST /alleinarbeit/ende                   → beendet (auch nach einem Alarm: „mir geht es gut“)
//   POST /alleinarbeit/kuemmern {mitarbeiter} → ein Kollege übernimmt den Alarm
//   GET  /notfallkontakte                    → [{ name, email }]  eigene Kontakte
//   POST /notfallkontakte {kontakte}         → ersetzt die Liste (höchstens 5)
//
// Empfänger (Rolle „empfaenger“, z. B. Angehörige) sehen nur die Einträge der Person, für die sie
// eingeladen sind. Notfallkontakte bekommen bei Alarm eine E-Mail (alarmeMelden, vom Zeitgeber in
// dienst.mjs) und eine Entwarnung, sobald die Person sich meldet.
//
// Ort nur, wenn das Gerät ihn mitschickt (vom Mitarbeiter beim Start eingeschaltet), nur der
// letzte bekannte, kein Verlauf. Beendete Einträge werden nach 7 Tagen gelöscht.

export class AlleinFehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

const AUFBEWAHRUNG_TAGE = 7;
export const INTERVALLE = [15, 30, 60, 120];

function tabelle(db) {
  db.exec(`
    create table if not exists alleinarbeit (
      mitarbeiter text primary key, name text not null, beginn text not null, frist text not null,
      intervall integer not null, status text not null, grund text, alarm text, ort text, kuemmert text, geaendert text not null
    );
    create table if not exists notfallkontakte (mitarbeiter text not null, name text not null, email text not null);
  `);
  try {
    db.exec('alter table alleinarbeit add column gemeldet text'); // Zeit der Alarm-E-Mail
  } catch {
    // schon vorhanden
  }
}

function pruefeOrt(o) {
  if (o == null) return null;
  const ok = typeof o === 'object' && Number.isFinite(o.lat) && Number.isFinite(o.lon) && Math.abs(o.lat) <= 90 && Math.abs(o.lon) <= 180;
  return ok ? JSON.stringify({ lat: o.lat, lon: o.lon, genau: Number.isFinite(o.genau) ? o.genau : undefined, zeit: new Date().toISOString() }) : null;
}

/** Abgelaufene Fristen werden beim Lesen zum Alarm — kein eigener Zeitgeber nötig. */
function fristenPruefen(db, jetzt = new Date()) {
  const iso = jetzt.toISOString();
  db.prepare("update alleinarbeit set status = 'alarm', grund = 'frist', alarm = ?, geaendert = ? where status = 'aktiv' and frist < ?").run(iso, iso, iso);
  db.prepare("delete from alleinarbeit where status = 'ende' and geaendert < ?").run(new Date(jetzt.getTime() - AUFBEWAHRUNG_TAGE * 86400000).toISOString());
}

const zeile = (z) => ({
  mitarbeiter: z.mitarbeiter,
  name: z.name,
  beginn: z.beginn,
  frist: z.frist,
  intervall: z.intervall,
  status: z.status,
  ...(z.grund ? { grund: z.grund } : {}),
  ...(z.alarm ? { alarm: z.alarm } : {}),
  ...(z.ort ? { ort: JSON.parse(z.ort) } : {}),
  ...(z.kuemmert ? { kuemmert: z.kuemmert } : {}),
});

import { alarmMail, eintragMail, entwarnungMail } from './mailvorlage.mjs';
import { absenderAdresse } from './post.mjs';

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export async function alleinarbeitWeg(methode, pfad, wer, koerper, melden = () => {}, senden = () => {}) {
  if (pfad === '/notfallkontakte') {
    tabelle(wer.db);
    if (wer.mitarbeiter.rolle === 'empfaenger') throw new AlleinFehler(403, 'Nur für die Person selbst');
    if (methode === 'GET') return wer.db.prepare('select name, email from notfallkontakte where mitarbeiter = ?').all(wer.mitarbeiter.id);
    if (methode !== 'POST') return undefined;
    const { kontakte } = (await koerper()) ?? {};
    if (!Array.isArray(kontakte) || kontakte.length > 5) throw new AlleinFehler(400, 'kontakte ist eine Liste mit höchstens 5 Einträgen');
    const sauber = kontakte.map((k) => ({ name: String(k?.name ?? '').trim().slice(0, 80), email: String(k?.email ?? '').trim().slice(0, 120) }));
    if (sauber.some((k) => !EMAIL.test(k.email))) throw new AlleinFehler(400, 'Bitte gültige E-Mail-Adressen eintragen');
    // Neue Adressen bekommen einmal Bescheid (Art. 14 DSGVO) — fängt zugleich Tippfehler ab,
    // bevor im Ernstfall eine fremde Adresse Alarm und Standort bekommt.
    const bisher = new Set(wer.db.prepare('select email from notfallkontakte where mitarbeiter = ?').all(wer.mitarbeiter.id).map((k) => k.email.toLowerCase()));
    const neue = sauber.filter((k) => !bisher.has(k.email.toLowerCase()));
    if (neue.length) senden(neue, eintragText(wer.mitarbeiter.name, wer.betrieb));
    wer.db.prepare('delete from notfallkontakte where mitarbeiter = ?').run(wer.mitarbeiter.id);
    for (const k of sauber) wer.db.prepare('insert into notfallkontakte values (?, ?, ?)').run(wer.mitarbeiter.id, k.name, k.email);
    return sauber;
  }
  if (pfad !== '/alleinarbeit' && !pfad.startsWith('/alleinarbeit/')) return undefined;
  const db = wer.db;
  tabelle(db);
  fristenPruefen(db);
  const ich = wer.mitarbeiter;
  const jetzt = new Date();
  const iso = jetzt.toISOString();
  const eigener = () => zeile(db.prepare('select * from alleinarbeit where mitarbeiter = ?').get(ich.id));

  const empfaenger = ich.rolle === 'empfaenger';
  if (methode === 'GET' && pfad === '/alleinarbeit') {
    if (empfaenger) return db.prepare("select * from alleinarbeit where mitarbeiter = ? and status in ('aktiv', 'alarm')").all(ich.fuer ?? '').map(zeile);
    return db.prepare("select * from alleinarbeit where status in ('aktiv', 'alarm') or mitarbeiter = ? order by status, frist").all(ich.id).map(zeile);
  }
  if (methode !== 'POST') return undefined;
  const k = (await koerper()) ?? {};
  // Empfänger dürfen nur „Ich kümmere mich“ — und nur für ihre Person.
  if (empfaenger && !(pfad === '/alleinarbeit/kuemmern' && String(k.mitarbeiter ?? '') === ich.fuer)) throw new AlleinFehler(403, 'Empfänger sehen nur die Alarme ihrer Person');

  if (pfad === '/alleinarbeit/start') {
    const min = Number(k.minuten);
    if (!INTERVALLE.includes(min)) throw new AlleinFehler(400, `minuten ist eins von ${INTERVALLE.join(', ')}`);
    const frist = new Date(jetzt.getTime() + min * 60000).toISOString();
    db.prepare(
      `insert into alleinarbeit (mitarbeiter, name, beginn, frist, intervall, status, grund, alarm, ort, kuemmert, geaendert) values (?, ?, ?, ?, ?, 'aktiv', null, null, ?, null, ?)
       on conflict (mitarbeiter) do update set name = excluded.name, beginn = excluded.beginn, frist = excluded.frist, intervall = excluded.intervall,
         status = 'aktiv', grund = null, alarm = null, ort = excluded.ort, kuemmert = null, gemeldet = null, geaendert = excluded.geaendert`,
    ).run(ich.id, ich.name, iso, frist, min, pruefeOrt(k.ort), iso);
    return eigener();
  }

  const da = db.prepare('select * from alleinarbeit where mitarbeiter = ?').get(ich.id);
  if (pfad === '/alleinarbeit/ok') {
    if (!da || da.status === 'ende') throw new AlleinFehler(409, 'Keine Alleinarbeit begonnen');
    // Auch nach einem Fristalarm: Die Bestätigung hebt ihn auf (die Person meldet sich).
    const frist = new Date(jetzt.getTime() + da.intervall * 60000).toISOString();
    if (da.gemeldet) melden('entwarnung', da);
    db.prepare("update alleinarbeit set frist = ?, status = 'aktiv', grund = null, alarm = null, kuemmert = null, gemeldet = null, ort = coalesce(?, ort), geaendert = ? where mitarbeiter = ?").run(
      frist,
      pruefeOrt(k.ort),
      iso,
      ich.id,
    );
    return eigener();
  }
  if (pfad === '/alleinarbeit/notruf') {
    db.prepare(
      `insert into alleinarbeit (mitarbeiter, name, beginn, frist, intervall, status, grund, alarm, ort, kuemmert, geaendert) values (?, ?, ?, ?, 0, 'alarm', 'notruf', ?, ?, null, ?)
       on conflict (mitarbeiter) do update set status = 'alarm', grund = 'notruf', alarm = excluded.alarm, ort = coalesce(excluded.ort, alleinarbeit.ort), kuemmert = null, gemeldet = null, geaendert = excluded.geaendert`,
    ).run(ich.id, ich.name, iso, iso, iso, pruefeOrt(k.ort), iso);
    melden('pruefen');
    return eigener();
  }
  if (pfad === '/alleinarbeit/ende') {
    if (da?.gemeldet) melden('entwarnung', da);
    db.prepare("update alleinarbeit set status = 'ende', geaendert = ? where mitarbeiter = ?").run(iso, ich.id);
    return da ? eigener() : null;
  }
  if (pfad === '/alleinarbeit/kuemmern') {
    const r = db.prepare("update alleinarbeit set kuemmert = ?, geaendert = ? where mitarbeiter = ? and status = 'alarm'").run(ich.name, iso, String(k.mitarbeiter ?? ''));
    if (!r.changes) throw new AlleinFehler(404, 'Kein offener Alarm für diese Person');
    return zeile(db.prepare('select * from alleinarbeit where mitarbeiter = ?').get(String(k.mitarbeiter)));
  }
  return undefined;
}

/**
 * Neue Alarme an die Notfallkontakte melden (E-Mail), einmal je Alarm. Vom Zeitgeber in dienst.mjs
 * jede Minute für alle Betriebe aufgerufen — so kommt die Meldung auch, wenn keine App offen ist.
 */
export function alarmeMelden(db, senden, betrieb) {
  tabelle(db);
  fristenPruefen(db);
  const neu = db.prepare("select * from alleinarbeit where status = 'alarm' and gemeldet is null").all();
  for (const a of neu) {
    const an = db.prepare('select name, email from notfallkontakte where mitarbeiter = ?').all(a.mitarbeiter);
    if (an.length) senden(an, alarmText(a, betrieb));
    db.prepare('update alleinarbeit set gemeldet = ? where mitarbeiter = ?').run(new Date().toISOString(), a.mitarbeiter);
  }
  return neu;
}

/** Entwarnung an die Notfallkontakte, wenn sich die Person nach einem gemeldeten Alarm meldet. */
export function entwarnen(db, a, senden, betrieb) {
  const an = db.prepare('select name, email from notfallkontakte where mitarbeiter = ?').all(a.mitarbeiter);
  if (an.length) senden(an, entwarnungMail(a, betrieb));
}

/** Texte der Mails: mailvorlage.mjs (HTML und Textfassung). */
export const alarmText = (a, betrieb) => alarmMail(a, betrieb);
const eintragText = (name, betrieb) => eintragMail(name, betrieb, process.env.MONTIX_ABSENDER ? absenderAdresse(process.env.MONTIX_ABSENDER) : 'montix@feif.space');
