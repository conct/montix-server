// Termine dem Kunden mitteilen und seine Antwort zurückholen. Der Betrieb schickt einen Link (per
// E-Mail vom Server oder selbst per Messenger/SMS); der Kunde sieht dort Datum, Uhrzeit und Ort und
// tippt „Termin bestätigen“ oder „Passt nicht“ (mit Wunschtermin). Die Antwort kommt als Push an die
// Zuständigen und an die Person, die mitgeteilt hat. Auf Wunsch erinnert der Server am Vortag per E-Mail.
//
// Angemeldet (Betrieb):
//   POST /termin/mitteilen {termin:{id,titel,start,bis?,dauerMin,mitarbeiter?}, kunde:{name,email?,ort?},
//                           art:'einladung'|'aenderung'|'absage', perMail?, erinnerung?, nachricht?}
//        → { link, status, gesendet, perMail }
//   GET  /termin/antworten → [{ termin, status, antwort, antwortZeit, gesendet, art, link }]
// Öffentlich (ohne Anmeldung, noindex):
//   GET  /t/<schlüssel>              → Seite für den Kunden
//   POST /t/<schlüssel>  wahl=ja|nein&text=…  → Antwort
//   GET  /t/<schlüssel>/termin.ics   → Termin für den eigenen Kalender
//
// Gespeichert: Titel, Zeit, Name, E-Mail und Ort des Kunden für diesen Termin — 30 Tage nach dem
// letzten Termintag gelöscht.

import { randomBytes } from 'node:crypto';

import { terminMail } from './mailvorlage.mjs';

const AUFBEWAHRUNG_TAGE = 30;
const SCHLUESSEL = /^t[A-Za-z0-9_-]{16}$/;

export class TerminFehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

export function tabelle(db) {
  db.exec(`
    create table if not exists terminmitteilung (
      termin text primary key, schluessel text unique not null, von text not null, von_name text,
      titel text not null, start text not null, bis text, dauer integer not null, zustaendig text,
      kunde text, email text, ort text, nachricht text,
      art text not null, status text not null, antwort text, antwort_zeit text,
      gesendet text not null, erinnerung integer not null default 0, erinnert text
    );
  `);
}

const DATUM = /^\d{4}-\d{2}-\d{2}$/;
const START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const z2 = (n) => String(n).padStart(2, '0');

/** „Montag, 16.11.2026“ aus JJJJ-MM-TT. */
export function datumLang(iso) {
  const [j, m, t] = iso.slice(0, 10).split('-').map(Number);
  return `${WOCHENTAGE[new Date(Date.UTC(j, m - 1, t)).getUTCDay()]}, ${z2(t)}.${z2(m)}.${j}`;
}

/** Uhrzeit von–bis, z. B. „08:00–09:00 Uhr“. */
export function zeitVonBis(start, dauer) {
  const [h, m] = start.slice(11, 16).split(':').map(Number);
  const e = h * 60 + m + dauer;
  return `${start.slice(11, 16)}–${z2(Math.floor(e / 60) % 24)}:${z2(e % 60)} Uhr`;
}

/** Alles, was der Kunde über den Termin lesen soll, in einer Zeile. */
export function wannText(t) {
  const mehrtaegig = t.bis && t.bis > t.start.slice(0, 10);
  return mehrtaegig
    ? `${datumLang(t.start)} bis ${datumLang(t.bis)}, jeweils ${zeitVonBis(t.start, t.dauer)}`
    : `${datumLang(t.start)}, ${zeitVonBis(t.start, t.dauer)}`;
}

/** Lokale Zeit in Berlin (ohne Zone gespeichert) → Zeitpunkt in ms. */
export function berlinMs(lokal) {
  const [d, h] = lokal.split('T');
  const [j, m, t] = d.split('-').map(Number);
  const [hh, mm] = (h ?? '00:00').split(':').map(Number);
  const alsUtc = Date.UTC(j, m - 1, t, hh, mm);
  // Versatz Berlins zu diesem Zeitpunkt (Sommer-/Winterzeit) aus Intl bestimmen.
  const teile = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(alsUtc));
  const w = Object.fromEntries(teile.map((p) => [p.type, Number(p.value)]));
  const versatz = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - alsUtc;
  return alsUtc - versatz;
}

const text = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const emailOk = (e) => typeof e === 'string' && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e) && e.length <= 200;

