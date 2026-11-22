// Cloud-TSE von fiskaly (SIGN DE, API v2). Übernommen aus CHOOZY (server/tse/fiskaly.js), als
// ES-Modul; gegen die OpenAPI-Beschreibung fiskaly SIGN DE API 2.2.3 abgeglichen (18.10.2026):
//
//   1. Die Transaktionskennung MUSS eine UUID sein — sie entsteht aus dem SHA-256 der Belegnummer.
//   2. Zeitstempel kommen als Unix-Sekunden zurück und werden hier zu ISO 8601 (DSFinV-K).
//   3. Die Antwort trägt qr_code_data (Prüfcode für den Bon), Algorithmus und öffentlichen Schlüssel.
//
// Hier wird nicht gerechnet: Was signiert wird, baut vorgangsdaten.mjs. Diese Datei spricht nur mit
// dem Anbieter. Nur node:crypto und node:https; in Tests ersetzt ein Fänger `anfrage`.

import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';

export const STANDARD_BASIS = 'https://kassensichv-middleware.fiskaly.com/api/v2';

/** Ein JSON-Aufruf über https, ohne fremdes Paket. */
export function anfrage(adresse, { methode = 'GET', rumpf = null, kopf = {} } = {}) {
  return new Promise((fertig, gescheitert) => {
    const ziel = new URL(adresse);
    const daten = rumpf ? Buffer.from(JSON.stringify(rumpf), 'utf8') : null;
    const bitte = request(
      {
        hostname: ziel.hostname,
        port: ziel.port || undefined,
        path: ziel.pathname + ziel.search,
        method: methode,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...(daten ? { 'Content-Length': daten.length } : {}), ...kopf },
        timeout: 15000,
      },
      (antwort) => {
        const teile = [];
        antwort.on('data', (t) => teile.push(t));
        antwort.on('end', () => {
          const text = Buffer.concat(teile).toString('utf8');
          try {
            const gelesen = text ? JSON.parse(text) : {};
            if (antwort.statusCode >= 400) {
              gescheitert(new Error(`TSE ${antwort.statusCode}: ${gelesen.message || gelesen.error || text.slice(0, 200)}`));
              return;
            }
            fertig(gelesen);
          } catch (e) {
            gescheitert(new Error(`TSE-Antwort unlesbar: ${e.message}`));
          }
        });
      },
    );
    bitte.on('timeout', () => bitte.destroy(new Error('TSE antwortet nicht')));
    bitte.on('error', gescheitert);
    if (daten) bitte.write(daten);
    bitte.end();
  });
}

/** Die beiden Rümpfe, die gegen die API-Referenz zu prüfen sind. Beim Start KEINE Vorgangsdaten (DSFinV-K). */
export const RUMPF = {
  start: (clientId) => ({ state: 'ACTIVE', client_id: clientId }),
  ende: (clientId, processType, processData, belegId) => ({
    state: 'FINISHED',
    client_id: clientId,
    schema: { raw: { process_type: processType, process_data: Buffer.from(processData, 'utf8').toString('base64') } },
    // Die Belegnummer als Beigabe — ohne sie lässt sich eine Transaktion beim Anbieter keinem Bon zuordnen.
    metadata: belegId ? { beleg: String(belegId).slice(0, 64) } : undefined,
  }),
};

/**
 * Transaktionskennung aus der Belegnummer (UUIDv4-Form aus SHA-256). Zweimal dieselbe Kennung ist
 * gewollt: Ein zweiter Versuch nach einem Abbruch landet auf derselben Transaktion statt eine
 * zweite anzulegen, die niemand abschließt. Ohne Belegnummer: Zufall.
 */
