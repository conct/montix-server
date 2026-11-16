// Objektraum: gemeinsamer Bereich eines Betriebs mit anderen Firmen und dem Auftraggeber.
// Punkte (Aufgaben/Mängel) mit Status, Notizen, vertrauliche Hinweise (Türcode). Jeder Teilnehmer
// hat einen eigenen Link — er ist sein Ausweis; wer schreibt, steht dabei. Der Betrieb arbeitet in
// der App (angemeldet), die anderen im Browser (Formulare ohne Skript, wie /weg).
//
// Angemeldet (Betrieb, Datenweg mit AVV):
//   GET  /raeume                                   → Liste
//   GET  /raum?id=                                 → Raum mit Teilnehmern, Punkten, Notizen
//   POST /raum {titel, objekt?}                    → { id }
//   POST /raum/archivieren {id}                    → Raum zu: Links tot, Fotos und Codes gelöscht
//   POST /raum/teilnehmer {raum, name, rolle, email?, rechte?} → { id, link } (Einladung per Mail)
//   POST /raum/teilnehmer/entfernen {raum, id}
//   POST /raum/punkt {raum, id?, titel?, text?, zustaendig?, status?, foto?}
//   POST /raum/notiz {raum, text?, foto?, code?, bezeichnung?, sichtbar?, tage?}
//   POST /raum/code {raum, id}                     → { code } (Einsicht wird festgehalten)
//   GET  /raum/foto?raum=&id=                      → { typ, daten }
// Öffentlich:
//   GET  /objekt/<schlüssel>                       → Seite des Teilnehmers
//   POST /objekt/<schlüssel>  aktion=…             → abhaken, wieder_offen, punkt, notiz, anzeigen
//   GET  /objekt/<schlüssel>/foto/<id>             → Foto
// E-Mail: Einladung sofort; Neuigkeiten gesammelt — der erste Eintrag öffnet ein Fenster (je Betrieb
// 0, 5 oder 15 Minuten), alles darin kommt in eine Mail je Teilnehmer.
//   GET/POST /raum/einstellungen {mailMinuten}       → Takt der Sammelmail (setzen: nur Verwalter)

import { createHash, randomBytes } from 'node:crypto';

import { erstelleGeheim } from './geheim.mjs';
import { raumEinladungMail, raumNeuMail } from './mailvorlage.mjs';
import { nachricht as pushNachricht, tokensVon } from './push.mjs';

const MB = 1024 * 1024;
const FOTO_MAX = 10 * MB;
/**
 * Sammelmail der Neuigkeiten: sofort (nächste Prüfung), 5 oder 15 Minuten. Im zentralen Hosting
 * (MONTIX_VERTRAG=pflicht) fest 15 Minuten — einstellbar mit eigenem Server oder gebuchtem
 * Serverpaket (`node verwalten.mjs serverpaket <betrieb> an`). Entscheidung des Nutzers, 14.11.2026.
 */
export const MAIL_TAKTE = [0, 5, 15];
const MAIL_TAKT_EIGEN = 5;
const MAIL_TAKT_HOSTING = 15;
const SCHLUESSEL = /^o[A-Za-z0-9_-]{22}$/;
const ROLLEN = ['firma', 'auftraggeber'];
const STANDARD_RECHTE = { anlegen: true, abhaken: true, schreiben: true };
const BILDTYP = { 'image/jpeg': [0xff, 0xd8], 'image/png': [0x89, 0x50], 'image/webp': null };

const hash = (s) => createHash('sha256').update(s).digest('hex');
const neueId = (p) => `${p}_${randomBytes(6).toString('hex')}`;
const kurz = (s, n) => String(s ?? '').trim().slice(0, n);

export class RaumFehler extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const tabelle = (db) => {
  db.exec(`create table if not exists raeume (id text primary key, titel text not null, objekt text, von text not null,
    erstellt text not null, geaendert text not null, archiviert text)`);
  db.exec(`create table if not exists raum_teilnehmer (id text primary key, raum text not null, name text not null, rolle text not null,
    email text, schluessel_hash text unique not null, schluessel_enc text not null, rechte text not null, erstellt text not null,
    entfernt text, zuletzt text)`);
  db.exec(`create table if not exists raum_punkte (id text primary key, raum text not null, titel text not null, text text,
    zustaendig text, status text not null, von text not null, von_name text not null, erstellt text not null,
    erledigt_am text, erledigt_von text, geaendert text not null, foto text)`);
  db.exec(`create table if not exists raum_notizen (id text primary key, raum text not null, text text, von text not null,
    von_name text not null, erstellt text not null, foto text, code_enc text, bezeichnung text, sichtbar text, loescht_am text)`);
  db.exec('create table if not exists raum_einsichten (notiz text not null, wer text not null, zeit text not null)');
  db.exec('create table if not exists raum_dateien (id text primary key, raum text not null, typ text not null, groesse integer not null, daten blob not null)');
  db.exec('create table if not exists raum_post (teilnehmer text not null, raum text not null, zeile text not null, zeit text not null)');
  db.exec('create table if not exists raum_einstellungen (schluessel text primary key, wert text not null)');
};

