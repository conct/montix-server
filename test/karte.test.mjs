import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { erstelleDienst } from '../dienst.mjs';
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
  assert.deepEqual(await (await fetch(`${basis}/karte/info`)).json(), { kacheln: false });
  assert.equal((await fetch(`${basis}/karte/karte.pmtiles`)).status, 404);

  writeFileSync(datei, Buffer.from('0123456789abcdef'));
  process.env.MONTIX_KARTE = datei;
  assert.deepEqual(await (await fetch(`${basis}/karte/info`)).json(), { kacheln: true });
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
