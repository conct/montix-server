// Kleine Adressdatei für Tests — gleicher Aufbau wie scripts/adressen-erzeugen.py.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normiert } from '../adressen.mjs';

const MARKE = ['xadr', 'xstr', 'xort'];

/** Legt die Datei an und setzt MONTIX_ADRESSEN darauf. Einträge: {art, strasse, nr, plz, ort, land, lat, lon, rang}. */
export function testAdressen(eintraege) {
  const pfad = join(mkdtempSync(join(tmpdir(), 'adressen-')), 'adressen.sqlite');
  const db = new DatabaseSync(pfad);
  db.exec(`
    create table eintrag (id integer primary key, art integer not null, strasse text, nr text, plz text, ort text, land text not null, lat real not null, lon real not null, rang integer not null);
    create table meta (schluessel text primary key, wert text);
    create virtual table suche using fts5(text, content='', columnsize=0, detail=column, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
    create index eintrag_lage on eintrag (lat, lon);
    insert into meta values ('stand', '2026-11-20'), ('laender', 'de,at');
  `);
  const rein = db.prepare('insert into eintrag (art, strasse, nr, plz, ort, land, lat, lon, rang) values (?,?,?,?,?,?,?,?,?)');
  const index = db.prepare('insert into suche (rowid, text) values (?, ?)');
  for (const e of eintraege) {
    const r = rein.run(e.art, e.strasse ?? '', e.nr ?? '', e.plz ?? '', e.ort ?? '', e.land ?? 'de', e.lat, e.lon, e.rang ?? 0);
    index.run(r.lastInsertRowid, `${MARKE[e.art]} ${normiert(`${e.strasse ?? ''} ${e.nr ?? ''} ${e.plz ?? ''} ${e.ort ?? ''}`)}`);
  }
  db.close();
  process.env.MONTIX_ADRESSEN = pfad;
  return pfad;
}
