// Nachrichten zwischen den Mitarbeitern eines Betriebs (Text und Sprachnachricht).
// Anders als der Abgleich bekommt jedes Gerät nur, was an alle, an die Person selbst oder von
// ihr ist — eine Nachricht an Max liegt nicht auf dem Handy von Erika.
//
//   GET  /kollegen                         → [{ id, name, rolle }]       (aktive Mitarbeiter)
//   GET  /nachrichten?seit=<rev>           → { rev, nachrichten[] }      (ohne Aufnahme, nur Kennzeichen)
//   POST /nachricht {an, text?, audio?, dauerMs?}  → { id, rev }         an = Mitarbeiter-ID oder '*'
//   GET  /nachricht/<id>/audio             → { daten }                   Base64 der Aufnahme
//   POST /nachricht/<id>/loeschen          → { ok }                      nur Absender: für alle löschen
//
// Gelöschte Nachrichten bleiben als leere Zeile mit neuer rev stehen (geloescht = 1), damit die
// Geräte der Empfänger sie beim nächsten Abruf ebenfalls entfernen.

import { randomBytes } from 'node:crypto';

const AUDIO_MAX = 4_000_000; // Base64-Zeichen, gut 2,5 Minuten
/** Nachrichten samt Sprachaufnahme werden nach dieser Frist gelöscht (wie auf dem Gerät). */
export const AUFBEWAHRUNG_TAGE = 90;

export class NachrichtFehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

const tabelle = (db) => {
  db.exec(`
    create table if not exists nachrichten (
      rev integer primary key autoincrement, id text unique not null, von text not null, an text not null,
      text text, audio text, dauer_ms integer, zeit text not null
    );
    create index if not exists nachrichten_an on nachrichten (an, rev);
  `);
  try {
    db.exec('alter table nachrichten add column geloescht integer not null default 0');
  } catch {
    // schon vorhanden
  }
};

export async function nachrichtenweg(methode, pfad, url, wer, koerper, nachPost = () => {}) {
  const audioId = pfad.match(/^\/nachricht\/([a-z0-9_]+)\/audio$/)?.[1];
  const loeschId = pfad.match(/^\/nachricht\/([a-z0-9_]+)\/loeschen$/)?.[1];
  if (!audioId && !loeschId && !['/kollegen', '/nachrichten', '/nachricht'].includes(pfad)) return undefined;
  const db = wer.db;
  tabelle(db);
  const ich = wer.mitarbeiter.id;
  // Ältere Nachrichten löschen — bei jedem Zugriff, damit es keinen eigenen Aufräumlauf braucht.
  db.prepare('delete from nachrichten where zeit < ?').run(new Date(Date.now() - AUFBEWAHRUNG_TAGE * 86400000).toISOString());

  if (methode === 'GET' && pfad === '/kollegen') {
    const alle = db.prepare("select id, name, rolle, coalesce(kuerzel, '') as kuerzel, coalesce(farbe, '') as farbe, bereiche from mitarbeiter where aktiv = 1 and rolle != 'empfaenger' order by name").all();
    // Fremdfahrer und Partnerbetriebe sehen nur die Disposition (Verwalter, Recht „Disposition“), nicht die ganze Belegschaft.
    const gast = wer.mitarbeiter.rolle === 'fremdfahrer' || wer.mitarbeiter.rolle === 'partner';
    const dispo = (m) => m.rolle === 'verwalter' || String(m.bereiche ?? '').includes('recht:dispo');
    return alle.filter((m) => !gast || dispo(m)).map(({ bereiche: _b, ...m }) => m);
  }

  if (methode === 'GET' && pfad === '/nachrichten') {
    const seit = Number(url.searchParams.get('seit') ?? 0);
    if (!Number.isInteger(seit) || seit < 0) throw new NachrichtFehler(400, 'seit muss eine Zahl sein');
    const namen = new Map(db.prepare('select id, name from mitarbeiter').all().map((m) => [m.id, m.name]));
    const zeilen = db
      .prepare("select * from nachrichten where rev > ? and (an = '*' or an = ? or von = ?) order by rev limit 200")
      .all(seit, ich, ich);
    return {
      rev: zeilen.length ? zeilen[zeilen.length - 1].rev : seit,
      nachrichten: zeilen.map((z) => ({
        id: z.id,
        von: z.von,
        vonName: namen.get(z.von) ?? 'Unbekannt',
        an: z.an,
        anName: z.an === '*' ? 'Alle' : (namen.get(z.an) ?? 'Unbekannt'),
        text: z.text ?? '',
        audio: !!z.audio,
        dauerMs: z.dauer_ms ?? 0,
        zeit: z.zeit,
        ...(z.geloescht ? { geloescht: true } : {}),
      })),
    };
  }

  if (methode === 'POST' && pfad === '/nachricht') {
    const { an, text, audio, dauerMs } = await koerper();
    if (typeof an !== 'string' || (an !== '*' && !db.prepare('select 1 from mitarbeiter where id = ? and aktiv = 1').get(an))) {
      throw new NachrichtFehler(400, 'Unbekannter Empfänger');
    }
    const t = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
    const a = typeof audio === 'string' && audio.length ? audio : null;
    if (!t && !a) throw new NachrichtFehler(400, 'Nachricht ist leer');
    if (a && (a.length > AUDIO_MAX || !/^[A-Za-z0-9+/=]+$/.test(a))) throw new NachrichtFehler(413, 'Sprachnachricht zu lang');
    const id = `nm_${randomBytes(8).toString('hex')}`;
    const r = db
      .prepare('insert into nachrichten (id, von, an, text, audio, dauer_ms, zeit) values (?, ?, ?, ?, ?, ?, ?)')
      .run(id, ich, an, t || null, a, Number.isFinite(dauerMs) ? Math.round(dauerMs) : null, new Date().toISOString());
    // Push an die Empfänger: an alle (ohne Absender und ohne Angehörige) oder an die eine Person.
    const ziele = an === '*' ? db.prepare("select id from mitarbeiter where aktiv = 1 and rolle != 'empfaenger' and id != ?").all(ich).map((z) => z.id) : [an];
    nachPost(ziele, wer.mitarbeiter.name, t ? t.slice(0, 140) : 'Sprachnachricht');
    return { id, rev: Number(r.lastInsertRowid) };
  }

  if (methode === 'GET' && audioId) {
    const z = db.prepare("select audio from nachrichten where id = ? and (an = '*' or an = ? or von = ?)").get(audioId, ich, ich);
    if (!z?.audio) throw new NachrichtFehler(404, 'Keine Aufnahme');
    return { daten: z.audio };
  }

  if (methode === 'POST' && loeschId) {
    const z = db.prepare('select * from nachrichten where id = ? and geloescht = 0').get(loeschId);
    if (!z) return { ok: true };
    if (z.von !== ich) throw new NachrichtFehler(403, 'Löschen kann nur, wer die Nachricht geschickt hat.');
    db.exec('begin immediate');
    try {
      db.prepare('delete from nachrichten where id = ?').run(loeschId);
      db.prepare('insert into nachrichten (id, von, an, zeit, geloescht) values (?, ?, ?, ?, 1)').run(z.id, z.von, z.an, z.zeit);
      db.exec('commit');
    } catch (e) {
      db.exec('rollback');
      throw e;
    }
    return { ok: true };
  }

  throw new NachrichtFehler(404, 'Unbekannter Weg');
}
