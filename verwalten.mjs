// Verwaltung auf dem Server (Kommandozeile, kein Weg über das Netz):
//
//   node verwalten.mjs betrieb "Muster GmbH"                      → Betriebskennung
//   node verwalten.mjs betrieb-loeschen <betrieb>                 → alles des Betriebs löschen (unwiderruflich)
//   node verwalten.mjs einladung <betrieb> "Erika Muster" [verwalter|mitarbeiter]
//                                                                 → Einladungscode (7 Tage einlösbar, einmal)
//   node verwalten.mjs serverpaket <betrieb> an|aus               → gebuchtes Serverpaket (z. B. Mail-Takt einstellbar)
//   node verwalten.mjs modul <betrieb> kasse <anzahl>             → gebuchte Kassen (Barkasse mit TSE, 0 = abbestellt)
//   node verwalten.mjs nutzung <betrieb> [JJJJ-MM]                → Touren-Nutzung des Monats für die Rechnung (Fahrzeuge, Fremdfahrer-Touren)
//   node verwalten.mjs karte                                      → Kartendatei für die Touren-Karten holen oder aktualisieren
//   node verwalten.mjs adressen                                   → Adressdatei (Adresssuche, Orte der Tour-Stopps) holen oder aktualisieren
//   node verwalten.mjs hilfe                                      → offene Hilfe-Lücken als JSON (hilfe.mjs)
//   node verwalten.mjs hilfe-erledigt <schluessel> …              → Lücken abhaken, sobald ein eigener Text ausgeliefert ist
//
// Daten wie beim Dienst über MONTIX_DATEN (Vorgabe ./daten).
import { adressDatei, adressenHolen, ADRESSEN_QUELLE } from './adressen.mjs';
import { karteHolen, KARTE_QUELLE, kartenDatei } from './karte.mjs';
import { MODULE, modulAnzahl, modulSetzen } from './module.mjs';
import { tourenNutzung } from './touren.mjs';
import { geraeteDb } from './geraete.mjs';
import { lueckeErledigt, lueckenListe } from './hilfe.mjs';
import { hatServerpaket, serverpaketSetzen } from './raeume.mjs';
import { oeffneSpeicher } from './speicher.mjs';

const speicher = oeffneSpeicher(process.env.MONTIX_DATEN ?? './daten');
const [befehl, ...rest] = process.argv.slice(2);

const ordner = speicher.speicherOrt ?? process.env.MONTIX_DATEN ?? './daten';

