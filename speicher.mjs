// Speicher des Abgleich-Servers: eine SQLite-Datei je Betrieb (eigene Daten, einfache
// Sicherung, Selbstbetrieb ohne Datenbankserver) plus ein kleines Verzeichnis aller Betriebe.
// node:sqlite ist in Node 24 eingebaut — keine fremden Pakete.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Was die App abgleichen darf. Alles andere weist der Server ab. */
export const SAMMLUNGEN = ['kunden', 'artikel', 'termine', 'plaene', 'berichte', 'unterschriften', 'belege', 'sprachnotizen', 'schritte', 'aktionen', 'zeichnungen', 'lager', 'etiketten', 'ankuenfte', 'leergut', 'lieferanten', 'bestellungen', 'touren', 'tourereignisse', 'zeiten', 'wartungen', 'projekte', 'bautagebuch', 'inventar', 'pruefungen', 'unterweisungen', 'gefaehrdungen', 'nachweise', 'verbandbuch', 'gefahrstoffe', 'roh', 'dateien'];

/** Kennung eines NFC-Etiketts (UID) einheitlich: Großbuchstaben, nur Hex-Ziffern. */
export const kennungNorm = (k) => String(k ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');

/** Zeichen ohne Verwechslungsgefahr (kein 0/O, 1/I/L) — Codes werden abgetippt. */
const ZEICHEN = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const hash = (s) => createHash('sha256').update(s).digest('hex');

export function zufallsCode(gruppen = 3, laenge = 4) {
  const b = randomBytes(gruppen * laenge);
  const z = [...b].map((x) => ZEICHEN[x % ZEICHEN.length]).join('');
  return z.match(new RegExp(`.{${laenge}}`, 'g')).join('-');
}

const jetzt = () => new Date().toISOString();

/** Nummernkreise je Art und Jahr (über POST /nummer). */
export const PRAEFIX = { angebot: 'AN', lieferschein: 'LS', rechnung: 'RE' };

/**
 * Präfix zu einer Art. Dazu kommt je Kasse ein eigener Kreis `kassenbeleg:<Kassen-ID>` →
 * „KB-<Kassen-ID>“. Den vergibt nur die Barkasse (kasse.mjs) selbst, in derselben Transaktion, in
 * der sie den Beleg speichert — nie über POST /nummer, sonst könnte eine Nummer ohne Beleg entstehen.
 */
const praefixVon = (art) => PRAEFIX[art] ?? (/^kassenbeleg:[A-Z0-9]{1,8}$/.test(art) ? `KB-${art.slice(12)}` : null);

/**
 * Nächste Nummer vergeben, OHNE eigene Transaktion — der Aufrufer hält sie (begin immediate).
 * Gleicher Beleg, gleiche Nummer (idempotent).
 */
export function naechsteNummer(db, belegId, art, jahr) {
  const praefix = praefixVon(art);
  if (!praefix) throw new Error('Ungültige Angaben');
  const da = db.prepare('select nummer from vergeben where beleg = ?').get(belegId);
  if (da) return da.nummer;
  const z = db.prepare('select letzte from nummern where art = ? and jahr = ?').get(art, jahr);
  const n = (z?.letzte ?? 0) + 1;
  db.prepare('insert into nummern values (?, ?, ?) on conflict (art, jahr) do update set letzte = excluded.letzte').run(art, jahr, n);
  const nummer = `${praefix}-${jahr}-${String(n).padStart(4, '0')}`;
  db.prepare('insert into vergeben values (?, ?, ?, ?)').run(belegId, art, nummer, jetzt());
  return nummer;
}

export function oeffneSpeicher(ordner) {
  const memory = ordner === ':memory:';
  if (!memory) mkdirSync(ordner, { recursive: true });
  const datei = (name) => (memory ? ':memory:' : join(ordner, name));

  const verzeichnis = new DatabaseSync(datei('betriebe.db'));
  verzeichnis.exec(`
    pragma journal_mode = wal;
    create table if not exists betriebe (id text primary key, name text not null, erstellt text not null);
    create table if not exists einladungen (
      code_hash text primary key, betrieb text not null, mitarbeiter text not null,
      gueltig_bis text not null, benutzt text
    );
  `);
  // art: 'betrieb' (Standard) oder 'privat' — Einzelperson, die nur die Alleinarbeit nutzt.
  try {
    verzeichnis.exec("alter table betriebe add column art text not null default 'betrieb'");
  } catch {
    // schon vorhanden
  }

  // Schlüssel zum Signieren der Rechte (Ed25519), je Instanz. Die Geräte bekommen den öffentlichen
  // Teil bei der Anmeldung und prüfen die Rechte damit auch ohne Netz.
  const schluesselDatei = memory ? null : join(ordner, 'rechte-schluessel.pem');
  let privat;
  if (schluesselDatei && existsSync(schluesselDatei)) privat = createPrivateKey(readFileSync(schluesselDatei, 'utf8'));
  else {
    privat = generateKeyPairSync('ed25519').privateKey;
    if (schluesselDatei) writeFileSync(schluesselDatei, privat.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  // Rohform (32 Byte) des öffentlichen Schlüssels, Base64 — so erwartet ihn @noble/curves.
  const oeffentlich = Buffer.from(createPublicKey(privat).export({ format: 'jwk' }).x, 'base64url').toString('base64');

  const offen = new Map();
  /** Datenbank eines Betriebs, beim ersten Zugriff angelegt. */
  function betrieb(id) {
    if (!/^[a-z0-9]{6,32}$/.test(id)) throw new Error('Ungültige Betriebskennung');
    let db = offen.get(id);
    if (db) return db;
    db = new DatabaseSync(datei(`betrieb-${id}.db`));
    db.exec(`
      pragma journal_mode = wal;
      create table if not exists stand (schluessel text primary key, wert integer not null);
      insert or ignore into stand values ('rev', 0);
      create table if not exists mitarbeiter (
        id text primary key, name text not null, rolle text not null default 'mitarbeiter',
        aktiv integer not null default 1, erstellt text not null
      );
      create table if not exists geraete (
        token_hash text primary key, mitarbeiter text not null, name text not null,
        erstellt text not null, zuletzt text
      );
      create table if not exists daten (
        sammlung text not null, id text not null, inhalt text, geloescht integer not null default 0,
        geaendert text not null, rev integer not null, von text,
        primary key (sammlung, id)
      );
      create index if not exists daten_rev on daten (rev);
      create table if not exists nummern (art text not null, jahr integer not null, letzte integer not null, primary key (art, jahr));
      create table if not exists vergeben (beleg text primary key, art text not null, nummer text not null, vergeben text not null);
      create table if not exists vertrag (fassung text not null, zugestimmt text not null, von text not null, name text not null);
    `);
    // Spalten nachrüsten (ältere Dateien): freigegebene Bereiche (null = alle) und Stammdaten.
    // fuer: bei Empfängern (Angehörige) die Person, deren Alarme sie bekommen.
    for (const spalte of ['bereiche', 'kuerzel', 'telefon', 'email', 'farbe', 'fuer']) {
      try {
        db.exec(`alter table mitarbeiter add column ${spalte} text`);
      } catch {
        // schon vorhanden
      }
    }
    offen.set(id, db);
    return db;
  }

  function inTransaktion(db, f) {
    db.exec('begin immediate');
    try {
      const r = f();
      db.exec('commit');
      return r;
    } catch (e) {
      db.exec('rollback');
      throw e;
    }
  }

  return {
    speicherOrt: ordner,
    oeffentlicherSchluessel: oeffentlich,

    /**
     * Rechte eines Mitarbeiters als signierter Text: Rolle und freigegebene Bereiche. Der Text wird
     * genau so signiert und übertragen, damit das Gerät ihn ohne Umformen prüfen kann.
     */
    signierteRechte(betriebId, m) {
      const text = JSON.stringify({
        v: 1,
        betrieb: betriebId,
        mitarbeiter: m.id,
        name: m.name,
        rolle: m.rolle,
        bereiche: m.bereiche ? JSON.parse(m.bereiche) : null,
        ausgestellt: jetzt(),
      });
      return { text, signatur: sign(null, Buffer.from(text, 'utf8'), privat).toString('base64') };
    },

    /**
     * Stammdaten eines Mitarbeiters ändern (Verwalter). Der letzte Verwalter kann nicht zum
     * Mitarbeiter werden — sonst könnte niemand mehr den Betrieb verwalten.
     */
    mitarbeiterDaten(db, id, d) {
      const m = db.prepare('select * from mitarbeiter where id = ?').get(id);
      if (!m) return 'unbekannt';
      const rolle = d.rolle === 'verwalter' || d.rolle === 'mitarbeiter' ? d.rolle : m.rolle;
      if (m.rolle === 'verwalter' && rolle === 'mitarbeiter') {
        const verwalter = db.prepare("select count(*) as n from mitarbeiter where rolle = 'verwalter' and aktiv = 1").get().n;
        if (verwalter <= 1) return 'letzter';
      }
      const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
      db.prepare('update mitarbeiter set name = ?, rolle = ?, kuerzel = ?, telefon = ?, email = ?, farbe = ? where id = ?').run(
        text(d.name, 80) || m.name,
        rolle,
        text(d.kuerzel, 6) ?? m.kuerzel,
        text(d.telefon, 40) ?? m.telefon,
        text(d.email, 120) ?? m.email,
        typeof d.farbe === 'string' && /^(#[0-9a-fA-F]{6})?$/.test(d.farbe) ? d.farbe : m.farbe,
        id,
      );
      return 'ok';
    },

    rechteSetzen(db, id, bereiche) {
      const wert = bereiche === null ? null : JSON.stringify(bereiche);
      return db.prepare('update mitarbeiter set bereiche = ? where id = ?').run(wert, id).changes > 0;
    },

    /**
     * Ganzen Betrieb löschen (Vertrag zur Auftragsverarbeitung: binnen 14 Tagen ab Verlangen):
     * Datei samt -wal/-shm, Eintrag im Verzeichnis, offene Einladungen. Geräte sind damit abgemeldet.
     */
    betriebLoeschen(id) {
      if (!this.betriebName(id)) return false;
      const db = offen.get(id);
      if (db) {
        db.close();
        offen.delete(id);
      }
      verzeichnis.prepare('delete from einladungen where betrieb = ?').run(id);
      verzeichnis.prepare('delete from betriebe where id = ?').run(id);
      if (!memory) for (const endung of ['', '-wal', '-shm']) {
        const f = datei(`betrieb-${id}.db${endung}`);
        if (existsSync(f)) rmSync(f);
      }
      return true;
    },

    /** Dieses eine Gerät abmelden (über sein eigenes Token). */
    geraetAbmelden(db, token) {
      return db.prepare('delete from geraete where token_hash = ?').run(hash(token)).changes > 0;
    },

    /**
     * Eine Person samt Geräten, Push-Zielen, Notfallkontakten, Empfängern und Alleinarbeit entfernen.
     * Datensätze, die sie im Betrieb angelegt hat (Kunden, Berichte …), gehören dem Betrieb und bleiben.
     */
    personLoeschen(db, id) {
      for (const sql of [
        'delete from geraete where mitarbeiter = ?',
        "delete from geraete where mitarbeiter in (select id from mitarbeiter where fuer = ? and rolle = 'empfaenger')",
        "delete from mitarbeiter where fuer = ? and rolle = 'empfaenger'",
      ])
        db.prepare(sql).run(id);
      // Freigaben bleiben (sie gehören dem Betrieb), tragen aber nicht mehr den Namen der Person.
      try {
        db.prepare("update freigaben set von_name = 'gelöscht' where von = ?").run(id);
      } catch {
        // Tabelle gibt es (noch) nicht
      }
      // Gemeinsame Bereiche: Einträge bleiben (sie gehören zum Objekt), ohne den Namen der Person.
      try {
        const name = db.prepare('select name from mitarbeiter where id = ?').get(id)?.name;
        db.prepare("update raum_punkte set von_name = 'gelöscht' where von = ?").run(`betrieb:${id}`);
        db.prepare("update raum_notizen set von_name = 'gelöscht' where von = ?").run(`betrieb:${id}`);
        if (name) {
          db.prepare("update raum_punkte set erledigt_von = 'gelöscht' where erledigt_von like ?").run(`% (${name})`);
          db.prepare("update raum_einsichten set wer = 'gelöscht' where wer like ?").run(`% (${name})`);
        }
      } catch {
        // Tabelle gibt es (noch) nicht
      }
      for (const t of ['notfallkontakte', 'alleinarbeit', 'push'])
        try {
          db.prepare(`delete from ${t} where mitarbeiter = ?`).run(id);
        } catch {
          // Tabelle gibt es (noch) nicht
        }
      db.prepare("delete from daten where sammlung = 'schritte' and substr(id, 1, ?) = ?").run(id.length + 1, `${id}_`);
      // Ausweiskarten der Person aus dem Etikettenregister nehmen (als Grabstein, damit die Geräte es erfahren).
      const karten = db
        .prepare("select id, inhalt from daten where sammlung = 'etiketten' and geloescht = 0")
        .all()
        .filter((z) => {
          const e = JSON.parse(z.inhalt);
          return e?.art === 'ausweis' && e.ziel === id;
        });
      if (karten.length) this.schreiben(db, id, karten.map((z) => ({ sammlung: 'etiketten', id: z.id, geaendert: jetzt(), geloescht: true })));
      db.prepare("update mitarbeiter set aktiv = 0, name = 'gelöscht', kuerzel = null, telefon = null, email = null where id = ?").run(id);
    },

    /** Gesamter Bestand eines Betriebs als ein Objekt — zum Herausholen vor einer Löschung. */
    export(db, betriebId) {
      const daten = db.prepare('select sammlung, id, inhalt, geaendert from daten where geloescht = 0 order by sammlung, id').all();
      const sammlungen = {};
      for (const z of daten) (sammlungen[z.sammlung] ??= []).push({ id: z.id, geaendert: z.geaendert, inhalt: JSON.parse(z.inhalt) });
      return {
        dienst: 'montix-abgleich',
        exportiert: jetzt(),
        betrieb: { id: betriebId, name: this.betriebName(betriebId) },
        vertrag: this.vertrag(db),
        mitarbeiter: db.prepare('select id, name, rolle, aktiv, erstellt from mitarbeiter order by name').all(),
        sammlungen,
      };
    },

    /** Zustimmung zum Vertrag zur Auftragsverarbeitung (Art. 28 Abs. 9 DSGVO, elektronisch). */
    vertrag(db) {
      return db.prepare('select fassung, zugestimmt, von, name from vertrag order by zugestimmt desc limit 1').get() ?? null;
    },
    vertragZustimmen(db, fassung, mitarbeiter) {
      db.prepare('insert into vertrag values (?, ?, ?, ?)').run(fassung, jetzt(), mitarbeiter.id, mitarbeiter.name);
      return this.vertrag(db);
    },

    betriebAnlegen(name) {
      const id = randomBytes(6).toString('hex');
      verzeichnis.prepare('insert into betriebe (id, name, erstellt) values (?, ?, ?)').run(id, name, jetzt());
      betrieb(id);
      return id;
    },

    betriebName(id) {
      return verzeichnis.prepare('select name from betriebe where id = ?').get(id)?.name;
    },

    betriebArt(id) {
      return verzeichnis.prepare('select art from betriebe where id = ?').get(id)?.art ?? 'betrieb';
    },

    /** Alle Betriebe mit ihrer Datenbank — für den Zeitgeber der Alleinarbeit. */
    alleBetriebe() {
      return verzeichnis.prepare('select id, name, art, erstellt from betriebe').all().map((b) => ({ ...b, db: betrieb(b.id) }));
    },

    /**
     * Privates Konto für eine Einzelperson, nur für die Alleinarbeit (Einzelplatz ohne Betrieb):
     * Ein-Personen-Betrieb der Art „privat“, die Person ist ihr eigener Verwalter, das Gerät ist
     * sofort angemeldet. Ihre übrigen Daten gleicht sie nicht ab — das sperrt der Dienst.
     */
    privatAnlegen(name, geraetName) {
      const id = randomBytes(6).toString('hex');
      verzeichnis.prepare("insert into betriebe (id, name, erstellt, art) values (?, ?, ?, 'privat')").run(id, name, jetzt());
      const { code } = this.einladen(id, name, 'verwalter', 1);
      return this.anmelden(code, geraetName);
    },

    /** Empfänger (z. B. Angehörige) für eine Person einladen — sieht nur deren Alleinarbeits-Alarme. */
    empfaengerEinladen(betriebId, fuer, name, tage = 7) {
      const db = betrieb(betriebId);
      const id = `em_${randomBytes(5).toString('hex')}`;
      db.prepare("insert into mitarbeiter (id, name, rolle, erstellt, fuer, bereiche) values (?, ?, 'empfaenger', ?, ?, ?)").run(id, name, jetzt(), fuer, JSON.stringify(['alleinarbeit']));
      const code = zufallsCode();
      const bis = new Date(Date.now() + tage * 86400000).toISOString();
      verzeichnis.prepare('insert into einladungen values (?, ?, ?, ?, null)').run(hash(code), betriebId, id, bis);
      return { code, mitarbeiter: id, gueltigBis: bis };
    },

    empfaengerListe(db, fuer) {
      return db
        .prepare("select m.id, m.name, m.erstellt, (select count(*) from geraete g where g.mitarbeiter = m.id) as geraete from mitarbeiter m where m.rolle = 'empfaenger' and m.fuer = ? and m.aktiv = 1 order by m.name")
        .all(fuer);
    },

    empfaengerEntfernen(db, fuer, id) {
      db.prepare('delete from geraete where mitarbeiter = ?').run(id);
      return db.prepare("update mitarbeiter set aktiv = 0 where id = ? and fuer = ? and rolle = 'empfaenger'").run(id, fuer).changes > 0;
    },

    /** Mitarbeiter anlegen (oder vorhandenen nehmen) und einen Einladungscode für ein Gerät ausgeben. */
    einladen(betriebId, name, rolle = 'mitarbeiter', tage = 7) {
      if (!this.betriebName(betriebId)) throw new Error('Unbekannter Betrieb');
      if (!['verwalter', 'mitarbeiter', 'fremdfahrer', 'partner'].includes(rolle)) throw new Error('Rolle ist verwalter, mitarbeiter, fremdfahrer oder partner');
      const db = betrieb(betriebId);
      let m = db.prepare('select id from mitarbeiter where name = ?').get(name);
      if (!m) {
        m = { id: `ma_${randomBytes(5).toString('hex')}` };
        db.prepare('insert into mitarbeiter (id, name, rolle, erstellt) values (?, ?, ?, ?)').run(m.id, name, rolle, jetzt());
      } else db.prepare('update mitarbeiter set rolle = ?, aktiv = 1 where id = ?').run(rolle, m.id);
      // Fremdfahrer sehen in der App nur Touren und Nachrichten (der Server filtert die Daten zusätzlich).
      if (rolle === 'fremdfahrer' || rolle === 'partner') db.prepare('update mitarbeiter set bereiche = ? where id = ?').run(JSON.stringify(['touren', 'nachrichten']), m.id);
      const code = zufallsCode();
      const bis = new Date(Date.now() + tage * 86400000).toISOString();
      verzeichnis.prepare('insert into einladungen values (?, ?, ?, ?, null)').run(hash(code), betriebId, m.id, bis);
      return { code, mitarbeiter: m.id, gueltigBis: bis };
    },

    /** Einladungscode einlösen: einmalig, mit Frist. Gibt das Geräte-Token zurück. */
    anmelden(code, geraetName) {
      const norm = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g)?.join('-') ?? '';
      const e = verzeichnis.prepare('select * from einladungen where code_hash = ?').get(hash(norm));
      if (!e || e.benutzt || e.gueltig_bis < jetzt()) return null;
      const db = betrieb(e.betrieb);
      const m = db.prepare('select * from mitarbeiter where id = ? and aktiv = 1').get(e.mitarbeiter);
      if (!m) return null;
      verzeichnis.prepare('update einladungen set benutzt = ? where code_hash = ?').run(jetzt(), e.code_hash);
      const token = `${e.betrieb}.${randomBytes(24).toString('base64url')}`;
      db.prepare('insert into geraete values (?, ?, ?, ?, null)').run(hash(token), m.id, String(geraetName ?? 'Gerät').slice(0, 80), jetzt());
      return {
        token,
        betrieb: { id: e.betrieb, name: this.betriebName(e.betrieb), art: this.betriebArt(e.betrieb) },
        mitarbeiter: { id: m.id, name: m.name, rolle: m.rolle },
        pruefschluessel: oeffentlich,
        rechte: this.signierteRechte(e.betrieb, m),
      };
    },

    /** Geräte-Token prüfen; gibt Betrieb und Mitarbeiter zurück oder null. */
    pruefe(token) {
      const betriebId = String(token ?? '').split('.')[0];
      if (!this.betriebName(betriebId)) return null;
      const db = betrieb(betriebId);
      const g = db.prepare('select * from geraete where token_hash = ?').get(hash(token));
      if (!g) return null;
      const m = db.prepare('select * from mitarbeiter where id = ? and aktiv = 1').get(g.mitarbeiter);
      if (!m) return null;
      db.prepare('update geraete set zuletzt = ? where token_hash = ?').run(jetzt(), g.token_hash);
      return { db, betrieb: { id: betriebId, name: this.betriebName(betriebId), art: this.betriebArt(betriebId) }, mitarbeiter: { id: m.id, name: m.name, rolle: m.rolle, ...(m.fuer ? { fuer: m.fuer } : {}) }, roh: m };
    },

    /** Mitarbeiter mit ihren Geräten — für die Verwaltung in der App. Geräte nur über eine Kurzkennung. */
    mitarbeiterListe(db) {
      const geraete = db.prepare('select substr(token_hash, 1, 12) as id, mitarbeiter, name, erstellt, zuletzt from geraete order by erstellt').all();
      return db
        .prepare("select id, name, rolle, aktiv, erstellt, bereiche, kuerzel, telefon, email, farbe from mitarbeiter where rolle != 'empfaenger' order by name")
        .all()
        .map((m) => ({
          id: m.id,
          name: m.name,
          rolle: m.rolle,
          aktiv: !!m.aktiv,
          kuerzel: m.kuerzel ?? '',
          telefon: m.telefon ?? '',
          email: m.email ?? '',
          farbe: m.farbe ?? '',
          bereiche: m.bereiche ? JSON.parse(m.bereiche) : null,
          geraete: geraete.filter((g) => g.mitarbeiter === m.id).map(({ mitarbeiter: _, ...g }) => g),
        }));
    },

    /** Mitarbeiter sperren oder wieder zulassen; gesperrt gelten seine Geräte-Tokens nicht mehr. */
    /**
     * Fremdfahrer und Partnerbetriebe („Andere Firmen“ → Firmen, die für uns arbeiten): mit Stand
     * der letzten Einladung (offen bis … / eingelöst) und Zahl der angemeldeten Geräte.
     */
    gaesteListe(db) {
      const letzte = verzeichnis.prepare('select gueltig_bis, benutzt from einladungen where mitarbeiter = ? order by gueltig_bis desc limit 1');
      return db
        .prepare("select m.id, m.name, m.rolle, m.aktiv, m.erstellt, (select count(*) from geraete g where g.mitarbeiter = m.id) as geraete from mitarbeiter m where m.rolle in ('fremdfahrer', 'partner') order by m.name")
        .all()
        .map((m) => {
          const e = letzte.get(m.id);
          return { id: m.id, name: m.name, rolle: m.rolle, aktiv: !!m.aktiv, geraete: m.geraete, einladung: e ? { bis: e.gueltig_bis, eingeloest: e.benutzt ?? null } : null };
        });
    },

    mitarbeiterAktiv(db, id, aktiv) {
      return db.prepare('update mitarbeiter set aktiv = ? where id = ?').run(aktiv ? 1 : 0, id).changes > 0;
    },

    /** Ein Gerät abmelden (z. B. verloren); der Mitarbeiter bleibt und kann neu eingeladen werden. */
    geraetEntfernen(db, kurz) {
      if (!/^[0-9a-f]{12}$/.test(kurz)) return false;
      return db.prepare('delete from geraete where substr(token_hash, 1, 12) = ?').run(kurz).changes > 0;
    },

    /**
     * Änderungen eines Geräts übernehmen. Die jüngere Änderung gewinnt (Zeitstempel des Geräts);
     * Löschungen bleiben als Grabstein stehen, damit andere Geräte sie mitbekommen.
     */
    schreiben(db, von, aenderungen) {
      return inTransaktion(db, () => {
        let rev = db.prepare("select wert from stand where schluessel = 'rev'").get().wert;
        const alt = db.prepare('select geaendert from daten where sammlung = ? and id = ?');
        const setze = db.prepare(
          'insert into daten values (?, ?, ?, ?, ?, ?, ?) on conflict (sammlung, id) do update set inhalt = excluded.inhalt, geloescht = excluded.geloescht, geaendert = excluded.geaendert, rev = excluded.rev, von = excluded.von',
        );
        const verworfen = [];
        let uebernommen = 0;
        for (const a of aenderungen) {
          const vorher = alt.get(a.sammlung, a.id);
          if (vorher && vorher.geaendert >= a.geaendert) {
            verworfen.push({ sammlung: a.sammlung, id: a.id });
            continue;
          }
          rev += 1;
          setze.run(a.sammlung, a.id, a.geloescht ? null : JSON.stringify(a.inhalt), a.geloescht ? 1 : 0, a.geaendert, rev, von);
          uebernommen += 1;
        }
        db.prepare("update stand set wert = ? where schluessel = 'rev'").run(rev);
        return { rev, uebernommen, verworfen };
      });
    },

    /** Alles nach der Abholmarke `seit`, höchstens `grenze` Einträge. */
    lesen(db, seit, grenze = 500, bytes = 4_000_000) {
      const alle = db.prepare('select * from daten where rev > ? order by rev limit ?').all(seit, grenze + 1);
      // Höchstens `bytes` je Antwort (Bilder), aber immer mindestens ein Eintrag.
      let summe = 0;
      let n = 0;
      while (n < Math.min(alle.length, grenze) && (n === 0 || summe + (alle[n].inhalt?.length ?? 0) <= bytes)) summe += alle[n++].inhalt?.length ?? 0;
      const mehr = alle.length > n;
      const liste = alle.slice(0, n).map((z) => ({
        sammlung: z.sammlung,
        id: z.id,
        geloescht: !!z.geloescht,
        geaendert: z.geaendert,
        rev: z.rev,
        ...(z.geloescht ? {} : { inhalt: JSON.parse(z.inhalt) }),
      }));
      const rev = liste.length ? liste[liste.length - 1].rev : db.prepare("select wert from stand where schluessel = 'rev'").get().wert;
      return { rev: Math.max(rev, seit), mehr, aenderungen: liste };
    },

    /**
     * Belegnummer vergeben — nur hier, damit sie im Betrieb eindeutig und lückenlos bleibt,
     * auch wenn mehrere Geräte offline waren. Gleicher Beleg, gleiche Nummer (idempotent).
     */
    nummer(db, belegId, art, jahr) {
      if (!PRAEFIX[art] || !Number.isInteger(jahr) || jahr < 2000 || jahr > 2200) throw new Error('Ungültige Angaben');
      return inTransaktion(db, () => naechsteNummer(db, belegId, art, jahr));
    },

    /**
     * Mitarbeiterausweis nachschlagen (NFC-Karte → Person). Das Etikettenregister ist eine
     * abgeglichene Sammlung; hier entscheidet der Server mit dem aktuellen Stand: unbekannte,
     * gesperrte Karten und gesperrte Personen werden abgelehnt.
     */
    ausweis(db, kennung) {
      const id = kennungNorm(kennung);
      if (!id) return 'unbekannt';
      const z = db.prepare("select inhalt from daten where sammlung = 'etiketten' and id = ? and geloescht = 0").get(id);
      const e = z ? JSON.parse(z.inhalt) : null;
      if (!e || e.art !== 'ausweis' || typeof e.ziel !== 'string') return 'unbekannt';
      if (e.gesperrt) return 'gesperrt';
      const m = db.prepare("select id, name, aktiv from mitarbeiter where id = ? and rolle != 'empfaenger'").get(e.ziel);
      if (!m) return 'unbekannt';
      if (!m.aktiv) return 'inaktiv';
      return { id: m.id, name: m.name };
    },

    /** Nummernstand übernehmen, z. B. wenn ein Einzelplatz-Gerät in den Betrieb wechselt. */
    nummernMindestens(db, art, jahr, letzte) {
      db.prepare('insert into nummern values (?, ?, ?) on conflict (art, jahr) do update set letzte = max(letzte, excluded.letzte)').run(art, jahr, letzte);
    },
  };
}
