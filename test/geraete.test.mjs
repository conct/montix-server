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
});

test('Geräteliste: Seite und Freigabe (direkt am Speicher)', async () => {
  const { melden, liste, alleFuerVerwaltung, seite } = await import('../geraete.mjs');
  const db = geraeteDb(':memory:');
  melden(db, { art: 'drucker', geraet: 'Etikettendrucker Y', verbindung: 'bluetooth', sprache: 'tspl', ok: true });
  assert.equal(liste(db).length, 0);
  freigabeSetzen(db, alleFuerVerwaltung(db)[0].schluessel, 'frei');
  assert.deepEqual(liste(db).map((x) => [x.geraet, x.verbindung, x.sprache]), [['Etikettendrucker Y', 'Bluetooth LE', 'Etikettendrucker (TSPL)']]);
  melden(db, { art: 'drucker', geraet: 'Etikettendrucker Y', verbindung: 'bluetooth', sprache: 'tspl', ok: false });
  assert.equal(liste(db).length, 0, 'gleich viele Nein wie Ja: nicht mehr gezeigt');
  assert.match(seite(db), /Geräte, die mit Montix funktionieren/);
});
