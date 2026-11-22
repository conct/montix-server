// Barkasse mit TSE (kasse.mjs) über den Dienst: Kassen je Gerät, Nummernkreis KB je Kasse, Recht
// zum Kassieren, Storno, Kassenabschluss je Kasse, Freischaltung/Buchung und TSE-Ausfall.
// Statt fiskaly ein Fänger, der Transaktionen nachspielt.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { after, before, test } from 'node:test';

import { erstelleDienst, VERTRAG_FASSUNG } from '../dienst.mjs';
import { berlinJahr, darfKassieren, darfStornieren, kasseFreigabe, RECHT_KASSE, RECHT_STORNO, steuerJeSatz, tagesbeginn } from '../kasse.mjs';
import { modulSetzen } from '../module.mjs';
import { hash, oeffneSpeicher } from '../speicher.mjs';

const TSS = '00000000-0000-4000-8000-0000000000aa';
const CLIENT1 = '00000000-0000-4000-8000-0000000000c1';
const CLIENT2 = '00000000-0000-4000-8000-0000000000c2';
const J = berlinJahr();

/** Nachgespielte fiskaly-Middleware: zählt Signaturen je Client, kann ausfallen. */
function falscheTse() {
  const f = { aus: false, zaehler: 0, aufrufe: [] };
  f.anfrage = async (adresse, o = {}) => {
    f.aufrufe.push({ adresse, ...o });
    if (f.aus) throw new Error('TSE antwortet nicht');
    if (adresse.endsWith('/auth')) return { access_token: 'tok', access_token_expires_in: 600 };
    if (adresse.includes('tx_revision=1')) return { state: 'ACTIVE' };
    if (adresse.includes('tx_revision=2')) {
      f.zaehler += 1;
      return {
        number: f.zaehler,
        time_start: 1792273500 + f.zaehler,
        time_end: 1792273501 + f.zaehler,
        tss_serial_number: 'seriennummer-der-tse',
        qr_code_data: `V0;${o.rumpf.client_id};Kassenbeleg-V1;${Buffer.from(o.rumpf.schema.raw.process_data, 'base64').toString()};${f.zaehler}`,
        signature: { value: `signatur-${f.zaehler}`, algorithm: 'ecdsa-plain-SHA384', counter: 100 + f.zaehler, public_key: 'PUB' },
      };
    }
    throw new Error(`unerwartet: ${adresse}`);
  };
  return f;
}

let speicher;
const tse = falscheTse();
let eigen; // eigener Server eines Betriebs (ohne Buchung)
let zentral; // zentraler Server (Vertragspflicht, Buchung je Kasse)
let ebasis;
let zbasis;

before(async () => {
  speicher = oeffneSpeicher(':memory:');
  const opt = { zeitgeber: false, senden: () => {}, push: async () => {}, postfachUmgebung: {}, tseAnfrage: tse.anfrage, tseUmgebung: {} };
  eigen = erstelleDienst(speicher, opt);
  zentral = erstelleDienst(speicher, { ...opt, vertragPflicht: true, tseUmgebung: { TSE_ANBIETER: 'fiskaly', TSE_API_KEY: 'k', TSE_API_SECRET: 's', TSE_TSS_ID: TSS } });
  await new Promise((r) => eigen.listen(0, '127.0.0.1', r));
  await new Promise((r) => zentral.listen(0, '127.0.0.1', r));
  ebasis = `http://127.0.0.1:${eigen.address().port}`;
  zbasis = `http://127.0.0.1:${zentral.address().port}`;
});
after(() => {
  eigen.close();
  zentral.close();
});

