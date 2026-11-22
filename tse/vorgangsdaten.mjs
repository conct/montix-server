// Vorgangsdaten für die TSE — `processData` zum processType „Kassenbeleg-V1“.
// Übernommen aus CHOOZY (server/tse/vorgangsdaten.js), als ES-Modul.
//
// Diese Zeichenkette IST der Inhalt der Signatur: Was hier falsch steht, ist unwiderruflich falsch
// signiert. Deshalb steht sie in einer eigenen Datei ohne Netz und Datenbank, mit eigener Prüfung
// (test/tse.test.mjs). Format nach amtlicher DSFinV-K 2.4, Anhang I (BZSt):
//
//     <Vorgangstyp>^<Brutto-Steuerumsätze>^<Zahlungen>
//
//   - Trennzeichen ist das Dach (^).
//   - Steuerumsätze: FÜNF Beträge mit Unterstrich, immer zwei Nachkommastellen mit Punkt, auch
//     unbenutzte (0.00). Reihenfolge fest: 1. allgemeiner Satz (19 %, historisch 16 %),
//     2. ermäßigter Satz (7 %, historisch 5 %), 3. Durchschnittsatz § 24 Abs. 1 Nr. 3 UStG,
//     4. Durchschnittsatz § 24 Abs. 1 Nr. 1 UStG, 5. 0 % (nicht steuerbar, steuerfrei).
//   - Zahlungen: '<Betrag>:<Bar|Unbar>[:<Währung>]', verkettet mit Unterstrich; Währung nur, wenn
//     nicht EUR. Zahlungen über 0.00 entfallen. Reihenfolge: Bar EUR, Bar fremd, Unbar EUR, Unbar fremd.
//
// Ein Storno ist KEIN eigener Vorgangstyp — 'AVBelegstorno' darf mit TSE ausdrücklich nicht
// verwendet werden (DSFinV-K Tz. 4.2.1/4.2.2). Ein Storno ist ein Beleg mit negativen Beträgen.

/** Welcher Steuercontainer gehört zu welchem Satz? */
export const CONTAINER = [
  { nummer: 0, saetze: [19, 16] },
  { nummer: 1, saetze: [7, 5] },
  { nummer: 2, saetze: [10.7, 9.5, 9, 8.4] },
  { nummer: 3, saetze: [5.5] },
  { nummer: 4, saetze: [0] },
];

/** Zahlarten der Kasse auf „Bar“ oder „Unbar“ — die TSE kennt nur diese beiden. */
export const ZAHLART = { bar: 'Bar', unbar: 'Unbar', karte: 'Unbar' };

/**
 * Zwei Dezimalstellen, Punkt, zur Null hin abgeschnitten statt gerundet. Vorher auf sechs Stellen
 * gerundet, damit Gleitkomma-Reste (0.29 * 100 = 28.999…) keinen Cent verschlucken.
 */
export function betrag(wert) {
  const cent = Math.trunc(Math.round((Number(wert) || 0) * 1e6) / 1e4);
  return (cent === 0 ? 0 : cent / 100).toFixed(2);
}

function containerFuer(satz) {
  const gefunden = CONTAINER.find((e) => e.saetze.includes(Number(satz)));
  // Ein unbekannter Satz landet nicht still im Nullcontainer — das wäre eine falsche Aussage über
  // einen steuerpflichtigen Umsatz.
  if (!gefunden) throw new Error(`Unbekannter Steuersatz für die TSE: ${satz}`);
  return gefunden.nummer;
}

/**
 * processData bauen.
 * @param {{ vorgangstyp?: string, steuer?: Array<[number, number]>, zahlungen?: Array<{betrag:number, art:string, waehrung?:string}> }} angaben
 */
export function vorgangsdaten({ vorgangstyp = 'Beleg', steuer = [], zahlungen = [] } = {}) {
  const container = [0, 0, 0, 0, 0];
  for (const [satz, brutto] of steuer) container[containerFuer(satz)] += Number(brutto) || 0;
  const summen = container.map((w) => betrag(w)).join('_');

  // Zahlungen derselben Art und Währung addieren, Nullbeträge weglassen, dann sortieren.
  const gesammelt = new Map();
  for (const z of zahlungen) {
    const art = ZAHLART[String(z.art)] ?? (z.art === 'Bar' || z.art === 'Unbar' ? z.art : 'Unbar');
    const waehrung = String(z.waehrung || 'EUR').toUpperCase();
    const schluessel = `${art}:${waehrung}`;
    gesammelt.set(schluessel, (gesammelt.get(schluessel) || 0) + (Number(z.betrag) || 0));
  }
  const rang = (art, waehrung) => (art === 'Bar' ? (waehrung === 'EUR' ? 0 : 1) : waehrung === 'EUR' ? 2 : 3);
  const zeilen = [...gesammelt.entries()]
    .map(([schluessel, summe]) => {
      const [art, waehrung] = schluessel.split(':');
      return { art, waehrung, summe };
    })
    .filter((e) => betrag(e.summe) !== '0.00')
    .sort((a, b) => rang(a.art, a.waehrung) - rang(b.art, b.waehrung) || a.waehrung.localeCompare(b.waehrung))
    .map((e) => `${betrag(e.summe)}:${e.art}${e.waehrung === 'EUR' ? '' : `:${e.waehrung}`}`);

  return `${vorgangstyp}^${summen}^${zeilen.join('_')}`;
}

/** Aus einem gebuchten Kassenvorgang: Steuer je Satz (brutto) und eine Zahlung über den Umsatz. */
export function ausVorgang(vorgang) {
  const steuer = Array.isArray(vorgang?.steuerBrutto) ? vorgang.steuerBrutto : [];
  return vorgangsdaten({
    vorgangstyp: 'Beleg',
    steuer,
    zahlungen: [{ betrag: Number(vorgang?.umsatz) || 0, art: String(vorgang?.art || 'bar') }],
  });
}
