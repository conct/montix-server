// Start: MONTIX_DATEN=<ordner> PORT=8790 node index.mjs
import { erstelleDienst } from './dienst.mjs';
import { kachelnDa } from './karte.mjs';
import { oeffneSpeicher } from './speicher.mjs';

const ordner = process.env.MONTIX_DATEN ?? './daten';
const port = Number(process.env.PORT ?? 8790);

erstelleDienst(oeffneSpeicher(ordner)).listen(port, '0.0.0.0', () => {
  console.log(`montix-abgleich auf Port ${port}, Daten in ${ordner}`);
  if (!kachelnDa()) console.log('Hinweis: Keine Kartendatei — die Touren-Karten laden ihre Kacheln von OpenStreetMap. Eigene Karten: node verwalten.mjs karte');
});