async function rufe(basis, pfad, token, body) {
  const r = await fetch(basis + pfad, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Der DSFinV-K-Export kommt als ZIP, alles andere als JSON.
  if (!(r.headers.get('content-type') ?? '').includes('json')) return { status: r.status, daten: null, text: '' };
  const text = await r.text();
  return { status: r.status, daten: JSON.parse(text), text };
}

const kurz = (token) => hash(token).slice(0, 12);

/** Neuer Betrieb mit Verwalter (v) und zwei Monteuren (m, m2); Tokens, Datenbank, Kennungen. */
function betrieb(name) {
  const id = speicher.betriebAnlegen(name);
  const v = speicher.anmelden(speicher.einladen(id, `${name} Chefin`, 'verwalter').code, 'Handy V');
  const m = speicher.anmelden(speicher.einladen(id, `${name} Monteur`, 'mitarbeiter').code, 'Handy M');
  const m2 = speicher.anmelden(speicher.einladen(id, `${name} Zweiter`, 'mitarbeiter').code, 'Handy M2');
  const db = speicher.alleBetriebe().find((b) => b.id === id).db;
  return { id, v: v.token, m: m.token, m2: m2.token, m2id: m2.mitarbeiter.id, db, vid: v.mitarbeiter.id };
}

/** TSS-Zugang eintragen und dem Gerät des Monteurs die Kasse K1 zuweisen. */
async function mitKasse(basis, b, { client = CLIENT1, tss = true } = {}) {
  if (tss) assert.equal((await rufe(basis, '/kasse/tse', b.v, { apiKey: 'k', apiSecret: 's', tssId: TSS })).status, 200);
  const r = await rufe(basis, '/kasse/kassen', b.v, { id: 'K1', name: 'Kasse Transporter', clientId: client, geraet: kurz(b.m) });
  assert.equal(r.status, 200, r.text);
  return r.daten;
}

const kaffee = (n = 1) => ({ text: 'Kaffee', menge: n, preisCent: 250, satz: 19 });
const buch = { text: 'Buch', menge: 1, preisCent: 1070, satz: 7 };

test('Steuer je Satz, Tagesgrenzen nach deutscher Zeit, Recht zum Kassieren', () => {
  assert.deepEqual(steuerJeSatz([{ satz: 19, betragCent: 119 }, { satz: 7, betragCent: 107 }, { satz: 19, betragCent: 119 }]), [
    { satz: 19, bruttoCent: 238, nettoCent: 200, ustCent: 38 },
    { satz: 7, bruttoCent: 107, nettoCent: 100, ustCent: 7 },
  ]);
  assert.equal(tagesbeginn('2026-11-17'), '2026-11-16T23:00:00.000Z');
  assert.equal(tagesbeginn('2026-07-01'), '2026-06-30T22:00:00.000Z');
  const monteur = { rolle: 'mitarbeiter', bereiche: null };
  assert.equal(darfKassieren('alle', monteur), true);
  assert.equal(darfKassieren('ausgewaehlte', monteur), false);
  assert.equal(darfKassieren('ausgewaehlte', { rolle: 'mitarbeiter', bereiche: JSON.stringify(['report', RECHT_KASSE]) }), true);
  assert.equal(darfKassieren('ausgewaehlte', { rolle: 'verwalter', bereiche: null }), true);
  assert.equal(darfKassieren('niemand', { rolle: 'verwalter', bereiche: null }), false);
  assert.equal(darfStornieren('alle', { rolle: 'verwalter', bereiche: null }), true);
  assert.equal(darfStornieren('alle', monteur), false);
  assert.equal(darfStornieren('alle', { rolle: 'mitarbeiter', bereiche: JSON.stringify([RECHT_STORNO]) }), true);
  assert.equal(darfStornieren('niemand', { rolle: 'mitarbeiter', bereiche: JSON.stringify([RECHT_STORNO]) }), true, 'Stornieren hängt nur am eigenen Recht');
});

test('TSE-Zugang: nur Verwalter, Secret kommt nie zurück; Probelauf bucht nichts', async () => {
  const b = betrieb('Einrichtung');
  assert.equal((await rufe(ebasis, '/kasse/tse', b.m, { apiKey: 'k', apiSecret: 's', tssId: TSS })).status, 403);
  assert.equal((await rufe(ebasis, '/kasse/tse', b.v, { apiKey: 'k', apiSecret: 's', tssId: 'keine-uuid' })).status, 400);
  const r = await rufe(ebasis, '/kasse/tse', b.v, { apiKey: 'test_key', apiSecret: 'GANZ-GEHEIM', tssId: TSS });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.daten.zugang, true);
  assert.equal(r.daten.secretGesetzt, true);
  assert.ok(!r.text.includes('GANZ-GEHEIM'));
  assert.equal((await rufe(ebasis, '/kasse/tse', b.v, { apiKey: 'test_key2', tssId: TSS })).status, 200, 'ohne neues Secret bleibt das alte');
  const g = await rufe(ebasis, '/kasse/tse', b.v);
  assert.equal(g.daten.apiKey, 'test_key2');
  assert.ok(!g.text.includes('GANZ-GEHEIM'));
  assert.deepEqual((await rufe(ebasis, '/kasse/tse', b.m)).daten, { zugang: true, quelle: 'betrieb' });
  assert.ok(!JSON.stringify(b.db.prepare('select * from kasse_tse').all()).includes('GANZ-GEHEIM'));
  assert.equal((await rufe(ebasis, '/kasse/tse/probe', b.v, {})).status, 409, 'ohne Kasse kein Client');
  await mitKasse(ebasis, b, { tss: false });
  const p = await rufe(ebasis, '/kasse/tse/probe', b.v, { kasse: 'K1' });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.daten.ok, true);
  assert.equal(p.daten.vorgangsdaten, 'Beleg^1.00_0.00_0.00_0.00_0.00^1.00:Bar');
  assert.equal((await rufe(ebasis, '/kasse/belege', b.v)).daten.length, 0);
  assert.equal((await rufe(ebasis, '/kasse/tse/probe', b.m, {})).status, 403);
});