const zeile = (r) => ({
  termin: r.termin,
  status: r.status,
  antwort: r.antwort ?? undefined,
  antwortZeit: r.antwort_zeit ?? undefined,
  gesendet: r.gesendet,
  art: r.art,
  erinnerung: !!r.erinnerung,
  erinnert: r.erinnert ?? undefined,
});

export function aufraeumen(db) {
  tabelle(db);
  const grenze = new Date(Date.now() - AUFBEWAHRUNG_TAGE * 86400000).toISOString().slice(0, 10);
  db.prepare('delete from terminmitteilung where coalesce(bis, substr(start, 1, 10)) < ?').run(grenze);
}

/**
 * Angemeldete Wege. `senden` verschickt Mails (post.mjs), `basis` ist die öffentliche Adresse.
 */
export async function terminWeg(methode, pfad, wer, koerper, basis, senden) {
  if (pfad !== '/termin/mitteilen' && pfad !== '/termin/antworten') return undefined;
  const db = wer.db;
  tabelle(db);
  if (methode === 'GET' && pfad === '/termin/antworten') return db.prepare('select * from terminmitteilung order by gesendet desc limit 2000').all().map(zeile);
  if (methode !== 'POST' || pfad !== '/termin/mitteilen') return undefined;

  const k = (await koerper()) ?? {};
  const t = k.termin ?? {};
  const art = ['einladung', 'aenderung', 'absage'].includes(k.art) ? k.art : null;
  if (!art) throw new TerminFehler(400, 'art ist einladung, aenderung oder absage');
  if (typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(t.id)) throw new TerminFehler(400, 'termin.id fehlt');
  if (!START.test(String(t.start ?? ''))) throw new TerminFehler(400, 'termin.start als JJJJ-MM-TTTHH:MM');
  if (t.bis !== undefined && t.bis !== null && !DATUM.test(String(t.bis))) throw new TerminFehler(400, 'termin.bis als JJJJ-MM-TT');
  const dauer = Number(t.dauerMin);
  if (!Number.isInteger(dauer) || dauer < 5 || dauer > 24 * 60) throw new TerminFehler(400, 'termin.dauerMin in Minuten');
  const titel = text(t.titel, 120);
  if (!titel) throw new TerminFehler(400, 'termin.titel fehlt');
  const kunde = k.kunde ?? {};
  const email = kunde.email ? String(kunde.email).trim() : null;
  if (email && !emailOk(email)) throw new TerminFehler(400, 'Die E-Mail-Adresse des Kunden sieht nicht richtig aus');
  if (k.perMail && !email) throw new TerminFehler(400, 'Für den Kunden ist keine E-Mail-Adresse hinterlegt');
  const zustaendig = Array.isArray(t.mitarbeiter) ? t.mitarbeiter.filter((x) => typeof x === 'string').slice(0, 20) : [];

  const alt = db.prepare('select * from terminmitteilung where termin = ?').get(t.id);
  const schluessel = alt?.schluessel ?? `t${randomBytes(12).toString('base64url')}`;
  const jetzt = new Date().toISOString();
  const status = art === 'absage' ? 'abgesagt' : 'offen';
  const neu = {
    termin: t.id,
    schluessel,
    von: wer.mitarbeiter.id,
    von_name: wer.mitarbeiter.name ?? null,
    titel,
    start: t.start,
    bis: t.bis && t.bis > t.start.slice(0, 10) ? t.bis : null,
    dauer,
    zustaendig: JSON.stringify(zustaendig),
    kunde: text(kunde.name, 120),
    email,
    ort: text(kunde.ort, 200),
    nachricht: text(k.nachricht, 1000),
    art,
    status,
    antwort: null,
    antwort_zeit: null,
    gesendet: jetzt,
    erinnerung: art !== 'absage' && k.erinnerung && email ? 1 : 0,
    // Bei einer Änderung neu erinnern; sonst die frühere Erinnerung behalten.
    erinnert: art === 'aenderung' || !alt ? null : alt.erinnert,
  };
  db.prepare(
    `insert into terminmitteilung (termin, schluessel, von, von_name, titel, start, bis, dauer, zustaendig, kunde, email, ort, nachricht, art, status, antwort, antwort_zeit, gesendet, erinnerung, erinnert)
     values (@termin, @schluessel, @von, @von_name, @titel, @start, @bis, @dauer, @zustaendig, @kunde, @email, @ort, @nachricht, @art, @status, @antwort, @antwort_zeit, @gesendet, @erinnerung, @erinnert)
     on conflict (termin) do update set von = excluded.von, von_name = excluded.von_name, titel = excluded.titel, start = excluded.start, bis = excluded.bis,
       dauer = excluded.dauer, zustaendig = excluded.zustaendig, kunde = excluded.kunde, email = excluded.email, ort = excluded.ort, nachricht = excluded.nachricht,
       art = excluded.art, status = excluded.status, antwort = null, antwort_zeit = null, gesendet = excluded.gesendet, erinnerung = excluded.erinnerung, erinnert = excluded.erinnert`,
  ).run(neu);

  const link = `${basis}/t/${schluessel}`;
  if (k.perMail && email) senden([{ name: neu.kunde ?? '', email }], terminMail({ ...neu, wann: wannText(neu), link }, wer.betrieb));
  return { link, status, gesendet: jetzt, perMail: !!(k.perMail && email) };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function finde(speicher, schluessel) {
  if (!SCHLUESSEL.test(schluessel)) return null;
  for (const b of speicher.alleBetriebe()) {
    tabelle(b.db);
    const r = b.db.prepare('select * from terminmitteilung where schluessel = ?').get(schluessel);
    if (r) return { b, r };
  }
  return null;
}

const STATUS_TEXT = {
  offen: '',
  bestaetigt: 'Sie haben den Termin bestätigt. Vielen Dank!',
  abgelehnt: 'Sie haben uns mitgeteilt, dass der Termin nicht passt. Wir melden uns bei Ihnen.',
  abgesagt: 'Dieser Termin ist abgesagt.',
};

function seite(b, r, hinweis) {
  const termin = `<div class="termin"><p class="gross">${esc(wannText(r))}</p><p><strong>${esc(r.titel)}</strong>${r.ort ? `<br>${esc(r.ort)}` : ''}</p></div>`;
  const kopf =
    r.status === 'abgesagt'
      ? '<h1>Termin abgesagt</h1>'
      : r.art === 'aenderung'
        ? '<h1>Ihr Termin hat sich geändert</h1>'
        : '<h1>Ihr Termin</h1>';
  const formular =
    r.status === 'abgesagt' || Date.now() > berlinMs(`${r.bis ?? r.start.slice(0, 10)}T23:59`)
      ? ''
      : `<form method="post">
${r.status === 'bestaetigt' ? '' : '<button name="wahl" value="ja" class="ja">Termin bestätigen</button>'}
<details${r.status === 'abgelehnt' ? ' open' : ''}><summary>Passt nicht</summary>
<p><label for="text">Wann passt es Ihnen besser? (freiwillig)</label><textarea id="text" name="text" maxlength="500" rows="3" placeholder="z. B. lieber nachmittags oder ab dem 20.11.">${esc(r.antwort ?? '')}</textarea></p>
<button name="wahl" value="nein" class="nein">Termin passt nicht</button></details></form>`;
  const status = hinweis ?? STATUS_TEXT[r.status];
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(b.name)} – Termin</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f4f6f8;color:#111827}main{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px #0001}h1{font-size:22px;margin:6px 0 14px}.gross{font-size:20px;font-weight:800;margin:0 0 6px}.termin{background:#f2f6fb;border-radius:10px;padding:14px 16px;margin:0 0 16px}p{color:#374151;line-height:1.5}small{color:#6b7280}button{font:inherit;font-weight:700;border:0;border-radius:999px;padding:13px 22px;cursor:pointer;width:100%;margin:6px 0}.ja{background:#15803D;color:#fff}.nein{background:#B91C1C;color:#fff}details{margin:10px 0}summary{cursor:pointer;color:#374151;padding:8px 0}textarea{width:100%;box-sizing:border-box;font:inherit;border:1px solid #d1d5db;border-radius:8px;padding:8px}.status{font-weight:700;color:#15803D}.status.nein{background:none;color:#B91C1C}a{color:#0b5fb8}</style></head>
<body><main><small>${esc(b.name)}</small>${kopf}${termin}${r.nachricht ? `<p>${esc(r.nachricht).replace(/\n/g, '<br>')}</p>` : ''}${status ? `<p class="status${r.status === 'abgelehnt' || r.status === 'abgesagt' ? ' nein' : ''}">${esc(status)}</p>` : ''}${formular}
${r.status === 'abgesagt' ? '' : `<p><a href="${esc(r.schluessel)}/termin.ics">In den eigenen Kalender übernehmen</a></p>`}
<small>Diese Seite ist nur über Ihren Link erreichbar und wird ${AUFBEWAHRUNG_TAGE} Tage nach dem Termin gelöscht. Verantwortlich: ${esc(b.name)}, Montix verarbeitet die Angaben im Auftrag.</small></main></body></html>`;
}

/** iCalendar mit lokaler Zeit (Europe/Berlin); mehrtägig als tägliche Wiederholung. */
export function ics(b, r) {
  const ical = (s) => String(s ?? '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const lokal = (iso) => iso.replace(/[-:]/g, '').slice(0, 13) + '00';
  const ende = new Date(berlinMs(r.start) + r.dauer * 60000);
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ende);
  const tage = r.bis ? Math.round((Date.parse(`${r.bis}T00:00Z`) - Date.parse(`${r.start.slice(0, 10)}T00:00Z`)) / 86400000) + 1 : 1;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Montix//Termin//DE',
    'BEGIN:VEVENT',
    `UID:${r.termin}@montix`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;TZID=Europe/Berlin:${lokal(r.start)}`,
    `DTEND;TZID=Europe/Berlin:${lokal(p.replace(' ', 'T'))}`,
    ...(tage > 1 ? [`RRULE:FREQ=DAILY;COUNT=${tage}`] : []),
    `SUMMARY:${ical(`${r.titel} – ${b.name}`)}`,
    ...(r.ort ? [`LOCATION:${ical(r.ort)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

async function formular(req) {
  let s = '';
  for await (const t of req) {
    s += t;
    if (s.length > 4096) break;
  }
  return new URLSearchParams(s);
}

/**
 * Öffentliche Wege unter /t/… — gibt true zurück, wenn beantwortet.
 * `gemeldet(db, zeile)` benachrichtigt den Betrieb (Push) über eine Antwort.
 */
export async function terminOeffentlich(speicher, req, res, pfad, gemeldet) {
  const m = pfad.match(/^\/t\/([A-Za-z0-9_-]+)(\/termin\.ics)?$/);
  if (!m) return false;
  const html = (status, inhalt) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
    res.end(inhalt);
    return true;
  };
  const f = finde(speicher, m[1]);
  if (!f) return html(404, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font-family:system-ui;padding:24px">Diesen Termin gibt es nicht (mehr).</p>');
  const { b, r } = f;
  if (m[2]) {
    if (req.method !== 'GET') return false;
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="termin.ics"', 'cache-control': 'no-store' });
    res.end(ics(b, r));
    return true;
  }
  if (req.method === 'GET') return html(200, seite(b, r));
  if (req.method !== 'POST') return false;
  if (r.status === 'abgesagt') return html(200, seite(b, r));
  const daten = await formular(req);
  const wahl = daten.get('wahl');
  if (wahl !== 'ja' && wahl !== 'nein') return html(400, seite(b, r, 'Bitte „Termin bestätigen“ oder „Termin passt nicht“ wählen.'));
  const status = wahl === 'ja' ? 'bestaetigt' : 'abgelehnt';
  const antwort = wahl === 'nein' ? text(daten.get('text'), 500) : null;
  // Zweimal dasselbe (Doppeltipp, Neuladen) meldet nicht zweimal.
  const gleich = r.status === status && (r.antwort ?? null) === antwort;
  if (!gleich) {
    const zeit = new Date().toISOString();
    b.db.prepare('update terminmitteilung set status = ?, antwort = ?, antwort_zeit = ? where termin = ?').run(status, antwort, zeit, r.termin);
    gemeldet?.(b.db, { ...r, status, antwort, antwort_zeit: zeit });
  }
  // Post/Redirect/Get: Neuladen schickt die Antwort nicht noch einmal ab (auch nicht nach einer Änderung des Termins).
  res.writeHead(303, { location: m[1], 'cache-control': 'no-store' });
  res.end();
  return true;
}

/** Erinnerung per E-Mail etwa 24 Stunden vor Beginn (geprüft jede Minute, je Termin einmal). */
export function erinnerungenVerschicken(db, betrieb, senden, basis, jetzt = Date.now()) {
  tabelle(db);
  const offen = db.prepare("select * from terminmitteilung where erinnerung = 1 and erinnert is null and email is not null and status in ('offen', 'bestaetigt')").all();
  for (const r of offen) {
    const beginn = berlinMs(r.start);
    if (jetzt < beginn - 24 * 3600000 || jetzt > beginn) continue;
    db.prepare('update terminmitteilung set erinnert = ? where termin = ?').run(new Date(jetzt).toISOString(), r.termin);
    senden([{ name: r.kunde ?? '', email: r.email }], terminMail({ ...r, art: 'erinnerung', wann: wannText(r), link: `${basis}/t/${r.schluessel}` }, betrieb));
  }
}
