// DSFinV-K-Export der Barkasse: TSE-Zeilen trocken (aus CHOOZY tse-zeilen.pruefung.js), dann der
// ganze Weg GET /kasse/dsfinvk — ZIP entpacken, Dateien, Spalten aus der amtlichen index.xml,
// Zahlenformat, Storno-Verweis, Zeitraumfilter und 403 für Nicht-Verwalter.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { after, before, test } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';

import { erstelleDienst } from '../dienst.mjs';
import { dateienAusIndex, zip } from '../dsfinvk/export.mjs';
import { MAX, stammZeilen, transaktionsZeile } from '../dsfinvk/tse-zeilen.mjs';
import { berlinJahr } from '../kasse.mjs';
import { hash, oeffneSpeicher } from '../speicher.mjs';

const TSS = '00000000-0000-4000-8000-0000000000aa';
const CLIENT1 = '00000000-0000-4000-8000-0000000000c1';
const CLIENT2 = '00000000-0000-4000-8000-0000000000c2';
const J = berlinJahr();
const heute = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());

/** ZIP lesen (nur Deflate, wie zip() schreibt) — Name → Inhalt; prüft die Prüfsummen. */
function entpacken(b) {
  const aus = new Map();
  let i = 0;
  while (b.readUInt32LE(i) === 0x04034b50) {
    const methode = b.readUInt16LE(i + 8);
    const pruef = b.readUInt32LE(i + 14);
    const gepackt = b.readUInt32LE(i + 18);
    const nameLaenge = b.readUInt16LE(i + 26);
    const extra = b.readUInt16LE(i + 28);
    const name = b.subarray(i + 30, i + 30 + nameLaenge).toString('utf8');
    const start = i + 30 + nameLaenge + extra;
    const roh = b.subarray(start, start + gepackt);
    const daten = methode === 8 ? inflateRawSync(roh) : roh;
    assert.equal(crc32(daten) >>> 0, pruef, `Prüfsumme ${name}`);
    aus.set(name, daten);
    i = start + gepackt;
  }
  assert.equal(b.readUInt32LE(b.length - 22), 0x06054b50, 'Ende des Zentralverzeichnisses');
  return aus;
}
/** CSV mit ; und " lesen (wie die index.xml es beschreibt). */
function zeilen(buf) {
  const aus = [];
  let zeile = [];
  let feld = '';
  let inText = false;
  const t = buf.toString('utf8');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inText) {
      if (c === '"' && t[i + 1] === '"') {
        feld += '"';
        i++;
      } else if (c === '"') inText = false;
      else feld += c;
    } else if (c === '"') inText = true;
    else if (c === ';') {
      zeile.push(feld);
      feld = '';
    } else if (c === '\r' && t[i + 1] === '\n') {
      zeile.push(feld);
      aus.push(zeile);
      zeile = [];
      feld = '';
      i++;
    } else feld += c;
  }
  return aus;
}

test('TSE-Zeilen: eine Stammzeile je TSE, keine Transaktionszeile ohne Signatur, Längen', () => {
  const beleg = (z = {}) => ({ nummer: 'KB-K1-2026-0001', tse_status: 'signiert', tse_serie: 'a1b2c3', tse_zaehler: 7, tse_transaktion: 42, tse_pruefwert: 'MEUCIQ', tse_start: '2026-10-17T21:45:00Z', tse_ende: '2026-10-17T21:45:12Z', tse_algo: 'ecdsa-plain-SHA384', tse_schluessel: 'BFxk', tse_vorgang: 'Beleg^1.00_0.00_0.00_0.00_0.00^1.00:Bar', ...z });
  const z = stammZeilen([beleg(), beleg({ nummer: '2' }), beleg({ nummer: '3', tse_serie: 'd4e5f6' }), beleg({ nummer: '4', tse_status: 'keine', tse_serie: null })], {});
  assert.equal(z.length, 2);
  assert.deepEqual(z.map((x) => x.TSE_ID), [1, 2]);
  assert.equal(z[0].TSE_ZEITFORMAT, 'unixTime');
  assert.equal(z[0].TSE_PD_ENCODING, 'UTF-8');
  assert.equal(stammZeilen([beleg({ tse_status: 'ausfall' })]).length, 0);
  const lang = 'x'.repeat(2500);
  const mit = stammZeilen([beleg({ tse_serie: 's'.repeat(100) })], { seriennummer: 's'.repeat(100), zertifikat: lang, zeitformat: 'utcTime' });
  assert.equal(mit[0].TSE_SERIAL.length, MAX.TSE_SERIAL);
  assert.equal(mit[0].TSE_ZERTIFIKAT_I.length, 1000);
  assert.equal(mit[0].TSE_ZERTIFIKAT_II.length, 1000);
  assert.equal(mit[0].TSE_ZEITFORMAT, 'utcTime');
  const ids = new Map([['a1b2c3', 1]]);
  const t = transaktionsZeile(beleg(), ids);
  assert.equal(t.TSE_ID, 1);
  assert.equal(t.TSE_TANR, 42);
  assert.equal(t.TSE_TA_VORGANGSART, 'Kassenbeleg-V1');
  assert.equal(t.TSE_VORGANGSDATEN, 'Beleg^1.00_0.00_0.00_0.00_0.00^1.00:Bar');
  assert.equal(transaktionsZeile(beleg({ tse_status: 'keine' }), ids), null);
});

