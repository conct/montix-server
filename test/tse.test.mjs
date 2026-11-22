// TSE-Kern ohne Netz: Vorgangsdaten gegen die Beispiele der DSFinV-K 2.4 (Anhang I) und der
// fiskaly-Adapter gegen die OpenAPI-Beschreibung (SIGN DE API 2.2.3). Übernommen aus den
// CHOOZY-Prüfungen server/tse/*.pruefung.js; statt https ein Fänger.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { alsIso, ANTWORT, fiskalyTse, kennungFuer, RUMPF, STANDARD_BASIS } from '../tse/fiskaly.mjs';
import { tseAus, tseMit } from '../tse/index.mjs';
import { betrag, vorgangsdaten } from '../tse/vorgangsdaten.mjs';

test('Vorgangsdaten: Beispiele aus Anhang I wörtlich', () => {
  assert.equal(vorgangsdaten({ steuer: [[19, 100]], zahlungen: [{ betrag: 100, art: 'bar' }] }), 'Beleg^100.00_0.00_0.00_0.00_0.00^100.00:Bar');
  assert.equal(vorgangsdaten({ steuer: [[19, 50], [7, 50]], zahlungen: [{ betrag: 100, art: 'karte' }] }), 'Beleg^50.00_50.00_0.00_0.00_0.00^100.00:Unbar');
  assert.equal(vorgangsdaten({ steuer: [[0, 100]], zahlungen: [{ betrag: 100, art: 'bar' }] }), 'Beleg^0.00_0.00_0.00_0.00_100.00^100.00:Bar');
  assert.equal(vorgangsdaten({ steuer: [[19, -20], [16, 80]], zahlungen: [{ betrag: 60, art: 'karte' }] }), 'Beleg^60.00_0.00_0.00_0.00_0.00^60.00:Unbar');
});

test('Vorgangsdaten: Storno, Sortierung, Zusammenfassen, Abschneiden', () => {
  assert.equal(vorgangsdaten({ steuer: [[19, -2.5]], zahlungen: [{ betrag: -2.5, art: 'bar' }] }), 'Beleg^-2.50_0.00_0.00_0.00_0.00^-2.50:Bar');
  assert.equal(vorgangsdaten({ steuer: [[19, 10], [16, 5], [7, 2], [5, 1]], zahlungen: [{ betrag: 18, art: 'bar' }] }), 'Beleg^15.00_3.00_0.00_0.00_0.00^18.00:Bar');
  assert.equal(vorgangsdaten({ steuer: [[19, 30]], zahlungen: [{ betrag: 10, art: 'bar' }, { betrag: 20, art: 'bar' }] }), 'Beleg^30.00_0.00_0.00_0.00_0.00^30.00:Bar');
  assert.equal(vorgangsdaten({ steuer: [[19, 30]], zahlungen: [{ betrag: 20, art: 'unbar' }, { betrag: 10, art: 'bar' }] }), 'Beleg^30.00_0.00_0.00_0.00_0.00^10.00:Bar_20.00:Unbar');
  assert.equal(
    vorgangsdaten({ steuer: [[19, 30]], zahlungen: [{ betrag: 10, art: 'bar' }, { betrag: 3.5, art: 'bar', waehrung: 'CHF' }] }),
    'Beleg^30.00_0.00_0.00_0.00_0.00^10.00:Bar_3.50:Bar:CHF',
  );
  assert.equal(vorgangsdaten({ steuer: [[19, 10]], zahlungen: [{ betrag: 10, art: 'bar' }, { betrag: 0, art: 'unbar' }] }), 'Beleg^10.00_0.00_0.00_0.00_0.00^10.00:Bar');
  assert.equal(betrag(1.999), '1.99');
  assert.equal(betrag(-1.999), '-1.99');
  // Gleitkomma-Rest darf keinen Cent verschlucken (0.29 * 100 = 28.999…).
  assert.equal(betrag(0.29), '0.29');
  assert.equal(betrag(1.13 + 0.16), '1.29');
  assert.throws(() => vorgangsdaten({ steuer: [[13, 10]], zahlungen: [] }), /Unbekannter Steuersatz/);
});

const ANTWORT_VOM_ANBIETER = {
  _id: '0b2f4f3e-8d8c-4a1e-9c2b-6b9f0a1d2e3f',
  number: 42,
  time_start: 1792273500,
  time_end: 1792273512,
  tss_serial_number: 'b3d4e5f6a7b8c9d0e1f2',
  state: 'FINISHED',
  qr_code_data: 'V0;KAS-0001;Kassenbeleg-V1;...;ecdsa-plain-SHA384;',
  log: { operation: 'FinishTransaction', timestamp: 1792273512, timestamp_format: 'unixTime' },
  signature: { value: 'MEUCIQDm2v9Zr0W1e0b1Uu0t2O3f4g5h6i7j8k9l0m1n2o3p4q==', algorithm: 'ecdsa-plain-SHA384', counter: 7, public_key: 'BFxk2b8n1Q9w0e8r7t6y5u4i3o2p1a0s9d8f7g6h5j4k3l2m1n0' },
};

test('fiskaly: Rümpfe für Start und Abschluss', () => {
  const start = RUMPF.start('c1ffd4d1-0000-4000-8000-000000000001');
  assert.equal(start.state, 'ACTIVE');
  assert.equal(start.client_id, 'c1ffd4d1-0000-4000-8000-000000000001');
  assert.equal(start.schema, undefined, 'beim Start keine Vorgangsdaten (DSFinV-K)');
  const daten = 'Beleg^19.00_0.00_0.00_0.00_0.00^19.00:Bar';
  const ende = RUMPF.ende('c1', 'Kassenbeleg-V1', daten, 'KB-2026-0001');
  assert.equal(ende.state, 'FINISHED');
  assert.equal(ende.schema.raw.process_type, 'Kassenbeleg-V1');
  assert.equal(Buffer.from(ende.schema.raw.process_data, 'base64').toString('utf8'), daten);
  assert.equal(ende.metadata.beleg, 'KB-2026-0001');
  assert.equal(RUMPF.ende('x', 'Kassenbeleg-V1', daten, '').metadata, undefined);
});

