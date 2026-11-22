// Verwaltung auf dem Server (Kommandozeile, kein Weg über das Netz):
//
//   node verwalten.mjs betrieb "Muster GmbH"                      → Betriebskennung
//   node verwalten.mjs betrieb-loeschen <betrieb>                 → alles des Betriebs löschen (unwiderruflich)
//   node verwalten.mjs einladung <betrieb> "Erika Muster" [verwalter|mitarbeiter]
//                                                                 → Einladungscode (7 Tage einlösbar, einmal)
//   node verwalten.mjs serverpaket <betrieb> an|aus               → gebuchtes Serverpaket (z. B. Mail-Takt einstellbar)
//   node verwalten.mjs modul <betrieb> kasse <anzahl>             → gebuchte Kassen (Barkasse mit TSE, 0 = abbestellt)
//
// Daten wie beim Dienst über MONTIX_DATEN (Vorgabe ./daten).
import { MODULE, modulAnzahl, modulSetzen } from './module.mjs';
import { hatServerpaket, serverpaketSetzen } from './raeume.mjs';
import { oeffneSpeicher } from './speicher.mjs';

const speicher = oeffneSpeicher(process.env.MONTIX_DATEN ?? './daten');
const [befehl, ...rest] = process.argv.slice(2);

if (befehl === 'betrieb' && rest[0]) {
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
  console.log('Aufruf: node verwalten.mjs betrieb "<Name>" | betrieb-loeschen <betrieb> [--ja] | einladung <betrieb> "<Name>" [verwalter|mitarbeiter] | serverpaket <betrieb> an|aus | modul <betrieb> kasse <anzahl>');
  process.exit(1);
}