if (befehl === 'hilfe') {
  const offen = lueckenListe(geraeteDb(ordner)).filter((l) => !l.erledigt);
  console.log(JSON.stringify(offen.map(({ schluessel, id, titel, pfad, sprache, plattform, anzahl, erst, zuletzt }) => ({ schluessel, id, titel, pfad, sprache, plattform, anzahl, erst, zuletzt })), null, 1));
} else if (befehl === 'hilfe-erledigt' && rest.length) {
  for (const s of rest) lueckeErledigt(geraeteDb(ordner), s);
  console.log(`${rest.length} abgehakt.`);
} else if (befehl === 'karte') {
  console.log(`Kartendatei (Deutschland, aus OpenStreetMap): ${KARTE_QUELLE} → ${kartenDatei()}`);
  try {
    await karteHolen();
  } catch (e) {
    console.log(`Fehler: ${e?.message ?? e}`);
    process.exit(1);
  }
} else if (befehl === 'adressen') {
  console.log(`Adressdatei (aus OpenStreetMap): ${ADRESSEN_QUELLE} → ${adressDatei()}`);
  try {
    await adressenHolen();
  } catch (e) {
    console.log(`Fehler: ${e?.message ?? e}`);
    process.exit(1);
  }
} else if (befehl === 'nutzung' && rest[0]) {
  const b = speicher.alleBetriebe().find((x) => x.id === rest[0]);
  if (!b) {
    console.log(`Kein Betrieb mit der Kennung ${rest[0]}.`);
    process.exit(1);
  }
  const monat = /^\d{4}-\d{2}$/.test(rest[1] ?? '') ? rest[1] : new Date().toISOString().slice(0, 7);
  const n = tourenNutzung(b.db, monat);
  const eur = (x) => x.toFixed(2).replace('.', ',') + ' €';
  console.log(`Touren ${b.name}, ${monat} (brutto):`);
  console.log(`  ${n.fahrzeuge} Fahrzeuge × ${eur(n.jeFahrzeug)} = ${eur(n.fahrzeuge * n.jeFahrzeug)}${n.kennzeichen.length ? `  (${n.kennzeichen.join(', ')})` : ''}`);
  for (const g of n.fremd) console.log(`  ${g.rolle === 'partner' ? 'Partner' : 'Fremdfahrer'} ${g.name}: ${g.touren} Touren = ${eur(g.betrag)}`);
  console.log(`  Summe ${eur(n.summe)}`);
} else if (befehl === 'betrieb' && rest[0]) {
  const id = speicher.betriebAnlegen(rest[0]);
  console.log(`Betrieb angelegt: ${rest[0]}\nKennung: ${id}\nNächster Schritt: node verwalten.mjs einladung ${id} "<Name>" verwalter`);
} else if (befehl === 'betrieb-loeschen' && rest[0]) {
  const name = speicher.betriebName(rest[0]);
  if (!name) {
    console.log(`Kein Betrieb mit der Kennung ${rest[0]}.`);
    process.exit(1);
  }
  if (rest[1] !== '--ja') {
    console.log(`Löscht „${name}“ (${rest[0]}) mit allen Daten, Mitarbeitern und Geräten. Das lässt sich nicht rückgängig machen.\nVorher sichern: GET /export als Verwalter. Zum Ausführen: node verwalten.mjs betrieb-loeschen ${rest[0]} --ja`);
    process.exit(1);
  }
  speicher.betriebLoeschen(rest[0]);
  console.log(`Gelöscht: ${name} (${rest[0]}). Sicherungen werden spätestens nach 30 Tagen überschrieben.`);
} else if (befehl === 'einladung' && rest[0] && rest[1]) {
  const e = speicher.einladen(rest[0], rest[1], rest[2] ?? 'mitarbeiter');
  console.log(`Einladungscode für ${rest[1]}: ${e.code}\nGültig bis ${e.gueltigBis.slice(0, 10)}, einmal einlösbar (App → Einstellungen → Abgleich).
Das Gerät bleibt danach dauerhaft angemeldet, bis es abgemeldet oder die Person gesperrt wird.`);
} else if (befehl === 'serverpaket' && rest[0] && ['an', 'aus'].includes(rest[1])) {
  const b = speicher.alleBetriebe().find((x) => x.id === rest[0]);
  if (!b) {
    console.log(`Kein Betrieb mit der Kennung ${rest[0]}.`);
    process.exit(1);
  }
  serverpaketSetzen(b.db, rest[1] === 'an');
  console.log(`Serverpaket für ${b.name}: ${hatServerpaket(b.db) ? 'an' : 'aus'}.`);
} else if (befehl === 'modul' && rest[0] && rest[1] in MODULE && /^\d{1,3}$/.test(rest[2] ?? '')) {
  const b = speicher.alleBetriebe().find((x) => x.id === rest[0]);
  if (!b) {
    console.log(`Kein Betrieb mit der Kennung ${rest[0]}.`);
    process.exit(1);
  }
  modulSetzen(b.db, rest[1], Number(rest[2]));
  const n = modulAnzahl(b.db, rest[1]);
  console.log(`${MODULE[rest[1]]} für ${b.name}: ${n ? `${n} gebucht` : 'nicht gebucht'}.`);
} else {
  console.log('Aufruf: node verwalten.mjs betrieb "<Name>" | betrieb-loeschen <betrieb> [--ja] | einladung <betrieb> "<Name>" [verwalter|mitarbeiter] | serverpaket <betrieb> an|aus | modul <betrieb> kasse|mehrplatz <anzahl> | modul <betrieb> enterprise 0|1|12 | nutzung <betrieb> [JJJJ-MM] | karte | adressen | hilfe | hilfe-erledigt <schluessel> …');
  process.exit(1);
}
