import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { erstelleDienst } from '../dienst.mjs';
import { datenPruefen, datenStand } from '../datenstand.mjs';
import { karteHolen } from '../karte.mjs';
import { oeffneSpeicher } from '../speicher.mjs';

let server;
let basis;
const ordner = mkdtempSync(join(tmpdir(), 'karte-'));
const datei = join(ordner, 'karte.pmtiles');

before(async () => {
  server = erstelleDienst(oeffneSpeicher(':memory:'), { zeitgeber: false, senden: () => {}, push: async () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  delete process.env.MONTIX_KARTE;
  rmSync(ordner, { recursive: true, force: true });
});

test('Karte: Bibliotheken vom eigenen Server, Kacheln mit Range, ohne Datei Hinweis', async () => {
  const js = await fetch(`${basis}/karte/leaflet.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${basis}/karte/protomaps-leaflet.js`)).status, 200);
  assert.equal((await fetch(`${basis}/karte/gibtsnicht.js`)).status, 401);

  process.env.MONTIX_KARTE = join(ordner, 'fehlt.pmtiles');
  assert.deepEqual(await (await fetch(`${basis}/karte/info`)).json(), { kacheln: false, neu: 'fehlt', holen: 'node verwalten.mjs karte' });
  assert.equal((await fetch(`${basis}/karte/karte.pmtiles`)).status, 404);

  writeFileSync(datei, Buffer.from('0123456789abcdef'));
  process.env.MONTIX_KARTE = datei;
  assert.equal((await (await fetch(`${basis}/karte/info`)).json()).kacheln, true);
  const teil = await fetch(`${basis}/karte/karte.pmtiles`, { headers: { range: 'bytes=2-5' } });
  assert.equal(teil.status, 206);
  assert.equal(teil.headers.get('content-range'), 'bytes 2-5/16');
  assert.equal(teil.headers.get('access-control-allow-origin'), '*');
  assert.equal(await teil.text(), '2345');
  const ende = await fetch(`${basis}/karte/karte.pmtiles`, { headers: { range: 'bytes=-3' } });
  assert.equal(await ende.text(), 'def');
  assert.equal((await fetch(`${basis}/karte/karte.pmtiles`, { headers: { range: 'bytes=99-' } })).status, 416);
  assert.equal((await (await fetch(`${basis}/karte/karte.pmtiles`)).text()).length, 16);
});

test('Karte holen: vom Server laden, fortsetzen, bei gleichem Stand nichts tun', async () => {
  writeFileSync(datei, Buffer.alloc(300_000, 7));
  process.env.MONTIX_KARTE = datei;
  const ziel = join(ordner, 'geholt.pmtiles');
  const still = () => {};
  const a = await karteHolen({ quelle: `${basis}/karte/karte.pmtiles`, ziel, melden: still });
  assert.deepEqual(a, { neu: true, groesse: 300_000 });
  assert.deepEqual(await karteHolen({ quelle: `${basis}/karte/karte.pmtiles`, ziel, melden: still }), { neu: false, groesse: 300_000 });
  // Abgebrochener Download: Teil liegt da, nächster Aufruf setzt fort.
  rmSync(ziel);
  rmSync(`${ziel}.etag`);
  writeFileSync(`${ziel}.teil`, Buffer.alloc(1000, 7));
  const etag = (await fetch(`${basis}/karte/karte.pmtiles`, { headers: { range: 'bytes=0-0' } })).headers.get('etag');
  writeFileSync(`${ziel}.teil.etag`, etag);
  const meldungen = [];
  await karteHolen({ quelle: `${basis}/karte/karte.pmtiles`, ziel, melden: (m) => meldungen.push(m) });
  assert.ok(meldungen[0].startsWith('Setze fort'), meldungen[0]);
  assert.equal(readFileSync(ziel).length, 300_000);
});

test('Eigener Server: neue Kartendaten beim Montix-Server werden gemeldet, gleicher Stand nicht', async () => {
  writeFileSync(datei, Buffer.alloc(5000, 1));
  process.env.MONTIX_KARTE = datei;
  process.env.MONTIX_KARTE_QUELLE = `${basis}/karte/karte.pmtiles`;
  process.env.MONTIX_ADRESSEN_QUELLE = `${basis}/adressen/gibtsnicht.sqlite`;
  const meldungen = [];
  rmSync(`${datei}.etag`, { force: true });
  await datenPruefen({ melden: (m) => meldungen.push(m), auto: false });
  assert.equal(datenStand.karte.neu, 'neuer');
  assert.ok(meldungen.some((m) => m.includes('node verwalten.mjs karte')));
  assert.equal((await (await fetch(`${basis}/karte/info`)).json()).neu, 'neuer');
  const etag = (await fetch(`${basis}/karte/karte.pmtiles`, { headers: { range: 'bytes=0-0' } })).headers.get('etag');
  writeFileSync(`${datei}.etag`, etag);
  await datenPruefen({ melden: () => {}, auto: false });
  assert.equal(datenStand.karte.neu, false);
  delete process.env.MONTIX_KARTE_QUELLE;
  delete process.env.MONTIX_ADRESSEN_QUELLE;
});