test('fiskaly: Transaktionskennung ist UUIDv4 und je Beleg stabil', () => {
  const form = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const eine = kennungFuer('KB-2026-0001');
  assert.match(eine, form);
  assert.equal(eine, kennungFuer('KB-2026-0001'));
  assert.notEqual(eine, kennungFuer('KB-2026-0002'));
  assert.match(kennungFuer(''), form);
  assert.doesNotMatch('KB-2026-0001', form);
});

test('fiskaly: Zeitstempel als ISO 8601, Antwort vollständig', () => {
  assert.equal(alsIso(1792273512), '2026-10-17T21:45:12Z');
  assert.equal(alsIso('1792273512'), '2026-10-17T21:45:12Z');
  assert.equal(alsIso('2026-10-17T21:45:12Z'), '2026-10-17T21:45:12Z');
  assert.equal(alsIso(null), null);
  assert.equal(alsIso(''), null);
  const w = ANTWORT(ANTWORT_VOM_ANBIETER);
  assert.equal(w.seriennummer, 'b3d4e5f6a7b8c9d0e1f2');
  assert.equal(w.signaturzaehler, 7);
  assert.equal(w.transaktionsnummer, 42);
  assert.ok(w.pruefwert.startsWith('MEUCIQ'));
  assert.equal(w.algorithmus, 'ecdsa-plain-SHA384');
  assert.equal(w.start, '2026-10-17T21:45:00Z');
  assert.equal(w.ende, '2026-10-17T21:45:12Z');
  assert.ok(w.schluessel.startsWith('BFxk'));
  assert.ok(w.pruefcode.startsWith('V0;'));
  const ohne = ANTWORT({ number: 1, time_start: 1792273500 });
  assert.equal(ohne.pruefwert, null);
  assert.equal(ohne.signaturzaehler, null);
  assert.equal(STANDARD_BASIS, 'https://kassensichv-middleware.fiskaly.com/api/v2');
});

test('fiskaly: Ablauf mit Fänger — Anmeldung einmal, Start und Abschluss mit derselben Kennung', async () => {
  const aufrufe = [];
  const faenger = async (adresse, o = {}) => {
    aufrufe.push({ adresse, ...o });
    if (adresse.endsWith('/auth')) return { access_token: 'tok', access_token_expires_in: 600 };
    if (adresse.includes('tx_revision=2')) return ANTWORT_VOM_ANBIETER;
    if (adresse.includes('tx_revision=1')) return { state: 'ACTIVE' };
    return { serial_number: 'b3d4', signature_algorithm: 'ecdsa-plain-SHA384', certificate: 'CERT' };
  };
  const ein = { apiKey: 'k', apiSecret: 's', tssId: '00000000-0000-4000-8000-000000000001', clientId: '00000000-0000-4000-8000-000000000002', basis: 'https://test.example/api/v2/' };
  assert.equal(fiskalyTse({ apiKey: 'nur das' }, { anfrage: faenger }), null);
  const tse = tseMit(ein, { anfrage: faenger });
  const d = await tse.signiere({ belegId: 'KB-2026-0001', art: 'bar', umsatz: 19, steuerBrutto: [[19, 19]] });
  assert.equal(d.vorgangsdaten, 'Beleg^19.00_0.00_0.00_0.00_0.00^19.00:Bar');
  assert.equal(d.pruefcode, ANTWORT_VOM_ANBIETER.qr_code_data);
  await tse.signiere({ belegId: 'KB-2026-0002', art: 'unbar', umsatz: 7, steuerBrutto: [[7, 7]] });
  assert.equal(aufrufe.filter((a) => a.adresse.endsWith('/auth')).length, 1, 'Token wird wiederverwendet');
  const [start, ende] = aufrufe.filter((a) => a.adresse.includes('/tx/')).slice(0, 2);
  assert.equal(start.adresse.replace(/\?.*/, ''), ende.adresse.replace(/\?.*/, ''));
  assert.ok(start.adresse.startsWith('https://test.example/api/v2/tss/00000000-0000-4000-8000-000000000001/tx/'));
  assert.equal(start.methode, 'PUT');
  assert.equal(start.kopf.Authorization, 'Bearer tok');
  assert.equal(Buffer.from(ende.rumpf.schema.raw.process_data, 'base64').toString(), 'Beleg^19.00_0.00_0.00_0.00_0.00^19.00:Bar');
  assert.equal((await tse.stammdaten()).zertifikat, 'CERT');
});

test('Zwischenschicht: aus der Umgebung nur vollständig und nur fiskaly', () => {
  const umgebung = { TSE_ANBIETER: 'fiskaly', TSE_API_KEY: 'k', TSE_API_SECRET: 's', TSE_TSS_ID: 't', TSE_CLIENT_ID: 'c' };
  const tse = tseAus(umgebung);
  assert.equal(tse.anbieter, 'fiskaly');
  assert.equal(typeof tse.signiere, 'function');
  assert.equal(typeof tse.stammdaten, 'function');
  assert.equal(tseAus({}), null);
  assert.equal(tseAus({ TSE_ANBIETER: 'fiskaly', TSE_API_KEY: 'nur das' }), null);
  assert.equal(tseAus({ ...umgebung, TSE_ANBIETER: 'irgendwer' }), null);
});
