import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { erstelleBmf, kurseAusPdf, pdfLinks, plausibel } from '../bmf.mjs';

// Das echte BMF-Schreiben vom 02.11.2026 (Monatlich fortgeschriebene Übersicht 2026, Januar bis Oktober).
const PDF = new Uint8Array(readFileSync(new URL('./bmf-2026-11-02.pdf', import.meta.url)));
const SEITE = `<a href="Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Umrechnungskurse/2026-11-02-umsatzsteuer-umrechnungskurse-2026.pdf?__blob=publicationFile&amp;v=4">x</a>
<a href="/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Umrechnungskurse/2026-02-03-umsatzsteuer-umrechnungskurse-2025.pdf?__blob=publicationFile&amp;v=6">y</a>
<a href="/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Umrechnungskurse/2025-02-03-umsatzsteuer-umrechnungskurse-2024.pdf?__blob=publicationFile&amp;v=7">z</a>`;

test('BMF: Kurse aus dem echten PDF lesen, wie gedruckt', () => {
  const k = kurseAusPdf(PDF, 2026);
  assert.deepEqual(Object.keys(k), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(k['2026-10'], { CHF: 0.9282, GBP: 0.84282, USD: 1.1202, PLN: 4.3813, CZK: 24.367, DKK: 7.4746, SEK: 11.153, NOK: 10.5914, HUF: 365.77, RON: 5.3392 });
  assert.equal(k['2026-01'].CHF, 0.9272);
  assert.ok(plausibel(k));
  assert.ok(!plausibel({ '2026-10': { ...k['2026-10'], CHF: 9282 } }), 'Lesefehler wird abgelehnt');
  assert.ok(!plausibel({ '2026-10': { CHF: 0.93 } }), 'unvollständig wird abgelehnt');
});

test('BMF: Links auf der Übersichtsseite, neueste zuerst', () => {
  const l = pdfLinks(SEITE);
  assert.deepEqual(l.map((x) => [x.datum, x.jahr]), [['2026-11-02', 2026], ['2026-02-03', 2025], ['2025-02-03', 2024]]);
  assert.ok(l[0].url.startsWith('https://www.bundesfinanzministerium.de/Content/') && l[0].url.includes('&v=4'));
});

test('BMF: einmal am Tag nachsehen, nur neue PDFs laden, Fehler lassen den Stand stehen', async () => {
  const ordner = mkdtempSync(join(tmpdir(), 'bmf-'));
  const abrufe = [];
  let kaputt = false;
  const holen = async (url) => {
    abrufe.push(url.includes('.pdf') ? url.match(/(\d{4}-\d{2}-\d{2})-/)[1] : 'seite');
    if (kaputt) return new Response('weg', { status: 503 });
    if (!url.includes('.pdf')) return new Response(SEITE);
    // Für das Vorjahr reicht hier dasselbe PDF; gelesen wird es als 2025.
    return new Response(PDF);
  };
  const b = erstelleBmf(ordner, { holen, umgebung: {} });
  const t0 = Date.parse('2026-11-23T08:00:00Z');
  const s = await b.auffrischen(t0);
  assert.equal(s.stand, '2026-11-02');
  assert.deepEqual(s.quellen, { 2026: '2026-11-02', 2025: '2026-02-03' });
  assert.equal(s.kurse['2026-10'].CHF, 0.9282);
  assert.deepEqual(abrufe, ['seite', '2026-11-02', '2026-02-03'], 'nur die jüngsten zwei Jahre');
  await b.auffrischen(t0 + 3600_000);
  assert.equal(abrufe.length, 3, 'innerhalb eines Tages nicht noch einmal');
  // Neuer Tag, gleiche PDFs: nur die Seite.
  const neu = erstelleBmf(ordner, { holen, umgebung: {} });
  assert.equal(neu.stand().kurse['2026-10'].CHF, 0.9282, 'übersteht einen Neustart');
  await neu.auffrischen(t0 + 25 * 3600_000);
  assert.deepEqual(abrufe.slice(3), ['seite'], 'unverändertes PDF wird nicht neu geladen');
  kaputt = true;
  assert.equal((await neu.auffrischen(t0 + 50 * 3600_000)).kurse['2026-10'].CHF, 0.9282, 'BMF nicht erreichbar: alter Stand bleibt');
  assert.equal(erstelleBmf(ordner, { holen, umgebung: { MONTIX_BMF: 'aus' } }).stand(), null);
});