test('Kassen je Gerät: nur zugewiesene Geräte kassieren, eigener Client je Kasse', async () => {
  const b = betrieb('Kassen');
  assert.equal((await rufe(ebasis, '/kasse/kassen', b.m, { name: 'X', clientId: CLIENT1, geraet: kurz(b.m) })).status, 403, 'nur Verwalter');
  assert.equal((await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' })).status, 403, 'Gerät ohne Kasse');
  const st0 = (await rufe(ebasis, '/kasse/status', b.m)).daten;
  assert.equal(st0.verfuegbar, true);
  assert.equal(st0.kasse, null);
  assert.equal(st0.benutzbar, false);
  await mitKasse(ebasis, b);
  const st = (await rufe(ebasis, '/kasse/status', b.m)).daten;
  assert.deepEqual(st.kasse, { id: 'K1', name: 'Kasse Transporter' });
  assert.equal(st.benutzbar, true);
  assert.equal(st.tse.eingerichtet, true);
  assert.deepEqual((await rufe(ebasis, '/ich', b.m)).daten.module.kasse.kasse, { id: 'K1', name: 'Kasse Transporter' });
  assert.equal((await rufe(ebasis, '/ich', b.m2)).daten.module.kasse.benutzbar, false, 'anderes Gerät ist keine Kasse');
  // Dasselbe Gerät und derselbe Client gehen nicht an eine zweite Kasse.
  assert.equal((await rufe(ebasis, '/kasse/kassen', b.v, { name: 'Zweite', clientId: CLIENT2, geraet: kurz(b.m) })).status, 409);
  assert.equal((await rufe(ebasis, '/kasse/kassen', b.v, { name: 'Zweite', clientId: CLIENT1, geraet: kurz(b.m2) })).status, 409);
  assert.equal((await rufe(ebasis, '/kasse/kassen', b.v, { name: 'Zweite', clientId: CLIENT2, geraet: 'aaaaaaaaaaaa' })).status, 400);
  const zwei = await rufe(ebasis, '/kasse/kassen', b.v, { name: 'Kasse Laden', clientId: CLIENT2, geraet: 'dieses' });
  assert.equal(zwei.status, 200, zwei.text);
  const k2 = zwei.daten.kassen.find((k) => k.name === 'Kasse Laden');
  assert.equal(k2.id, 'K2');
  assert.equal(k2.geraet.name, 'Handy V');
  // Je Kasse ein eigener Client bei fiskaly.
  await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' });
  const v = await rufe(ebasis, '/kasse/beleg', b.v, { positionen: [kaffee()], zahlart: 'bar' });
  assert.equal(v.daten.kasse.id, 'K2');
  assert.equal(v.daten.tse.client, CLIENT2);
  assert.ok(v.daten.tse.qr_code_data.includes(CLIENT2));
  // Auflösen: Gerät ist keine Kasse mehr, die Belege bleiben, die ID kommt nicht wieder.
  const auf = await rufe(ebasis, '/kasse/kassen/aufloesen', b.v, { id: 'K2' });
  assert.ok(auf.daten.kassen.find((k) => k.id === 'K2').aufgeloest);
  assert.equal((await rufe(ebasis, '/kasse/beleg', b.v, { positionen: [kaffee()], zahlart: 'bar' })).status, 403);
  assert.equal((await rufe(ebasis, '/kasse/kassen', b.v, { id: 'K2', name: 'Neu', clientId: CLIENT2, geraet: 'dieses' })).status, 409);
  assert.equal((await rufe(ebasis, '/kasse/belege?kasse=K2', b.v)).daten.length, 1);
});

test('Recht zum Kassieren: alle, ausgewählte Personen oder niemand', async () => {
  const b = betrieb('Recht');
  await mitKasse(ebasis, b);
  assert.equal((await rufe(ebasis, '/kasse/recht', b.m, { wer: 'niemand' })).status, 403);
  assert.equal((await rufe(ebasis, '/kasse/recht', b.v, { wer: 'manche' })).status, 400);
  assert.equal((await rufe(ebasis, '/kasse/recht', b.v)).daten.wer, 'alle');
  assert.equal((await rufe(ebasis, '/kasse/recht', b.v, { wer: 'ausgewaehlte' })).daten.wer, 'ausgewaehlte');
  const nein = await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' });
  assert.equal(nein.status, 403);
  assert.match(nein.daten.fehler, /nicht benutzen/);
  assert.equal((await rufe(ebasis, '/kasse/status', b.m)).daten.benutzbar, false);
  // Das Recht steht in der Freigabeliste der Person (wie das Bildschirmfoto-Recht).
  const mid = speicher.pruefe(b.m).mitarbeiter.id;
  assert.equal((await rufe(ebasis, '/mitarbeiter/rechte', b.v, { id: mid, bereiche: ['kasse', RECHT_KASSE] })).status, 200);
  assert.equal((await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' })).status, 200);
  assert.equal((await rufe(ebasis, '/kasse/status', b.m)).daten.benutzbar, true);
  await rufe(ebasis, '/kasse/recht', b.v, { wer: 'niemand' });
  assert.equal((await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' })).status, 403);
});

test('Nummernkreis je Kasse: lückenlos, idempotent, nur über /kasse/beleg; Belege unveränderlich', async () => {
  const b = betrieb('Nummern');
  await mitKasse(ebasis, b);
  await rufe(ebasis, '/kasse/kassen', b.v, { id: 'LADEN', name: 'Laden', clientId: CLIENT2, geraet: 'dieses' });
  const r1 = await rufe(ebasis, '/kasse/beleg', b.m, { id: 'geraet-beleg-0001', positionen: [kaffee(2), buch], zahlart: 'bar', gegebenCent: 2000 });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.daten.nummer, `KB-K1-${J}-0001`);
  assert.equal(r1.daten.kasse.id, 'K1');
  assert.equal(r1.daten.summeCent, 1570);
  assert.equal(r1.daten.rueckgeldCent, 430);
  assert.equal(r1.daten.tse.status, 'signiert');
  assert.equal(r1.daten.tse.vorgangsdaten, 'Beleg^5.00_10.70_0.00_0.00_0.00^15.70:Bar');
  assert.ok(r1.daten.tse.qr_code_data.startsWith('V0;'));
  assert.ok(r1.daten.tse.seriennummer && r1.daten.tse.signaturzaehler && r1.daten.tse.transaktionsnummer && r1.daten.tse.pruefwert);
  assert.deepEqual(r1.daten.steuer.map((s) => [s.satz, s.bruttoCent, s.ustCent]), [[19, 500, 80], [7, 1070, 70]]);
  // Gleiche Kennung (Gerät hat nach Abbruch neu gesendet) → derselbe Beleg, keine neue Nummer.
  assert.equal((await rufe(ebasis, '/kasse/beleg', b.m, { id: 'geraet-beleg-0001', positionen: [kaffee(2), buch], zahlart: 'bar' })).daten.nummer, `KB-K1-${J}-0001`);
  // Ungültige Eingaben verbrauchen keine Nummer.
  assert.equal((await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [{ ...kaffee(), satz: 16 }], zahlart: 'bar' })).status, 400);
  assert.equal((await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'scheck' })).status, 400);
  assert.equal((await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [{ ...kaffee(), preisCent: -250 }], zahlart: 'bar' })).status, 400);
  assert.equal((await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [], zahlart: 'bar' })).status, 400);
  assert.equal((await rufe(ebasis, '/nummer', b.m, { beleg: 'x', art: 'kassenbeleg:K1', jahr: J })).status, 400, 'nicht über /nummer');
  const laden = await rufe(ebasis, '/kasse/beleg', b.v, { positionen: [kaffee()], zahlart: 'unbar' });
  assert.equal(laden.daten.nummer, `KB-LADEN-${J}-0001`, 'eigener Kreis je Kasse');
  assert.equal(laden.daten.tse.vorgangsdaten, 'Beleg^2.50_0.00_0.00_0.00_0.00^2.50:Unbar');
  const r2 = await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' });
  assert.equal(r2.daten.nummer, `KB-K1-${J}-0002`);
  assert.equal((await rufe(ebasis, '/nummer', b.m, { beleg: 're1', art: 'rechnung', jahr: J })).daten.nummer, `RE-${J}-0001`);
  assert.deepEqual((await rufe(ebasis, '/kasse/belege', b.m)).daten.map((x) => x.nummer), [`KB-K1-${J}-0002`, `KB-K1-${J}-0001`], 'Monteur sieht seine Kasse');
  assert.equal((await rufe(ebasis, '/kasse/belege?kasse=LADEN', b.m)).status, 403);
  assert.equal((await rufe(ebasis, '/kasse/belege?kasse=K1', b.v)).daten.length, 2);
  assert.throws(() => b.db.prepare('update kasse_belege set summe_cent = 1 where nummer = ?').run(`KB-K1-${J}-0001`), /unveränderlich/);
  assert.throws(() => b.db.prepare("update kasse_belege set tse_status = 'keine' where nummer = ?").run(`KB-K1-${J}-0001`), /unveränderlich/);
  assert.throws(() => b.db.prepare('delete from kasse_belege').run(), /nicht gelöscht/);
});