export function kennungFuer(belegId) {
  if (!belegId) return randomUUID();
  const h = createHash('sha256').update(String(belegId), 'utf8').digest('hex');
  const version = `4${h.slice(13, 16)}`;
  const variante = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${version}-${variante}-${h.slice(20, 32)}`;
}

/** Unix-Sekunden → ISO 8601 (DSFinV-K verlangt ISO für TSE_TA_START/-ENDE); Text bleibt Text. */
export function alsIso(wert) {
  if (wert === null || wert === undefined || wert === '') return null;
  if (typeof wert === 'number' || /^\d{9,}$/.test(String(wert))) return new Date(Number(wert) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return String(wert);
}

/** Antwort des Anbieters auf das, was Beleg, Bon und Export brauchen. */
export const ANTWORT = (gelesen) => {
  const signatur = gelesen?.signature || {};
  const protokoll = gelesen?.log || {};
  return {
    seriennummer: gelesen.tss_serial_number || gelesen.tss_serial || null,
    signaturzaehler: Number(signatur.counter) || null,
    transaktionsnummer: Number(gelesen.number) || null,
    pruefwert: signatur.value || null,
    start: alsIso(gelesen.time_start) || alsIso(protokoll.timestamp),
    ende: alsIso(gelesen.time_end) || alsIso(protokoll.timestamp),
    algorithmus: signatur.algorithm || null,
    schluessel: signatur.public_key || null,
    pruefcode: gelesen.qr_code_data || null,
  };
};

/**
 * Die TSE aufbauen — oder null, wenn sie nicht vollständig eingerichtet ist.
 * @param {{ basis?: string, apiKey?: string, apiSecret?: string, tssId?: string, clientId?: string }} einstellungen
 * @param {{ anfrage?: typeof anfrage }} [optionen]  in Tests ein Fänger statt https
 */
export function fiskalyTse(einstellungen = {}, { anfrage: holen = anfrage } = {}) {
  const basis = String(einstellungen.basis || STANDARD_BASIS).replace(/\/$/, '');
  const apiKey = String(einstellungen.apiKey || '');
  const apiSecret = String(einstellungen.apiSecret || '');
  const tssId = String(einstellungen.tssId || '');
  const clientId = String(einstellungen.clientId || '');
  if (!apiKey || !apiSecret || !tssId || !clientId) return null;

  let token = null;
  let tokenBis = 0;

  async function anmelden() {
    if (token && Date.now() < tokenBis - 30000) return token;
    const a = await holen(`${basis}/auth`, { methode: 'POST', rumpf: { api_key: apiKey, api_secret: apiSecret } });
    token = a.access_token;
    tokenBis = Date.now() + (Number(a.access_token_expires_in) * 1000 || 900000);
    return token;
  }

  /**
   * Transaktion starten und sofort beenden: Die Kasse bucht erst, wenn der Verkauf feststeht. Der
   * Start ist trotzdem Pflicht — dort vergibt die TSE Transaktionsnummer und Startzeit.
   */
  async function signiere(vorgang) {
    const kopf = { Authorization: `Bearer ${await anmelden()}` };
    const belegId = String(vorgang?.belegId || '');
    const ziel = `${basis}/tss/${encodeURIComponent(tssId)}/tx/${encodeURIComponent(kennungFuer(belegId))}`;
    await holen(`${ziel}?tx_revision=1`, { methode: 'PUT', rumpf: RUMPF.start(clientId), kopf });
    const fertig = await holen(`${ziel}?tx_revision=2`, { methode: 'PUT', rumpf: RUMPF.ende(clientId, 'Kassenbeleg-V1', vorgang.vorgangsdaten, belegId), kopf });
    const werte = ANTWORT(fertig);
    if (!werte.pruefwert) throw new Error('TSE ohne Prüfwert');
    return werte;
  }

  /** Stammdaten der TSS (Zertifikat, Zeitformat …) — für einen späteren DSFinV-K-Export. */
  async function stammdaten() {
    const g = await holen(`${basis}/tss/${encodeURIComponent(tssId)}`, { kopf: { Authorization: `Bearer ${await anmelden()}` } });
    return {
      seriennummer: g.serial_number || null,
      algorithmus: g.signature_algorithm || null,
      zeitformat: g.signature_timestamp_format || null,
      kodierung: g.transaction_data_encoding || null,
      schluessel: g.public_key || null,
      zertifikat: g.certificate || null,
      bsiNummer: g.bsi_certification_id || null,
    };
  }

  return { signiere, stammdaten, anbieter: 'fiskaly', tssId, clientId };
}
