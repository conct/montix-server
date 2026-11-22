// DSFinV-K-Export der Barkasse — die Kassendaten so, wie Betriebsprüfung und Kassen-Nachschau sie
// verlangen (§ 146b AO): je Kassenabschluss die Dateien der DSFinV-K 2.4 plus die amtliche
// index.xml und ihre DTD, als ZIP. Nach CHOOZY server/werkzeug/dsfinvk-export.js, umgeschrieben auf
// node:sqlite und die Montix-Tabellen kasse_abschluesse, kasse_belege, kasse_kassen.
//
// Es wird nichts neu gerechnet und nichts verändert: Der Export liest Abschlüsse und Belege.
//
// SPALTEN, LÄNGEN UND NACHKOMMASTELLEN KOMMEN AUS DER AMTLICHEN index.xml (BZSt, DSFinV-K 2.4) —
// genau diese Datei liegt dem Export bei, so können Index und Dateien nicht auseinanderlaufen.
// Dezimaltrennzeichen ist das Komma, Felder mit Semikolon, Zeilenende CRLF, UTF-8.
//
// ZUORDNUNGEN, DIE DIE STEUERBERATUNG ANSEHEN SOLLTE (eine Stelle, hier):
//   1. UST_SCHLUESSEL: 19 % → 1, 7 % → 2, 0 % → 5 (andere Sätze kennt die Barkasse nicht).
//   2. ZAHLART_TYP: 'bar' → Bar, 'unbar' → Unbar (Kartenzahlung über Stripe/SumUp).
//   3. GV_TYP: Ware und Leistung 'Umsatz', ausgegebenes Pfand 'Pfand', zurückgenommenes Leergut
//      'PfandRueckzahlung' (Position art 'pfand' bzw. 'leergut', siehe kasse.mjs). Pfand folgt dem
//      USt-Satz der Ware. Ein Storno ist ein Beleg mit negativen Beträgen (BON_STORNO 1) und
//      verweist in references.csv auf den stornierten Beleg.
//   4. Z_KASSE_ID = Kassen-ID (K1 …), KASSE_SERIENNR = fiskaly-Client der Kasse.

import { deflateRawSync, crc32 } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stammZeilen, transaktionsZeile } from './tse-zeilen.mjs';

const ORDNER = dirname(fileURLToPath(import.meta.url));
export const INDEX_DATEI = join(ORDNER, 'index.xml');
export const DTD_DATEI = join(ORDNER, 'gdpdu-01-09-2004.dtd');

const UST_SCHLUESSEL = { 19: 1, 7: 2, 0: 5 };
const ZAHLART = { bar: 'Bar', unbar: 'Unbar' };
export const ustSchluessel = (satz) => UST_SCHLUESSEL[Number(satz)] ?? 7;
const zahlartTyp = (art) => ZAHLART[String(art)] ?? 'Keine';

/** Zeit ohne Millisekunden (ISO 8601, UTC). */
const alsZeit = (iso) => (iso ? new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z') : '');
/** Buchungstag nach deutscher Zeit. */
const alsTag = (iso) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(iso));