test('TSE-Ausfall: Beleg wird trotzdem gebucht, Status ausfall mit Grund; ohne Zugang Status keine', async () => {
  const b = betrieb('Ausfall');
  await mitKasse(ebasis, b);
  tse.aus = true;
  try {
    const r = await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.daten.nummer, `KB-K1-${J}-0001`);
    assert.equal(r.daten.tse.status, 'ausfall');
    assert.match(r.daten.tse.fehler, /antwortet nicht/);
    assert.equal(r.daten.tse.pruefwert, null);
  } finally {
    tse.aus = false;
  }
  const r2 = await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' });
  assert.equal(r2.daten.nummer, `KB-K1-${J}-0002`);
  assert.equal(r2.daten.tse.status, 'signiert');

  const o = betrieb('Ohne TSE');
  await mitKasse(ebasis, o, { tss: false });
  const st = (await rufe(ebasis, '/kasse/status', o.m)).daten;
  assert.equal(st.tse.eingerichtet, false);
  const k = await rufe(ebasis, '/kasse/beleg', o.m, { positionen: [kaffee()], zahlart: 'bar' });
  assert.equal(k.daten.tse.status, 'keine');
  assert.equal(k.daten.tse.qr_code_data, null);
});

test('Storno mit Pflicht-Grund: Verwalter überall, sonst nur mit Recht „Barkasse stornieren“ an der eigenen Kasse; Gegenbuchung, nur einmal', async () => {
  const b = betrieb('Storno');
  await mitKasse(ebasis, b);
  const o = await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee(2), buch], zahlart: 'unbar' });
  assert.equal((await rufe(ebasis, '/kasse/storno', b.v, { nummer: o.daten.nummer })).status, 400, 'ohne Grund kein Storno');
  assert.equal((await rufe(ebasis, '/kasse/storno', b.v, { nummer: o.daten.nummer, grund: 'x' })).status, 400, 'Grund zu kurz');
  // Der Verwalter storniert von seinem Gerät aus (das selbst keine Kasse ist).
  const s = await rufe(ebasis, '/kasse/storno', b.v, { nummer: o.daten.nummer, grund: 'Falsch getippt' });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.daten.nummer, `KB-K1-${J}-0002`);
  assert.equal(s.daten.kasse.id, 'K1');
  assert.equal(s.daten.art, 'storno');
  assert.equal(s.daten.stornoVon, o.daten.nummer);
  assert.equal(s.daten.summeCent, -1570);
  assert.equal(s.daten.zahlart, 'unbar');
  assert.equal(s.daten.tse.status, 'signiert');
  assert.equal(s.daten.tse.client, CLIENT1);
  assert.equal(s.daten.tse.vorgangsdaten, 'Beleg^-5.00_-10.70_0.00_0.00_0.00^-15.70:Unbar');
  assert.deepEqual(s.daten.positionen.map((p) => p.menge), [-2, -1]);
  assert.equal((await rufe(ebasis, '/kasse/storno', b.v, { nummer: o.daten.nummer, grund: 'Nochmal' })).status, 409);
  assert.equal((await rufe(ebasis, '/kasse/storno', b.v, { nummer: s.daten.nummer, grund: 'Storno vom Storno' })).status, 400);
  assert.equal((await rufe(ebasis, '/kasse/storno', b.v, { nummer: 'KB-K1-1999-0001', grund: 'Gibt es nicht' })).status, 404);
  // Kassierende ohne eigenes Recht stornieren nicht — auch nicht an ihrer Kasse.
  const o2 = await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' });
  const ohne = await rufe(ebasis, '/kasse/storno', b.m, { nummer: o2.daten.nummer, grund: 'Kunde wollte doch nicht' });
  assert.equal(ohne.status, 403);
  assert.match(ohne.daten.fehler, /Barkasse stornieren/);
  assert.equal((await rufe(ebasis, '/kasse/status', b.m)).daten.stornieren, false);
  // Mit dem Recht „Barkasse stornieren“ an der eigenen Kasse.
  const mid = speicher.pruefe(b.m).mitarbeiter.id;
  assert.equal((await rufe(ebasis, '/mitarbeiter/rechte', b.v, { id: mid, bereiche: ['kasse', RECHT_STORNO] })).status, 200);
  assert.equal((await rufe(ebasis, '/kasse/status', b.m)).daten.stornieren, true);
  assert.equal((await rufe(ebasis, '/kasse/storno', b.m, { nummer: o2.daten.nummer, grund: 'Kunde wollte doch nicht' })).status, 200, 'Monteur mit Recht storniert an seiner Kasse');
  // Dasselbe Recht an einem Gerät, das nicht die Kasse des Belegs ist: nein.
  const o3 = await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' });
  assert.equal((await rufe(ebasis, '/mitarbeiter/rechte', b.v, { id: b.m2id, bereiche: ['kasse', RECHT_STORNO] })).status, 200);
  assert.equal((await rufe(ebasis, '/kasse/storno', b.m2, { nummer: o3.daten.nummer, grund: 'Fremde Kasse' })).status, 403);
  assert.equal((await rufe(ebasis, '/kasse/status', b.v)).daten.stornieren, true, 'Verwalter überall');
  assert.equal((await rufe(ebasis, '/kasse/belege', b.m)).daten.find((x) => x.nummer === o.daten.nummer).storniertDurch, s.daten.nummer);
});

