import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';

import { erstelleDienst } from '../dienst.mjs';
import { pythonHelfer } from '../mail.mjs';
import { oeffneSpeicher } from '../speicher.mjs';

let server;
let basis;
let speicher;
let betrieb;
const auftraege = [];
let antwortVon = () => ({ ok: true });

before(async () => {
  speicher = oeffneSpeicher(':memory:');
  betrieb = speicher.betriebAnlegen('Muster GmbH');
  const helfer = async (a) => (auftraege.push(a), antwortVon(a));
  server = erstelleDienst(speicher, { zeitgeber: false, senden: () => {}, push: async () => {}, mailHelfer: helfer });
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
  return { status: r.status, daten: await r.json() };
}
async function geraet(name, rolle) {
  const { code } = speicher.einladen(betrieb, name, rolle);
  return (await rufe('/anmelden', { body: { code, geraet: `Handy ${name}` } })).daten;
}

const KONTO = { name: 'Anna Muster', adresse: 'anna@muster.de', imapHost: 'imap.muster.de', imapPort: 993, smtpHost: 'smtp.muster.de', smtpPort: 465, passwort: 'geheim123' };

test('Postfach je Mitarbeiter: einrichten, Passwort nie zurück, anderer sieht es nicht', async () => {
  const a = await geraet('Anna', 'monteur');
  const b = await geraet('Bernd', 'monteur');
  assert.deepEqual((await rufe('/mail/konto', { token: a.token })).daten, { eingerichtet: false });

  antwortVon = () => ({ ok: true, ordner: [{ pfad: 'INBOX', name: 'Posteingang', rolle: 'eingang' }] });
  let r = await rufe('/mail/konto', { token: a.token, body: KONTO });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  assert.equal(r.daten.eingerichtet, true);
  assert.equal(r.daten.passwort, undefined);
  assert.equal(r.daten.benutzer, 'anna@muster.de');
  assert.equal(auftraege.at(-1).aktion, 'pruefen');
  assert.equal(auftraege.at(-1).konto.passwort, 'geheim123');

  r = await rufe('/mail/konto', { token: a.token });
  assert.equal(r.daten.adresse, 'anna@muster.de');
  assert.equal(r.daten.passwort, undefined);
  assert.equal((await rufe('/mail/konto', { token: b.token })).daten.eingerichtet, false);
  assert.equal((await rufe('/mail/liste', { token: b.token })).status, 409);

  // Ändern ohne Passwort behält das alte.
  await rufe('/mail/konto', { token: a.token, body: { ...KONTO, passwort: '', name: 'Anna M.' } });
  assert.equal(auftraege.at(-1).konto.passwort, 'geheim123');
  assert.equal((await rufe('/mail/konto', { token: a.token })).daten.name, 'Anna M.');

  // Liste, Senden: der Helfer bekommt die Zugangsdaten, die App nur das Ergebnis.
  antwortVon = (x) => (x.aktion === 'liste' ? { ok: true, gesamt: 1, mails: [{ uid: 7, betreff: 'Hallo' }] } : { ok: true, messageId: '<1@muster.de>' });
  r = await rufe('/mail/liste?ordner=INBOX', { token: a.token });
  assert.equal(r.daten.mails[0].betreff, 'Hallo');
  r = await rufe('/mail/senden', { token: a.token, body: { an: 'kunde@example.org; zwei@example.org', betreff: 'Angebot', text: 'Guten Tag' } });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  assert.deepEqual(auftraege.at(-1).an, ['kunde@example.org', 'zwei@example.org']);

  // Ablehnung durch den Mailserver kommt als Meldung an.
  antwortVon = () => ({ ok: false, fehler: 'Anmeldung am Posteingangsserver abgelehnt' });
  r = await rufe('/mail/liste', { token: a.token });
  assert.equal(r.status, 502);
  assert.match(r.daten.fehler, /abgelehnt/);

  await rufe('/mail/konto/loeschen', { token: a.token, body: {} });
  assert.equal((await rufe('/mail/konto', { token: a.token })).daten.eingerichtet, false);
});

test('Eingaben: nur Mail-Ports, gültige Adressen, Passwort nötig', async () => {
  const a = await geraet('Clara', 'monteur');
  antwortVon = () => ({ ok: true, ordner: [] });
  assert.equal((await rufe('/mail/konto', { token: a.token, body: { ...KONTO, imapPort: 8790 } })).status, 400);
  assert.equal((await rufe('/mail/konto', { token: a.token, body: { ...KONTO, imapHost: '127.0.0.1:22' } })).status, 400);
  assert.equal((await rufe('/mail/konto', { token: a.token, body: { ...KONTO, passwort: '' } })).status, 400);
  assert.equal((await rufe('/mail/konto', { token: a.token, body: { ...KONTO, adresse: 'kein-at' } })).status, 400);
  await rufe('/mail/konto', { token: a.token, body: KONTO });
  assert.equal((await rufe('/mail/senden', { token: a.token, body: { an: 'quatsch', text: 'x' } })).status, 400);
  assert.equal((await rufe('/mail/senden', { token: a.token, body: { an: [], text: 'x' } })).status, 400);
});

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
test('mail-helfer.py: Syntax und saubere Fehlermeldung ohne Server', { skip: !python }, async () => {
  const r = await pythonHelfer({ aktion: 'ordner', konto: { imapHost: 'imap.ungueltig.invalid', imapPort: 993, benutzer: 'x', passwort: 'y' } }, { python });
  assert.equal(r.ok, false);
  assert.match(r.fehler, /nicht erreichbar/);
});
