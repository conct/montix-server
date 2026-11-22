// Die beiden TSE-Dateien des DSFinV-K-Exports: 'tse.csv' und 'transactions_tse.csv'.
// Übernommen aus CHOOZY (server/werkzeug/dsfinvk/tse-zeilen.js), als ES-Modul. Reine Rechnung aus
// Belegzeilen (Spalten tse_* wie in kasse_belege), deshalb trocken prüfbar (test/dsfinvk.test.mjs).
//
// Felder aus der amtlichen index.xml (DSFinV-K 2.4), Abschnitte 'Stamm_TSE' und 'TSE_Transaktionen'.
// Was die TSE selbst beisteuert ('stamm': Zertifikat, Zeitformat, Kodierung) kommt aus
// tse.stammdaten(); ist sie beim Export nicht erreichbar, tragen die Belege Seriennummer,
// Algorithmus und Schlüssel selbst.

/** Längengrenzen aus der index.xml — länger fällt die Datei durch. */
export const MAX = { TSE_SERIAL: 68, TSE_SIG_ALGO: 21, TSE_ZEITFORMAT: 31, TSE_PD_ENCODING: 5, TSE_PUBLIC_KEY: 512, ZERTIFIKAT: 1000 };

const kurz = (wert, laenge) => String(wert ?? '').slice(0, laenge);

/** Eine Stammzeile je TSE, die in diesem Abschluss signiert hat (TSE_ID zählt je Abschluss ab 1). */
export function stammZeilen(belege, stamm = {}) {
  const reihen = new Map();
  for (const b of belege) {
    if (String(b.tse_status) !== 'signiert' || !b.tse_serie) continue;
    const serie = String(b.tse_serie);
    if (reihen.has(serie)) continue;
    const zertifikat = String((serie === String(stamm.seriennummer || '') ? stamm.zertifikat : '') || '');
    reihen.set(serie, {
      TSE_ID: reihen.size + 1,
      TSE_SERIAL: kurz(serie, MAX.TSE_SERIAL),
      TSE_SIG_ALGO: kurz(b.tse_algo || stamm.algorithmus || '', MAX.TSE_SIG_ALGO),
      // fiskaly führt Protokollzeiten in Unix-Sekunden; was die TSE selbst sagt, geht vor.
      TSE_ZEITFORMAT: kurz(stamm.zeitformat || 'unixTime', MAX.TSE_ZEITFORMAT),
      TSE_PD_ENCODING: kurz(stamm.kodierung || 'UTF-8', MAX.TSE_PD_ENCODING),
      TSE_PUBLIC_KEY: kurz(b.tse_schluessel || stamm.schluessel || '', MAX.TSE_PUBLIC_KEY),
      // Das Zertifikat wird auf zwei Felder zu je 1000 Zeichen verteilt.
      TSE_ZERTIFIKAT_I: zertifikat.slice(0, MAX.ZERTIFIKAT),
      TSE_ZERTIFIKAT_II: zertifikat.slice(MAX.ZERTIFIKAT, MAX.ZERTIFIKAT * 2),
    });
  }
  return [...reihen.values()];
}

/** Transaktionszeile zu einem Beleg — oder null, wenn er nicht signiert ist (das steht dann in BON_NOTIZ). */
export function transaktionsZeile(b, tseIdJeSerie) {
  if (String(b.tse_status) !== 'signiert') return null;
  return {
    TSE_ID: tseIdJeSerie.get(String(b.tse_serie)) || '',
    TSE_TANR: Number(b.tse_transaktion) || '',
    TSE_TA_START: String(b.tse_start || ''),
    TSE_TA_ENDE: String(b.tse_ende || ''),
    TSE_TA_VORGANGSART: 'Kassenbeleg-V1',
    TSE_TA_SIGZ: Number(b.tse_zaehler) || '',
    TSE_TA_SIG: String(b.tse_pruefwert || ''),
    TSE_TA_FEHLER: '',
    // Die signierten Daten im Klartext — die Cloud-TSE löscht nach drei Monaten, aufzubewahren sind zehn Jahre.
    TSE_VORGANGSDATEN: String(b.tse_vorgang || ''),
  };
}