/** Ein Feld für die CSV: Text in Anführungszeichen, wenn nötig. */
function feld(wert) {
  if (wert === null || wert === undefined) return '';
  const text = String(wert);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Dateien und Spalten aus der amtlichen index.xml: je Spalte Name, Länge (Text) oder
 * Nachkommastellen (Zahl). Ein schlichter Mustervergleich statt eines XML-Lesers — die Datei ist flach.
 */
export function dateienAusIndex(text = readFileSync(INDEX_DATEI, 'utf8')) {
  const dateien = {};
  for (const block of text.split('<Table>').slice(1)) {
    const url = block.match(/<URL>([^<]+)<\/URL>/)?.[1];
    if (!url) continue;
    const spalten = [...block.matchAll(/<VariableColumn>([\s\S]*?)<\/VariableColumn>/g)].map(([, inhalt]) => ({
      name: inhalt.match(/<Name>([^<]+)<\/Name>/)[1],
      max: Number(inhalt.match(/<MaxLength>(\d+)<\/MaxLength>/)?.[1]) || null,
      genau: inhalt.includes('<Numeric') ? Number(inhalt.match(/<Accuracy>(\d+)<\/Accuracy>/)?.[1] ?? 0) : null,
    }));
    dateien[url] = { name: url, spalten, zeilen: [] };
  }
  return dateien;
}

/** Eine Zeile schreiben: Zahlen mit den Nachkommastellen der index.xml und Komma, Texte auf ihre Länge gekürzt. */
function schreibe(datei, werte) {
  datei.zeilen.push(
    datei.spalten
      .map((s) => {
        const w = werte[s.name];
        if (w === undefined || w === null || w === '') return '';
        if (s.genau !== null && typeof w === 'number') return s.genau ? w.toFixed(s.genau).replace('.', ',') : String(Math.round(w));
        return feld(s.max ? String(w).slice(0, s.max) : w);
      })
      .join(';'),
  );
}

/** Geschäftsvorfall einer Position (DSFinV-K 2.4, Anhang: GV_TYP). */
export const gvTyp = (p) => (p.art === 'pfand' ? 'Pfand' : p.art === 'leergut' ? 'PfandRueckzahlung' : 'Umsatz');

const csv = (d) => Buffer.from(`${[d.spalten.map((s) => s.name).join(';'), ...d.zeilen].join('\r\n')}\r\n`, 'utf8');
const euro = (cent) => Math.round(cent) / 100;
/** Laufende Nummer aus der Belegnummer (KB-K1-2026-0042 → 42). */
const bonNr = (nummer) => Number(String(nummer).split('-').at(-1)) || '';

/**
 * Die DSFinV-K-Dateien für die gegebenen Abschlüsse.
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db
 * @param {object[]} o.abschluesse  Zeilen aus kasse_abschluesse
 * @param {{ name: string, strasse: string, plz: string, ort: string, land?: string, stnr?: string, ustid?: string }} o.firma
 * @param {Map<string, object>} [o.stamm]  Kassen-ID → tse.stammdaten()
 * @param {string} [o.version]  Software-Version für cashregister.csv
 * @returns {{ name: string, daten: Buffer }[]}
 */
export function dsfinvkDateien({ db, abschluesse, firma, stamm = new Map(), version = 'Montix' }) {
  const d = dateienAusIndex();
  const kasse = (id) => db.prepare('select * from kasse_kassen where id = ?').get(id);
  /** Abschluss, in dem ein Beleg (lfd) einer Kasse liegt. */
  const abschlussVon = (kasseId, lfd) => db.prepare('select z_nummer from kasse_abschluesse where kasse = ? and von_lfd < ? and bis_lfd >= ?').get(kasseId, lfd, lfd);
  let belegeGesamt = 0;

  for (const a of abschluesse) {
    const summen = JSON.parse(a.summen);
    const k = kasse(a.kasse);
    const schluessel = { Z_KASSE_ID: a.kasse, Z_ERSTELLUNG: alsZeit(a.erstellt), Z_NR: a.z_nummer };

    schreibe(d['cashpointclosing.csv'], {
      ...schluessel,
      Z_BUCHUNGSTAG: alsTag(a.bis),
      TAXONOMIE_VERSION: '2.4',
      Z_START_ID: summen.ersterBeleg ?? '',
      Z_ENDE_ID: summen.letzterBeleg ?? '',
      NAME: firma.name,
      STRASSE: firma.strasse,
      PLZ: firma.plz,
      ORT: firma.ort,
      LAND: firma.land ?? 'DEU',
      STNR: firma.stnr ?? '',
      USTID: firma.ustid ?? '',
      Z_SE_ZAHLUNGEN: euro(summen.umsatzCent),
      Z_SE_BARZAHLUNGEN: euro(summen.jeZahlart.bar ?? 0),
    });
    schreibe(d['location.csv'], { ...schluessel, LOC_NAME: firma.name, LOC_STRASSE: firma.strasse, LOC_PLZ: firma.plz, LOC_ORT: firma.ort, LOC_LAND: firma.land ?? 'DEU', LOC_USTID: firma.ustid ?? '' });
    schreibe(d['cashregister.csv'], {
      ...schluessel,
      KASSE_BRAND: 'Montix',
      KASSE_MODELL: `App-Kasse ${k?.name ?? a.kasse}`,
      KASSE_SERIENNR: k?.client_id ?? a.kasse,
      KASSE_SW_BRAND: 'Montix',
      KASSE_SW_VERSION: version,
      KASSE_BASISWAEH_CODE: 'EUR',
      KEINE_UST_ZUORDNUNG: '0',
    });
    // Einzelaufzeichnung: genau die Belege dieses Abschlusses (über die Zeilennummer, wie der Abschluss selbst).
    const belege = db.prepare('select * from kasse_belege where kasse = ? and lfd > ? and lfd <= ? order by lfd').all(a.kasse, a.von_lfd, a.bis_lfd);
    for (const s of summen.jeSatz) schreibe(d['vat.csv'], { ...schluessel, UST_SCHLUESSEL: ustSchluessel(s.satz), UST_SATZ: s.satz, UST_BESCHR: `${s.satz} % USt` });
    // Geschäftsvorfälle je Art und Satz aus den Positionen (Umsatz, Pfand, Pfandrückzahlung).
    const vorfaelle = new Map();
    for (const b of belege) {
      for (const p of JSON.parse(b.positionen)) {
        const key = `${gvTyp(p)}|${p.satz}`;
        vorfaelle.set(key, (vorfaelle.get(key) ?? 0) + p.betragCent);
      }
    }
    const GV_REIHE = ['Umsatz', 'Pfand', 'PfandRueckzahlung'];
    const liste = [...vorfaelle.entries()].map(([key, brutto]) => {
      const [gv, satzText] = key.split('|');
      return { gv, satz: Number(satzText), brutto };
    });
    liste.sort((x, y) => GV_REIHE.indexOf(x.gv) - GV_REIHE.indexOf(y.gv) || y.satz - x.satz);
    for (const { gv, satz, brutto } of liste) {
      const netto = Math.round((brutto * 100) / (100 + satz));
      schreibe(d['businesscases.csv'], { ...schluessel, GV_TYP: gv, AGENTUR_ID: 0, UST_SCHLUESSEL: ustSchluessel(satz), Z_UMS_BRUTTO: euro(brutto), Z_UMS_NETTO: euro(netto), Z_UST: euro(brutto - netto) });
    }
    for (const art of ['bar', 'unbar']) {
      if (summen.jeZahlart[art]) schreibe(d['payment.csv'], { ...schluessel, ZAHLART_TYP: zahlartTyp(art), ZAHLART_NAME: art === 'bar' ? 'Bar' : 'Karte', Z_ZAHLART_BETRAG: euro(summen.jeZahlart[art]) });
    }
    schreibe(d['cash_per_currency.csv'], { ...schluessel, ZAHLART_WAEH: 'EUR', ZAHLART_BETRAG_WAEH: euro(summen.jeZahlart.bar ?? 0) });

    belegeGesamt += belege.length;
    const tseIdJeSerie = new Map();
    for (const z of stammZeilen(belege, stamm.get(a.kasse) ?? {})) {
      tseIdJeSerie.set(z.TSE_SERIAL, z.TSE_ID);
      schreibe(d['tse.csv'], { ...schluessel, ...z });
    }

    for (const b of belege) {
      const bon = { ...schluessel, BON_ID: b.nummer };
      const storno = b.art === 'storno' ? '1' : '0';
      schreibe(d['transactions.csv'], {
        ...bon,
        BON_NR: bonNr(b.nummer),
        BON_TYP: 'Beleg',
        TERMINAL_ID: b.kasse,
        BON_STORNO: storno,
        BON_START: alsZeit(b.tse_start ?? b.beginn ?? b.erstellt),
        BON_ENDE: alsZeit(b.tse_ende ?? b.erstellt),
        BEDIENER_ID: b.mitarbeiter,
        BEDIENER_NAME: b.mitarbeiter_name,
        UMS_BRUTTO: euro(b.summe_cent),
        BON_NOTIZ: [b.tse_status === 'signiert' ? '' : `ohne TSE (${b.tse_status}${b.tse_fehler ? `: ${b.tse_fehler}` : ''})`, b.grund ? `Storno-Grund: ${b.grund}` : ''].filter(Boolean).join(' · '),
      });
      schreibe(d['allocation_groups.csv'], { ...bon, ABRECHNUNGSKREIS: b.kasse });
      const tz = transaktionsZeile(b, tseIdJeSerie);
      if (tz) schreibe(d['transactions_tse.csv'], { ...bon, ...tz });
      schreibe(d['datapayment.csv'], { ...bon, ZAHLART_TYP: zahlartTyp(b.zahlart), ZAHLART_NAME: b.zahlart === 'bar' ? 'Bar' : 'Karte', ZAHLWAEH_CODE: 'EUR', ZAHLWAEH_BETRAG: euro(b.summe_cent), BASISWAEH_BETRAG: euro(b.summe_cent) });

      // Ein Storno zeigt auf seinen Ursprung: welcher Beleg, aus welchem Abschluss, von welcher Kasse.
      if (b.storno_von) {
        const alt = db.prepare('select nummer, kasse, erstellt, lfd from kasse_belege where nummer = ?').get(b.storno_von);
        if (alt) {
          schreibe(d['references.csv'], {
            ...bon,
            REF_TYP: 'Transaktion',
            REF_NAME: 'Storno',
            REF_DATUM: alsZeit(alt.erstellt),
            REF_Z_KASSE_ID: alt.kasse,
            REF_Z_NR: abschlussVon(alt.kasse, alt.lfd)?.z_nummer ?? '',
            REF_BON_ID: alt.nummer,
          });
        }
      }

      // Steuer je Satz: aus dem Beleg (dort aus den Positionen gerechnet), nicht neu.
      for (const s of JSON.parse(b.steuer)) {
        schreibe(d['transactions_vat.csv'], { ...bon, UST_SCHLUESSEL: ustSchluessel(s.satz), BON_BRUTTO: euro(s.bruttoCent), BON_NETTO: euro(s.nettoCent), BON_UST: euro(s.ustCent) });
      }
      JSON.parse(b.positionen).forEach((p, i) => {
        const netto = Math.round((p.betragCent * 100) / (100 + p.satz));
        schreibe(d['lines.csv'], {
          ...bon,
          POS_ZEILE: String(i + 1),
          ARTIKELTEXT: p.text,
          POS_TERMINAL_ID: b.kasse,
          GV_TYP: gvTyp(p),
          INHAUS: '0',
          P_STORNO: storno,
          AGENTUR_ID: 0,
          ART_NR: p.artikel ?? '',
          MENGE: p.menge,
          FAKTOR: 1,
          EINHEIT: 'Stk',
          STK_BR: euro(p.preisCent),
        });
        schreibe(d['lines_vat.csv'], { ...bon, POS_ZEILE: String(i + 1), UST_SCHLUESSEL: ustSchluessel(p.satz), POS_BRUTTO: euro(p.betragCent), POS_NETTO: euro(netto), POS_UST: euro(p.betragCent - netto) });
      });
    }
  }

  return {
    belege: belegeGesamt,
    dateien: [
      ...Object.values(d).map((x) => ({ name: x.name, daten: csv(x), zeilen: x.zeilen.length })),
      { name: 'index.xml', daten: readFileSync(INDEX_DATEI) },
      { name: 'gdpdu-01-09-2004.dtd', daten: readFileSync(DTD_DATEI) },
    ],
  };
}

/**
 * ZIP ohne fremdes Paket (Deflate aus node:zlib, Prüfsumme crc32). Dateinamen in UTF-8 (Bit 11).
 * @param {{ name: string, daten: Buffer }[]} dateien
 */
export function zip(dateien, zeit = new Date()) {
  const dosZeit = (zeit.getHours() << 11) | (zeit.getMinutes() << 5) | Math.floor(zeit.getSeconds() / 2);
  const dosDatum = ((zeit.getFullYear() - 1980) << 9) | ((zeit.getMonth() + 1) << 5) | zeit.getDate();
  const teile = [];
  const verzeichnis = [];
  let versatz = 0;
  for (const f of dateien) {
    const name = Buffer.from(f.name, 'utf8');
    const gepackt = deflateRawSync(f.daten);
    const pruef = crc32(f.daten) >>> 0;
    const kopf = Buffer.alloc(30);
    kopf.writeUInt32LE(0x04034b50, 0);
    kopf.writeUInt16LE(20, 4);
    kopf.writeUInt16LE(0x0800, 6);
    kopf.writeUInt16LE(8, 8);
    kopf.writeUInt16LE(dosZeit, 10);
    kopf.writeUInt16LE(dosDatum, 12);
    kopf.writeUInt32LE(pruef, 14);
    kopf.writeUInt32LE(gepackt.length, 18);
    kopf.writeUInt32LE(f.daten.length, 22);
    kopf.writeUInt16LE(name.length, 26);
    kopf.writeUInt16LE(0, 28);
    teile.push(kopf, name, gepackt);
    const zentral = Buffer.alloc(46);
    zentral.writeUInt32LE(0x02014b50, 0);
    zentral.writeUInt16LE(20, 4);
    zentral.writeUInt16LE(20, 6);
    zentral.writeUInt16LE(0x0800, 8);
    zentral.writeUInt16LE(8, 10);
    zentral.writeUInt16LE(dosZeit, 12);
    zentral.writeUInt16LE(dosDatum, 14);
    zentral.writeUInt32LE(pruef, 16);
    zentral.writeUInt32LE(gepackt.length, 20);
    zentral.writeUInt32LE(f.daten.length, 24);
    zentral.writeUInt16LE(name.length, 28);
    zentral.writeUInt32LE(versatz, 42);
    verzeichnis.push(zentral, name);
    versatz += kopf.length + name.length + gepackt.length;
  }
  const vz = Buffer.concat(verzeichnis);
  const ende = Buffer.alloc(22);
  ende.writeUInt32LE(0x06054b50, 0);
  ende.writeUInt16LE(dateien.length, 8);
  ende.writeUInt16LE(dateien.length, 10);
  ende.writeUInt32LE(vz.length, 12);
  ende.writeUInt32LE(versatz, 16);
  return Buffer.concat([...teile, vz, ende]);
}
