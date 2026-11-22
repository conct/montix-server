// Die TSE, wie die Kasse sie sieht: ein Ding mit `signiere(vorgang)` und `stammdaten()` — oder null,
// dann bucht die Kasse mit tse_status 'keine'. Übernommen aus CHOOZY (server/tse/index.js).
//
// Welcher Anbieter angeschlossen ist, weiß die Kasse nicht. Heute nur fiskaly SIGN DE v2.
// Montix: Die Zugangsdaten kommen je Betrieb aus dessen Datenbank (kasse.mjs, der Verwalter trägt
// sie in der App ein). Auf einem eigenen Server darf die Umgebung als Vorgabe dienen:
//
//     TSE_ANBIETER=fiskaly  TSE_API_KEY=…  TSE_API_SECRET=…  TSE_TSS_ID=…  TSE_CLIENT_ID=…
//     TSE_BASIS=…           (nur für eine andere Adresse als die Standard-Middleware)
//
// Fehlt eine Angabe, bleibt die TSE aus — lieber kein Anschluss als ein halber.

import { fiskalyTse } from './fiskaly.mjs';
import { ausVorgang } from './vorgangsdaten.mjs';

/** Aus fertigen Einstellungen ({ apiKey, apiSecret, tssId, clientId, basis }) die TSE bauen. */
export function tseMit(einstellungen, optionen = {}) {
  const roh = fiskalyTse(einstellungen, optionen);
  if (!roh) return null;
  return {
    anbieter: 'fiskaly',
    /**
     * Signieren. Die Vorgangsdaten entstehen HIER und gehen auch zurück: Die Cloud-TSE hält sie
     * nur drei Monate, aufbewahrungspflichtig sind sie zehn Jahre — sie gehören an den Beleg.
     */
    async signiere(vorgang) {
      const vorgangsdaten = ausVorgang(vorgang);
      const daten = await roh.signiere({ ...vorgang, vorgangsdaten });
      return { ...daten, vorgangsdaten };
    },
    async stammdaten() {
      return roh.stammdaten();
    },
  };
}

/**
 * Zugang zur TSS aus der Umgebung (TSE_*), ohne Client — in Montix hat jede Kasse (jedes Gerät)
 * ihren eigenen fiskaly-Client, die Client-ID steht an der Kasse. Oder null.
 */
export function zugangAus(umgebung = process.env, protokoll = null) {
  const anbieter = String(umgebung.TSE_ANBIETER || '').trim().toLowerCase();
  if (!anbieter || anbieter === 'keine') return null;
  if (anbieter !== 'fiskaly') {
    protokoll?.warnung?.('tse', 'Unbekannter Anbieter – TSE bleibt aus', { anbieter });
    return null;
  }
  const e = { basis: umgebung.TSE_BASIS, apiKey: umgebung.TSE_API_KEY, apiSecret: umgebung.TSE_API_SECRET, tssId: umgebung.TSE_TSS_ID };
  if (!e.apiKey || !e.apiSecret || !e.tssId) {
    protokoll?.warnung?.('tse', 'Zugangsdaten unvollständig – TSE bleibt aus', { anbieter });
    return null;
  }
  return e;
}

/** Vollständige Einstellungen aus der Umgebung (mit TSE_CLIENT_ID, wie in CHOOZY), oder null. */
export function einstellungenAus(umgebung = process.env, protokoll = null) {
  const z = zugangAus(umgebung, protokoll);
  if (!z) return null;
  const e = { ...z, clientId: umgebung.TSE_CLIENT_ID };
  if (!e.clientId) {
    protokoll?.warnung?.('tse', 'Client-ID fehlt – TSE bleibt aus', { anbieter: 'fiskaly' });
    return null;
  }
  return e;
}

/** Wie in CHOOZY: TSE aus der Umgebung, oder null. */
export function tseAus(umgebung = process.env, protokoll = null, optionen = {}) {
  const e = einstellungenAus(umgebung, protokoll);
  return e ? tseMit(e, optionen) : null;
}
