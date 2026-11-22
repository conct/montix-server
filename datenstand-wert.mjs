// Stand der Karten- und Adressdaten (gesetzt von datenstand.mjs, gelesen von den Info-Wegen).
// Eigenes Modul, damit karte.mjs und adresse.mjs es ohne Ringabhängigkeit lesen können.
/** Je Datei: { neu: 'fehlt' | 'neuer' | false, geprueft, befehl } oder null (noch nicht geprüft). */
export const datenStand = { karte: null, adressen: null };
