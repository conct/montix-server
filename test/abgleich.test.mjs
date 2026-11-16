import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { after, before, test } from 'node:test';

import { ZENTRAL } from '../anbieter.mjs';
import { erstelleDienst } from '../dienst.mjs';

const geodienst = [];
const GEO = {
  features: [
    { properties: { type: 'house', street: 'Hauptstraße', housenumber: '1', postcode: '01097', city: 'Dresden', district: 'Innere Neustadt', countrycode: 'DE' } },
    { properties: { type: 'city', name: 'Wien', countrycode: 'AT' } },
    { properties: { type: 'street', name: 'Irgendwo' } },
  ],
};
import { oeffneSpeicher } from '../speicher.mjs';

let server;
let basis;
let speicher;
let betrieb;
const post = [];
const pushes = [];

before(async () => {
  speicher = oeffneSpeicher(':memory:');
  betrieb = speicher.betriebAnlegen('Muster GmbH');
  server = erstelleDienst(speicher, { zeitgeber: false, senden: (an, m) => post.push({ an: an.map((e) => e.email), ...m }), push: async (l) => void pushes.push(...l), adresseHolen: async (u) => (geodienst.push(u), { ok: true, json: async () => GEO }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function rufe(pfad, { token, body, method } = {}) {
  const r = await fetch(basis + pfad, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, daten: await r.json() };
}

async function geraet(name, rolle) {
  const { code } = speicher.einladen(betrieb, name, rolle);
  const r = await rufe('/anmelden', { body: { code: code.toLowerCase().replace(/-/g, ' '), geraet: `Handy ${name}` } });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  return r.daten;
}

const t = (s) => `2026-11-13T10:00:${String(s).padStart(2, '0')}.000Z`;

test('Status ohne Anmeldung, alles andere nur mit Token', async () => {
  assert.equal((await rufe('/status')).daten.dienst, 'montix-abgleich');
  assert.equal((await rufe('/abgleich?seit=0')).status, 401);
  assert.equal((await rufe('/ich', { token: `${betrieb}.falsch` })).status, 401);
});

test('Einladungscode gilt genau einmal', async () => {
  const { code } = speicher.einladen(betrieb, 'Einmal');
  assert.equal((await rufe('/anmelden', { body: { code } })).status, 200);
  assert.equal((await rufe('/anmelden', { body: { code } })).status, 403);
});

test('Zwei Geräte gleichen ab; jüngere Änderung gewinnt; Löschen kommt an', async () => {
  const a = await geraet('Anna', 'verwalter');
  const b = await geraet('Bernd', 'monteur');
  assert.equal(a.mitarbeiter.rolle, 'verwalter');
  assert.equal(b.betrieb.name, 'Muster GmbH');

  const kunde = { id: 'k1', party: { name: 'Bäckerei' }, updatedAt: t(1) };
  let r = await rufe('/abgleich', { token: a.token, body: { aenderungen: [{ sammlung: 'kunden', id: 'k1', geaendert: t(1), inhalt: kunde }] } });
  assert.equal(r.daten.uebernommen, 1);

  r = await rufe('/abgleich?seit=0', { token: b.token });
  assert.equal(r.daten.aenderungen.length, 1);
  assert.equal(r.daten.aenderungen[0].inhalt.party.name, 'Bäckerei');
  const markeB = r.daten.rev;

  // B ändert später, A schickt danach eine ältere Fassung: B gewinnt.
  await rufe('/abgleich', { token: b.token, body: { aenderungen: [{ sammlung: 'kunden', id: 'k1', geaendert: t(5), inhalt: { ...kunde, party: { name: 'Bäckerei Neu' } } }] } });
  r = await rufe('/abgleich', { token: a.token, body: { aenderungen: [{ sammlung: 'kunden', id: 'k1', geaendert: t(3), inhalt: { ...kunde, party: { name: 'Alt' } } }] } });
  assert.deepEqual(r.daten.verworfen, [{ sammlung: 'kunden', id: 'k1' }]);

  // A löscht noch später: Grabstein kommt bei B an.
  await rufe('/abgleich', { token: a.token, body: { aenderungen: [{ sammlung: 'kunden', id: 'k1', geaendert: t(9), geloescht: true }] } });
  r = await rufe(`/abgleich?seit=${markeB}`, { token: b.token });
  const letzte = r.daten.aenderungen.at(-1);
  assert.equal(letzte.geloescht, true);
  assert.equal(letzte.inhalt, undefined);
});

test('Unbekannte Sammlung und kaputte Zeitstempel werden abgewiesen', async () => {
  const a = await geraet('Carla');
  assert.equal((await rufe('/abgleich', { token: a.token, body: { aenderungen: [{ sammlung: 'geheim', id: 'x', geaendert: t(1), inhalt: {} }] } })).status, 400);
  assert.equal((await rufe('/abgleich', { token: a.token, body: { aenderungen: [{ sammlung: 'kunden', id: 'x', geaendert: 'gestern', inhalt: {} }] } })).status, 400);
});

test('Belegnummern: fortlaufend je Art und Jahr, gleicher Beleg gleiche Nummer', async () => {
  const a = await geraet('Dora');
  const b = await geraet('Emil');
  const n = async (tok, beleg, art = 'rechnung') => (await rufe('/nummer', { token: tok, body: { beleg, art, jahr: 2026 } })).daten.nummer;
  assert.equal(await n(a.token, 'bl1'), 'RE-2026-0001');
  assert.equal(await n(b.token, 'bl2'), 'RE-2026-0002');
  assert.equal(await n(a.token, 'bl1'), 'RE-2026-0001');
  assert.equal(await n(b.token, 'bl3', 'angebot'), 'AN-2026-0001');
  // Wechselt ein Einzelplatz-Gerät mit Stand 7 in den Betrieb, geht es danach weiter.
  const r = await rufe('/nummer', { token: a.token, body: { beleg: 'bl4', art: 'rechnung', jahr: 2026, mindestens: 7 } });
  assert.equal(r.daten.nummer, 'RE-2026-0008');
});

test('Abholen in Seiten', async () => {
  const a = await geraet('Fritz');
  const viele = Array.from({ length: 1200 }, (_, i) => ({ sammlung: 'artikel', id: `a${i}`, geaendert: t(1), inhalt: { id: `a${i}` } }));
  await rufe('/abgleich', { token: a.token, body: { aenderungen: viele } });
  let seit = 0;
  let zahl = 0;
  for (;;) {
    const r = await rufe(`/abgleich?seit=${seit}`, { token: a.token });
    zahl += r.daten.aenderungen.filter((x) => x.sammlung === 'artikel').length;
    seit = r.daten.rev;
    if (!r.daten.mehr) break;
  }
  assert.equal(zahl, 1200);
});

test('Verwalter lädt ein, sperrt und entfernt Geräte; Monteur darf das nicht', async () => {
  const chef = await geraet('Gisela', 'verwalter');
  const monteur = await geraet('Hans', 'monteur');
  assert.equal((await rufe('/mitarbeiter', { token: monteur.token })).status, 403);

  const e = await rufe('/einladung', { token: chef.token, body: { name: 'Ida', rolle: 'monteur' } });
  assert.equal(e.status, 200);
  const ida = (await rufe('/anmelden', { body: { code: e.daten.code, geraet: 'Handy Ida' } })).daten;
  assert.equal(ida.mitarbeiter.name, 'Ida');

  const liste = (await rufe('/mitarbeiter', { token: chef.token })).daten;
  const eintrag = liste.find((m) => m.name === 'Ida');
  assert.equal(eintrag.geraete.length, 1);
  assert.equal(eintrag.geraete[0].name, 'Handy Ida');

  // Gerät entfernen: Token gilt nicht mehr.
  await rufe('/geraet/entfernen', { token: chef.token, body: { id: eintrag.geraete[0].id } });
  assert.equal((await rufe('/ich', { token: ida.token })).status, 401);

  // Mitarbeiter sperren: alle seine Geräte gesperrt; wieder zulassen hebt es auf.
  const hans = liste.find((m) => m.name === 'Hans');
  await rufe('/mitarbeiter/aktiv', { token: chef.token, body: { id: hans.id, aktiv: false } });
  assert.equal((await rufe('/ich', { token: monteur.token })).status, 401);
  await rufe('/mitarbeiter/aktiv', { token: chef.token, body: { id: hans.id, aktiv: true } });
  assert.equal((await rufe('/ich', { token: monteur.token })).status, 200);

  assert.equal((await rufe('/mitarbeiter/aktiv', { token: chef.token, body: { id: chef.mitarbeiter.id, aktiv: false } })).status, 400);
});

test('Vertrag zur Auftragsverarbeitung: Pflicht im zentralen Betrieb, Export, Betrieb löschen', async () => {
  const sp = oeffneSpeicher(':memory:');
  const bid = sp.betriebAnlegen('Zentral GmbH');
  const srv = erstelleDienst(sp, { vertragPflicht: true });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const ruf = async (pfad, token, body) => {
    const r = await fetch(url + pfad, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, daten: await r.json() };
  };
  const an = async (name, rolle) => {
    const { code } = sp.einladen(bid, name, rolle);
    const r = await fetch(url + '/anmelden', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    return (await r.json()).token;
  };
  const chef = await an('Chefin', 'verwalter');
  const monteur = await an('Monteur', 'monteur');

  const ich = (await ruf('/ich', chef)).daten;
  assert.equal(ich.vertrag.pflicht, true);
  assert.equal(ich.vertrag.stand, null);
  assert.equal((await ruf('/abgleich?seit=0', monteur)).status, 451);
  assert.equal((await ruf('/vertrag', monteur, { fassung: ich.vertrag.fassung })).status, 403);
  assert.equal((await ruf('/vertrag', chef, { fassung: 'alt' })).status, 409);
  const z = (await ruf('/vertrag', chef, { fassung: ich.vertrag.fassung })).daten;
  assert.equal(z.name, 'Chefin');
  assert.equal((await ruf('/abgleich?seit=0', monteur)).status, 200);

  await ruf('/abgleich', monteur, { aenderungen: [{ sammlung: 'kunden', id: 'k1', geaendert: '2026-11-13T10:00:00.000Z', inhalt: { id: 'k1', name: 'Bäckerei' } }] });
  assert.equal((await ruf('/export', monteur)).status, 403);
  const ex = (await ruf('/export', chef)).daten;
  assert.equal(ex.sammlungen.kunden[0].inhalt.name, 'Bäckerei');
  assert.equal(ex.mitarbeiter.length, 2);
  assert.equal(ex.vertrag.fassung, ich.vertrag.fassung);

  assert.equal(sp.betriebLoeschen(bid), true);
  assert.equal((await ruf('/ich', chef)).status, 401);
  srv.close();
});

test('Rechte: Verwalter gibt Bereiche frei, Gerät bekommt sie signiert', async () => {
  const chef = await geraet('Jana', 'verwalter');
  const monteur = await geraet('Kai', 'monteur');
  const liste = (await rufe('/mitarbeiter', { token: chef.token })).daten;
  const kai = liste.find((m) => m.name === 'Kai');
  assert.equal(kai.bereiche, null);

  assert.equal((await rufe('/mitarbeiter/rechte', { token: monteur.token, body: { id: kai.id, bereiche: [] } })).status, 403);
  assert.equal((await rufe('/mitarbeiter/rechte', { token: chef.token, body: { id: kai.id, bereiche: ['kalender; drop'] } })).status, 400);
  assert.equal((await rufe('/mitarbeiter/rechte', { token: chef.token, body: { id: kai.id, bereiche: ['calendar', 'report'] } })).status, 200);

  const ich = (await rufe('/ich', { token: monteur.token })).daten;
  const inhalt = JSON.parse(ich.rechte.text);
  assert.deepEqual(inhalt.bereiche, ['calendar', 'report']);
  assert.equal(inhalt.rolle, 'monteur');

  // Signatur mit dem öffentlichen Schlüssel aus der Anmeldung prüfen (Rohform → SPKI).
  const roh = Buffer.from(monteur.pruefschluessel, 'base64');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), roh]);
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.equal(verify(null, Buffer.from(ich.rechte.text), pub, Buffer.from(ich.rechte.signatur, 'base64')), true);
  assert.equal(verify(null, Buffer.from(ich.rechte.text.replace('report', 'belege')), pub, Buffer.from(ich.rechte.signatur, 'base64')), false);
});

test('Kartenzahlung: Verwalter hinterlegt Stripe-Schlüssel, Gerät holt Token und Zahlung', async () => {
  // Stripe-Schnittstelle nachbilden; alles andere geht an den echten fetch.
  const echt = globalThis.fetch;
  const aufrufe = [];
  globalThis.fetch = async (url, o = {}) => {
    if (!String(url).startsWith('https://api.stripe.com')) return echt(url, o);
    aufrufe.push(`${o.method} ${String(url).replace('https://api.stripe.com/v1', '').split('?')[0]}`);
    const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (!String(o.headers?.authorization).includes('rk_test_gut')) return json({ error: { message: 'Invalid API Key' } }, 401);
    if (String(url).includes('/terminal/locations') && o.method === 'GET') return json({ data: [] });
    if (String(url).includes('/terminal/locations')) return json({ id: 'tml_1' });
    if (String(url).includes('/connection_tokens')) return json({ secret: 'pst_test_abc' });
    if (String(url).endsWith('/payment_intents')) return json({ id: 'pi_1', client_secret: 'pi_1_secret' });
    if (String(url).includes('/payment_intents/pi_1')) return json({ status: 'succeeded', amount: 1999, amount_received: 1999, metadata: { montix: '1', betrieb } });
    return json({}, 404);
  };
  try {
    const chef = await geraet('Lena', 'verwalter');
    const monteur = await geraet('Moritz', 'monteur');
    assert.equal((await rufe('/zahlung/status', { token: monteur.token })).daten.stripe, false);
    assert.equal((await rufe('/terminal/token', { token: monteur.token, body: {} })).status, 503);
    assert.equal((await rufe('/zahlung/stripe', { token: monteur.token, body: { schluessel: 'rk_test_gut1234567890' } })).status, 403);
    assert.equal((await rufe('/zahlung/stripe', { token: chef.token, body: { schluessel: 'passwort' } })).status, 400);
    assert.equal((await rufe('/zahlung/stripe', { token: chef.token, body: { schluessel: 'rk_test_falsch1234567890' } })).status, 400);
    const ok = await rufe('/zahlung/stripe', { token: chef.token, body: { schluessel: 'rk_test_gut1234567890', standort: { name: 'Muster', strasse: 'Hauptstr. 5', plz: '50667', ort: 'Köln' } } });
    assert.equal(ok.daten.stripe, true);
    assert.equal((await rufe('/zahlung/status', { token: monteur.token })).daten.stripe, true);
    assert.equal((await rufe('/terminal/token', { token: monteur.token, body: {} })).daten.secret, 'pst_test_abc');
    assert.equal((await rufe('/terminal/standort', { token: monteur.token, body: {} })).daten.id, 'tml_1');
    assert.equal((await rufe('/zahlung', { token: monteur.token, body: { betragCent: 10 } })).status, 400);
    assert.equal((await rufe('/zahlung', { token: monteur.token, body: { betragCent: 1999, beschreibung: 'Bericht' } })).daten.id, 'pi_1');
    assert.equal((await rufe('/zahlung/pi_1', { token: monteur.token })).daten.status, 'succeeded');
    // Der Schlüssel taucht im Export nicht auf.
    assert.equal(JSON.stringify((await rufe('/export', { token: chef.token })).daten).includes('rk_test_gut'), false);
    assert.ok(aufrufe.includes('POST /payment_intents'));
  } finally {
    globalThis.fetch = echt;
  }
});

test('Nachrichten: an alle und an eine Person, nur Beteiligte sehen sie, Sprachnachricht auf Abruf', async () => {
  const nina = await geraet('Nina', 'verwalter');
  const otto = await geraet('Otto', 'monteur');
  const paul = await geraet('Paul', 'monteur');
  const kollegen = (await rufe('/kollegen', { token: otto.token })).daten;
  assert.ok(kollegen.some((k) => k.name === 'Nina'));

  assert.equal((await rufe('/nachricht', { token: nina.token, body: { an: '*', text: '' } })).status, 400);
  assert.equal((await rufe('/nachricht', { token: nina.token, body: { an: 'ma_gibtsnicht', text: 'x' } })).status, 400);
  await rufe('/nachricht', { token: nina.token, body: { an: '*', text: 'Morgen 7 Uhr Treffpunkt Lager' } });
  await rufe('/nachricht', { token: nina.token, body: { an: otto.mitarbeiter.id, text: 'Otto, bitte Schlüssel mitbringen', audio: 'QUJD', dauerMs: 1200 } });

  const beiOtto = (await rufe('/nachrichten?seit=0', { token: otto.token })).daten;
  const beiPaul = (await rufe('/nachrichten?seit=0', { token: paul.token })).daten;
  const eigene = (n) => n.nachrichten.filter((m) => m.von === nina.mitarbeiter.id).map((m) => m.text);
  assert.deepEqual(eigene(beiOtto), ['Morgen 7 Uhr Treffpunkt Lager', 'Otto, bitte Schlüssel mitbringen']);
  assert.deepEqual(eigene(beiPaul), ['Morgen 7 Uhr Treffpunkt Lager']);
  const privat = beiOtto.nachrichten.find((m) => m.audio);
  assert.equal(privat.vonName, 'Nina');
  assert.equal(privat.anName, 'Otto');
  assert.equal((await rufe(`/nachricht/${privat.id}/audio`, { token: otto.token })).daten.daten, 'QUJD');
  assert.equal((await rufe(`/nachricht/${privat.id}/audio`, { token: paul.token })).status, 404);
  // Abholmarke: danach nur Neues
  assert.equal((await rufe(`/nachrichten?seit=${beiOtto.rev}`, { token: otto.token })).daten.nachrichten.length, 0);
  // Nach 90 Tagen ist eine Nachricht weg (Zeitpunkt künstlich zurückgesetzt).
  const db = speicher.pruefe(otto.token).db;
  db.prepare('update nachrichten set zeit = ? where id = ?').run(new Date(Date.now() - 91 * 86400000).toISOString(), privat.id);
  const danach = (await rufe('/nachrichten?seit=0', { token: otto.token })).daten.nachrichten;
  assert.equal(danach.some((m) => m.id === privat.id), false);
});

test('Mitarbeiterdaten: Verwalter pflegt Stammdaten und Rolle, letzter Verwalter bleibt', async () => {
  const chef = await geraet('Rita', 'verwalter');
  const ma = await geraet('Sven', 'monteur');
  const liste = (await rufe('/mitarbeiter', { token: chef.token })).daten;
  const sven = liste.find((m) => m.name === 'Sven');
  assert.equal((await rufe('/mitarbeiter/daten', { token: ma.token, body: { id: sven.id, kuerzel: 'SV' } })).status, 403);
  const ok = await rufe('/mitarbeiter/daten', { token: chef.token, body: { id: sven.id, kuerzel: 'SV', telefon: '0171 123', email: 'sven@example.org', farbe: '#2f855a' } });
  assert.equal(ok.status, 200);
  const nach = (await rufe('/mitarbeiter', { token: chef.token })).daten.find((m) => m.id === sven.id);
  assert.equal(nach.kuerzel, 'SV');
  assert.equal(nach.farbe, '#2f855a');
  assert.equal((await rufe('/kollegen', { token: ma.token })).daten.find((k) => k.id === sven.id).farbe, '#2f855a');
  // Ungültige Farbe wird nicht übernommen.
  await rufe('/mitarbeiter/daten', { token: chef.token, body: { id: sven.id, farbe: 'rot' } });
  assert.equal((await rufe('/mitarbeiter', { token: chef.token })).daten.find((m) => m.id === sven.id).farbe, '#2f855a');
  // Sven wird Verwalter, Rita darf danach Monteur werden.
  await rufe('/mitarbeiter/daten', { token: chef.token, body: { id: sven.id, rolle: 'verwalter' } });
  assert.equal((await rufe('/mitarbeiter/daten', { token: chef.token, body: { id: chef.mitarbeiter.id, rolle: 'monteur' } })).status, 200);
});

test('Bewegung: Schritte nur für sich selbst, Aktionen nur vom Verwalter', async () => {
  const chef = await geraet('Bea', 'verwalter');
  const ma = await geraet('Tom', 'monteur');
  const eigen = { sammlung: 'schritte', id: `${ma.mitarbeiter.id}_2026-11-13`, geaendert: t(1), inhalt: { mitarbeiter: ma.mitarbeiter.id, datum: '2026-11-13', schritte: 8000 } };
  const fremd = { sammlung: 'schritte', id: `${chef.mitarbeiter.id}_2026-11-13`, geaendert: t(1), inhalt: { mitarbeiter: chef.mitarbeiter.id, datum: '2026-11-13', schritte: 99999 } };
  const aktionMa = { sammlung: 'aktionen', id: 'a-ma', geaendert: t(1), inhalt: { titel: 'selbst ausgedacht' } };
  assert.equal((await rufe('/abgleich', { token: ma.token, body: { aenderungen: [eigen, fremd, aktionMa] } })).status, 200);
  await rufe('/abgleich', { token: chef.token, body: { aenderungen: [{ sammlung: 'aktionen', id: 'a1', geaendert: t(2), inhalt: { titel: 'Winterwandern' } }] } });
  // Alle Seiten lesen (der Server liefert höchstens 500 je Antwort).
  const alles = [];
  for (let seit = 0, mehr = true; mehr; ) {
    const d = (await rufe(`/abgleich?seit=${seit}`, { token: chef.token })).daten;
    alles.push(...d.aenderungen);
    ({ mehr } = d);
    seit = d.rev;
  }
  const ids = alles.filter((a) => a.sammlung === 'schritte' || a.sammlung === 'aktionen').map((a) => a.id);
  assert.ok(ids.includes(eigen.id));
  assert.ok(!ids.includes(fremd.id));
  assert.ok(!ids.includes('a-ma'));
  assert.ok(ids.includes('a1'));
});

test('Alleinarbeit: Frist, Bestätigung, Fristalarm, Notruf, Kümmern, Ende', async () => {
  const ma = await geraet('Ali', 'monteur');
  const kollege = await geraet('Kim', 'monteur');
  assert.equal((await rufe('/alleinarbeit/start', { token: ma.token, body: { minuten: 7 } })).status, 400);
  const s = await rufe('/alleinarbeit/start', { token: ma.token, body: { minuten: 30, ort: { lat: 50.7, lon: 7.1, genau: 12 } } });
  assert.equal(s.status, 200);
  assert.equal(s.daten.status, 'aktiv');
  // Kollege sieht die laufende Alleinarbeit samt Ort.
  let liste = (await rufe('/alleinarbeit', { token: kollege.token })).daten;
  assert.equal(liste.find((e) => e.mitarbeiter === ma.mitarbeiter.id).ort.lat, 50.7);
  // Frist abgelaufen → beim nächsten Lesen Alarm.
  speicher.pruefe(ma.token).db.prepare('update alleinarbeit set frist = ? where mitarbeiter = ?').run('2000-01-01T00:00:00.000Z', ma.mitarbeiter.id);
  liste = (await rufe('/alleinarbeit', { token: kollege.token })).daten;
  const alarm = liste.find((e) => e.mitarbeiter === ma.mitarbeiter.id);
  assert.equal(alarm.status, 'alarm');
  assert.equal(alarm.grund, 'frist');
  assert.equal((await rufe('/alleinarbeit/kuemmern', { token: kollege.token, body: { mitarbeiter: ma.mitarbeiter.id } })).daten.kuemmert, 'Kim');
  // Die Person meldet sich: Alarm weg, Frist neu.
  const ok = await rufe('/alleinarbeit/ok', { token: ma.token, body: {} });
  assert.equal(ok.daten.status, 'aktiv');
  assert.ok(ok.daten.frist > new Date().toISOString());
  // Notruf sofort.
  assert.equal((await rufe('/alleinarbeit/notruf', { token: ma.token, body: {} })).daten.grund, 'notruf');
  assert.equal((await rufe('/alleinarbeit/ende', { token: ma.token, body: {} })).daten.status, 'ende');
  liste = (await rufe('/alleinarbeit', { token: kollege.token })).daten;
  assert.ok(!liste.some((e) => e.mitarbeiter === ma.mitarbeiter.id));
});

test('Alleinarbeit: Empfänger sehen nur ihre Person, Notfallkontakte bekommen E-Mail und Entwarnung', async () => {
  const ma = await geraet('Ute', 'monteur');
  const kollege = await geraet('Jan', 'monteur');
  // Notfallkontakt eintragen, ungültige Adresse abgewiesen.
  assert.equal((await rufe('/notfallkontakte', { token: ma.token, body: { kontakte: [{ name: 'Mama', email: 'kein-mail' }] } })).status, 400);
  post.length = 0;
  assert.equal((await rufe('/notfallkontakte', { token: ma.token, body: { kontakte: [{ name: 'Mama', email: 'mama@example.org' }] } })).status, 200);
  // Neuer Kontakt bekommt einmal Bescheid (Art. 14 DSGVO), beim erneuten Speichern nicht wieder.
  assert.equal(post.filter((m) => m.betreff.includes('als Notfallkontakt')).length, 1);
  await rufe('/notfallkontakte', { token: ma.token, body: { kontakte: [{ name: 'Mama', email: 'Mama@example.org' }] } });
  assert.equal(post.filter((m) => m.betreff.includes('als Notfallkontakt')).length, 1);
  assert.ok(post[0].text.includes('Verantwortlich für diese Daten: Muster GmbH'));
  // Empfänger einladen und anmelden.
  const einl = (await rufe('/empfaenger/einladung', { token: ma.token, body: { name: 'Mama' } })).daten;
  const em = (await rufe('/anmelden', { body: { code: einl.code, geraet: 'Handy Mama' } })).daten;
  assert.equal(em.mitarbeiter.rolle, 'empfaenger');
  assert.equal((await rufe('/empfaenger', { token: ma.token })).daten.length, 1);
  // Empfänger: kein Abgleich, keine Kollegen, kein eigener Start.
  assert.equal((await rufe('/abgleich?seit=0', { token: em.token })).status, 403);
  assert.equal((await rufe('/kollegen', { token: em.token })).status, 403);
  assert.equal((await rufe('/alleinarbeit/start', { token: em.token, body: { minuten: 30 } })).status, 403);
  // Empfänger taucht nicht als Kollege auf.
  assert.ok(!(await rufe('/kollegen', { token: kollege.token })).daten.some((k) => k.name === 'Mama'));
  // Beide arbeiten allein; Mama sieht nur Ute.
  await rufe('/alleinarbeit/start', { token: ma.token, body: { minuten: 30 } });
  await rufe('/alleinarbeit/start', { token: kollege.token, body: { minuten: 30 } });
  const sicht = (await rufe('/alleinarbeit', { token: em.token })).daten;
  assert.deepEqual(sicht.map((e) => e.name), ['Ute']);
  // Frist läuft ab → Zeitgeber meldet per E-Mail, einmal.
  post.length = 0;
  speicher.pruefe(ma.token).db.prepare('update alleinarbeit set frist = ? where mitarbeiter = ?').run('2000-01-01T00:00:00.000Z', ma.mitarbeiter.id);
  server.pruefeAlarme();
  server.pruefeAlarme();
  const alarm = post.filter((m) => m.betreff.startsWith('ALARM'));
  assert.equal(alarm.length, 1);
  assert.deepEqual(alarm[0].an, ['Mama@example.org']);
  assert.ok(alarm[0].text.includes('Verantwortlich für diese Daten'));
  assert.ok(alarm[0].text.includes('kein Standort') || alarm[0].text.includes('Hinnavigieren'));
  // Mama kümmert sich, Ute meldet sich → Entwarnung.
  assert.equal((await rufe('/alleinarbeit/kuemmern', { token: em.token, body: { mitarbeiter: ma.mitarbeiter.id } })).daten.kuemmert, 'Mama');
  assert.equal((await rufe('/alleinarbeit/kuemmern', { token: em.token, body: { mitarbeiter: kollege.mitarbeiter.id } })).status, 403);
  await rufe('/alleinarbeit/ok', { token: ma.token, body: {} });
  assert.ok(post.some((m) => m.betreff.startsWith('Entwarnung')));
  // Notruf meldet sofort — mit Karte und Navigation, wenn ein Ort mitkommt.
  post.length = 0;
  await rufe('/alleinarbeit/notruf', { token: ma.token, body: { ort: { lat: 50.73512, lon: 7.10012, genau: 8 } } });
  const notruf = post.find((m) => m.betreff.includes('Notruf'));
  assert.ok(notruf.text.includes('google.com/maps/dir/?api=1&destination=50.73512,7.10012'));
  assert.ok(notruf.text.includes('openstreetmap.org'));
  // Empfänger entfernen → Gerät abgemeldet.
  await rufe('/empfaenger/entfernen', { token: ma.token, body: { id: einl.mitarbeiter } });
  assert.equal((await rufe('/alleinarbeit', { token: em.token })).status, 401);
  await rufe('/alleinarbeit/ende', { token: ma.token, body: {} });
  await rufe('/alleinarbeit/ende', { token: kollege.token, body: {} });
});

test('Privatkonto: nur Alleinarbeit, ohne Abgleich, mit Obergrenze', async () => {
  const p = await rufe('/privat', { body: { name: 'Eva Einzeln', geraet: 'Handy Eva' } });
  assert.equal(p.status, 200);
  assert.equal(p.daten.mitarbeiter.rolle, 'verwalter');
  assert.equal((await rufe('/abgleich?seit=0', { token: p.daten.token })).status, 403);
  assert.equal((await rufe('/einladung', { token: p.daten.token, body: { name: 'X' } })).status, 403);
  assert.equal((await rufe('/alleinarbeit/start', { token: p.daten.token, body: { minuten: 60 } })).status, 200);
  assert.equal((await rufe('/empfaenger/einladung', { token: p.daten.token, body: { name: 'Bruder' } })).status, 200);
  await rufe('/alleinarbeit/ende', { token: p.daten.token, body: {} });
  for (let i = 0; i < 4; i++) await rufe('/privat', { body: { name: `P${i}` } });
  assert.equal((await rufe('/privat', { body: { name: 'zu viel' } })).status, 429);
});

test('Post: Umschlagabsender ist die nackte From-Adresse (SPF/DMARC)', async () => {
  const { absenderAdresse } = await import('../post.mjs');
  assert.equal(absenderAdresse('Montix <montix@feif.space>'), 'montix@feif.space');
  assert.equal(absenderAdresse('montix@feif.space'), 'montix@feif.space');
});

test('Löschen aus der App: Gerät, Person, Privatkonto, Betrieb', async () => {
  const p = speicher.privatAnlegen('Lotte Los', 'Handy');
  assert.equal((await rufe('/konto/loeschen', { token: p.token, body: { art: 'person' } })).daten.geloescht, 'konto');
  assert.equal((await rufe('/ich', { token: p.token })).status, 401);
  const b = speicher.betriebAnlegen('Löschprobe KG');
  const anm = async (name, rolle) => (await rufe('/anmelden', { body: { code: speicher.einladen(b, name, rolle).code } })).daten;
  const chef = await anm('Chefin', 'verwalter');
  const ma = await anm('Mo', 'monteur');
  assert.equal((await rufe('/konto/loeschen', { token: chef.token, body: { art: 'person' } })).status, 409);
  assert.equal((await rufe('/konto/loeschen', { token: ma.token, body: { art: 'person' } })).daten.geloescht, 'person');
  assert.equal((await rufe('/ich', { token: ma.token })).status, 401);
  assert.equal((await rufe('/konto/loeschen', { token: chef.token, body: { art: 'betrieb', bestaetigung: 'falsch' } })).status, 400);
  assert.equal((await rufe('/konto/loeschen', { token: chef.token, body: { art: 'betrieb', bestaetigung: 'Löschprobe KG' } })).daten.geloescht, 'betrieb');
  assert.equal((await rufe('/ich', { token: chef.token })).status, 401);
});

test('Push: Token anmelden, Alarm an Kollegen und Empfänger, Nachricht an Empfänger', async () => {
  const b = speicher.betriebAnlegen('Push GmbH');
  const anm = async (name) => (await rufe('/anmelden', { body: { code: speicher.einladen(b, name, 'monteur').code } })).daten;
  const a = await anm('Anna');
  const k = await anm('Kai');
  const einl = (await rufe('/empfaenger/einladung', { token: a.token, body: { name: 'Opa' } })).daten;
  const opa = (await rufe('/anmelden', { body: { code: einl.code } })).daten;
  assert.equal((await rufe('/push/token', { token: k.token, body: { token: 'kaputt' } })).status, 400);
  for (const [w, t] of [[k, 'ExponentPushToken[kai1234567890]'], [opa, 'ExponentPushToken[opa1234567890]'], [a, 'ExponentPushToken[anna123456789]']]) {
    assert.equal((await rufe('/push/token', { token: w.token, body: { token: t, plattform: 'android' } })).status, 200);
  }
  pushes.length = 0;
  await rufe('/alleinarbeit/notruf', { token: a.token, body: {} });
  const ziele = pushes.map((p) => p.to).sort();
  assert.deepEqual(ziele, ['ExponentPushToken[kai1234567890]', 'ExponentPushToken[opa1234567890]']);
  assert.equal(pushes[0].channelId, 'alarm');
  pushes.length = 0;
  await rufe('/alleinarbeit/ende', { token: a.token, body: {} });
  assert.ok(pushes.every((p) => p.title === 'Entwarnung: Anna') && pushes.length === 2);
  pushes.length = 0;
  await rufe('/nachricht', { token: k.token, body: { an: a.mitarbeiter.id, text: 'Kommst du?' } });
  assert.deepEqual(pushes.map((p) => p.to), ['ExponentPushToken[anna123456789]']);
  assert.equal(pushes[0].title, 'Nachricht von Kai');
});

test('Unterwegs: Link für den Kunden zeigt nur gerundete Entfernung, Kollegen sehen die Fahrt', async () => {
  const b = speicher.betriebAnlegen('Weg GmbH');
  const anm = async (name) => (await rufe('/anmelden', { body: { code: speicher.einladen(b, name, 'monteur').code } })).daten;
  const m = await anm('Max Mustermann');
  const k = await anm('Kim');
  const ziel = { lat: 50.73, lon: 7.1 };
  const s = await rufe('/unterwegs/start', { token: m.token, body: { termin: 't1', kunde: 'Bäckerei', ziel, ort: { lat: 50.77, lon: 7.1 } } });
  assert.equal(s.status, 200);
  const pfad = new URL(s.daten.link).pathname;
  let seite = await (await fetch(basis + pfad)).text();
  assert.ok(seite.includes('Max ist unterwegs'));
  assert.ok(seite.includes('etwa 4 km'));
  assert.ok(!seite.includes('50.77')); // kein genauer Ort auf der Seite
  const fahrten = (await rufe('/unterwegs', { token: k.token })).daten;
  assert.equal(fahrten[0].kunde, 'Bäckerei');
  await rufe('/unterwegs/ort', { token: m.token, body: { ort: { lat: 50.731, lon: 7.1 } } });
  seite = await (await fetch(basis + pfad)).text();
  assert.ok(seite.includes('gleich da'));
  await rufe('/unterwegs/ende', { token: m.token, body: {} });
  seite = await (await fetch(basis + pfad)).text();
  assert.ok(seite.includes('ist angekommen'));
  assert.equal((await fetch(basis + '/weg/wnichtdaxxxxxxxxxxxx')).status, 404);
});

test('Post: HTML-Fassung macht Links zu Knöpfen und maskiert Text', async () => {
  const { htmlAusText } = await import('../post.mjs');
  const h = htmlAusText('Max <b> hat sich nicht gemeldet.\nHinnavigieren: https://www.google.com/maps/dir/?api=1&destination=1,2');
  assert.ok(h.includes('&lt;b&gt;'));
  assert.ok(h.includes('<a href="https://www.google.com/maps/dir/?api=1&amp;destination=1,2"'));
  assert.ok(h.includes('>Hinnavigieren</a>'));
});

test('Freigaben: Mappe teilen, Seite und Download, PIN mit Sperre, neue Fassung, Widerruf, Rechte', async () => {
  const b = speicher.betriebAnlegen('Elektro Kurz');
  const anm = async (name, rolle) => (await rufe('/anmelden', { body: { code: speicher.einladen(b, name, rolle).code } })).daten;
  const m = await anm('Mia', 'monteur');
  const k = await anm('Kai', 'monteur');
  const v = await anm('Vera', 'verwalter');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0 L10 10"/></svg>').toString('base64');
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF').toString('base64');

  // Typen werden geprüft: falscher Inhalt, Skript im SVG, fremder Typ
  assert.equal((await rufe('/freigabe', { token: m.token, body: { titel: 'X', teile: [{ name: 'a', typ: 'application/pdf', daten: svg }] } })).status, 400);
  const boese = Buffer.from('<svg onload="alert(1)"></svg>').toString('base64');
  assert.equal((await rufe('/freigabe', { token: m.token, body: { titel: 'X', teile: [{ name: 'a', typ: 'image/svg+xml', daten: boese }] } })).status, 400);
  assert.equal((await rufe('/freigabe', { token: m.token, body: { titel: 'X', teile: [{ name: 'a', typ: 'text/html', daten: svg }] } })).status, 400);

  const r = await rufe('/freigabe', {
    token: m.token,
    body: { titel: 'Leitungsplan EG', objekt: 'Hauptstr. 1', ablaufTage: null, teile: [{ name: 'Plan', typ: 'image/svg+xml', daten: svg }, { name: 'Plan.pdf', typ: 'application/pdf', daten: pdf }], plan: { format: 'montix-plan/1', elemente: [] } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  const pfad = new URL(r.daten.link).pathname;
  let seite = await (await fetch(basis + pfad)).text();
  assert.ok(seite.includes('Leitungsplan EG') && seite.includes('Elektro Kurz') && seite.includes('Hauptstr. 1'));
  const dateiLink = seite.match(/href="([^"]+datei\/1[^"]*laden=1)"/)[1].replace(/&amp;/g, '&');
  const d = await fetch(new URL(dateiLink, basis + pfad));
  assert.equal(d.status, 200);
  assert.equal(d.headers.get('content-type'), 'application/pdf');
  assert.ok(d.headers.get('content-disposition').startsWith('attachment'));
  assert.ok(d.headers.get('content-security-policy').includes('sandbox'));
  assert.ok((await d.text()).startsWith('%PDF-'));
  const daten = await (await fetch(basis + pfad + '/daten')).json();
  assert.equal(daten.format, 'montix-mappe/1');
  assert.equal(daten.plan.format, 'montix-plan/1');

  // Liste mit Abrufen; Kollege darf nicht widerrufen, Verwalter schon — vorher neue Fassung
  let liste = (await rufe('/freigaben', { token: v.token })).daten;
  const f = liste.find((x) => x.id === r.daten.id);
  assert.equal(f.abrufe, 1);
  assert.equal(f.ablauf, null);
  assert.equal(f.teile.length, 2);
  assert.equal((await rufe('/freigabe/widerrufen', { token: k.token, body: { id: f.id } })).status, 403);
  assert.equal((await rufe('/freigabe/fassung', { token: m.token, body: { id: f.id, teile: [{ name: 'Plan neu', typ: 'image/svg+xml', daten: svg }] } })).daten.fassung, 2);
  seite = await (await fetch(basis + pfad)).text();
  assert.ok(seite.includes('Plan neu') && seite.includes('Fassung 2'));
  assert.equal((await rufe('/freigabe/widerrufen', { token: v.token, body: { id: f.id } })).status, 200);
  assert.equal((await fetch(basis + pfad)).status, 410);
  liste = (await rufe('/freigaben', { token: m.token })).daten;
  assert.ok(liste.find((x) => x.id === f.id).widerrufen);
  assert.equal(liste.find((x) => x.id === f.id).teile.length, 0);

  // PIN: ohne PIN nur das Formular, Dateien gesperrt; falsche PIN zählt, nach 10 Fehlern Sperre
  const p = await rufe('/freigabe', { token: m.token, body: { titel: 'Alarmanlage', pin: '4711', ablaufTage: 30, teile: [{ name: 'Plan', typ: 'image/svg+xml', daten: svg }] } });
  const pp = new URL(p.daten.link).pathname;
  seite = await (await fetch(basis + pp)).text();
  assert.ok(seite.includes('PIN') && !seite.includes('datei/0'));
  assert.equal((await fetch(basis + pp + '/datei/0')).status, 403);
  const mitPin = (pin) => fetch(basis + pp, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `pin=${pin}` }).then((x) => x.text());
  assert.ok((await mitPin('0000')).includes('stimmt nicht'));
  seite = await mitPin('4711');
  assert.ok(seite.includes('datei/0?z='));
  const z = seite.match(/datei\/0\?z=([^"&]+)/)[1];
  assert.equal((await fetch(`${basis}${pp}/datei/0?z=${z}`)).status, 200);
  for (let i = 0; i < 10; i++) await mitPin('1111');
  assert.ok((await mitPin('4711')).includes('Zu viele falsche Versuche'));

  // Unbekannt und Privatkonto
  assert.equal((await fetch(basis + '/teilen/tnichtdaxxxxxxxxxxxxxxxx')).status, 404);
  const privat = speicher.privatAnlegen('Solo', 'x');
  assert.equal((await rufe('/freigaben', { token: privat.token })).status, 403);
});

test('Freigaben: Ablauf löscht die Dateien, Kontolöschung entfernt den Namen', async () => {
  const { abgelaufeneAufraeumen } = await import('../freigaben.mjs');
  const b = speicher.betriebAnlegen('Sanitär Lang');
  const m = (await rufe('/anmelden', { body: { code: speicher.einladen(b, 'Lea Lang', 'monteur').code } })).daten;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
  const r = (await rufe('/freigabe', { token: m.token, body: { titel: 'Kurz', ablaufTage: 1, teile: [{ name: 'P', typ: 'image/svg+xml', daten: svg }] } })).daten;
  const pfad = new URL(r.link).pathname;
  assert.ok((await (await fetch(basis + pfad)).text()).includes('Lea Lang') === false); // Name steht nicht auf der Seite
  const db = speicher.alleBetriebe().find((x) => x.id === b).db;
  abgelaufeneAufraeumen(db, new Date(Date.now() + 2 * 86400000));
  assert.equal(db.prepare('select count(*) n from freigabe_dateien where freigabe = ?').get(r.id).n, 0);
  const liste = (await rufe('/freigaben', { token: m.token })).daten;
  assert.equal(liste.find((x) => x.id === r.id).von, 'Lea Lang');
  speicher.personLoeschen(db, m.mitarbeiter.id);
  assert.equal(db.prepare('select von_name from freigaben where id = ?').get(r.id).von_name, 'gelöscht');
});

test('Objektraum: Firmen und Auftraggeber legen Punkte an, haken ab, schreiben; Türcode vertraulich; Mail gebündelt', async () => {
  const b = speicher.betriebAnlegen('Bau Berg');
  const v = (await rufe('/anmelden', { body: { code: speicher.einladen(b, 'Vera Berg', 'verwalter').code } })).daten;
  post.length = 0;
  const raum = (await rufe('/raum', { token: v.token, body: { titel: 'Umbau Schulstraße', objekt: 'Schulstr. 3' } })).daten;
  const ag = (await rufe('/raum/teilnehmer', { token: v.token, body: { raum: raum.id, name: 'Familie Kühn', rolle: 'auftraggeber', email: 'kuehn@example.org' } })).daten;
  const el = (await rufe('/raum/teilnehmer', { token: v.token, body: { raum: raum.id, name: 'Elektro Kurz', rolle: 'firma', email: 'kurz@example.org' } })).daten;
  const nur = (await rufe('/raum/teilnehmer', { token: v.token, body: { raum: raum.id, name: 'Maler Lese', rolle: 'firma', rechte: { anlegen: false, abhaken: false, schreiben: false } } })).daten;
  assert.equal(post.filter((p) => p.betreff.startsWith('Einladung')).length, 2); // nur wer eine Adresse hat
  assert.ok(post[0].text.includes(ag.link));

  const pAg = new URL(ag.link).pathname;
  const pEl = new URL(el.link).pathname;
  const form = (pfad, felder) => fetch(basis + pfad, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(felder).toString() });

  // Auftraggeber meldet einen Mangel mit Foto (multipart)
  const fd = new FormData();
  fd.append('aktion', 'punkt');
  fd.append('titel', 'Fliese im Bad gesprungen');
  fd.append('foto', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' }), 'bad.jpg');
  const r1 = await fetch(basis + pAg, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(r1.status, 303);
  let seite = await (await fetch(basis + pEl)).text();
  assert.ok(seite.includes('Fliese im Bad gesprungen') && seite.includes('Familie Kühn'));
  const fotoPfad = seite.match(/src="([^"]+\/foto\/[^"]+)"/)[1];
  assert.equal((await fetch(new URL(fotoPfad, basis + pEl))).headers.get('content-type'), 'image/jpeg');

  // Elektriker hakt ab; Betrieb sieht es in der App
  const punkt = (await rufe(`/raum?id=${raum.id}`, { token: v.token })).daten.punkte[0];
  assert.equal((await form(pEl, { aktion: 'abhaken', punkt: punkt.id })).status, 303);
  let a = (await rufe(`/raum?id=${raum.id}`, { token: v.token })).daten;
  assert.equal(a.punkte[0].status, 'erledigt');
  assert.equal(a.punkte[0].erledigtVon, 'Elektro Kurz');

  // Nur-Lesen darf nichts
  const pNur = new URL(nur.link).pathname;
  assert.ok((await (await form(pNur, { aktion: 'abhaken', punkt: punkt.id })).text()).includes('keine Punkte abhaken'));
  assert.ok(!(await (await fetch(basis + pNur)).text()).includes('Neuer Punkt'));

  // Türcode vom Auftraggeber nur für Elektro Kurz
  await form(pAg, { aktion: 'notiz', bezeichnung: 'Türcode Haustür', code: '4-7-1-1', sichtbar: el.id, tage: '7' });
  seite = await (await fetch(basis + pEl)).text();
  assert.ok(seite.includes('Türcode Haustür') && !seite.includes('4-7-1-1'));
  assert.ok(!(await (await fetch(basis + pNur)).text()).includes('Türcode Haustür')); // Maler sieht ihn nicht
  a = (await rufe(`/raum?id=${raum.id}`, { token: v.token })).daten;
  const codeNotiz = a.notizen.find((n) => n.vertraulich);
  assert.equal(codeNotiz.text, null);
  seite = await (await form(pEl, { aktion: 'anzeigen', notiz: codeNotiz.id })).text();
  assert.ok(seite.includes('4-7-1-1'));
  assert.ok((await (await form(pNur, { aktion: 'anzeigen', notiz: codeNotiz.id })).text()).includes('nicht für Sie bestimmt'));
  assert.equal((await rufe('/raum/code', { token: v.token, body: { raum: raum.id, notiz: codeNotiz.id } })).daten.code, '4-7-1-1');
  a = (await rufe(`/raum?id=${raum.id}`, { token: v.token })).daten;
  assert.deepEqual(a.notizen.find((n) => n.vertraulich).einsichten.map((e) => e.wer).sort(), ['Bau Berg (Vera Berg)', 'Elektro Kurz']);

  // Betrieb schreibt aus der App; gebündelte Mail: eine je Teilnehmer, ohne Code
  await rufe('/raum/notiz', { token: v.token, body: { raum: raum.id, text: 'Montag ab 8 Uhr vor Ort' } });
  // Takt: Vorgabe 5 Minuten; nur der Verwalter stellt um
  assert.equal((await rufe('/raum/einstellungen', { token: v.token })).daten.mailMinuten, 5);
  assert.equal((await rufe('/raum/einstellungen', { token: v.token, body: { mailMinuten: 7 } })).status, 400);
  assert.equal((await rufe('/raum/einstellungen', { token: v.token, body: { mailMinuten: 15 } })).daten.mailMinuten, 15);
  post.length = 0;
  server.postVerschicken();
  server.postVerschicken(new Date(Date.now() + 10 * 60000));
  assert.equal(post.length, 0); // innerhalb der 15 Minuten noch keine Mail
  server.postVerschicken(new Date(Date.now() + 16 * 60000));
  const anKuehn = post.filter((p) => p.an.includes('kuehn@example.org'));
  const anKurz = post.filter((p) => p.an.includes('kurz@example.org'));
  assert.equal(anKuehn.length, 1);
  assert.equal(anKurz.length, 1);
  assert.ok(anKurz[0].text.includes('Montag ab 8 Uhr') && anKurz[0].text.includes('Fliese') && !anKurz[0].text.includes('Erledigt')); // eigene Aktion nicht
  assert.ok(anKuehn[0].text.includes('Erledigt (Elektro Kurz)') && !anKuehn[0].text.includes('vertraulich'));
  assert.ok(anKurz[0].text.includes('vertraulichen Hinweis'));
  assert.ok(!post.some((p) => p.text.includes('4-7-1-1') || p.html.includes('4-7-1-1')));
  assert.ok(anKurz[0].text.includes(el.link));

  // Code löscht sich nach Ablauf; Entfernen und Schließen machen Links tot
  const { erstelleRaeume } = await import('../raeume.mjs');
  const db = speicher.alleBetriebe().find((x) => x.id === b).db;
  erstelleRaeume({ ordner: ':memory:', senden: () => {} }).aufraeumen(db, new Date(Date.now() + 8 * 86400000));
  assert.ok((await (await fetch(basis + pEl)).text()).includes('gelöscht'));
  await rufe('/raum/teilnehmer/entfernen', { token: v.token, body: { raum: raum.id, teilnehmer: nur.id } });
  assert.equal((await fetch(basis + pNur)).status, 404);
  await rufe('/raum/archivieren', { token: v.token, body: { id: raum.id } });
  assert.equal((await fetch(basis + pAg)).status, 404);
  assert.equal((await rufe('/raeume', { token: v.token })).daten[0].archiviert !== null, true);
  // Kontolöschung: Einträge bleiben, der Name nicht
  speicher.personLoeschen(db, v.mitarbeiter.id);
  const reste = JSON.stringify([...db.prepare('select von_name from raum_notizen').all(), ...db.prepare('select wer from raum_einsichten').all()]);
  assert.ok(!reste.includes('Vera') && reste.includes('gelöscht'));
});

test('Freigaben: per E-Mail senden (nur mit passendem Link), CSV als Datei', async () => {
  const b = speicher.betriebAnlegen('Dach Duc');
  const m = (await rufe('/anmelden', { body: { code: speicher.einladen(b, 'Mo', 'monteur').code } })).daten;
  const csv = Buffer.from('"EXTF";700;21;"Buchungsstapel"\r\n').toString('base64');
  const r = (await rufe('/freigabe', { token: m.token, body: { titel: 'DATEV 10/2026', ablaufTage: 30, teile: [{ name: 'EXTF.csv', typ: 'text/csv', daten: csv }] } })).daten;
  assert.ok(r.link);
  const fremd = (await rufe('/freigabe', { token: m.token, body: { titel: 'Anders', ablaufTage: 7, teile: [{ name: 'x.csv', typ: 'text/csv', daten: csv }] } })).daten;
  assert.equal((await rufe('/freigabe/senden', { token: m.token, body: { id: r.id, link: fremd.link, email: 'kanzlei@example.org' } })).status, 400);
  assert.equal((await rufe('/freigabe/senden', { token: m.token, body: { id: r.id, link: r.link, email: 'keine-adresse' } })).status, 400);
  post.length = 0;
  assert.equal((await rufe('/freigabe/senden', { token: m.token, body: { id: r.id, link: r.link, email: 'kanzlei@example.org', nachricht: 'Anbei Oktober.' } })).status, 200);
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].an, ['kanzlei@example.org']);
  assert.ok(post[0].text.includes(r.link) && post[0].text.includes('Anbei Oktober.') && post[0].betreff.includes('Dach Duc'));
  assert.ok(!post[0].text.includes('Mo ')); // Name der Person steht nicht in der Mail
  const seite = await (await fetch(basis + new URL(r.link).pathname)).text();
  assert.ok(seite.includes('Herunterladen (CSV'));
  const binaer = Buffer.from([0x22, 0x00, 0x41]).toString('base64');
  assert.equal((await rufe('/freigabe', { token: m.token, body: { titel: 'X', teile: [{ name: 'b.csv', typ: 'text/csv', daten: binaer }] } })).status, 400);
});

test('Mail-Takt: im zentralen Hosting fest 15 Minuten, mit Serverpaket einstellbar', async () => {
  const { erstelleDienst } = await import('../dienst.mjs');
  const { serverpaketSetzen } = await import('../raeume.mjs');
  const zentral = erstelleDienst(speicher, { zeitgeber: false, vertragPflicht: true, senden: () => {}, push: async () => {} });
  await new Promise((r) => zentral.listen(0, '127.0.0.1', r));
  const z = `http://127.0.0.1:${zentral.address().port}`;
  try {
    const b = speicher.betriebAnlegen('Hosting Hans');
    const v = (await (await fetch(`${z}/anmelden`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: speicher.einladen(b, 'Hans', 'verwalter').code }) })).json());
    const db = speicher.alleBetriebe().find((x) => x.id === b).db;
    speicher.vertragZustimmen(db, (await import('../dienst.mjs')).VERTRAG_FASSUNG, { id: v.mitarbeiter.id, name: 'Hans' });
    const hol = (body) => fetch(`${z}/raum/einstellungen`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${v.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let r = await (await hol()).json();
    assert.equal(r.mailMinuten, 15);
    assert.equal(r.einstellbar, false);
    assert.equal((await hol({ mailMinuten: 0 })).status, 403);
    serverpaketSetzen(db, true);
    r = await (await hol({ mailMinuten: 0 })).json();
    assert.equal(r.mailMinuten, 0);
    assert.equal(r.einstellbar, true);
  } finally {
    zentral.close();
  }
});

test('Freigaben: Tonaufnahme mit Abspieler, falscher Inhalt abgewiesen', async () => {
  const b = speicher.betriebAnlegen('Ton Tom');
  const m = (await rufe('/anmelden', { body: { code: speicher.einladen(b, 'Tom', 'monteur').code } })).daten;
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(16)]).toString('base64');
  const r = await rufe('/freigabe', { token: m.token, body: { titel: 'Sprachnotiz', teile: [{ name: 'notiz.m4a', typ: 'audio/mp4', daten: m4a }] } });
  assert.equal(r.status, 200);
  const seite = await (await fetch(basis + new URL(r.daten.link).pathname)).text();
  assert.ok(seite.includes('<audio controls') && seite.includes('Herunterladen (Aufnahme'));
  assert.equal((await rufe('/freigabe', { token: m.token, body: { titel: 'X', teile: [{ name: 'x.m4a', typ: 'audio/mp4', daten: Buffer.from('kein ton').toString('base64') }] } })).status, 400);
});

test('Terminmitteilung: Mail an den Kunden, Bestätigen und Ablehnen per Link, Push, Änderung, Absage, Erinnerung', async () => {
  const b = speicher.betriebAnlegen('Bad & Heizung Roth');
  const anm = async (name) => (await rufe('/anmelden', { body: { code: speicher.einladen(b, name, 'monteur').code } })).daten;
  const m = await anm('Mia Roth');
  const k = await anm('Kai');
  await rufe('/push/token', { token: k.token, body: { token: 'ExponentPushToken[kaikaikaikaikai]', plattform: 'android' } });
  const termin = { id: 'tm_bad1', titel: 'Badsanierung', start: '2030-03-04T08:00', bis: '2030-03-06', dauerMin: 480, mitarbeiter: [k.mitarbeiter.id] };
  const kunde = { name: 'Familie Weber', email: 'weber@example.org', ort: 'Lindenweg 3, 01099 Dresden' };

  assert.equal((await rufe('/termin/mitteilen', { token: m.token, body: { termin, kunde: { name: 'X' }, art: 'einladung', perMail: true } })).status, 400);
  const vorher = post.length;
  const r = await rufe('/termin/mitteilen', { token: m.token, body: { termin, kunde, art: 'einladung', perMail: true, erinnerung: true } });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  assert.equal(r.daten.status, 'offen');
  assert.equal(post.length, vorher + 1);
  const mail = post.at(-1);
  assert.deepEqual(mail.an, ['weber@example.org']);
  assert.ok(mail.betreff.startsWith('Ihr Termin: Montag, 04.03.2030 bis Mittwoch, 06.03.2030 – Bad & Heizung Roth'), mail.betreff);
  assert.ok(mail.text.includes('jeweils 08:00–16:00 Uhr'));
  assert.ok(mail.text.includes(r.daten.link));

  const pfad = new URL(r.daten.link).pathname;
  let seite = await (await fetch(basis + pfad)).text();
  assert.ok(seite.includes('Termin bestätigen'));
  assert.ok(seite.includes('Lindenweg 3'));
  const ical = await fetch(basis + pfad + '/termin.ics');
  assert.equal(ical.headers.get('content-type'), 'text/calendar; charset=utf-8');
  const icsText = await ical.text();
  assert.ok(icsText.includes('DTSTART;TZID=Europe/Berlin:20300304T080000'));
  assert.ok(icsText.includes('DTEND;TZID=Europe/Berlin:20300304T160000'));
  assert.ok(icsText.includes('RRULE:FREQ=DAILY;COUNT=3'));

  const antworten = async (form) => fetch(basis + pfad, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  const pushVorher = pushes.length;
  const umgeleitet = await fetch(basis + pfad, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'wahl=nein&text=Lieber+ab+dem+11.03.', redirect: 'manual' });
  assert.equal(umgeleitet.status, 303); // Neuladen schickt nichts noch einmal ab
  seite = await (await fetch(basis + pfad)).text();
  assert.ok(seite.includes('nicht passt'));
  assert.ok(seite.includes('>Lieber ab dem 11.03.</textarea>'));
  assert.equal(pushes.length, pushVorher + 1);
  assert.equal(pushes.at(-1).title, 'Termin passt nicht: Familie Weber');
  assert.equal(pushes.at(-1).data.url, '/calendar/tm_bad1');
  await antworten({ wahl: 'nein', text: 'Lieber ab dem 11.03.' }); // Neuladen meldet nicht noch einmal
  assert.equal(pushes.length, pushVorher + 1);
  let liste = (await rufe('/termin/antworten', { token: k.token })).daten;
  assert.equal(liste[0].status, 'abgelehnt');
  assert.equal(liste[0].antwort, 'Lieber ab dem 11.03.');

  // Änderung: derselbe Link, Antwort zurückgesetzt, Kunde bestätigt.
  const neu = { ...termin, start: '2030-03-11T08:00', bis: '2030-03-13' };
  const r2 = await rufe('/termin/mitteilen', { token: m.token, body: { termin: neu, kunde, art: 'aenderung', perMail: true, erinnerung: true } });
  assert.equal(r2.daten.link, r.daten.link);
  assert.ok(post.at(-1).betreff.startsWith('Ihr Termin hat sich geändert: Montag, 11.03.2030'));
  await antworten({ wahl: 'ja' });
  liste = (await rufe('/termin/antworten', { token: m.token })).daten;
  assert.equal(liste[0].status, 'bestaetigt');
  assert.equal(pushes.at(-1).title, 'Termin bestätigt: Familie Weber');

  // Erinnerung: erst ab 24 Stunden vorher, nur einmal.
  const vorErinnerung = post.length;
  server.termineErinnern(Date.parse('2030-03-09T12:00:00Z'));
  assert.equal(post.length, vorErinnerung);
  server.termineErinnern(Date.parse('2030-03-10T08:00:00Z'));
  assert.equal(post.length, vorErinnerung + 1);
  assert.ok(post.at(-1).betreff.startsWith('Erinnerung an Ihren Termin'));
  server.termineErinnern(Date.parse('2030-03-10T09:00:00Z'));
  assert.equal(post.length, vorErinnerung + 1);

  // Absage: Seite ohne Knöpfe, Antworten werden nicht mehr angenommen.
  await rufe('/termin/mitteilen', { token: m.token, body: { termin: neu, kunde, art: 'absage', perMail: true } });
  assert.ok(post.at(-1).betreff.startsWith('Termin abgesagt'));
  seite = await (await fetch(basis + pfad)).text();
  assert.ok(seite.includes('Termin abgesagt'));
  assert.ok(!seite.includes('name="wahl"'));
  assert.equal((await fetch(basis + '/t/tnichtdaxxxxxxxxxxx')).status, 404);
});

test('Adressvorschläge: ohne Anmeldung, Photon-Treffer als Anschrift, Zwischenspeicher', async () => {
  const vorher = geodienst.length;
  const r = await rufe('/adresse?q=' + encodeURIComponent('Hauptstr 1 Dresd'));
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  assert.deepEqual(r.daten.vorschlaege[0], { text: 'Hauptstraße 1, 01097 Dresden (Innere Neustadt)', strasse: 'Hauptstraße 1', plz: '01097', ort: 'Dresden', land: 'DE' });
  assert.equal(r.daten.vorschlaege[1].text, 'Wien, AT');
  assert.equal(r.daten.vorschlaege.length, 2, 'ohne Ort kein Vorschlag');
  assert.ok(geodienst.at(-1).includes('lang=de'));
  await rufe('/adresse?q=' + encodeURIComponent('hauptstr  1 dresd'));
  assert.equal(geodienst.length, vorher + 1, 'zweite Anfrage aus dem Zwischenspeicher');
  assert.deepEqual((await rufe('/adresse?q=ab')).daten, { vorschlaege: [] });
  const um = await rufe('/adresse?lat=51.02673&lon=14.00482');
  assert.equal(um.status, 200);
  assert.ok(geodienst.at(-1).includes('/reverse?lat=51.0267&lon=14.0048'), geodienst.at(-1));
  assert.equal(um.daten.vorschlaege[0].strasse, 'Hauptstraße 1');
  assert.equal((await rufe('/adresse?lat=999&lon=1')).status, 400);
});

test('Postfach: Eingang, Hinweis, Anmeldung, Auftrag, Helfer holt ab und meldet zurück', { skip: !ZENTRAL && 'nur auf dem zentralen Server' }, async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pj } = await import('node:path');
  const { erstelleDienst: dienst } = await import('../dienst.mjs');
  const { oeffneSpeicher } = await import('../speicher.mjs');
  const brief = [];
  const sp = oeffneSpeicher(mkdtempSync(pj(tmpdir(), 'pf-')));
  const srv = dienst(sp, { zeitgeber: false, senden: (an, m) => brief.push({ an: an.map((e) => e.email), ...m }), push: async () => {}, postfachUmgebung: { MONTIX_POSTFACH_CODE: 'geheim-code', MONTIX_POSTFACH_EINGANG: 'ein-token', MONTIX_POSTFACH_HELFER: 'helfer-token' } });
  await new Promise((ok) => srv.listen(0, ok));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${b}/postfach/eingang`, { method: 'POST', body: '{}' })).status, 401);
    const ein = await fetch(`${b}/postfach/eingang`, { method: 'POST', headers: { authorization: 'Bearer ein-token' }, body: JSON.stringify({ uid: '7', von: 'Kunde <k@example.org>', an: 'montix@feif.space', betreff: 'Lizenz?', text: 'Ich möchte Mehrplatz kaufen.' }) });
    assert.deepEqual(await ein.json(), { neu: true, id: 1 });
    const doppelt = await fetch(`${b}/postfach/eingang`, { method: 'POST', headers: { authorization: 'Bearer ein-token' }, body: JSON.stringify({ uid: '7' }) });
    assert.deepEqual(await doppelt.json(), { neu: false });
    assert.equal(brief.length, 1);
    assert.deepEqual(brief[0].an, ['mail@feif.space']);
    assert.ok(brief[0].text.includes('/postfach/mail/1'));

    // Ohne Anmeldung nur die Anmeldeseite, falscher Code abgewiesen.
    assert.ok((await (await fetch(`${b}/postfach`)).text()).includes('Zugangscode'));
    const falsch = await fetch(`${b}/postfach/anmelden`, { method: 'POST', body: 'code=nein', redirect: 'manual' });
    assert.equal(falsch.status, 401);
    const an = await fetch(`${b}/postfach/anmelden`, { method: 'POST', body: 'code=geheim-code', redirect: 'manual' });
    assert.equal(an.status, 303);
    const keks = an.headers.get('set-cookie').split(';')[0];
    const seite = await (await fetch(`${b}/postfach`, { headers: { cookie: keks } })).text();
    assert.ok(seite.includes('Lizenz?') && seite.includes('Lizenz/Kauf'));

    // Helfer holt das Sichten ab und liefert Einschätzung und Entwurf.
    assert.equal((await fetch(`${b}/postfach/abholen`)).status, 401);
    const a1 = await (await fetch(`${b}/postfach/abholen`, { headers: { authorization: 'Bearer helfer-token' } })).json();
    assert.equal(a1.art, 'sichten');
    assert.equal(a1.mail.betreff, 'Lizenz?');
    await fetch(`${b}/postfach/ergebnis/${a1.id}`, { method: 'POST', headers: { authorization: 'Bearer helfer-token' }, body: JSON.stringify({ ok: true, text: 'Lizenzanfrage', einschaetzung: 'Lizenzanfrage Mehrplatz', entwurf: 'Guten Tag, gern …' }) });
    const mailSeite = await (await fetch(`${b}/postfach/mail/1`, { headers: { cookie: keks } })).text();
    assert.ok(mailSeite.includes('Lizenzanfrage Mehrplatz') && mailSeite.includes('Guten Tag, gern'));

    // Ein abgebrochener Abruf darf keinen Auftrag schlucken.
    const ab = new AbortController();
    const tot = fetch(`${b}/postfach/abholen`, { headers: { authorization: 'Bearer helfer-token' }, signal: ab.signal }).catch(() => null);
    await new Promise((ok) => setTimeout(ok, 100));
    ab.abort();
    await tot;
    await new Promise((ok) => setTimeout(ok, 100));
    // Auftrag aus der Verwaltung, Helfer wartet (Long-Poll) und bekommt ihn mit Verlauf.
    const warten = fetch(`${b}/postfach/abholen`, { headers: { authorization: 'Bearer helfer-token' } }).then((r) => r.json());
    await new Promise((ok) => setTimeout(ok, 100));
    assert.equal((await fetch(`${b}/postfach/auftrag`, { method: 'POST', headers: { cookie: keks }, body: 'mail=1&text=Schick+den+Entwurf+ab.', redirect: 'manual' })).status, 303);
    const a2 = await warten;
    assert.equal(a2.text, 'Schick den Entwurf ab.');
    assert.equal(a2.verlauf[0].art, 'sichten');
    await fetch(`${b}/postfach/ergebnis/${a2.id}`, { method: 'POST', headers: { authorization: 'Bearer helfer-token' }, body: JSON.stringify({ ok: true, text: 'Antwort an k@example.org gesendet.' }) });
    assert.ok((await (await fetch(`${b}/postfach/mail/1`, { headers: { cookie: keks } })).text()).includes('Antwort an k@example.org gesendet.'));
    // Auftrag ohne Anmeldung geht nicht.
    assert.equal((await fetch(`${b}/postfach/auftrag`, { method: 'POST', body: 'text=x' })).status, 401);
  } finally {
    srv.close();
  }
});

test('Postfach: der alte Pfad schickt auf die eigene Adresse weiter, der Helferweg nicht', { skip: !ZENTRAL && 'nur auf dem zentralen Server' }, async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pj } = await import('node:path');
  const { erstelleDienst: dienst } = await import('../dienst.mjs');
  const { oeffneSpeicher } = await import('../speicher.mjs');
  const sp = oeffneSpeicher(mkdtempSync(pj(tmpdir(), 'pf-um-')));
  const srv = dienst(sp, {
    zeitgeber: false,
    senden: () => {},
    push: async () => {},
    postfachUmgebung: {
      MONTIX_POSTFACH_CODE: 'geheim-code',
      MONTIX_POSTFACH_EINGANG: 'ein-token',
      MONTIX_POSTFACH_HELFER: 'helfer-token',
      MONTIX_OEFFENTLICH: 'https://montix.feif.space',
    },
  });
  await new Promise((ok) => srv.listen(0, ok));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    // Wer ueber den alten Pfad kommt, bekommt die Seite nicht, sondern den Weg
    // dorthin, wo ihre Formulare auch ankommen. Mit Suchteil, sonst waere ein
    // Link auf eine einzelne Mail nach der Umleitung nur noch der Posteingang.
    const alt = await fetch(`${b}/postfach/mail/1?x=2`, { headers: { 'x-forwarded-host': 'feif.space' }, redirect: 'manual' });
    assert.equal(alt.status, 308);
    assert.equal(alt.headers.get('location'), 'https://montix.feif.space/postfach/mail/1?x=2');

    // Der Helfer holt mit GET ab und soll keiner Umleitung folgen muessen:
    // Sein Token steht im Kopf, und ein Umzug darf ihn nicht stillegen. Ohne
    // Auftrag haelt dieser Weg die Verbindung offen -- genau daran ist zu
    // sehen, dass er nicht umgeleitet wurde: Eine Umleitung kaeme sofort.
    const bremse = AbortSignal.timeout(300);
    const haengt = await fetch(`${b}/postfach/abholen`, { headers: { 'x-forwarded-host': 'feif.space', authorization: 'Bearer helfer-token' }, redirect: 'manual', signal: bremse })
      .then((r) => `Antwort ${r.status}`, (e) => e.name);
    assert.equal(haengt, 'TimeoutError');

    // Und ohne Token bleibt es bei der Abweisung, nicht bei einer Umleitung.
    const ohne = await fetch(`${b}/postfach/abholen`, { headers: { 'x-forwarded-host': 'feif.space' }, redirect: 'manual' });
    assert.equal(ohne.status, 401);

    // Unter der richtigen Adresse die Seite selbst.
    const neu = await fetch(`${b}/postfach`, { headers: { 'x-forwarded-host': 'montix.feif.space' }, redirect: 'manual' });
    assert.equal(neu.status, 200);
    assert.ok((await neu.text()).includes('Zugangscode'));
  } finally {
    srv.close();
  }
});

test('Verwaltung: antworten, Lizenz ausstellen und senden, Testbetrieb anlegen, löschen nur mit Kennung', { skip: !ZENTRAL && 'nur auf dem zentralen Server' }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pj } = await import('node:path');
  const { erstelleDienst: dienst } = await import('../dienst.mjs');
  const { oeffneSpeicher } = await import('../speicher.mjs');
  const ordner = mkdtempSync(pj(tmpdir(), 'vw-'));
  // Wegwerf-Schlüssel statt des echten Lizenzschlüssels.
  const paar = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privat = pj(ordner, 'lizenz.json');
  writeFileSync(privat, JSON.stringify(await crypto.subtle.exportKey('jwk', paar.privateKey)));
  const brief = [];
  const sp = oeffneSpeicher(ordner);
  const srv = dienst(sp, { zeitgeber: false, senden: (an, m) => brief.push({ an: an.map((e) => e.email), ...m }), push: async () => {}, postfachUmgebung: { MONTIX_POSTFACH_CODE: 'geheim-code', MONTIX_POSTFACH_EINGANG: 'ein-token', MONTIX_LIZENZ_PRIVAT: privat } });
  await new Promise((ok) => srv.listen(0, ok));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const form = (pfad, daten) => fetch(`${b}${pfad}`, { method: 'POST', headers: { cookie: keks }, body: new URLSearchParams(daten).toString(), redirect: 'manual' });
  const seite = async (pfad) => (await fetch(`${b}${pfad}`, { headers: { cookie: keks } })).text();
  let keks = '';
  try {
    await fetch(`${b}/postfach/eingang`, { method: 'POST', headers: { authorization: 'Bearer ein-token' }, body: JSON.stringify({ uid: '1', messageId: '<m1@example.org>', von: 'Erika Muster <erika@example.org>', betreff: 'Mehrplatz kaufen', text: 'Wir möchten 3 Plätze.' }) });
    // Ohne Helfer-Token kein Sichten-Auftrag, aber der Hinweis geht hinaus.
    assert.equal(brief.length, 1);
    assert.equal((await fetch(`${b}/postfach/abholen`)).status, 401);
    keks = (await fetch(`${b}/postfach/anmelden`, { method: 'POST', body: 'code=geheim-code', redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    const mail = await seite('/postfach/mail/1');
    assert.ok(mail.includes('Guten Tag Erika Muster,') && mail.includes('value="erika@example.org"') && mail.includes('Re: Mehrplatz kaufen'));
    assert.ok(!mail.includes('Auftrag an Claude'), 'ohne Helfer kein Claude-Feld');

    // Antworten: geht im Faden hinaus, Mail steht danach auf „beantwortet“.
    assert.equal((await form('/postfach/mail/1/antworten', { an: 'erika@example.org', betreff: 'Re: Mehrplatz kaufen', text: 'Guten Tag,\n\ngern.' })).status, 303);
    const antwort = brief.at(-1);
    assert.deepEqual(antwort.an, ['erika@example.org']);
    assert.equal(antwort.bezug, '<m1@example.org>');
    assert.ok((await seite('/postfach/mail/1')).includes('Antwort an erika@example.org gesendet.'));
    assert.ok((await seite('/postfach?alle=1')).includes('beantwortet'));

    // Lizenz: signiert mit dem Schlüssel, Mail an den Kunden, im Verlauf und unter „Lizenzen“.
    assert.equal((await form('/postfach/lizenz', { mail: '1', email: 'erika@example.org', name: 'Frau Muster', stufe: 'mehrplatz', plaetze: '3', senden: '1' })).status, 303);
    const lm = brief.at(-1);
    assert.equal(lm.betreff, 'Ihre Montix-Lizenz Mehrplatz – Ihr Lizenzschlüssel');
    const schluessel = /MX1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(lm.text)[0];
    const [, rumpf, sig] = schluessel.split('.');
    const pub = await crypto.subtle.importKey('jwk', await crypto.subtle.exportKey('jwk', paar.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(sig, 'base64url'), new TextEncoder().encode(rumpf)));
    assert.equal(JSON.parse(Buffer.from(rumpf, 'base64url')).plaetze, 3);
    assert.ok((await seite('/postfach/lizenzen')).includes('erika@example.org'));
    // Ungültig: Betrieb ohne „bis“.
    await form('/postfach/lizenz', { email: 'x@example.org', stufe: 'betrieb' });
    assert.ok((await seite('/postfach/lizenzen')).includes('Nicht ausgestellt: Betrieb und Enterprise brauchen'));

    // Testbetrieb: Betrieb, Verwalter-Einladung, Mail mit Code.
    await form('/postfach/betrieb', { name: 'Elektro Muster', verwalter: 'Erika Muster', email: 'erika@example.org', test: '1' });
    const em = brief.at(-1);
    assert.equal(em.betreff, 'Ihr Montix-Testbetrieb „Elektro Muster“');
    const codeAusMail = /Einladungscode für den ersten Verwalter: ([A-Z0-9-]+)/.exec(em.text)[1];
    const b1 = sp.alleBetriebe().find((x) => x.name === 'Elektro Muster');
    assert.ok(b1);
    assert.ok(sp.anmelden(codeAusMail, 'Testgerät'), 'Code aus der Mail meldet an');
    const liste = await seite('/postfach/betriebe');
    assert.ok(liste.includes('Elektro Muster') && liste.includes('Test bis'));

    // Löschen nur mit eingetippter Kennung.
    await form(`/postfach/betrieb/${b1.id}/loeschen`, { bestaetigung: 'falsch' });
    assert.ok(sp.alleBetriebe().some((x) => x.id === b1.id));
    await form(`/postfach/betrieb/${b1.id}/loeschen`, { bestaetigung: b1.id });
    assert.ok(!sp.alleBetriebe().some((x) => x.id === b1.id));
  } finally {
    srv.close();
  }
});

test('Fehler melden: ohne Anmeldung, mit Bildschirmfoto als Anhang an den Support, Grenzen', async () => {
  const { nachrichtBauen } = await import('../post.mjs');
  const vorher = post.length;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const r = await rufe('/fehler', { body: { text: 'Kalender stürzt ab\nbeim Wechsel auf Jahr', email: 'kunde@example.org', info: { Version: '1.0.0', Gerät: 'P90' }, bilder: [{ name: 'x.png', typ: 'image/png', daten: png }] } });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  const m = post.at(-1);
  assert.equal(post.length, vorher + 1);
  assert.deepEqual(m.an, ['mail@feif.space']);
  assert.equal(m.betreff, 'Montix-Fehler: Kalender stürzt ab');
  assert.equal(m.antwortAn, 'kunde@example.org');
  assert.ok(m.text.includes('Gerät: P90'));
  assert.equal(m.anhaenge[0].name, 'bildschirmfoto-1.png');
  const roh = nachrichtBauen('Montix <montix@feif.space>', { email: 'mail@feif.space' }, m.betreff, m.text, undefined, { anhaenge: m.anhaenge, antwortAn: m.antwortAn });
  assert.ok(roh.includes('Content-Type: multipart/mixed'));
  assert.ok(roh.includes('Reply-To: <kunde@example.org>'));
  assert.ok(roh.includes('filename="bildschirmfoto-1.png"'));
  assert.equal((await rufe('/fehler', { body: { text: '' } })).status, 400);
  assert.equal((await rufe('/fehler', { body: { text: 'Test', bilder: [{ typ: 'application/pdf', daten: png }] } })).status, 400);
});

test('Testbetrieb aus der App: Betrieb und Verwalter sofort, Stand in /ich, Grenze je Adresse', { skip: !ZENTRAL && 'nur auf dem zentralen Server' }, async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pj } = await import('node:path');
  const { erstelleDienst: dienst } = await import('../dienst.mjs');
  const { oeffneSpeicher } = await import('../speicher.mjs');
  const brief = [];
  const sp = oeffneSpeicher(mkdtempSync(pj(tmpdir(), 'tb-')));
  const srv = dienst(sp, { zeitgeber: false, vertragPflicht: true, senden: (an, m) => brief.push({ an: an.map((e) => e.email), ...m }), push: async () => {}, postfachUmgebung: {} });
  await new Promise((ok) => srv.listen(0, ok));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const post = (body) => fetch(`${b}/testbetrieb`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ betrieb: '', name: 'X' })).status, 400);
    const r = await post({ betrieb: 'Elektro Muster', name: 'Erika Muster', email: 'erika@example.org', geraet: 'P90' });
    assert.equal(r.status, 200);
    const k = await r.json();
    assert.ok(k.token);
    assert.equal(k.mitarbeiter.rolle, 'verwalter');
    assert.equal(k.betrieb.name, 'Elektro Muster');
    assert.match(k.test.bis, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(brief.some((m) => m.betreff === 'Neuer Testbetrieb: Elektro Muster'));
    const ich = await (await fetch(`${b}/ich`, { headers: { authorization: `Bearer ${k.token}` } })).json();
    assert.deepEqual(ich.stand, { art: 'test', bis: k.test.bis });
    // Höchstens drei je Adresse und Tag.
    await post({ betrieb: 'Zwei', name: 'A' });
    await post({ betrieb: 'Drei', name: 'A' });
    assert.equal((await post({ betrieb: 'Vier', name: 'A' })).status, 429);
  } finally {
    srv.close();
  }
});
