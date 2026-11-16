// Fehler melden aus der App: Beschreibung, Angaben zu Gerät und Version, bis zu drei
// Bildschirmfotos — als E-Mail an den Support (ANBIETER.support). Geht auch ohne Anmeldung
// (Einzelplatz); mit Gerät-Token steht der Betrieb dabei. Gespeichert wird nichts.
//
//   POST /fehler {text, info?, email?, bilder?: [{name, typ, daten(base64)}]} → { ok: true }

import { ANBIETER } from './mailvorlage.mjs';

const MAX_BILDER = 3;
const MAX_BILD = 3 * 1024 * 1024;
const TYPEN = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const emailOk = (e) => typeof e === 'string' && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e) && e.length <= 200;

class MeldeFehler extends Error {
  constructor(text, status = 400) {
    super(text);
    this.status = status;
  }
}

/** Prüft die Meldung und schickt sie per `senden` an den Support. */
export function fehlerMelden(k, wer, senden) {
  const text = String(k?.text ?? '').trim().slice(0, 5000);
  if (text.length < 3) throw new MeldeFehler('Bitte kurz beschreiben, was passiert ist.');
  const email = k?.email ? String(k.email).trim() : '';
  if (email && !emailOk(email)) throw new MeldeFehler('Die E-Mail-Adresse für Rückfragen sieht nicht richtig aus.');
  const info = k?.info && typeof k.info === 'object' ? k.info : {};
  const infoZeilen = Object.entries(info)
    .slice(0, 30)
    .map(([a, b]) => `${String(a).slice(0, 40)}: ${String(b ?? '').slice(0, 200)}`);
  const bilder = Array.isArray(k?.bilder) ? k.bilder : [];
  if (bilder.length > MAX_BILDER) throw new MeldeFehler(`Höchstens ${MAX_BILDER} Bildschirmfotos.`);
  const anhaenge = bilder.map((b, i) => {
    const endung = TYPEN[b?.typ];
    if (!endung) throw new MeldeFehler('Bildschirmfotos als JPEG, PNG oder WebP.');
    const daten = Buffer.from(String(b.daten ?? ''), 'base64');
    if (!daten.length || daten.length > MAX_BILD) throw new MeldeFehler('Ein Bildschirmfoto ist leer oder größer als 3 MB.');
    return { name: `bildschirmfoto-${i + 1}.${endung}`, typ: b.typ, daten };
  });
  const absender = wer ? `${wer.mitarbeiter.name} (${wer.betrieb.name}, ${wer.mitarbeiter.rolle})` : 'ohne Betrieb (Einzelplatz)';
  const erste = text.split('\n')[0].slice(0, 60);
  const mail = [
    `Fehlermeldung aus Montix — ${absender}`,
    email ? `Rückfragen an: ${email}` : 'Keine Adresse für Rückfragen angegeben.',
    '',
    text,
    '',
    '— Gerät und Version —',
    ...infoZeilen,
    '',
    anhaenge.length ? `${anhaenge.length} Bildschirmfoto(s) im Anhang.` : 'Ohne Bildschirmfoto.',
  ].join('\n');
  senden([{ name: 'Montix Support', email: ANBIETER.support }], { betreff: `Montix-Fehler: ${erste}`, text: mail, anhaenge, antwortAn: email || undefined });
  return { ok: true };
}
