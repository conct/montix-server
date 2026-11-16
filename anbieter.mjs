// Teile, die nur auf dem zentralen Montix-Server laufen: Store-Abos (abo.mjs) sowie Postfach,
// Lizenzausstellung und Testbetriebe (postfach.mjs). Im öffentlichen Paket für den eigenen Server
// fehlen beide Dateien; dann gelten die leeren Fassungen hier, und alles andere läuft unverändert.

async function laden(datei) {
  try {
    return await import(datei);
  } catch (e) {
    // Nur „Datei gibt es nicht“ zählt als „nicht dabei“ — jeder andere Fehler soll laut bleiben.
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(datei.slice(2))) return null;
    throw e;
  }
}

const abo = await laden('./abo.mjs');
const postfach = await laden('./postfach.mjs');

/** true auf dem zentralen Server (mit Abo und Postfach), false im öffentlichen Paket. */
export const ZENTRAL = !!(abo && postfach);

class NurZentral extends Error {
  constructor() {
    super('Käufe über Google Play und den App Store laufen nur über den Montix-Server, nicht über einen eigenen.');
    this.status = 404;
  }
}

export const KaufFehler = abo?.KaufFehler ?? NurZentral;
export const betriebUuid = abo?.betriebUuid ?? (() => null);

export const erstelleAbos =
  abo?.erstelleAbos ??
  (() => ({
    stand: () => null,
    auffrischen: async () => {},
    appleMeldung: () => {
      throw new NurZentral();
    },
    playMeldung: async () => {
      throw new NurZentral();
    },
    playPruefen: async () => {
      throw new NurZentral();
    },
    applePruefen: () => {
      throw new NurZentral();
    },
  }));

export const erstellePostfach =
  postfach?.erstellePostfach ??
  (() => ({
    weg: async () => false,
    betriebStand: () => null,
    testbetriebMerken: () => null,
    testGebucht: () => {},
    aufraeumen: () => {},
  }));
