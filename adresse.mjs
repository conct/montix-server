// Adressvorschläge beim Tippen (Kunde, Firmendaten). Die App fragt hier, nicht direkt beim
// Geodienst: So sieht der Dienst weder Gerät noch IP-Adresse, nur den getippten Text.
// Quelle ist Photon (OpenStreetMap-Daten, photon.komoot.io, ohne Schlüssel); eine eigene
// Photon-Instanz lässt sich über MONTIX_PHOTON einstellen. Gespeichert wird nichts außer einem
// kurzen Zwischenspeicher im Arbeitsspeicher.
//
//   GET /adresse?q=<text>          → { vorschlaege: [{ text, strasse, plz, ort, land }] }
//   GET /adresse?lat=<..>&lon=<..>  → dasselbe für die Umgebung eines Punkts, nächste zuerst
//                                      („Aktuelle Position“; auf ~10 m gerundet, nichts gespeichert)

const PHOTON = process.env.MONTIX_PHOTON ?? 'https://photon.komoot.io';
const MAX_CACHE = 2000;

/** Photon-Treffer → Montix-Anschrift. Ohne Ort taugt er nicht als Anschrift. */
export function alsAnschrift(f) {
  const p = f?.properties ?? {};
  const ort = p.city ?? p.town ?? p.village ?? p.municipality ?? (p.type === 'city' ? p.name : undefined) ?? p.county;
  if (!ort) return null;
  const strasse = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : p.type === 'street' ? p.name : '';
  const plz = p.postcode ?? '';
  const land = String(p.countrycode ?? 'DE').toUpperCase();
  const ortsteil = p.district && p.district !== ort ? ` (${p.district})` : '';
  const text = [strasse, [plz, ort].filter(Boolean).join(' ') + ortsteil, land !== 'DE' ? land : ''].filter(Boolean).join(', ');
  return { text, strasse, plz, ort, land };
}

/** Vorschlagsdienst mit Zwischenspeicher. `holen` ist in Tests ein Fänger statt fetch. */
export function erstelleAdresssuche({ holen = fetch } = {}) {
  const cache = new Map();
  return async function suchen(q, lat, lon) {
    let url;
    let key;
    if (lat != null && lon != null && lat !== '' && lon !== '') {
      const la = Number(lat);
      const lo = Number(lon);
      if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
        throw Object.assign(new Error('Ungültige Position.'), { status: 400 });
      }
      key = `@${la.toFixed(4)},${lo.toFixed(4)}`;
      url = `${PHOTON}/reverse?lat=${la.toFixed(4)}&lon=${lo.toFixed(4)}&lang=de&limit=8&radius=0.3`;
    } else {
      const text = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (text.length < 3) return { vorschlaege: [] };
      key = text.toLowerCase();
      // Vorrang für Deutschland (Mitte), ohne andere Länder auszuschließen.
      url = `${PHOTON}/api/?q=${encodeURIComponent(text)}&lang=de&limit=8&lat=51.2&lon=10.4&zoom=6&layer=house&layer=street&layer=city`;
    }
    if (cache.has(key)) return cache.get(key);
    const r = await holen(url, { headers: { 'user-agent': 'Montix-Abgleich (feif.space)' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Object.assign(new Error('Adressvorschläge gerade nicht erreichbar.'), { status: 502 });
    const daten = await r.json();
    const gesehen = new Set();
    const vorschlaege = [];
    for (const f of daten?.features ?? []) {
      const a = alsAnschrift(f);
      if (!a || gesehen.has(a.text)) continue;
      gesehen.add(a.text);
      vorschlaege.push(a);
      if (vorschlaege.length >= 6) break;
    }
    const erg = { vorschlaege };
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, erg);
    return erg;
  };
}
