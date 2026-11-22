// Eigener Server: einmal am Tag beim Montix-Server nachsehen, ob es neue Karten- oder Adressdaten
// gibt (nur die Kennung des Stands, kein Download). Neues steht im Protokoll, in /karte/info und
// /adresse/info (`neu`), und der Verwalter sieht es in der App (Einstellungen → Abgleich).
// Mit MONTIX_DATEN_AUTO=an holt der Server neue Stände selbst, nachts zwischen 2 und 5 Uhr.
// Der zentrale Server (MONTIX_VERTRAG=pflicht) ist selbst die Quelle und prüft nichts.

import { existsSync, readFileSync } from 'node:fs';

import { ADRESSEN_QUELLE, adressDatei, adressenHolen } from './adressen.mjs';
import { datenStand } from './datenstand-wert.mjs';
import { KARTE_QUELLE, karteHolen, kartenDatei } from './karte.mjs';

export { datenStand };

const DATEIEN = [
  { name: 'karte', quelle: () => process.env.MONTIX_KARTE_QUELLE ?? KARTE_QUELLE, ziel: kartenDatei, holen: karteHolen, befehl: 'node verwalten.mjs karte' },
  { name: 'adressen', quelle: () => process.env.MONTIX_ADRESSEN_QUELLE ?? ADRESSEN_QUELLE, ziel: adressDatei, holen: adressenHolen, befehl: 'node verwalten.mjs adressen' },
];

let holtGerade = false;

export async function datenPruefen({ holen = fetch, auto = process.env.MONTIX_DATEN_AUTO === 'an', jetzt = new Date(), melden = console.log } = {}) {
  for (const d of DATEIEN) {
    let etag = null;
    try {
      const r = await holen(d.quelle(), { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(20_000) });
      await r.body?.cancel();
      if (!r.ok) continue;
      etag = r.headers.get('etag');
    } catch {
      continue; // ohne Netz: morgen wieder
    }
    const ziel = d.ziel();
    const merk = `${ziel}.etag`;
    const neu = !existsSync(ziel) ? 'fehlt' : etag && (!existsSync(merk) || readFileSync(merk, 'utf8') !== etag) ? 'neuer' : false;
    datenStand[d.name] = { neu, geprueft: jetzt.toISOString(), befehl: d.befehl };
    if (!neu) continue;
    const nachts = jetzt.getHours() >= 2 && jetzt.getHours() < 5;
    if (auto && nachts && !holtGerade) {
      holtGerade = true;
      try {
        await d.holen({ melden: (m) => melden(`[${d.name}] ${m}`) });
        datenStand[d.name] = { neu: false, geprueft: new Date().toISOString(), befehl: d.befehl };
      } catch (e) {
        melden(`[${d.name}] automatisch holen ging nicht: ${e?.message ?? e}`);
      } finally {
        holtGerade = false;
      }
    } else {
      melden(`Hinweis: ${neu === 'fehlt' ? 'Keine' : 'Neue'} ${d.name === 'karte' ? 'Kartendaten' : 'Adressdaten'} ${neu === 'fehlt' ? 'auf diesem Server' : 'beim Montix-Server'} — holen mit: ${d.befehl}${auto ? ' (oder nachts automatisch)' : ''}`);
    }
  }
}
