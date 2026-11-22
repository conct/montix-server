// Adressvorschläge beim Tippen (Kunde, Firmendaten, Tour-Stopps). Gesucht wird in der eigenen
// Adressdatei des Servers (adressen.mjs, Daten aus OpenStreetMap) — kein fremder Dienst sieht den
// getippten Text. Gespeichert wird nichts.
//
//   GET /adresse?q=<text>          → { vorschlaege: [{ text, strasse, plz, ort, land }] }
//   GET /adresse?lat=<..>&lon=<..>  → dasselbe für die Umgebung eines Punkts, nächste zuerst
//                                      („Aktuelle Position“; nichts gespeichert)
//   GET /adresse/info              → { daten: true|false, stand, laender }

import { adressenStand, suchen, umgebung } from './adressen.mjs';
import { datenStand } from './datenstand-wert.mjs';

const anschrift = ({ text, strasse, plz, ort, land }) => ({ text, strasse, plz, ort, land });

export function erstelleAdresssuche() {
  return async function vorschlaege(q, lat, lon) {
    if (lat != null && lon != null && lat !== '' && lon !== '') {
      const la = Number(lat);
      const lo = Number(lon);
      if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
        throw Object.assign(new Error('Ungültige Position.'), { status: 400 });
      }
      return { vorschlaege: umgebung(la, lo, 6).map(anschrift) };
    }
    const text = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (text.length < 3) return { vorschlaege: [] };
    return { vorschlaege: suchen(text, { grenze: 6 }).map(anschrift) };
  };
}

export function adresseInfo() {
  const s = adressenStand();
  const neu = datenStand.adressen?.neu ?? (s ? false : 'fehlt');
  return s ? { daten: true, ...s, neu, ...(neu ? { holen: 'node verwalten.mjs adressen' } : {}) } : { daten: false, neu, holen: 'node verwalten.mjs adressen' };
}