test('Kassenabschluss je Kasse: nur Verwalter (mit Kassenwahl), Z-Nummer lückenlos, nahtlos, Summen je Satz und Zahlart', async () => {
  const b = betrieb('Abschluss');
  await mitKasse(ebasis, b);
  await rufe(ebasis, '/kasse/kassen', b.v, { id: 'K2', name: 'Laden', clientId: CLIENT2, geraet: 'dieses' });
  await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee(2)], zahlart: 'bar' });
  const zwei = await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [buch], zahlart: 'unbar' });
  await rufe(ebasis, '/kasse/storno', b.v, { nummer: zwei.daten.nummer, grund: 'Falsch gebucht' });
  await rufe(ebasis, '/kasse/beleg', b.v, { positionen: [buch], zahlart: 'bar' }); // an K2
  assert.equal((await rufe(ebasis, '/kasse/abschluss', b.m, { kasse: 'K2' })).status, 403, 'Monteur schließt nicht ab');
  assert.equal((await rufe(ebasis, '/kasse/abschluss', b.m, {})).status, 403, 'auch nicht an seiner eigenen Kasse');
  const z1 = await rufe(ebasis, '/kasse/abschluss', b.v, { kasse: 'K1' });
  assert.equal(z1.status, 200, z1.text);
  assert.equal(z1.daten.kasse, 'K1');
  assert.equal(z1.daten.zNummer, 1);
  assert.equal(z1.daten.von, null);
  const s1 = z1.daten.summen;
  assert.equal(s1.anzahl, 3, 'nur Belege dieser Kasse');
  assert.equal(s1.belege, 2);
  assert.equal(s1.stornos, 1);
  assert.equal(s1.umsatzCent, 500);
  assert.equal(s1.stornoCent, -1070);
  assert.deepEqual(s1.jeZahlart, { bar: 500, unbar: 0 });
  assert.deepEqual(s1.jeSatz, [
    { satz: 19, bruttoCent: 500, nettoCent: 420, ustCent: 80 },
    { satz: 7, bruttoCent: 0, nettoCent: 0, ustCent: 0 },
  ]);
  assert.equal(s1.tse.signiert, 3);
  assert.equal(s1.ersterBeleg, `KB-K1-${J}-0001`);
  assert.equal(s1.letzterBeleg, `KB-K1-${J}-0003`);
  // Eigene Z-Nummern je Kasse.
  const zk2 = await rufe(ebasis, '/kasse/abschluss', b.v, {});
  assert.equal(zk2.daten.kasse, 'K2');
  assert.equal(zk2.daten.zNummer, 1);
  assert.equal(zk2.daten.summen.anzahl, 1);

  const vier = await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'unbar' });
  const z2 = await rufe(ebasis, '/kasse/abschluss', b.v, { kasse: 'K1' });
  assert.equal(z2.daten.zNummer, 2);
  assert.equal(z2.daten.von, z1.daten.bis, 'schließt nahtlos an');
  assert.equal(z2.daten.summen.anzahl, 1);
  assert.equal(z2.daten.summen.ersterBeleg, vier.daten.nummer);
  assert.deepEqual(z2.daten.summen.jeZahlart, { bar: 0, unbar: 250 });
  const z3 = await rufe(ebasis, '/kasse/abschluss', b.v, { kasse: 'K1' });
  assert.equal(z3.daten.zNummer, 3);
  assert.equal(z3.daten.summen.anzahl, 0);
  assert.deepEqual((await rufe(ebasis, '/kasse/abschluesse', b.m)).daten.map((a) => a.zNummer), [3, 2, 1]);
  assert.throws(() => b.db.prepare('delete from kasse_abschluesse').run(), /nicht gelöscht/);
  assert.throws(() => b.db.prepare("update kasse_abschluesse set summen = '{}'").run(), /unveränderlich/);
});

