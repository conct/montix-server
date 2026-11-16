// E-Mail in Montix — jeder Mitarbeiter richtet sein eigenes Postfach ein (IMAP/SMTP), der Server
// des Betriebs spricht mit dem Mailserver, die App nur mit diesem Server. So geht es auch im
// Browser und ohne natives Modul, und es funktioniert auf unserem wie auf einem eigenen Server.
//
// Gespeichert werden nur die Zugangsdaten — verschlüsselt (AES-256-GCM, Schlüssel je Instanz in
// mail-schluessel.bin), je Mitarbeiter in der Datenbank des Betriebs. Mails selbst legt der Server
// nicht ab; sie gehen bei jeder Anfrage durch (mail-helfer.py, ein Lauf je Anfrage).
//
//   GET  /mail/konto                       → { eingerichtet, name?, adresse?, imapHost?, … }  (ohne Passwort)
//   POST /mail/konto {name, adresse, imapHost, imapPort, smtpHost, smtpPort, benutzer, smtpBenutzer?, passwort?}
//                                          → prüft die Anmeldung, speichert; { eingerichtet, ordner }
//   POST /mail/konto/loeschen              → {}
//   GET  /mail/ordner                      → { ordner: [{ pfad, name, rolle }] }
//   GET  /mail/ungelesen                   → { ungelesen }  (Posteingang, für die Glocke)
//   GET  /mail/liste?ordner=&vor=<uid>     → { gesamt, mails: [{ uid, von, an, betreff, datum, gelesen, beantwortet, anhang }] }
//   GET  /mail/nachricht?ordner=&uid=      → { uid, von, an, cc, betreff, datum, text, anhaenge, messageId, referenzen }
//   GET  /mail/anhang?ordner=&uid=&nr=     → { name, typ, daten }  Base64
//   POST /mail/markieren {ordner, uid, gelesen}
//   POST /mail/loeschen  {ordner, uid}      → in den Papierkorb (wo es einen gibt)
//   POST /mail/senden    {an[], cc?[], betreff, text, antwortAuf?, referenzen?, antwortUid?, antwortOrdner?, anhaenge?[{name, typ, daten}]}

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { erstelleGeheim } from './geheim.mjs';

const HELFER = join(dirname(fileURLToPath(import.meta.url)), 'mail-helfer.py');
/** Nur die üblichen Mail-Ports — der Server soll sich nicht als Tunnel zu beliebigen Diensten eignen. */
const IMAP_PORTS = [993, 143];
const SMTP_PORTS = [465, 587];
const ANHAENGE_MAX = 10_000_000; // Base64-Zeichen insgesamt, gut 7 MB

export class MailFehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

