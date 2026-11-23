// Buchbare Zusatzmodule je Betrieb (`kasse`, die Barkasse mit TSE) — mit Anzahl: Bei der
// Barkasse ist jedes Gerät, das Bargeld erfasst, eine eigene Kasse (eigener TSE-Client), gebucht
// wird also je Kasse. Auf dem zentralen Server setzt der Anbieter die Anzahl — in der Verwaltung
// (postfach.mjs, „Betriebe“) oder mit `node verwalten.mjs modul <betrieb> kasse <anzahl>` (0 =
// abbestellt). Auf einem eigenen Server eines Betriebs braucht es keine Buchung.
//
// `mehrplatz` ist kein Modul, sondern ein Vermerk: Der Betrieb hat eine gekaufte Mehrplatz-Lizenz
// (Anzahl = Plätze). Die Lizenz selbst ist ein Schlüssel auf den Geräten, den der Server nicht
// sieht; der Vermerk sorgt dafür, dass die Monatsrechnung die Modulpreise von Einzel Plus nimmt.

export const MODULE = { kasse: 'Barkasse mit TSE', mehrplatz: 'Mehrplatz-Lizenz (Modulpreise wie Einzel Plus)' };

const tabelle = (db) => db.exec('create table if not exists module (id text primary key, anzahl integer not null, gebucht text not null, von text)');

/** Anzahl setzen (0 = abbestellt). Bereits gespeicherte Daten des Moduls bleiben. */
export function modulSetzen(db, id, anzahl, von = 'anbieter') {
  if (!(id in MODULE)) throw new Error(`Unbekanntes Modul: ${id}`);
  const n = Number(anzahl);
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error('Anzahl: ganze Zahl von 0 bis 999');
  tabelle(db);
  if (n > 0) db.prepare('insert into module values (?, ?, ?, ?) on conflict (id) do update set anzahl = excluded.anzahl, gebucht = excluded.gebucht, von = excluded.von').run(id, n, new Date().toISOString(), von);
  else db.prepare('delete from module where id = ?').run(id);
}

/** Gebuchte Anzahl (0 = nicht gebucht). */
export function modulAnzahl(db, id) {
  tabelle(db);
  return db.prepare('select anzahl from module where id = ?').get(id)?.anzahl ?? 0;
}

export function gebuchteModule(db) {
  tabelle(db);
  return db.prepare('select id, anzahl, gebucht from module order by id').all();
}
