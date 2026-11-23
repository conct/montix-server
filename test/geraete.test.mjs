import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { erstelleDienst } from '../dienst.mjs';
import { freigabeSetzen, geraeteDb } from '../geraete.mjs';
import { oeffneSpeicher } from '../speicher.mjs';

let server;
let basis;
before(async () => {
  server = erstelleDienst(oeffneSpeicher(':memory:'), { zeitgeber: false, senden: () => {}, push: async () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const melde = (body) => fetch(`${basis}/geraete/meldung`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('Geräteliste: Meldungen ohne Personenbezug, öffentlich erst nach Freigabe und mit mehr Ja als Nein', async () => {
  const g = { art: 'drucker', geraet: 'Bondrucker X 80', verbindung: 'wlan', sprache: 'escpos', papier: 80, ok: true };
  assert.equal((await melde(g)).status, 200);
  assert.equal((await melde({ ...g, geraet: 'bondrucker x 80' })).status, 200); // gleiches Gerät, andere Schreibweise
  assert.equal((await melde({ ...g, ok: false })).status, 200);
  assert.equal((await melde({ ...g, geraet: '<script>' })).status, 400);
  assert.equal((await melde({ ...g, sprache: 'quatsch' })).status, 400);
  assert.deepEqual((await (await fetch(`${basis}/geraete.json`)).json()).geraete, [], 'vor der Freigabe nichts öffentlich');
  const um = await fetch(`${basis}/geraete`, { redirect: 'manual' });
  assert.equal(um.status, 301);
  assert.equal(um.headers.get('location'), 'https://feif.space/apps-software/montix/geraete/');
  for (const [pfad, method] of [['/geraete/', 'GET'], ['/geraete', 'HEAD']]) assert.equal((await fetch(`${basis}${pfad}`, { method, redirect: 'manual' })).status, 301, `${method} ${pfad}`);
});

test('Geräteliste: Seite und Freigabe (direkt am Speicher)', async () => {
  const { melden, liste, alleFuerVerwaltung } = await import('../geraete.mjs');
  const db = geraeteDb(':memory:');
  melden(db, { art: 'drucker', geraet: 'Etikettendrucker Y', verbindung: 'bluetooth', sprache: 'tspl', ok: true });
  assert.equal(liste(db).length, 0);
  freigabeSetzen(db, alleFuerVerwaltung(db)[0].schluessel, 'frei');
  assert.deepEqual(liste(db).map((x) => [x.geraet, x.verbindung, x.sprache]), [['Etikettendrucker Y', 'Bluetooth LE', 'Etikettendrucker (TSPL)']]);
  melden(db, { art: 'drucker', geraet: 'Etikettendrucker Y', verbindung: 'bluetooth', sprache: 'tspl', ok: false });
  assert.equal(liste(db).length, 0, 'gleich viele Nein wie Ja: nicht mehr gezeigt');
});

test('Geräteliste: Hersteller und Modell getrennt, Hersteller Pflicht, Verwaltung überschreibt Meldungen', async () => {
  const { melden, liste, alleFuerVerwaltung, herstellerSetzen, aufteilen, herstellerGueltig } = await import('../geraete.mjs');
  assert.deepEqual(aufteilen('BRW30C9AB7FDE01'), { hersteller: 'Brother', modell: '' });
  assert.deepEqual(aufteilen('Munbyn'), { hersteller: 'Munbyn', modell: '' });
  assert.deepEqual(aufteilen('CT320B-4DV2'), { hersteller: '', modell: 'CT320B-4DV2' });
  assert.deepEqual(aufteilen('Brother HL-L2350DW series'), { hersteller: 'Brother', modell: 'HL-L2350DW' });
  assert.equal(herstellerGueltig('BRW30C9AB7FDE01'), false);
  assert.equal(herstellerGueltig('1234'), false);
  const db = geraeteDb(':memory:');
  melden(db, { art: 'drucker', geraet: 'CT320B-4DV2', verbindung: 'bluetooth', sprache: 'tspl', ok: true });
  melden(db, { art: 'drucker', hersteller: 'Munbyn', modell: '', verbindung: 'wlan', sprache: 'escpos', papier: 80, ok: true });
  for (const g of alleFuerVerwaltung(db)) freigabeSetzen(db, g.schluessel, 'frei');
  assert.deepEqual(liste(db).map((x) => [x.hersteller, x.modell]), [['Munbyn', null]], 'ohne Hersteller nicht öffentlich, Modell freiwillig');
  const ct = alleFuerVerwaltung(db).find((g) => g.geraet === 'CT320B-4DV2').schluessel;
  assert.equal(herstellerSetzen(db, ct, '', 'CT320B'), false);
  assert.equal(herstellerSetzen(db, ct, 'Hersteller A', 'CT320B-4DV2'), true);
  melden(db, { art: 'drucker', geraet: 'CT320B-4DV2', verbindung: 'bluetooth', sprache: 'tspl', ok: true });
  assert.deepEqual(liste(db).map((x) => [x.hersteller, x.modell, x.meldungen]), [['Hersteller A', 'CT320B-4DV2', 2], ['Munbyn', null, 1]], 'neue Meldung überschreibt die Verwaltung nicht');
});