test('ZIP ohne Fremdpaket: Inhalt kommt unverändert zurück', () => {
  const dateien = [
    { name: 'a.csv', daten: Buffer.from('X;Y\r\n1;2\r\n') },
    { name: 'ü.txt', daten: Buffer.from('Grüße '.repeat(500)) },
  ];
  const aus = entpacken(zip(dateien));
  assert.equal(aus.get('a.csv').toString(), 'X;Y\r\n1;2\r\n');
  assert.equal(aus.get('ü.txt').toString(), 'Grüße '.repeat(500));
});

let speicher;
let server;
let basis;
before(async () => {
  speicher = oeffneSpeicher(':memory:');
  const tse = async (adresse, o = {}) => {
    if (adresse.endsWith('/auth')) return { access_token: 'tok', access_token_expires_in: 600 };
    if (adresse.includes('tx_revision=1')) return { state: 'ACTIVE' };
    if (adresse.includes('tx_revision=2')) {
      tse.n = (tse.n ?? 0) + 1;
      return { number: tse.n, time_start: 1792273500, time_end: 1792273501, tss_serial_number: 'tse-serie', qr_code_data: 'V0;x', signature: { value: `sig-${tse.n}`, algorithm: 'ecdsa-plain-SHA384', counter: tse.n, public_key: 'PUB' } };
    }
    if (/\/tss\/[^/]+$/.test(adresse) && o.methode !== 'PUT') return { serial_number: 'tse-serie', signature_algorithm: 'ecdsa-plain-SHA384', certificate: 'ZERTIFIKAT' };
    throw new Error(`unerwartet: ${adresse}`);
  };
  server = erstelleDienst(speicher, { zeitgeber: false, senden: () => {}, push: async () => {}, postfachUmgebung: {}, tseAnfrage: tse, tseUmgebung: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function rufe(pfad, token, body) {
  const r = await fetch(basis + pfad, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const typ = r.headers.get('content-type') ?? '';
  return { status: r.status, typ, kopf: r.headers, daten: typ.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

test('GET /kasse/dsfinvk: ZIP mit den Dateien der DSFinV-K 2.4, Spalten aus der index.xml, nur Verwalter, Zeitraum', async () => {
  const id = speicher.betriebAnlegen('Export GmbH');
  const v = speicher.anmelden(speicher.einladen(id, 'Chefin', 'verwalter').code, 'Handy V').token;
  const m = speicher.anmelden(speicher.einladen(id, 'Monteur', 'mitarbeiter').code, 'Handy M').token;
  const db = speicher.alleBetriebe().find((b) => b.id === id).db;
  // Firmendaten, wie die App sie abgleicht (Sammlung 'roh', id 'firma').
  const firma = { party: { name: 'Elektro Muster GmbH', address: { line1: 'Hauptstraße 1', postcode: '01097', city: 'Dresden', countryCode: 'DE' }, vatId: 'DE123456789' }, steuernummer: '201/123/45678' };
  speicher.schreiben(db, 'x', [{ sammlung: 'roh', id: 'firma', geaendert: '2026-11-17T10:00:00.000Z', geloescht: false, inhalt: { daten: JSON.stringify(firma) } }]);
  assert.equal((await rufe('/kasse/tse', v, { apiKey: 'k', apiSecret: 's', tssId: TSS })).status, 200);
  assert.equal((await rufe('/kasse/kassen', v, { id: 'K1', name: 'Transporter', clientId: CLIENT1, geraet: hash(m).slice(0, 12) })).status, 200);
  assert.equal((await rufe('/kasse/kassen', v, { id: 'K2', name: 'Laden', clientId: CLIENT2, geraet: 'dieses' })).status, 200);
  const p = (text, menge, preisCent, satz) => ({ text, menge, preisCent, satz });
  const b1 = await rufe('/kasse/beleg', m, { positionen: [p('Kabel; 3 m "NYM"', 2, 1190, 19), p('Buch', 1, 1070, 7)], zahlart: 'bar', gegebenCent: 5000 });
  assert.equal(b1.status, 200);
  await rufe('/kasse/beleg', m, { positionen: [p('Stunde', 1.5, 6545, 19)], zahlart: 'unbar' });
  assert.equal((await rufe('/kasse/storno', v, { nummer: b1.daten.nummer, grund: 'Falsch getippt' })).status, 200);
  await rufe('/kasse/beleg', v, { positionen: [p('Laden', 1, 100, 0)], zahlart: 'bar' }); // an K2
  assert.equal((await rufe('/kasse/abschluss', v, { kasse: 'K1' })).status, 200);
  assert.equal((await rufe('/kasse/abschluss', v, { kasse: 'K2' })).status, 200);

  // Nur Verwalter, Zeitraum Pflicht, ohne Abschluss im Zeitraum nichts.
  assert.equal((await rufe(`/kasse/dsfinvk?von=${heute}&bis=${heute}`, m)).status, 403);
  assert.equal((await rufe('/kasse/dsfinvk', v)).status, 400);
  assert.equal((await rufe(`/kasse/dsfinvk?von=${heute}&bis=2020-01-01`, v)).status, 400);
  assert.equal((await rufe('/kasse/dsfinvk?von=2020-01-01&bis=2020-01-31', v)).status, 404, 'Zeitraumfilter: früher Monat ohne Abschluss');

  const r = await rufe(`/kasse/dsfinvk?von=${heute}&bis=${heute}&kasse=K1`, v);
  assert.equal(r.status, 200);
  assert.equal(r.typ, 'application/zip');
  assert.match(r.kopf.get('content-disposition'), /DSFinV-K_K1_/);
  const aus = entpacken(r.daten);
  const index = dateienAusIndex();
  assert.equal(Object.keys(index).length, 20, 'zwanzig Dateien laut amtlicher index.xml');
  for (const name of [...Object.keys(index), 'index.xml', 'gdpdu-01-09-2004.dtd']) assert.ok(aus.has(name), `${name} fehlt`);
  // Kopfzeilen = Spalten der index.xml, in derselben Reihenfolge.
  for (const [name, d] of Object.entries(index)) assert.deepEqual(zeilen(aus.get(name))[0], d.spalten.map((s) => s.name), name);
  const tabelle = (name) => {
    const [kopf, ...rest] = zeilen(aus.get(name));
    return rest.map((z) => Object.fromEntries(kopf.map((k, i) => [k, z[i]])));
  };

  const [z] = tabelle('cashpointclosing.csv');
  assert.equal(z.Z_KASSE_ID, 'K1');
  assert.equal(z.Z_NR, '1');
  assert.equal(z.TAXONOMIE_VERSION, '2.4');
  assert.equal(z.NAME, 'Elektro Muster GmbH');
  assert.equal(z.STRASSE, 'Hauptstraße 1');
  assert.equal(z.STNR, '201/123/45678');
  assert.equal(z.USTID, 'DE123456789');
  assert.equal(z.LAND, 'DEU');
  assert.equal(z.Z_BUCHUNGSTAG, heute);
  // Umsatz der Kasse K1: 34,50 + 98,18 − 34,50 = 98,18 (Komma als Dezimaltrenner).
  assert.equal(z.Z_SE_ZAHLUNGEN, '98,18');
  assert.equal(z.Z_SE_BARZAHLUNGEN, '0,00');
  assert.equal(z.Z_START_ID, `KB-K1-${J}-0001`);
  assert.equal(z.Z_ENDE_ID, `KB-K1-${J}-0003`);
  assert.equal(tabelle('cashregister.csv')[0].KASSE_SERIENNR, CLIENT1);

  const bons = tabelle('transactions.csv');
  assert.deepEqual(bons.map((b) => b.BON_ID), [`KB-K1-${J}-0001`, `KB-K1-${J}-0002`, `KB-K1-${J}-0003`], 'nur Belege von K1');
  assert.deepEqual(bons.map((b) => b.BON_STORNO), ['0', '0', '1']);
  assert.equal(bons[0].UMS_BRUTTO, '34,50');
  assert.equal(bons[2].UMS_BRUTTO, '-34,50');
  assert.equal(bons[0].BON_NR, '1');
  assert.match(bons[2].BON_NOTIZ, /Storno-Grund: Falsch getippt/);

  const pos = tabelle('lines.csv');
  assert.equal(pos[0].ARTIKELTEXT, 'Kabel; 3 m "NYM"', 'Semikolon und Anführungszeichen sauber eingeschlossen');
  assert.equal(pos[0].MENGE, '2,000');
  assert.equal(pos[0].STK_BR, '11,90000');
  assert.equal(pos.find((x) => x.BON_ID === `KB-K1-${J}-0002`).MENGE, '1,500');
  const vat = tabelle('transactions_vat.csv').filter((x) => x.BON_ID === `KB-K1-${J}-0001`);
  assert.deepEqual(vat.map((x) => [x.UST_SCHLUESSEL, x.BON_BRUTTO, x.BON_NETTO, x.BON_UST]), [['1', '23,80000', '20,00000', '3,80000'], ['2', '10,70000', '10,00000', '0,70000']]);
  assert.deepEqual(tabelle('payment.csv').map((x) => [x.ZAHLART_TYP, x.Z_ZAHLART_BETRAG]), [['Unbar', '98,18']]);

  const ref = tabelle('references.csv');
  assert.equal(ref.length, 1);
  assert.equal(ref[0].BON_ID, `KB-K1-${J}-0003`);
  assert.equal(ref[0].REF_BON_ID, `KB-K1-${J}-0001`);
  assert.equal(ref[0].REF_Z_NR, '1');
  assert.equal(ref[0].REF_Z_KASSE_ID, 'K1');

  const tse = tabelle('tse.csv');
  assert.equal(tse.length, 1);
  assert.equal(tse[0].TSE_SERIAL, 'tse-serie');
  assert.equal(tse[0].TSE_ZERTIFIKAT_I, 'ZERTIFIKAT', 'Stammdaten der TSS');
  const ttse = tabelle('transactions_tse.csv');
  assert.equal(ttse.length, 3);
  assert.equal(ttse[0].TSE_TA_VORGANGSART, 'Kassenbeleg-V1');
  assert.equal(ttse[0].TSE_VORGANGSDATEN, 'Beleg^23.80_10.70_0.00_0.00_0.00^34.50:Bar');

  // Ohne Kassenwahl: beide Kassen.
  const alle = entpacken((await rufe(`/kasse/dsfinvk?von=${heute}&bis=${heute}`, v)).daten);
  assert.equal(zeilen(alle.get('cashpointclosing.csv')).length, 3, 'Kopf + zwei Abschlüsse');
});

test('Pfand und Leergut: GV_TYP Pfand / PfandRueckzahlung je Position und in den Geschäftsvorfällen; Auszahlung nur durch Leergut', async () => {
  const id = speicher.betriebAnlegen('Getränke Muster');
  const v = speicher.anmelden(speicher.einladen(id, 'Chefin', 'verwalter').code, 'Handy V').token;
  const firma = { party: { name: 'Getränke Muster', address: { line1: 'Markt 1', postcode: '01067', city: 'Dresden', countryCode: 'DE' } } };
  const db = speicher.alleBetriebe().find((b) => b.id === id).db;
  speicher.schreiben(db, 'x', [{ sammlung: 'roh', id: 'firma', geaendert: '2026-11-21T10:00:00.000Z', geloescht: false, inhalt: { daten: JSON.stringify(firma) } }]);
  assert.equal((await rufe('/kasse/tse', v, { apiKey: 'k', apiSecret: 's', tssId: TSS })).status, 200);
  assert.equal((await rufe('/kasse/kassen', v, { id: 'K1', name: 'Laden', clientId: CLIENT1, geraet: 'dieses' })).status, 200);
  // Kiste Pils (20 Fl.) 16,00 € + Pfand 20 × 0,08 + 1 × 1,50; zwei leere Kästen zurück.
  const kiste = { text: 'Pils – Kiste (20 Fl.)', menge: 1, preisCent: 1600, satz: 19, artikel: 'ar_pils', faktor: 20 };
  const pfandFl = { text: 'Pfand Flasche', menge: 20, preisCent: 8, satz: 19, art: 'pfand', leergut: 'lg_fl' };
  const pfandKa = { text: 'Pfand Kasten', menge: 1, preisCent: 150, satz: 19, art: 'pfand', leergut: 'lg_ka' };
  const zurueck = (n) => ({ text: 'Leergut zurück: Kasten', menge: -n, preisCent: 150, satz: 19, art: 'leergut', leergut: 'lg_ka' });
  const b1 = await rufe('/kasse/beleg', v, { positionen: [kiste, pfandFl, pfandKa, zurueck(2)], zahlart: 'bar', gegebenCent: 2000 });
  assert.equal(b1.status, 200, JSON.stringify(b1.daten));
  assert.equal(b1.daten.summeCent, 1600 + 160 + 150 - 300);
  assert.deepEqual(b1.daten.positionen.map((p) => [p.art ?? '', p.leergut ?? '', p.faktor ?? 1]), [['', '', 20], ['pfand', 'lg_fl', 1], ['pfand', 'lg_ka', 1], ['leergut', 'lg_ka', 1]]);
  // Nur Leergut: Pfandauszahlung (negativ) ist erlaubt, ohne „gegeben“.
  const aus = await rufe('/kasse/beleg', v, { positionen: [zurueck(3)], zahlart: 'bar' });
  assert.equal(aus.status, 200, JSON.stringify(aus.daten));
  assert.equal(aus.daten.summeCent, -450);
  assert.equal((await rufe('/kasse/beleg', v, { positionen: [zurueck(3)], zahlart: 'bar', gegebenCent: 0 })).status, 400, 'gegeben bei Auszahlung');
  // Negativ durch etwas anderes als Leergut: weiterhin abgewiesen.
  assert.equal((await rufe('/kasse/beleg', v, { positionen: [{ ...kiste, menge: -1 }, zurueck(1)], zahlart: 'bar' })).status, 400);
  assert.equal((await rufe('/kasse/beleg', v, { positionen: [{ ...pfandKa, menge: -2 }], zahlart: 'bar' })).status, 400, 'Pfand negativ ist kein Leergut');
  // Storno der Auszahlung: Gegenbuchung, Felder bleiben.
  const st = await rufe('/kasse/storno', v, { nummer: aus.daten.nummer, grund: 'Falsche Kiste' });
  assert.equal(st.status, 200, JSON.stringify(st.daten));
  assert.equal(st.daten.positionen[0].art, 'leergut');
  assert.equal(st.daten.positionen[0].menge, 3);
  assert.equal((await rufe('/kasse/abschluss', v, { kasse: 'K1' })).status, 200);

  const r = await rufe(`/kasse/dsfinvk?von=${heute}&bis=${heute}&kasse=K1`, v);
  assert.equal(r.status, 200);
  const d = entpacken(r.daten);
  const tabelle = (name) => {
    const [kopf, ...rest] = zeilen(d.get(name));
    return rest.map((z) => Object.fromEntries(kopf.map((k, i) => [k, z[i]])));
  };
  const pos = tabelle('lines.csv').filter((x) => x.BON_ID === b1.daten.nummer);
  assert.deepEqual(pos.map((x) => x.GV_TYP), ['Umsatz', 'Pfand', 'Pfand', 'PfandRueckzahlung']);
  assert.equal(pos[3].MENGE, '-2,000');
  const gv = tabelle('businesscases.csv').map((x) => [x.GV_TYP, x.UST_SCHLUESSEL, x.Z_UMS_BRUTTO]);
  // Umsatz 16,00; Pfand 1,60 + 1,50; Leergut −3,00 − 4,50 + 4,50 (Storno) = −3,00.
  assert.deepEqual(gv, [['Umsatz', '1', '16,00000'], ['Pfand', '1', '3,10000'], ['PfandRueckzahlung', '1', '-3,00000']]);
});
