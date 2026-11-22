// Start: MONTIX_DATEN=<ordner> PORT=8790 node index.mjs
import { datenPruefen } from './datenstand.mjs';
import { erstelleDienst } from './dienst.mjs';
import { adressenDa } from './adressen.mjs';
import { kachelnDa } from './karte.mjs';
import { oeffneSpeicher } from './speicher.mjs';

const ordner = process.env.MONTIX_DATEN ?? './daten';
const port = Number(process.env.PORT ?? 8790);

erstelleDienst(oeffneSpeicher(ordner)).listen(port, '0.0.0.0', () => {
  console.log(`montix-abgleich auf Port ${port}, Daten in ${ordner}`);
  // Eigener Server: gleich beim Start einmal nach neuen Karten-/Adressdaten sehen.
  if (process.env.MONTIX_VERTRAG !== 'pflicht') setTimeout(() => void datenPruefen(), 30_000).unref?.();
  if (!adressenDa()) console.log('Hinweis: Keine Adressdatei — keine Adressvorschläge und keine Orte für Tour-Stopps. Holen: node verwalten.mjs adressen');
  if (!kachelnDa()) console.log('Hinweis: Keine Kartendatei — die Touren-Karten laden ihre Kacheln von OpenStreetMap. Eigene Karten: node verwalten.mjs karte');
});