const einstellung = (db, k) => db.prepare('select wert from raum_einstellungen where schluessel = ?').get(k)?.wert;

/** Serverpaket für einen Betrieb im zentralen Hosting an- oder abschalten (Kommandozeile). */
export function serverpaketSetzen(db, an) {
  tabelle(db);
  if (an) db.prepare("insert into raum_einstellungen values ('serverpaket', '1') on conflict (schluessel) do update set wert = '1'").run();
  else db.prepare("delete from raum_einstellungen where schluessel = 'serverpaket'").run();
}
export const hatServerpaket = (db) => (tabelle(db), einstellung(db, 'serverpaket') === '1');

function bildPruefen(typ, b) {
  if (!(typ in BILDTYP)) throw new RaumFehler(400, 'Nur Fotos (JPEG, PNG, WebP)');
  const kopf = BILDTYP[typ];
  const ok = kopf ? b[0] === kopf[0] && b[1] === kopf[1] : b.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!ok || !b.length) throw new RaumFehler(400, 'Das Foto ist beschädigt oder hat einen anderen Typ');
  if (b.length > FOTO_MAX) throw new RaumFehler(413, 'Das Foto ist größer als 10 MB');
}

function fotoSpeichern(db, raum, typ, daten) {
  bildPruefen(typ, daten);
  const id = neueId('rf');
  db.prepare('insert into raum_dateien values (?, ?, ?, ?, ?)').run(id, raum, typ, daten.length, daten);
  return id;
}

const rechteAus = (r) => ({
  anlegen: r?.anlegen !== false,
  abhaken: r?.abhaken !== false,
  schreiben: r?.schreiben !== false,
});

