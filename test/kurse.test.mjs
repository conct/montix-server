import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { erstelleKurse, ezbLesen } from '../kurse.mjs';

const XML = `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope><Cube><Cube time='2026-11-20'><Cube currency='USD' rate='1.1202'/><Cube currency='CHF' rate='0.9282'/></Cube></Cube></gesmes:Envelope>`;

test('EZB-Kurse: lesen, einmal holen, 12 Stunden zwischenspeichern, abschaltbar', async () => {
  assert.deepEqual(ezbLesen(XML), { datum: '2026-11-20', kurse: { USD: 1.1202, CHF: 0.9282 } });
  const ordner = mkdtempSync(join(tmpdir(), 'kurse-'));
  let abrufe = 0;
  const holen = async () => (abrufe++, new Response(XML));
  const k = erstelleKurse(ordner, { holen, umgebung: {} });
  const t0 = Date.parse('2026-11-23T08:00:00Z');
  assert.equal((await k.auffrischen(t0)).kurse.CHF, 0.9282);
  await k.auffrischen(t0 + 3600_000);
  assert.equal(abrufe, 1, 'innerhalb von 12 Stunden kein zweiter Abruf');
  assert.equal(erstelleKurse(ordner, { holen, umgebung: {} }).stand().datum, '2026-11-20', 'übersteht einen Neustart');
  const kaputt = erstelleKurse(ordner, { holen: async () => new Response('nein', { status: 500 }), umgebung: {} });
  assert.equal((await kaputt.auffrischen(t0 + 13 * 3600_000)).datum, '2026-11-20', 'Fehler lässt den alten Stand stehen');
  assert.equal(erstelleKurse(ordner, { holen, umgebung: { MONTIX_EZB: 'aus' } }).stand(), null);
});

test('EZB-Kurse: GET /kurse für Angemeldete über den Dienst', async () => {
  const { erstelleDienst } = await import('../dienst.mjs');
  const { oeffneSpeicher } = await import('../speicher.mjs');
  const sp = oeffneSpeicher(':memory:');
  const b = sp.betriebAnlegen('Kurs GmbH');
  const srv = erstelleDienst(sp, { zeitgeber: false, ordner: mkdtempSync(join(tmpdir(), 'kurse-dienst-')), senden: () => {}, push: async () => {}, kurseHolen: async () => new Response(XML), bmfHolen: async (url) => (url.includes('.pdf') ? new Response(readFileSync(new URL('./bmf-2026-11-02.pdf', import.meta.url))) : new Response('<a href="Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Umrechnungskurse/2026-11-02-umsatzsteuer-umrechnungskurse-2026.pdf">x</a>')) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const basis = `http://127.0.0.1:${srv.address().port}`;
  try {
    const anmelden = await (await fetch(`${basis}/anmelden`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: sp.einladen(b, 'Vera', 'verwalter').code }) })).json();
    assert.equal((await fetch(`${basis}/kurse`)).status, 401, 'ohne Anmeldung nicht');
    const k = await (await fetch(`${basis}/kurse`, { headers: { authorization: `Bearer ${anmelden.token}` } })).json();
    assert.equal(k.datum, '2026-11-20');
    assert.equal(k.kurse.CHF, 0.9282);
    assert.equal(k.bmf.stand, '2026-11-02');
    assert.equal(k.bmf.kurse['2026-10'].CHF, 0.9282, 'BMF-Kurse kommen mit');
  } finally {
    srv.close();
  }
});
