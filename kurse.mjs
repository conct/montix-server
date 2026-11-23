// EZB-Referenzkurse zur Orientierung (nie für einen Beleg): Was ist eine offene Rechnung in CHF heute
// ungefähr in Euro wert? Der Server des Betriebs holt einmal am Tag das freie XML der Europäischen
// Zentralbank (eurofxref-daily, ohne Vertrag und ohne Schlüssel); das Gerät fragt nie selbst draußen.
// Die steuerlich maßgeblichen Kurse (BMF, § 16 Abs. 6 UStG) kommen nicht von hier, sondern mit der App.
//
// Abschalten: MONTIX_EZB=aus. Stand liegt in <daten>/ezb-kurse.json, damit ein Neustart nichts verliert.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const QUELLE = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ALTER_MS = 12 * 3600_000;

/** XML der EZB lesen: { datum: 'JJJJ-MM-TT', kurse: { USD: 1.15, … } } (1 EUR = x Währung). */
export function ezbLesen(xml) {
  const datum = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const kurse = {};
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) kurse[m[1]] = Number(m[2]);
  if (!datum || !Object.keys(kurse).length) throw new Error('EZB-Kurse nicht lesbar');
  return { datum, kurse };
}

/**
 * @param {string} ordner Datenordner des Servers
 * @param {{ holen?: typeof fetch, umgebung?: Record<string, string|undefined> }} o
 */
export function erstelleKurse(ordner, { holen = fetch, umgebung = process.env } = {}) {
  const datei = join(ordner, 'ezb-kurse.json');
  const aus = umgebung.MONTIX_EZB === 'aus';
  let stand = null;
  try {
    stand = JSON.parse(readFileSync(datei, 'utf8'));
  } catch {
    stand = null;
  }
  return {
    stand: () => (aus ? null : stand),
    /** Höchstens alle 12 Stunden neu holen; Fehler lassen den alten Stand stehen. */
    async auffrischen(jetzt = Date.now()) {
      if (aus || (stand?.geholt && jetzt - Date.parse(stand.geholt) < ALTER_MS)) return stand;
      try {
        const r = await holen(QUELLE, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`EZB antwortet mit ${r.status}`);
        stand = { ...ezbLesen(await r.text()), geholt: new Date(jetzt).toISOString(), quelle: 'EZB-Referenzkurse' };
        writeFileSync(datei, JSON.stringify(stand));
      } catch (e) {
        console.error('[kurse]', e instanceof Error ? e.message : e);
      }
      return stand;
    },
  };
}