export function erstelleRaeume({ ordner, senden, push, zentral = false }) {
  const geheim = erstelleGeheim(ordner, 'raum-schluessel.bin');
  const einstellbar = (db) => !zentral || hatServerpaket(db);
  const mailTakt = (db) => {
    if (!einstellbar(db)) return MAIL_TAKT_HOSTING;
    const w = Number(einstellung(db, 'mail_minuten'));
    return MAIL_TAKTE.includes(w) ? w : MAIL_TAKT_EIGEN;
  };

  const raumLaden = (db, id) => {
    tabelle(db);
    const r = db.prepare('select * from raeume where id = ?').get(String(id ?? ''));
    if (!r) throw new RaumFehler(404, 'Unbekannter Bereich');
    return r;
  };
  const teilnehmerListe = (db, raum) => db.prepare('select * from raum_teilnehmer where raum = ? and entfernt is null order by erstellt').all(raum);
  const linkVon = (basis, t) => `${basis}/objekt/${geheim.entschluesseln(t.schluessel_enc)}`;

  /** Neuigkeit für alle Teilnehmer außer dem Urheber vormerken (Versand gebündelt im Takt). */
  function vormerken(db, raum, urheber, zeile) {
    const jetzt = new Date().toISOString();
    for (const t of teilnehmerListe(db, raum.id)) {
      if (t.id === urheber || !t.email) continue;
      db.prepare('insert into raum_post values (?, ?, ?, ?)').run(t.id, raum.id, zeile, jetzt);
    }
    db.prepare('update raeume set geaendert = ? where id = ?').run(jetzt, raum.id);
  }

  /** Push an den Betrieb, wenn jemand von außen etwas schreibt: wer den Raum angelegt hat und die Verwalter. */
  function betriebPush(db, raum, titel, text) {
    if (!push) return;
    const ids = [raum.von, ...db.prepare("select id from mitarbeiter where rolle = 'verwalter' and aktiv = 1").all().map((z) => z.id)];
    const tokens = tokensVon(db, [...new Set(ids)]);
    void push(tokens.map((t) => pushNachricht(t, titel, text, false, `/raeume/${raum.id}`)));
  }

  /**
   * Gesammelte Neuigkeiten verschicken — eine Mail je Teilnehmer und Raum. Der erste Eintrag öffnet
   * ein Fenster (Takt des Betriebs); was darin dazukommt, steht in derselben Mail.
   */
  function postVerschicken(db, betrieb, basis, jetzt = new Date()) {
    tabelle(db);
    const grenze = new Date(jetzt.getTime() - mailTakt(db) * 60000).toISOString();
    const gruppen = db
      .prepare('select teilnehmer, raum, group_concat(zeile, char(10)) zeilen from raum_post group by teilnehmer, raum having min(zeit) <= ?')
      .all(grenze);
    for (const g of gruppen) db.prepare('delete from raum_post where teilnehmer = ? and raum = ?').run(g.teilnehmer, g.raum);
    for (const g of gruppen) {
      const t = db.prepare('select * from raum_teilnehmer where id = ? and entfernt is null').get(g.teilnehmer);
      const r = db.prepare('select * from raeume where id = ? and archiviert is null').get(g.raum);
      if (!t?.email || !r) continue;
      senden([{ name: t.name, email: t.email }], raumNeuMail({ raum: r.titel, zeilen: String(g.zeilen).split('\n').slice(0, 30), link: linkVon(basis, t) }, betrieb));
    }
  }

  /** Abgelaufene Türcodes löschen. */
  function aufraeumen(db, jetzt = new Date()) {
    tabelle(db);
    db.prepare("update raum_notizen set code_enc = null, text = coalesce(text, '') where code_enc is not null and loescht_am < ?").run(jetzt.toISOString());
  }

  // ——— gemeinsame Handlungen (App und Browser) ———

  function punktAnlegen(db, raum, wer, k, foto) {
    const titel = kurz(k.titel, 160);
    if (!titel) throw new RaumFehler(400, 'Bitte einen Titel angeben');
    const id = neueId('rp');
    const jetzt = new Date().toISOString();
    db.prepare(
      `insert into raum_punkte (id, raum, titel, text, zustaendig, status, von, von_name, erstellt, geaendert, foto) values (?, ?, ?, ?, ?, 'offen', ?, ?, ?, ?, ?)`,
    ).run(id, raum.id, titel, kurz(k.text, 4000) || null, kurz(k.zustaendig, 40) || null, wer.id, wer.name, jetzt, jetzt, foto ?? null);
    vormerken(db, raum, wer.id, `Neuer Punkt von ${wer.name}: ${titel}`);
    return id;
  }

  function punktStatus(db, raum, wer, id, status) {
    const p = db.prepare('select * from raum_punkte where id = ? and raum = ?').get(String(id ?? ''), raum.id);
    if (!p) throw new RaumFehler(404, 'Unbekannter Punkt');
    if (p.status === status) return;
    const jetzt = new Date().toISOString();
    if (status === 'erledigt') db.prepare("update raum_punkte set status = 'erledigt', erledigt_am = ?, erledigt_von = ?, geaendert = ? where id = ?").run(jetzt, wer.name, jetzt, p.id);
    else db.prepare("update raum_punkte set status = 'offen', erledigt_am = null, erledigt_von = null, geaendert = ? where id = ?").run(jetzt, p.id);
    vormerken(db, raum, wer.id, status === 'erledigt' ? `Erledigt (${wer.name}): ${p.titel}` : `Wieder offen (${wer.name}): ${p.titel}`);
  }

  function notizAnlegen(db, raum, wer, k, foto) {
    const code = kurz(k.code, 200);
    const text = kurz(k.text, 4000);
    if (!code && !text && !foto) throw new RaumFehler(400, 'Die Notiz ist leer');
    const id = neueId('rn');
    const jetzt = new Date();
    const tage = Math.min(365, Math.max(1, Number(k.tage) || 30));
    const sichtbar = Array.isArray(k.sichtbar) ? k.sichtbar.map(String).slice(0, 50) : [];
    db.prepare(
      `insert into raum_notizen (id, raum, text, von, von_name, erstellt, foto, code_enc, bezeichnung, sichtbar, loescht_am) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      raum.id,
      text || null,
      wer.id,
      wer.name,
      jetzt.toISOString(),
      foto ?? null,
      code ? geheim.verschluesseln(code) : null,
      code ? kurz(k.bezeichnung, 80) || 'Zugangscode' : null,
      code ? JSON.stringify(sichtbar) : null,
      code ? new Date(jetzt.getTime() + tage * 86400000).toISOString() : null,
    );
    if (code) {
      // Vertrauliches steht nie in einer Mail — nur dass es etwas gibt, und nur für die, die es sehen dürfen.
      const jetztIso = jetzt.toISOString();
      for (const t of teilnehmerListe(db, raum.id)) {
        if (t.id !== wer.id && t.email && sichtbar.includes(t.id)) db.prepare('insert into raum_post values (?, ?, ?, ?)').run(t.id, raum.id, `${wer.name} hat einen vertraulichen Hinweis hinterlegt: ${kurz(k.bezeichnung, 80) || 'Zugangscode'} (nur über Ihren Link zu sehen)`, jetztIso);
      }
      db.prepare('update raeume set geaendert = ? where id = ?').run(jetztIso, raum.id);
    } else vormerken(db, raum, wer.id, `Notiz von ${wer.name}: ${text.length > 120 ? `${text.slice(0, 120)}…` : text || 'Foto'}`);
    return id;
  }

  function codeAnzeigen(db, raum, wer, id, darfAlles) {
    const n = db.prepare('select * from raum_notizen where id = ? and raum = ? and code_enc is not null').get(String(id ?? ''), raum.id);
    if (!n) throw new RaumFehler(404, 'Diesen Hinweis gibt es nicht (mehr)');
    const sichtbar = JSON.parse(n.sichtbar ?? '[]');
    if (!darfAlles && n.von !== wer.id && !sichtbar.includes(wer.id)) throw new RaumFehler(403, 'Dieser Hinweis ist nicht für Sie bestimmt');
    db.prepare('insert into raum_einsichten values (?, ?, ?)').run(n.id, wer.name, new Date().toISOString());
    return geheim.entschluesseln(n.code_enc);
  }

  /** Ansicht eines Raums — für den Betrieb (alles, außer Codes im Klartext) oder einen Teilnehmer. */
  function ansicht(db, raum, fuer) {
    const teilnehmer = teilnehmerListe(db, raum.id);
    const punkte = db.prepare('select * from raum_punkte where raum = ? order by status, erstellt').all(raum.id);
    const notizen = db
      .prepare('select * from raum_notizen where raum = ? order by erstellt desc')
      .all(raum.id)
      .filter((n) => !n.bezeichnung || !fuer || n.von === fuer.id || JSON.parse(n.sichtbar ?? '[]').includes(fuer.id));
    return {
      id: raum.id,
      titel: raum.titel,
      objekt: raum.objekt,
      erstellt: raum.erstellt,
      geaendert: raum.geaendert,
      archiviert: raum.archiviert,
      teilnehmer: teilnehmer.map((t) => ({ id: t.id, name: t.name, rolle: t.rolle, ...(fuer ? {} : { email: t.email, rechte: JSON.parse(t.rechte), zuletzt: t.zuletzt }) })),
      punkte: punkte.map((p) => ({ id: p.id, titel: p.titel, text: p.text, zustaendig: p.zustaendig, status: p.status, von: p.von_name, erstellt: p.erstellt, erledigtAm: p.erledigt_am, erledigtVon: p.erledigt_von, foto: p.foto })),
      notizen: notizen.map((n) => ({
        id: n.id,
        text: n.text,
        von: n.von_name,
        erstellt: n.erstellt,
        foto: n.foto,
        vertraulich: !!n.bezeichnung,
        bezeichnung: n.bezeichnung,
        geloescht: !!n.bezeichnung && !n.code_enc,
        loeschtAm: n.loescht_am,
        sichtbar: n.sichtbar ? JSON.parse(n.sichtbar) : undefined,
        einsichten: n.bezeichnung && !fuer ? db.prepare('select wer, zeit from raum_einsichten where notiz = ? order by zeit desc').all(n.id).map((e) => ({ ...e })) : undefined,
      })),
    };
  }

  const betriebAls = (wer) => ({ id: `betrieb:${wer.mitarbeiter.id}`, name: `${wer.betrieb.name} (${wer.mitarbeiter.name})` });
  const fotoAus = (f) => (f && typeof f.daten === 'string' ? { typ: String(f.typ ?? 'image/jpeg'), daten: Buffer.from(f.daten, 'base64') } : null);

  // ——— angemeldet ———

  function weg(methode, pfad, url, wer, koerper, basis) {
    if (pfad !== '/raeume' && pfad !== '/raum' && !pfad.startsWith('/raum/')) return undefined;
    const { db } = wer;
    tabelle(db);
    return (async () => {
      if (methode === 'GET' && pfad === '/raeume') {
        return db
          .prepare('select * from raeume order by archiviert is not null, geaendert desc')
          .all()
          .map((r) => ({
            id: r.id,
            titel: r.titel,
            objekt: r.objekt,
            geaendert: r.geaendert,
            archiviert: r.archiviert,
            offen: db.prepare("select count(*) n from raum_punkte where raum = ? and status = 'offen'").get(r.id).n,
            erledigt: db.prepare("select count(*) n from raum_punkte where raum = ? and status = 'erledigt'").get(r.id).n,
            teilnehmer: db.prepare('select count(*) n from raum_teilnehmer where raum = ? and entfernt is null').get(r.id).n,
          }));
      }
      if (methode === 'GET' && pfad === '/raum') return ansicht(db, raumLaden(db, url.searchParams.get('id')), null);
      if (pfad === '/raum/einstellungen') {
        if (methode === 'POST') {
          if (wer.mitarbeiter.rolle !== 'verwalter') throw new RaumFehler(403, 'Nur ein Verwalter');
          if (!einstellbar(db)) throw new RaumFehler(403, 'Im Montix-Hosting gilt fest 15 Minuten. Einstellbar mit eigenem Server oder einem Serverpaket.');
          const n = Number(((await koerper()) ?? {}).mailMinuten);
          if (!MAIL_TAKTE.includes(n)) throw new RaumFehler(400, `mailMinuten ist eins von ${MAIL_TAKTE.join(', ')}`);
          db.prepare("insert into raum_einstellungen values ('mail_minuten', ?) on conflict (schluessel) do update set wert = excluded.wert").run(String(n));
        }
        return { mailMinuten: mailTakt(db), moeglich: MAIL_TAKTE, einstellbar: einstellbar(db) };
      }
      if (methode === 'GET' && pfad === '/raum/foto') {
        const raum = raumLaden(db, url.searchParams.get('raum'));
        const f = db.prepare('select typ, daten from raum_dateien where id = ? and raum = ?').get(String(url.searchParams.get('id') ?? ''), raum.id);
        if (!f) throw new RaumFehler(404, 'Unbekanntes Foto');
        return { typ: f.typ, daten: Buffer.from(f.daten).toString('base64') };
      }
      if (methode !== 'POST') throw new RaumFehler(404, 'Unbekannter Weg');
      const k = (await koerper(FOTO_MAX * 1.4 + MB)) ?? {};
      const jetzt = new Date().toISOString();

      if (pfad === '/raum') {
        const titel = kurz(k.titel, 120);
        if (!titel) throw new RaumFehler(400, 'Bitte einen Titel angeben');
        const id = neueId('rm');
        db.prepare('insert into raeume (id, titel, objekt, von, erstellt, geaendert) values (?, ?, ?, ?, ?, ?)').run(id, titel, kurz(k.objekt, 200) || null, wer.mitarbeiter.id, jetzt, jetzt);
        return { id };
      }

      const raum = raumLaden(db, k.raum ?? k.id);
      if (raum.archiviert) throw new RaumFehler(410, 'Der Bereich ist geschlossen');
      const ich = betriebAls(wer);

      if (pfad === '/raum/archivieren') {
        db.prepare('delete from raum_dateien where raum = ?').run(raum.id);
        db.prepare('update raum_notizen set code_enc = null, foto = null where raum = ?').run(raum.id);
        db.prepare('update raum_punkte set foto = null where raum = ?').run(raum.id);
        db.prepare('update raeume set archiviert = ? where id = ?').run(jetzt, raum.id);
        return { ok: true };
      }
      if (pfad === '/raum/teilnehmer') {
        const name = kurz(k.name, 80);
        if (!name) throw new RaumFehler(400, 'Bitte einen Namen angeben');
        if (!ROLLEN.includes(k.rolle)) throw new RaumFehler(400, 'rolle ist firma oder auftraggeber');
        const email = kurz(k.email, 200);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RaumFehler(400, 'Die E-Mail-Adresse ist ungültig');
        const schluessel = `o${randomBytes(16).toString('base64url').slice(0, 22)}`;
        const id = neueId('rt');
        db.prepare('insert into raum_teilnehmer (id, raum, name, rolle, email, schluessel_hash, schluessel_enc, rechte, erstellt) values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          id,
          raum.id,
          name,
          k.rolle,
          email || null,
          hash(schluessel),
          geheim.verschluesseln(schluessel),
          JSON.stringify(rechteAus(k.rechte ?? STANDARD_RECHTE)),
          jetzt,
        );
        const link = `${basis}/objekt/${schluessel}`;
        if (email) senden([{ name, email }], raumEinladungMail({ name, raum: raum.titel, objekt: raum.objekt, link }, wer.betrieb));
        return { id, link };
      }
      if (pfad === '/raum/teilnehmer/link') {
        const t = db.prepare('select * from raum_teilnehmer where id = ? and raum = ? and entfernt is null').get(String(k.teilnehmer ?? ''), raum.id);
        if (!t) throw new RaumFehler(404, 'Unbekannter Teilnehmer');
        return { link: linkVon(basis, t) };
      }
      if (pfad === '/raum/teilnehmer/entfernen') {
        db.prepare('update raum_teilnehmer set entfernt = ?, schluessel_enc = ? where id = ? and raum = ?').run(jetzt, '', String(k.teilnehmer ?? ''), raum.id);
        return { ok: true };
      }
      if (pfad === '/raum/punkt') {
        const foto = fotoAus(k.foto);
        const fotoId = foto ? fotoSpeichern(db, raum.id, foto.typ, foto.daten) : null;
        if (!k.id) return { id: punktAnlegen(db, raum, ich, k, fotoId) };
        if (k.status === 'erledigt' || k.status === 'offen') punktStatus(db, raum, ich, k.id, k.status);
        if (k.zustaendig !== undefined) db.prepare('update raum_punkte set zustaendig = ?, geaendert = ? where id = ? and raum = ?').run(kurz(k.zustaendig, 40) || null, jetzt, String(k.id), raum.id);
        if (k.loeschen) db.prepare('delete from raum_punkte where id = ? and raum = ?').run(String(k.id), raum.id);
        return { ok: true };
      }
      if (pfad === '/raum/notiz') {
        const foto = fotoAus(k.foto);
        const fotoId = foto ? fotoSpeichern(db, raum.id, foto.typ, foto.daten) : null;
        return { id: notizAnlegen(db, raum, ich, k, fotoId) };
      }
      if (pfad === '/raum/code') return { code: codeAnzeigen(db, raum, ich, k.notiz, true) };
      throw new RaumFehler(404, 'Unbekannter Weg');
    })();
  }

  // ——— öffentlich (Browser) ———

  function finden(speicher, schluessel) {
    if (!SCHLUESSEL.test(schluessel)) return null;
    const h = hash(schluessel);
    for (const b of speicher.alleBetriebe()) {
      tabelle(b.db);
      const t = b.db.prepare('select * from raum_teilnehmer where schluessel_hash = ? and entfernt is null').get(h);
      if (t) return { b, t, raum: b.db.prepare('select * from raeume where id = ?').get(t.raum) };
    }
    return null;
  }

  const zaehler = new Map();
  const zuViel = (id) => {
    const minute = Math.floor(Date.now() / 60000);
    const k = `${id}|${minute}`;
    const n = (zaehler.get(k) ?? 0) + 1;
    if (zaehler.size > 5000) zaehler.clear();
    zaehler.set(k, n);
    return n > 30;
  };

  async function oeffentlich(speicher, req, res, pfad, url, basisFn) {
    const m = pfad.match(/^\/objekt\/([A-Za-z0-9_-]+)(?:\/foto\/([A-Za-z0-9_]+))?$/);
    if (!m) return false;
    const [, schluessel, fotoId] = m;
    const treffer = finden(speicher, schluessel);
    if (!treffer || treffer.raum?.archiviert) {
      seite(res, 404, rahmenHtml('Montix', `<div class="karte"><h1>${treffer ? 'Dieser Bereich ist geschlossen.' : 'Diesen Zugang gibt es nicht (mehr).'}</h1><p class="grau">Bitte bei der Firma nachfragen, die Sie eingeladen hat.</p></div>`));
      return true;
    }
    const { b, t, raum } = treffer;
    const db = b.db;
    const wer = { id: t.id, name: t.name };
    const rechte = JSON.parse(t.rechte);

    if (fotoId) {
      const f = db.prepare('select typ, groesse, daten from raum_dateien where id = ? and raum = ?').get(fotoId, raum.id);
      if (!f) return seite(res, 404, rahmenHtml('Montix', '<p>Kein Foto.</p>')), true;
      res.writeHead(200, { 'content-type': f.typ, 'content-length': f.groesse, 'content-security-policy': "default-src 'none'; sandbox", ...KOPF });
      res.end(Buffer.from(f.daten));
      return true;
    }

    db.prepare('update raum_teilnehmer set zuletzt = ? where id = ?').run(new Date().toISOString(), t.id);
    let meldung = null;
    let code = null;
    if (req.method === 'POST') {
      if (zuViel(t.id)) {
        seite(res, 429, rahmenHtml('Montix', '<div class="karte"><h1>Zu viele Eingaben.</h1><p>Bitte eine Minute warten.</p></div>'));
        return true;
      }
      try {
        const f = await formular(req);
        const aktion = f.get('aktion');
        const foto = f.datei && f.datei.daten.length ? fotoSpeichern(db, raum.id, f.datei.typ, f.datei.daten) : null;
        if (aktion === 'abhaken' || aktion === 'wieder_offen') {
          if (!rechte.abhaken) throw new RaumFehler(403, 'Sie dürfen keine Punkte abhaken.');
          punktStatus(db, raum, wer, f.get('punkt'), aktion === 'abhaken' ? 'erledigt' : 'offen');
          betriebPush(db, raum, raum.titel, `${t.name}: ${aktion === 'abhaken' ? 'Punkt erledigt' : 'Punkt wieder offen'}`);
        } else if (aktion === 'punkt') {
          if (!rechte.anlegen) throw new RaumFehler(403, 'Sie dürfen keine Punkte anlegen.');
          punktAnlegen(db, raum, wer, { titel: f.get('titel'), text: f.get('text') }, foto);
          betriebPush(db, raum, raum.titel, `${t.name}: neuer Punkt „${kurz(f.get('titel'), 60)}“`);
        } else if (aktion === 'notiz') {
          if (!rechte.schreiben) throw new RaumFehler(403, 'Sie dürfen keine Notizen schreiben.');
          const vertraulich = !!f.get('code');
          notizAnlegen(db, raum, wer, { text: f.get('text'), code: f.get('code'), bezeichnung: f.get('bezeichnung'), sichtbar: f.getAll('sichtbar'), tage: f.get('tage') }, foto);
          betriebPush(db, raum, raum.titel, vertraulich ? `${t.name} hat einen vertraulichen Hinweis hinterlegt` : `${t.name} hat eine Notiz geschrieben`);
        } else if (aktion === 'anzeigen') {
          code = { id: f.get('notiz'), wert: codeAnzeigen(db, raum, wer, f.get('notiz'), false) };
        }
        if (!code) {
          // Nach dem Schreiben neu laden (kein doppeltes Absenden beim Aktualisieren).
          res.writeHead(303, { location: `${basisFn()}/objekt/${schluessel}#${aktion === 'notiz' ? 'notizen' : 'punkte'}`, ...KOPF });
          res.end();
          return true;
        }
      } catch (e) {
        if (!(e instanceof RaumFehler)) throw e;
        meldung = e.message;
      }
    }
    seite(res, meldung ? 400 : 200, raumSeite(b, raum, t, rechte, ansicht(db, raum, wer), schluessel, { meldung, code }));
    return true;
  }

  return { weg, oeffentlich, postVerschicken, aufraeumen };
}

