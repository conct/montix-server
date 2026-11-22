import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { erstelleDienst } from '../dienst.mjs';
import { oeffneSpeicher } from '../speicher.mjs';

// Zwei Server: A = Spedition, B = Partnerbetrieb (eigener Server).
const A = {};
const B = {};

async function starten(x, name) {
  x.speicher = oeffneSpeicher(':memory:');
  x.betrieb = x.speicher.betriebAnlegen(name);
  x.server = erstelleDienst(x.speicher, { zeitgeber: false, senden: () => {}, push: async () => {}, adresseHolen: async () => ({ ok: true, json: async () => ({ features: [] }) }) });
  await new Promise((r) => x.server.listen(0, '127.0.0.1', r));
  x.basis = `http://127.0.0.1:${x.server.address().port}`;
}

before(async () => {
  await starten(A, 'Spedition A');
  await starten(B, 'Partner B');
});
after(() => {
  A.server.close();
  B.server.close();
});

async function rufe(x, pfad, { token, body } = {}) {
  const r = await fetch(x.basis + pfad, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, daten: await r.json().catch(() => null) };
}

async function geraet(x, name, rolle) {
  const { code } = x.speicher.einladen(x.betrieb, name, rolle);
  const r = await rufe(x, '/anmelden', { body: { code, geraet: name } });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  return r.daten;
}

const jetzt = () => new Date().toISOString();
const heute = () => jetzt().slice(0, 10);

test('Spedition gibt Tour an Partner, Partner verteilt an eigenen Fahrer, Meldungen kommen zurück', async () => {
  const dispoA = await geraet(A, 'Dispo A', 'verwalter');
  const partnerBeiA = await geraet(A, 'Partner B GmbH', 'partner');
  const dispoB = await geraet(B, 'Dispo B', 'verwalter');
  const fahrerB = await geraet(B, 'Fahrer Bernd', 'mitarbeiter');

  // A plant und gibt die Tour an den Partner.
  const tour = { id: 'tA', datum: heute(), name: 'Hamburg', partnerId: partnerBeiA.mitarbeiter.id, partnerName: 'Partner B GmbH', stopps: [{ id: 's1', name: 'Hafen', art: 'entladen' }] };
  await rufe(A, '/abgleich', { token: dispoA.token, body: { aenderungen: [{ sammlung: 'touren', id: 'tA', geaendert: jetzt(), inhalt: tour }] } });

  // Der Partner sieht bei A nur diese Tour.
  const sicht = await rufe(A, '/abgleich?seit=0', { token: partnerBeiA.token });
  assert.deepEqual(sicht.daten.aenderungen.filter((a) => a.sammlung === 'touren').map((a) => a.id), ['tA']);

  // Dispo B übernimmt sie in den eigenen Betrieb (mit dem Partnerzugang zu A) …
  const r = await rufe(B, '/touren/uebernehmen', { token: dispoB.token, body: { adresse: A.basis, token: partnerBeiA.token, tour } });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  const lokal = r.daten.id;
  // … und teilt sie dem eigenen Fahrer zu.
  const kopie = (await rufe(B, '/abgleich?seit=0', { token: dispoB.token })).daten.aenderungen.find((a) => a.id === lokal).inhalt;
  assert.equal(kopie.herkunft.tour, 'tA');
  await rufe(B, '/abgleich', { token: dispoB.token, body: { aenderungen: [{ sammlung: 'touren', id: lokal, geaendert: jetzt(), inhalt: { ...kopie, fahrerId: fahrerB.mitarbeiter.id, fahrerName: 'Fahrer Bernd' } }] } });

  // Fahrer B meldet bei B.
  const e = (id, art, extra = {}) => ({ sammlung: 'tourereignisse', id, geaendert: jetzt(), inhalt: { id, tourId: lokal, art, zeit: jetzt(), von: fahrerB.mitarbeiter.id, vonName: 'Fahrer Bernd', ...extra } });
  await rufe(B, '/abgleich', { token: fahrerB.token, body: { aenderungen: [e('b1', 'tour_start'), e('b2', 'angekommen', { stoppId: 's1' })] } });
  await rufe(B, '/touren/ort', { token: fahrerB.token, body: { tour: lokal, ort: { lat: 53.5, lon: 9.9 } } });

  // Weiterleitung (sonst jede Minute) → A sieht Status und Position.
  await B.server.partnerWeiterleiten();
  const lage = (await rufe(A, '/touren/lage', { token: dispoA.token })).daten.touren.find((x) => x.id === 'tA');
  assert.equal(lage.status, 'beim_kunden');
  assert.ok(lage.position, 'Position kam an');
  // Doppelt weiterleiten schickt nichts doppelt.
  await B.server.partnerWeiterleiten();
  const ereignisseA = (await rufe(A, '/abgleich?seit=0', { token: dispoA.token })).daten.aenderungen.filter((a) => a.sammlung === 'tourereignisse');
  assert.equal(ereignisseA.length, 2);

  // A ändert einen Stopp → B übernimmt ihn, Fahrer bleibt.
  await rufe(A, '/abgleich', { token: dispoA.token, body: { aenderungen: [{ sammlung: 'touren', id: 'tA', geaendert: jetzt(), inhalt: { ...tour, stopps: [...tour.stopps, { id: 's2', name: 'Lager Nord', art: 'laden' }] } }] } });
  await B.server.partnerWeiterleiten();
  const neu = (await rufe(B, '/abgleich?seit=0', { token: dispoB.token })).daten.aenderungen.filter((a) => a.id === lokal).at(-1).inhalt;
  assert.equal(neu.stopps.length, 2);
  assert.equal(neu.fahrerId, fahrerB.mitarbeiter.id);
});

test('Nur ein Partnerzugang darf übernehmen', async () => {
  const dispoA = await geraet(A, 'Dispo A2', 'verwalter');
  const monteurA = await geraet(A, 'Monteur A', 'mitarbeiter');
  const dispoB = await geraet(B, 'Dispo B2', 'verwalter');
  const r = await rufe(B, '/touren/uebernehmen', { token: dispoB.token, body: { adresse: A.basis, token: monteurA.token, tour: { id: 'x', stopps: [] } } });
  assert.equal(r.status, 403);
  void dispoA;
});
