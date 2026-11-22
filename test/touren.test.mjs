import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { erstelleDienst } from '../dienst.mjs';
import { oeffneSpeicher } from '../speicher.mjs';
import { stand } from '../touren.mjs';

let server;
let basis;
let speicher;
let betrieb;
const post = [];

// Photon-Fänger: jede Adresse liegt in Dresden, „Leipzig“ in Leipzig.
const geo = async (u) => ({
  ok: true,
  json: async () => ({ features: [{ geometry: { coordinates: String(u).includes('Leipzig') ? [12.37, 51.34] : [13.74, 51.05] }, properties: {} }] }),
});

before(async () => {
  speicher = oeffneSpeicher(':memory:');
  betrieb = speicher.betriebAnlegen('Spedition Muster');
  server = erstelleDienst(speicher, { zeitgeber: false, senden: (an, m) => post.push({ an: an.map((e) => e.email), ...m }), push: async () => {}, adresseHolen: geo });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function rufe(pfad, { token, body } = {}) {
  const r = await fetch(basis + pfad, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let daten;
  try {
    daten = JSON.parse(text);
  } catch {
    daten = text;
  }
  return { status: r.status, daten };
}

async function geraet(name, rolle) {
  const { code } = speicher.einladen(betrieb, name, rolle);
  const r = await rufe('/anmelden', { body: { code, geraet: `Handy ${name}` } });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  return r.daten;
}

const jetzt = (min = 0) => new Date(Date.now() + min * 60_000).toISOString();
const heute = () => new Date().toISOString().slice(0, 10);

test('Status einer Tour folgt den Ereignissen', () => {
  const tour = { id: 't', stopps: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(stand(tour, []).status, 'geplant');
  const e = [
    { art: 'tour_start', zeit: jetzt(-60) },
    { art: 'angekommen', stoppId: 'a', zeit: jetzt(-40) },
  ];
  assert.equal(stand(tour, e).status, 'beim_kunden');
  e.push({ art: 'quittung', stoppId: 'a', zeit: jetzt(-30), name: 'Meier' }, { art: 'abfahrt', stoppId: 'a', zeit: jetzt(-29) });
  const s = stand(tour, e);
  assert.equal(s.status, 'faehrt');
  assert.equal(s.erledigt, 1);
  assert.equal(s.naechster.id, 'b');
  e.push({ art: 'pause_start', zeit: jetzt(-10) });
  assert.equal(stand(tour, e).status, 'pause');
});

test('Disposition plant, Fahrer meldet, Lage und Empfänger-Link', async () => {
  const dispo = await geraet('Dispo', 'verwalter');
  const fahrer = await geraet('Fahrer Franz', 'mitarbeiter');
  const tour = {
    id: 'tour1',
    datum: heute(),
    name: 'Dresden – Leipzig',
    fahrerId: fahrer.mitarbeiter.id,
    fahrerName: 'Fahrer Franz',
    kennzeichen: 'DD-MX 123',
    stopps: [
      { id: 's1', name: 'Lager Dresden', art: 'laden', adresse: { line1: 'Hafenstraße 1', city: 'Dresden' } },
      { id: 's2', name: 'Kunde Leipzig', art: 'entladen', adresse: { line1: 'Markt 1', city: 'Leipzig' }, fenster: { von: '00:00', bis: '23:59' }, sendung: 'SN-42', email: 'empfang@kunde.example' },
    ],
  };
  // Ein Fahrer darf keine Touren anlegen, die Disposition schon.
  let r = await rufe('/abgleich', { token: fahrer.token, body: { aenderungen: [{ sammlung: 'touren', id: 'tour1', geaendert: jetzt(), inhalt: tour }] } });
  assert.equal(r.status, 200);
  assert.equal((await rufe('/abgleich?seit=0', { token: dispo.token })).daten.aenderungen.filter((a) => a.sammlung === 'touren').length, 0);
  r = await rufe('/abgleich', { token: dispo.token, body: { aenderungen: [{ sammlung: 'touren', id: 'tour1', geaendert: jetzt(), inhalt: tour }] } });
  assert.equal(r.status, 200);

  // Fahrer meldet: Tour begonnen, in Dresden fertig, losgefahren.
  const ereignis = (id, art, extra = {}) => ({ sammlung: 'tourereignisse', id, geaendert: jetzt(), inhalt: { id, tourId: 'tour1', art, zeit: jetzt(), von: fahrer.mitarbeiter.id, ...extra } });
  r = await rufe('/abgleich', { token: fahrer.token, body: { aenderungen: [ereignis('e1', 'tour_start'), ereignis('e2', 'angekommen', { stoppId: 's1' }), ereignis('e3', 'abfahrt', { stoppId: 's1' })] } });
  assert.equal(r.status, 200);
  r = await rufe('/touren/ort', { token: fahrer.token, body: { tour: 'tour1', ort: { lat: 51.2, lon: 13.0 } } });
  assert.equal(r.status, 200);

  r = await rufe('/touren/lage', { token: dispo.token });
  assert.equal(r.status, 200);
  const lage = r.daten.touren.find((t) => t.id === 'tour1');
  assert.equal(lage.status, 'faehrt');
  assert.equal(lage.erledigt, 1);
  assert.ok(lage.position);
  assert.ok(lage.stopps[1].ankunft, 'ETA für den offenen Stopp');

  // Empfänger-Link per Mail; die Seite zeigt Sendung und Ankunftsfenster.
  r = await rufe('/touren/benachrichtigen', { token: dispo.token, body: { tour: 'tour1', stopp: 's2' } });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  assert.deepEqual(post.at(-1).an, ['empfang@kunde.example']);
  const pfad = new URL(r.daten.link).pathname;
  let seite = await rufe(pfad);
  assert.equal(seite.status, 200);
  assert.match(seite.daten, /SN-42/);
  assert.match(seite.daten, /zwischen \d\d:\d\d und \d\d:\d\d Uhr/);

  // Zugestellt: Nachweis mit Namen.
  await rufe('/abgleich', { token: fahrer.token, body: { aenderungen: [ereignis('e4', 'angekommen', { stoppId: 's2' }), ereignis('e5', 'quittung', { stoppId: 's2', name: 'Frau Kunze' }), ereignis('e6', 'abfahrt', { stoppId: 's2' })] } });
  seite = await rufe(pfad);
  assert.match(seite.daten, /Zugestellt/);
  assert.match(seite.daten, /Frau Kunze/);
  assert.equal((await rufe('/sendung/sGibtEsNichtGibtEsNicht12')).status, 404);
});

test('Fremdfahrer sieht nur seine Tour und meldet nur dafür', async () => {
  const dispo = await geraet('Dispo2', 'verwalter');
  const fremd = await geraet('Sub Sepp', 'fremdfahrer');
  await rufe('/abgleich', { token: dispo.token, body: { aenderungen: [{ sammlung: 'kunden', id: 'k9', geaendert: jetzt(), inhalt: { id: 'k9', party: { name: 'Geheim' } } }] } });
  const tour = { id: 'tour2', datum: heute(), fahrerId: fremd.mitarbeiter.id, stopps: [{ id: 'x', name: 'Ziel' }] };
  await rufe('/abgleich', { token: dispo.token, body: { aenderungen: [{ sammlung: 'touren', id: 'tour2', geaendert: jetzt(), inhalt: tour }] } });
  const r = await rufe('/abgleich?seit=0', { token: fremd.token });
  assert.equal(r.status, 200);
  const sammlungen = new Set(r.daten.aenderungen.map((a) => a.sammlung));
  assert.ok(!sammlungen.has('kunden'), 'keine Kunden');
  assert.deepEqual(r.daten.aenderungen.filter((a) => a.sammlung === 'touren').map((a) => a.id), ['tour2']);
  assert.equal((await rufe('/mitarbeiter', { token: fremd.token })).status, 403);
  assert.equal((await rufe('/touren/lage', { token: fremd.token })).daten.touren.length, 1);
});

test('Eigene Meldung zurücknehmen, fremde nicht', async () => {
  const dispo = await geraet('Dispo3', 'verwalter');
  const a = await geraet('Fahrer A', 'mitarbeiter');
  const b = await geraet('Fahrer B', 'mitarbeiter');
  const tour = { id: 'tour3', datum: heute(), fahrerId: a.mitarbeiter.id, stopps: [{ id: 'x', name: 'Ziel' }] };
  await rufe('/abgleich', { token: dispo.token, body: { aenderungen: [{ sammlung: 'touren', id: 'tour3', geaendert: jetzt(), inhalt: tour }] } });
  const e = { id: 'ex1', tourId: 'tour3', art: 'tour_start', zeit: jetzt(), von: a.mitarbeiter.id };
  await rufe('/abgleich', { token: a.token, body: { aenderungen: [{ sammlung: 'tourereignisse', id: 'ex1', geaendert: jetzt(), inhalt: e }] } });
  // B darf A's Meldung nicht löschen …
  await rufe('/abgleich', { token: b.token, body: { aenderungen: [{ sammlung: 'tourereignisse', id: 'ex1', geaendert: jetzt(1), geloescht: true }] } });
  let lage = (await rufe('/touren/lage', { token: dispo.token })).daten.touren.find((x) => x.id === 'tour3');
  assert.equal(lage.status, 'faehrt');
  // … A selbst schon.
  await rufe('/abgleich', { token: a.token, body: { aenderungen: [{ sammlung: 'tourereignisse', id: 'ex1', geaendert: jetzt(2), geloescht: true }] } });
  lage = (await rufe('/touren/lage', { token: dispo.token })).daten.touren.find((x) => x.id === 'tour3');
  assert.equal(lage.status, 'geplant');
});

test('Disposition lädt Fremdfahrer und Partner ein, sieht den Stand und sperrt', async () => {
  const chef = await geraet('Chef', 'verwalter');
  const dispo = await geraet('Disponentin', 'mitarbeiter');
  // Recht „Disposition“ vergeben
  await rufe('/mitarbeiter/rechte', { token: chef.token, body: { id: dispo.mitarbeiter.id, bereiche: ['touren', 'recht:dispo'] } });
  const monteur = await geraet('Monteur ohne Dispo', 'mitarbeiter');
  assert.equal((await rufe('/touren/einladung', { token: monteur.token, body: { name: 'X', rolle: 'fremdfahrer' } })).status, 403);
  assert.equal((await rufe('/touren/einladung', { token: dispo.token, body: { name: 'Neuer Chef', rolle: 'verwalter' } })).status, 400);
  const r = await rufe('/touren/einladung', { token: dispo.token, body: { name: 'Sub Toni', rolle: 'fremdfahrer' } });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  let liste = (await rufe('/touren/gaeste', { token: dispo.token })).daten;
  let toni = liste.find((g) => g.name === 'Sub Toni');
  assert.equal(toni.rolle, 'fremdfahrer');
  assert.equal(toni.einladung.eingeloest, null);
  await rufe('/anmelden', { body: { code: r.daten.code, geraet: 'Toni' } });
  liste = (await rufe('/touren/gaeste', { token: dispo.token })).daten;
  toni = liste.find((g) => g.name === 'Sub Toni');
  assert.ok(toni.einladung.eingeloest);
  assert.equal(toni.geraete, 1);
  assert.equal((await rufe('/touren/gast/aktiv', { token: dispo.token, body: { id: toni.id, aktiv: false } })).status, 200);
  assert.equal((await rufe('/touren/gaeste', { token: dispo.token })).daten.find((g) => g.id === toni.id).aktiv, false);
  // Kollegen sind keine Gäste: nicht sperrbar über diesen Weg.
  assert.equal((await rufe('/touren/gast/aktiv', { token: dispo.token, body: { id: monteur.mitarbeiter.id, aktiv: false } })).status, 404);
});

test('Positionen nach 30 Tagen und Empfänger-Links nach 90 Tagen gelöscht', async () => {
  const dispo = await geraet('Dispo Frist', 'verwalter');
  const db = speicher.pruefe(dispo.token).db;
  const alt = (tage) => new Date(Date.now() - tage * 86400_000).toISOString();
  db.prepare('insert into tour_orte values (?, ?, ?, ?, ?, ?)').run('alt', 'x', alt(31), 51, 13, null);
  db.prepare('insert into tour_orte values (?, ?, ?, ?, ?, ?)').run('neu', 'x', alt(29), 51, 13, null);
  db.prepare('insert or replace into tour_letzte values (?, ?, ?, ?, ?, ?, ?)').run('alt', 'x', alt(31), 51, 13, null, 'handy');
  db.prepare('insert into tour_links values (?, ?, ?, ?, null)').run('pruef_alt', 'alt', 's', alt(91));
  await rufe('/touren/lage', { token: dispo.token });
  assert.deepEqual(db.prepare("select tour from tour_orte where tour in ('alt', 'neu')").all().map((z) => z.tour), ['neu']);
  assert.equal(db.prepare("select count(*) as n from tour_letzte where tour = 'alt'").get().n, 0);
  assert.equal(db.prepare("select count(*) as n from tour_links where pruef = 'pruef_alt'").get().n, 0);
});