// ——— Seite ———

const KOPF = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const datum = (iso) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });

function seite(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'", ...KOPF });
  res.end(html);
}

const rahmenHtml = (titel, inhalt) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(titel)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;background:#f4f6f8;color:#111827}main{max-width:760px;margin:0 auto}
.karte{background:#fff;border-radius:12px;padding:18px;box-shadow:0 1px 4px #0001;margin-bottom:14px}h1{font-size:22px;margin:4px 0 6px}h2{font-size:17px;margin:0 0 10px}
.grau,small{color:#6b7280}.punkt{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid #eef0f3}.punkt:first-of-type{border-top:0}
.punkt .inhalt{flex:1}.erledigt .titel{text-decoration:line-through;color:#6b7280}.titel{font-weight:700}
button{font-size:15px;padding:9px 14px;border-radius:8px;border:1px solid #208aef;background:#208aef;color:#fff;font-weight:700;cursor:pointer}
button.neben{background:#fff;color:#208aef}input[type=text],input[type=email],textarea,select{width:100%;box-sizing:border-box;font-size:16px;padding:10px;border:1px solid #d1d5db;border-radius:8px;margin:4px 0 10px;font-family:inherit}
textarea{min-height:70px}label{font-size:14px;font-weight:600;color:#374151}img{max-width:100%;border-radius:8px;margin-top:6px}
.code{font-size:28px;font-weight:800;letter-spacing:2px;background:#fff7e6;border:1px solid #f5c26b;border-radius:10px;padding:10px 14px;display:inline-block;margin:6px 0}
.fehler{background:#fdecec;border:1px solid #f5b5b5;color:#9b1c1c;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-weight:700}
details summary{cursor:pointer;font-weight:700;color:#208aef;margin:6px 0}.marke{font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;background:#e8f2fe;color:#0b5fb8}</style></head>
<body><main>${inhalt}</main></body></html>`;

function raumSeite(b, raum, t, rechte, a, schluessel, { meldung, code }) {
  const offen = a.punkte.filter((p) => p.status === 'offen');
  const erledigt = a.punkte.filter((p) => p.status === 'erledigt');
  const namen = Object.fromEntries(a.teilnehmer.map((x) => [x.id, x.name]));
  const zustaendig = (z) => (!z ? '' : z === 'betrieb' ? b.name : namen[z] ?? '');
  const foto = (id) => (id ? `<img src="${esc(schluessel)}/foto/${esc(id)}" alt="Foto" loading="lazy">` : '');
  const punkt = (p) => `<div class="punkt${p.status === 'erledigt' ? ' erledigt' : ''}">
<div class="inhalt"><div class="titel">${esc(p.titel)}</div>${p.text ? `<div>${esc(p.text).replace(/\n/g, '<br>')}</div>` : ''}
<small>${esc(p.von)} · ${datum(p.erstellt)}${zustaendig(p.zustaendig) ? ` · zuständig: ${esc(zustaendig(p.zustaendig))}` : ''}${p.status === 'erledigt' ? ` · erledigt ${datum(p.erledigtAm)} von ${esc(p.erledigtVon)}` : ''}</small>${foto(p.foto)}</div>
${rechte.abhaken ? `<form method="post"><input type="hidden" name="punkt" value="${esc(p.id)}"><button name="aktion" value="${p.status === 'erledigt' ? 'wieder_offen' : 'abhaken'}" class="${p.status === 'erledigt' ? 'neben' : ''}">${p.status === 'erledigt' ? 'Wieder offen' : 'Erledigt'}</button></form>` : ''}</div>`;
  const notiz = (n) => {
    const kopf = `<small>${esc(n.von)} · ${datum(n.erstellt)}</small>`;
    if (!n.vertraulich) return `<div class="punkt"><div class="inhalt">${n.text ? `<div>${esc(n.text).replace(/\n/g, '<br>')}</div>` : ''}${kopf}${foto(n.foto)}</div></div>`;
    if (n.geloescht) return `<div class="punkt"><div class="inhalt"><span class="marke">Vertraulich</span> ${esc(n.bezeichnung)} — gelöscht.<br>${kopf}</div></div>`;
    const sichtbar = code?.id === n.id;
    return `<div class="punkt"><div class="inhalt"><span class="marke">Vertraulich</span> <strong>${esc(n.bezeichnung)}</strong>${n.text ? `<div>${esc(n.text)}</div>` : ''}
${sichtbar ? `<div class="code">${esc(code.wert)}</div>` : ''}<br><small>${esc(n.von)} · ${datum(n.erstellt)} · löscht sich am ${datum(n.loeschtAm)}</small></div>
${sichtbar ? '' : `<form method="post"><input type="hidden" name="notiz" value="${esc(n.id)}"><button name="aktion" value="anzeigen" class="neben">Anzeigen</button></form>`}</div>`;
  };
  const andere = a.teilnehmer.filter((x) => x.id !== t.id);
  const multipart = 'method="post" enctype="multipart/form-data"';
  return rahmenHtml(
    `${raum.titel} – ${b.name}`,
    `${meldung ? `<div class="fehler">${esc(meldung)}</div>` : ''}
<div class="karte"><small>${esc(b.name)} · gemeinsamer Bereich</small><h1>${esc(raum.titel)}</h1>${raum.objekt ? `<p>${esc(raum.objekt)}</p>` : ''}
<p class="grau">Sie sind hier als <strong>${esc(t.name)}</strong>${t.rolle === 'auftraggeber' ? ' (Auftraggeber)' : ''}. Beteiligt: ${esc([b.name, ...a.teilnehmer.map((x) => x.name)].join(', '))}.</p></div>
<div class="karte" id="punkte"><h2>Offen (${offen.length})</h2>${offen.map(punkt).join('') || '<p class="grau">Keine offenen Punkte.</p>'}
${rechte.anlegen ? `<details><summary>Neuer Punkt${t.rolle === 'auftraggeber' ? ' oder Mangel' : ''}</summary><form ${multipart}><input type="hidden" name="aktion" value="punkt">
<label>Was ist zu tun?</label><input type="text" name="titel" maxlength="160" required>
<label>Beschreibung</label><textarea name="text" maxlength="4000"></textarea>
<label>Foto (optional)</label><input type="file" name="foto" accept="image/jpeg,image/png,image/webp"><p><button>Punkt anlegen</button></p></form></details>` : ''}</div>
${erledigt.length ? `<div class="karte"><h2>Erledigt (${erledigt.length})</h2>${erledigt.map(punkt).join('')}</div>` : ''}
<div class="karte" id="notizen"><h2>Notizen</h2>${a.notizen.map(notiz).join('') || '<p class="grau">Noch keine Notizen.</p>'}
${rechte.schreiben ? `<details><summary>Notiz schreiben</summary><form ${multipart}><input type="hidden" name="aktion" value="notiz">
<label>Notiz</label><textarea name="text" maxlength="4000"></textarea>
<label>Foto (optional)</label><input type="file" name="foto" accept="image/jpeg,image/png,image/webp"><p><button>Notiz speichern</button></p></form></details>
<details><summary>Türcode oder Zugang mitteilen (vertraulich)</summary><form method="post"><input type="hidden" name="aktion" value="notiz">
<label>Wofür?</label><input type="text" name="bezeichnung" maxlength="80" placeholder="z. B. Türcode Haupteingang, Schlüsseltresor">
<label>Code</label><input type="text" name="code" maxlength="200" required autocomplete="off">
<label>Hinweis (optional)</label><input type="text" name="text" maxlength="400" placeholder="z. B. Tresor links neben der Tür">
<label>Wer darf ihn sehen? (${esc(b.name)} immer)</label>${andere.map((x) => `<div><label><input type="checkbox" name="sichtbar" value="${esc(x.id)}" checked> ${esc(x.name)}</label></div>`).join('') || '<p class="grau">Nur Sie und der Betrieb.</p>'}
<label>Löscht sich nach</label><select name="tage"><option value="1">1 Tag</option><option value="7">7 Tagen</option><option value="30" selected>30 Tagen</option><option value="90">90 Tagen</option></select>
<p class="grau">Der Code steht in keiner E-Mail. Wer ihn anzeigt, wird festgehalten.</p><p><button>Vertraulich speichern</button></p></form></details>` : ''}</div>
<p class="grau"><small>Gemeinsamer Bereich mit Montix. Ihr Link ist Ihr persönlicher Zugang — bitte nicht weitergeben. Verantwortlich: ${esc(b.name)}.</small></p>`,
  );
}

/** Formular lesen: urlencoded oder multipart (ein Foto). Grenze 12 MB. */
async function formular(req) {
  const teile = [];
  let n = 0;
  for await (const s of req) {
    n += s.length;
    if (n > 12 * MB) throw new RaumFehler(413, 'Zu groß (höchstens 10 MB je Foto)');
    teile.push(s);
  }
  const roh = Buffer.concat(teile);
  const typ = String(req.headers['content-type'] ?? '');
  const grenze = typ.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!grenze) {
    const p = new URLSearchParams(roh.toString('utf8'));
    p.datei = null;
    return p;
  }
  const trenner = Buffer.from(`--${grenze[1] ?? grenze[2]}`);
  const felder = new URLSearchParams();
  felder.datei = null;
  let pos = roh.indexOf(trenner);
  while (pos !== -1) {
    const start = pos + trenner.length + 2; // \r\n
    const ende = roh.indexOf(trenner, start);
    if (ende === -1) break;
    const teil = roh.subarray(start, ende - 2);
    const kopfEnde = teil.indexOf('\r\n\r\n');
    if (kopfEnde !== -1) {
      const kopf = teil.subarray(0, kopfEnde).toString('utf8');
      const inhalt = teil.subarray(kopfEnde + 4);
      const name = kopf.match(/name="([^"]*)"/)?.[1];
      const dateiname = kopf.match(/filename="([^"]*)"/);
      if (dateiname) {
        if (name === 'foto' && inhalt.length) felder.datei = { typ: kopf.match(/content-type:\s*([^\r\n;]+)/i)?.[1]?.trim().toLowerCase() ?? '', daten: inhalt };
      } else if (name) felder.append(name, inhalt.toString('utf8'));
    }
    pos = ende;
  }
  return felder;
}