/** Startet mail-helfer.py; das Passwort geht nur über stdin. */
export function pythonHelfer(auftrag, { python = process.env.MONTIX_PYTHON ?? 'python3', zeit = 40_000 } = {}) {
  return new Promise((fertig) => {
    let aus = '';
    let p;
    try {
      p = spawn(python, [HELFER], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return fertig({ ok: false, fehler: 'Mail-Helfer lässt sich nicht starten.' });
    }
    const uhr = setTimeout(() => p.kill('SIGKILL'), zeit);
    p.stdout.on('data', (d) => (aus += d));
    p.on('error', () => fertig({ ok: false, fehler: 'Mail-Helfer lässt sich nicht starten (python3 fehlt?).' }));
    p.on('close', () => {
      clearTimeout(uhr);
      try {
        fertig(JSON.parse(aus));
      } catch {
        fertig({ ok: false, fehler: 'Der Mailserver antwortet nicht rechtzeitig.' });
      }
    });
    p.stdin.end(JSON.stringify(auftrag));
  });
}

const tabelle = (db) =>
  db.exec(`create table if not exists mail_konto (mitarbeiter text primary key, daten text not null, geaendert text not null)`);

const host = (v, was) => {
  const h = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) || h.length > 200) throw new MailFehler(400, `${was}: bitte einen Servernamen angeben, z. B. imap.beispiel.de`);
  return h;
};
const port = (v, erlaubt, was) => {
  const n = Number(v);
  if (!erlaubt.includes(n)) throw new MailFehler(400, `${was}: Port ${erlaubt.join(' oder ')}`);
  return n;
};
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const ADRESSE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function erstelleMail({ ordner, helfer = pythonHelfer }) {
  const geheim = erstelleGeheim(ordner, 'mail-schluessel.bin');

  const kontoLesen = (db, id) => {
    tabelle(db);
    const z = db.prepare('select daten from mail_konto where mitarbeiter = ?').get(id);
    if (!z) return null;
    try {
      return JSON.parse(geheim.entschluesseln(z.daten));
    } catch {
      return null;
    }
  };
  const ohnePasswort = (k) => (k ? { eingerichtet: true, ...Object.fromEntries(Object.entries(k).filter(([s]) => s !== 'passwort')) } : { eingerichtet: false });

  async function rufen(konto, auftrag) {
    const r = await helfer({ ...auftrag, konto });
    if (!r?.ok) throw new MailFehler(502, r?.fehler ?? 'Mailserver nicht erreichbar.');
    const { ok: _ok, ...rest } = r;
    return rest;
  }

  return async function mailWeg(methode, pfad, url, wer, koerper) {
    if (!pfad.startsWith('/mail/')) return undefined;
    if (wer.mitarbeiter.rolle === 'empfaenger') throw new MailFehler(403, 'E-Mail gibt es nur für Mitarbeiter.');
    const db = wer.db;
    const ich = wer.mitarbeiter.id;

    if (methode === 'GET' && pfad === '/mail/konto') return ohnePasswort(kontoLesen(db, ich));

    if (methode === 'POST' && pfad === '/mail/konto') {
      const b = await koerper();
      const alt = kontoLesen(db, ich);
      const adresse = text(b.adresse, 200);
      if (!ADRESSE.test(adresse)) throw new MailFehler(400, 'Bitte die eigene E-Mail-Adresse angeben.');
      const neu = {
        name: text(b.name, 100),
        adresse,
        imapHost: host(b.imapHost, 'Posteingang'),
        imapPort: port(b.imapPort ?? 993, IMAP_PORTS, 'Posteingang'),
        smtpHost: host(b.smtpHost, 'Postausgang'),
        smtpPort: port(b.smtpPort ?? 465, SMTP_PORTS, 'Postausgang'),
        benutzer: text(b.benutzer, 200) || adresse,
        smtpBenutzer: text(b.smtpBenutzer, 200) || undefined,
        passwort: typeof b.passwort === 'string' && b.passwort ? b.passwort.slice(0, 500) : alt?.passwort,
      };
      if (!neu.passwort) throw new MailFehler(400, 'Bitte das Passwort des Postfachs angeben.');
      const { ordner: liste } = await rufen(neu, { aktion: 'pruefen' });
      tabelle(db);
      db.prepare('insert into mail_konto (mitarbeiter, daten, geaendert) values (?, ?, ?) on conflict(mitarbeiter) do update set daten = excluded.daten, geaendert = excluded.geaendert').run(
        ich,
        geheim.verschluesseln(JSON.stringify(neu)),
        new Date().toISOString(),
      );
      return { ...ohnePasswort(neu), ordner: liste };
    }

    if (methode === 'POST' && pfad === '/mail/konto/loeschen') {
      tabelle(db);
      db.prepare('delete from mail_konto where mitarbeiter = ?').run(ich);
      return {};
    }

    const konto = kontoLesen(db, ich);
    if (!konto) throw new MailFehler(409, 'Noch kein Postfach eingerichtet.');
    const ordnerVon = (v) => text(v, 300) || 'INBOX';
    const uidVon = (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new MailFehler(400, 'uid fehlt');
      return n;
    };

    if (methode === 'GET' && pfad === '/mail/ordner') return rufen(konto, { aktion: 'ordner' });
    if (methode === 'GET' && pfad === '/mail/ungelesen') return rufen(konto, { aktion: 'ungelesen' });
    if (methode === 'GET' && pfad === '/mail/liste') {
      const vor = url.searchParams.get('vor');
      return rufen(konto, { aktion: 'liste', ordner: ordnerVon(url.searchParams.get('ordner')), vor: vor ? uidVon(vor) : null });
    }
    if (methode === 'GET' && pfad === '/mail/nachricht') {
      return rufen(konto, { aktion: 'nachricht', ordner: ordnerVon(url.searchParams.get('ordner')), uid: uidVon(url.searchParams.get('uid')) });
    }
    if (methode === 'GET' && pfad === '/mail/anhang') {
      const nr = Number(url.searchParams.get('nr'));
      if (!Number.isInteger(nr) || nr < 0) throw new MailFehler(400, 'nr fehlt');
      return rufen(konto, { aktion: 'anhang', ordner: ordnerVon(url.searchParams.get('ordner')), uid: uidVon(url.searchParams.get('uid')), nr });
    }
    if (methode === 'POST' && pfad === '/mail/markieren') {
      const b = await koerper();
      return rufen(konto, { aktion: 'markieren', ordner: ordnerVon(b.ordner), uid: uidVon(b.uid), gelesen: b.gelesen !== false });
    }
    if (methode === 'POST' && pfad === '/mail/loeschen') {
      const b = await koerper();
      return rufen(konto, { aktion: 'loeschen', ordner: ordnerVon(b.ordner), uid: uidVon(b.uid) });
    }
    if (methode === 'POST' && pfad === '/mail/senden') {
      const b = await koerper();
      const liste = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map((x) => text(x, 200)).filter(Boolean);
      const an = liste(b.an);
      const cc = liste(b.cc);
      if (!an.length) throw new MailFehler(400, 'Bitte mindestens einen Empfänger angeben.');
      const falsch = [...an, ...cc].find((x) => !ADRESSE.test(x.replace(/^.*<([^>]+)>\s*$/, '$1')));
      if (falsch) throw new MailFehler(400, `„${falsch}“ ist keine E-Mail-Adresse.`);
      if (an.length + cc.length > 50) throw new MailFehler(400, 'Höchstens 50 Empfänger.');
      const anhaenge = Array.isArray(b.anhaenge) ? b.anhaenge.map((d) => ({ name: text(d?.name, 200) || 'anhang', typ: text(d?.typ, 100) || 'application/octet-stream', daten: String(d?.daten ?? '') })) : [];
      if (anhaenge.reduce((s, d) => s + d.daten.length, 0) > ANHAENGE_MAX) throw new MailFehler(413, 'Anhänge zusammen höchstens etwa 7 MB.');
      return rufen(konto, {
        aktion: 'senden',
        an,
        cc,
        betreff: text(b.betreff, 500),
        text: String(b.text ?? '').slice(0, 200_000),
        antwortAuf: text(b.antwortAuf, 500) || undefined,
        referenzen: text(b.referenzen, 4000) || undefined,
        antwortUid: b.antwortUid ? uidVon(b.antwortUid) : undefined,
        antwortOrdner: b.antwortOrdner ? ordnerVon(b.antwortOrdner) : undefined,
        anhaenge,
      });
    }
    throw new MailFehler(404, 'Unbekannter Mail-Aufruf');
  };
}