test('Freischaltung: zentral nur mit gebuchten Kassen (Anzahl), eigener Server ohne Buchung, auch für Einzel Plus, nie für Privatkonten', async () => {
  assert.deepEqual(kasseFreigabe({ zentral: false, art: 'betrieb', gebucht: 0 }), { verfuegbar: true, gebucht: null });
  assert.deepEqual(kasseFreigabe({ zentral: true, art: 'betrieb', gebucht: 2 }), { verfuegbar: true, gebucht: 2 });
  assert.equal(kasseFreigabe({ zentral: true, art: 'betrieb', gebucht: 1, stand: { art: 'test', bis: '2099-01-01' } }).verfuegbar, true);
  assert.equal(kasseFreigabe({ zentral: true, art: 'betrieb', gebucht: 1, stand: { art: 'abo', aktiv: true, plaetze: 5 } }).verfuegbar, true);
  // Einzel Plus (ein Platz) bekommt die Barkasse wie jeder Betrieb – gebucht je Kasse.
  assert.equal(kasseFreigabe({ zentral: true, art: 'betrieb', gebucht: 1, stand: { art: 'abo', aktiv: true, plaetze: 1 } }).verfuegbar, true);
  assert.equal(kasseFreigabe({ zentral: true, art: 'betrieb', gebucht: 0, stand: { art: 'abo', aktiv: true, plaetze: 1 } }).verfuegbar, false);
  assert.equal(kasseFreigabe({ zentral: false, art: 'privat', gebucht: 1 }).verfuegbar, false);

  const b = betrieb('Zentral');
  speicher.vertragZustimmen(b.db, VERTRAG_FASSUNG, { id: b.vid, name: 'Chefin' });
  const ohne = await rufe(zbasis, '/kasse/kassen', b.v, { name: 'K', clientId: CLIENT1, geraet: kurz(b.m) });
  assert.equal(ohne.status, 403);
  assert.match(ohne.daten.fehler, /nicht gebucht/);
  assert.equal((await rufe(zbasis, '/kasse/status', b.m)).daten.verfuegbar, false);
  assert.equal((await rufe(zbasis, '/ich', b.m)).daten.module.kasse.verfuegbar, false);
  modulSetzen(b.db, 'kasse', 1);
  const k1 = await rufe(zbasis, '/kasse/kassen', b.v, { name: 'Transporter', clientId: CLIENT1, geraet: kurz(b.m) });
  assert.equal(k1.status, 200, k1.text);
  assert.equal(k1.daten.gebucht, 1);
  const k2 = await rufe(zbasis, '/kasse/kassen', b.v, { name: 'Laden', clientId: CLIENT2, geraet: kurz(b.m2) });
  assert.equal(k2.status, 403, 'mehr Kassen als gebucht');
  assert.match(k2.daten.fehler, /nachbuchen/);
  // Ändern einer vorhandenen Kasse (neues Handy) zählt nicht als weitere.
  assert.equal((await rufe(zbasis, '/kasse/kassen', b.v, { id: 'K1', name: 'Transporter', clientId: CLIENT1, geraet: kurz(b.m2) })).status, 200);
  modulSetzen(b.db, 'kasse', 2);
  assert.equal((await rufe(zbasis, '/kasse/kassen', b.v, { name: 'Laden', clientId: CLIENT2, geraet: kurz(b.m) })).status, 200);
  const ich = (await rufe(zbasis, '/ich', b.m)).daten.module.kasse;
  assert.equal(ich.verfuegbar, true);
  assert.equal(ich.benutzbar, true);
  // Auf dem zentralen Server gilt die Umgebung (TSE_*) NICHT als Vorgabe — jeder Betrieb hat seine eigene TSS.
  assert.equal(ich.tse.zugang, false);
  const mit = await rufe(zbasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' });
  assert.equal(mit.status, 200, mit.text);
  assert.equal(mit.daten.tse.status, 'keine');
  modulSetzen(b.db, 'kasse', 0);
  assert.equal((await rufe(zbasis, '/kasse/belege', b.m)).status, 403);
  // Derselbe Betrieb auf einem eigenen Server: ohne Buchung frei.
  assert.equal((await rufe(ebasis, '/kasse/belege', b.m)).status, 200);
  // Privatkonto (nur Alleinarbeit): nie.
  const p = speicher.privatAnlegen('Privat Paul', 'Handy');
  assert.equal((await rufe(ebasis, '/kasse/beleg', p.token, { positionen: [kaffee()], zahlart: 'bar' })).status, 403);
  assert.equal((await rufe(ebasis, '/ich', p.token)).daten.module.kasse.verfuegbar, false);
});

test('Eigener Server: Zugang zur TSS aus der Umgebung als Vorgabe, Client von der Kasse', async () => {
  const s = erstelleDienst(speicher, {
    zeitgeber: false,
    senden: () => {},
    push: async () => {},
    postfachUmgebung: {},
    tseAnfrage: tse.anfrage,
    tseUmgebung: { TSE_ANBIETER: 'fiskaly', TSE_API_KEY: 'k', TSE_API_SECRET: 's', TSE_TSS_ID: TSS },
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const basis = `http://127.0.0.1:${s.address().port}`;
    const b = betrieb('Umgebung');
    await mitKasse(basis, b, { tss: false });
    assert.deepEqual((await rufe(basis, '/kasse/status', b.m)).daten.tse, { eingerichtet: true, zugang: true, quelle: 'umgebung' });
    const r = await rufe(basis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' });
    assert.equal(r.daten.tse.status, 'signiert');
    assert.equal(r.daten.tse.client, CLIENT1);
  } finally {
    s.close();
  }
});

test('Kassenrechte je Person: Bürohilfe mit Abschluss und Export, Einrichten getrennt, Rechte vergeben nur Verwalter', async () => {
  const b = betrieb('Rechte5');
  await mitKasse(ebasis, b);
  const beleg = await rufe(ebasis, '/kasse/beleg', b.m, { positionen: [kaffee()], zahlart: 'bar' });
  assert.equal(beleg.status, 200);
  const heute = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
  const hilfe = b.m2; // Gerät ohne Kasse
  const setze = async (bereiche) => assert.equal((await rufe(ebasis, '/mitarbeiter/rechte', b.v, { id: b.m2id, bereiche })).status, 200);
  const ohne = (await rufe(ebasis, '/kasse/status', hilfe)).daten.rechte;
  assert.deepEqual(ohne, { kassieren: true, stornieren: false, abschluss: false, export: false, einrichten: false }, 'Vorgabe: kassieren (Betrieb „alle“), sonst nichts');
  // Ohne Rechte: nichts davon.
  assert.equal((await rufe(ebasis, '/kasse/abschluss', hilfe, { kasse: 'K1' })).status, 403);
  assert.equal((await rufe(ebasis, `/kasse/dsfinvk?von=${heute}&bis=${heute}`, hilfe)).status, 403);
  assert.equal((await rufe(ebasis, '/kasse/belege?kasse=K1', hilfe)).status, 403);
  assert.equal((await rufe(ebasis, '/kasse/kassen', hilfe)).status, 403);
  assert.equal((await rufe(ebasis, '/kasse/tse', hilfe, { apiKey: 'k', apiSecret: 's', tssId: TSS })).status, 403);

  // Bürohilfe: Kassenabschluss und Export, kein Kassieren.
  await rufe(ebasis, '/kasse/recht', b.v, { wer: 'ausgewaehlte' });
  await setze(['report', 'recht:barkasse-abschluss', 'recht:barkasse-export']);
  const st = (await rufe(ebasis, '/kasse/status', hilfe)).daten;
  assert.deepEqual(st.rechte, { kassieren: false, stornieren: false, abschluss: true, export: true, einrichten: false });
  assert.equal((await rufe(ebasis, '/kasse/kassen', hilfe)).status, 200, 'Kassenwahl ansehen');
  const z = await rufe(ebasis, '/kasse/abschluss', hilfe, { kasse: 'K1' });
  assert.equal(z.status, 200, z.text);
  assert.equal(z.daten.kasse, 'K1');
  assert.equal((await rufe(ebasis, '/kasse/belege?kasse=K1', hilfe)).daten.length, 1);
  assert.equal((await rufe(ebasis, '/kasse/abschluesse?kasse=K1', hilfe)).daten.length, 1);
  assert.equal((await rufe(ebasis, `/kasse/dsfinvk?von=${heute}&bis=${heute}`, hilfe)).status, 200);
  assert.equal((await rufe(ebasis, '/kasse/storno', hilfe, { nummer: beleg.daten.nummer, grund: 'Versehen' })).status, 403, 'kein Storno');
  assert.equal((await rufe(ebasis, '/kasse/kassen', hilfe, { name: 'X', clientId: CLIENT2, geraet: 'dieses' })).status, 403, 'kein Einrichten');
  assert.equal((await rufe(ebasis, '/kasse/tse/probe', hilfe, { kasse: 'K1' })).status, 403);
  // Rechte vergeben bleibt beim Verwalter.
  assert.equal((await rufe(ebasis, '/kasse/recht', hilfe, { wer: 'alle' })).status, 403);
  assert.equal((await rufe(ebasis, '/mitarbeiter/rechte', hilfe, { id: b.m2id, bereiche: null })).status, 403);

  // Einrichten: Kassen und TSE, aber kein Abschluss und kein Export.
  await setze(['recht:barkasse-einrichten']);
  assert.equal((await rufe(ebasis, '/kasse/kassen', hilfe, { id: 'K9', name: 'Büro', clientId: CLIENT2, geraet: 'dieses' })).status, 200);
  assert.equal((await rufe(ebasis, '/kasse/tse', hilfe, { apiKey: 'k2', tssId: TSS })).status, 200);
  assert.equal((await rufe(ebasis, '/kasse/tse', hilfe)).daten.apiKey, 'k2');
  assert.equal((await rufe(ebasis, '/kasse/tse/probe', hilfe, { kasse: 'K1' })).status, 200);
  assert.equal((await rufe(ebasis, '/kasse/abschluss', hilfe, { kasse: 'K1' })).status, 403);
  assert.equal((await rufe(ebasis, `/kasse/dsfinvk?von=${heute}&bis=${heute}`, hilfe)).status, 403);
  // Das Gerät ist jetzt Kasse K9, aber ohne Recht zum Kassieren wird nicht gebucht.
  assert.equal((await rufe(ebasis, '/kasse/beleg', hilfe, { positionen: [kaffee()], zahlart: 'bar' })).status, 403);
  await setze(['recht:barkasse-einrichten', RECHT_KASSE]);
  assert.equal((await rufe(ebasis, '/kasse/beleg', hilfe, { positionen: [kaffee()], zahlart: 'bar' })).status, 200);
});
