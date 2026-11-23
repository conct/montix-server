// Kartenzahlung mit dem Handy (Stripe Terminal, Tap to Pay) über das EIGENE Stripe-Konto des
// Betriebs — im Abgleich-Server, damit der Verwalter den Schlüssel in der App hinterlegen kann.
// Gleiche Wege wie der frühere Einzeldienst server/zahlung (die App ändert sich nicht):
//
//   GET  /zahlung/status      → { stripe, betrieb }
//   POST /terminal/token      → { secret }              Verbindungstoken fürs Stripe-SDK
//   POST /terminal/standort   → { id }                  Stripe-Standort (einmal angelegt)
//   POST /zahlung {betragCent, beschreibung}  → { id, clientSecret }
//   GET  /zahlung/:id         → { status, betragCent }
//   POST /zahlung/stripe {schluessel, standort}  (Verwalter) Schlüssel hinterlegen / entfernen
//
// Stripe wird direkt über die REST-Schnittstelle angesprochen (fetch), ohne Paket.
// Der geheime Schlüssel liegt verschlüsselt (AES-256-GCM, Instanzschlüssel) in der Datei des
// Betriebs und verlässt den Server nie — auch nicht im Export.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MIN_CENT = 50; // darunter lehnt Stripe ab
const MAX_CENT = 500000; // darüber eher ein Tippfehler

export class ZahlFehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

export function erstelleZahlung(ordner) {
  const memory = ordner === ':memory:';
  const datei = memory ? null : join(ordner, 'zahlung-schluessel.bin');
  let geheim;
  if (datei && existsSync(datei)) geheim = readFileSync(datei);
  else {
    geheim = randomBytes(32);
    if (datei) writeFileSync(datei, geheim, { mode: 0o600 });
  }

  const verschluesseln = (text) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', geheim, iv);
    const daten = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), daten]).toString('base64');
  };
  const entschluesseln = (b64) => {
    const roh = Buffer.from(b64, 'base64');
    const d = createDecipheriv('aes-256-gcm', geheim, roh.subarray(0, 12));
    d.setAuthTag(roh.subarray(12, 28));
    return Buffer.concat([d.update(roh.subarray(28)), d.final()]).toString('utf8');
  };

  const tabelle = (db) =>
    db.exec('create table if not exists zahlung (anbieter text primary key, schluessel text not null, standort text, angaben text, geaendert text not null)');

  function stripeDaten(db) {
    tabelle(db);
    const z = db.prepare("select * from zahlung where anbieter = 'stripe'").get();
    return z ? { schluessel: entschluesseln(z.schluessel), standort: z.standort, angaben: z.angaben ? JSON.parse(z.angaben) : null } : null;
  }

  async function stripe(schluessel, methode, pfad, params) {
    const body = params ? new URLSearchParams(params).toString() : undefined;
    const url = `https://api.stripe.com/v1${pfad}${methode === 'GET' && body ? `?${body}` : ''}`;
    let r;
    try {
      r = await fetch(url, {
        method: methode,
        headers: { authorization: `Bearer ${schluessel}`, ...(methode === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: methode === 'POST' ? body : undefined,
      });
    } catch {
      throw new ZahlFehler(502, 'Stripe ist nicht erreichbar.');
    }
    const daten = await r.json().catch(() => ({}));
    if (!r.ok) throw new ZahlFehler(r.status === 401 ? 400 : 502, `Stripe: ${daten?.error?.message ?? r.status}`);
    return daten;
  }

  async function standort(db, z) {
    if (z.standort) return z.standort;
    const liste = await stripe(z.schluessel, 'GET', '/terminal/locations', { limit: '100' });
    let id = liste.data?.find((l) => l.metadata?.montix === '1')?.id;
    if (!id) {
      const a = z.angaben ?? {};
      if (!a.strasse || !a.plz || !a.ort) throw new ZahlFehler(400, 'Für den Stripe-Standort fehlt die Anschrift (Firmendaten).');
      const neu = await stripe(z.schluessel, 'POST', '/terminal/locations', {
        display_name: a.name || 'Montix',
        'address[line1]': a.strasse,
        'address[postal_code]': a.plz,
        'address[city]': a.ort,
        'address[country]': 'DE',
        'metadata[montix]': '1',
      });
      id = neu.id;
    }
    db.prepare("update zahlung set standort = ? where anbieter = 'stripe'").run(id);
    return id;
  }

  /** Bearbeitet die Zahlungswege; gibt undefined zurück, wenn der Pfad nicht dazugehört. */
  async function zahlungsweg(methode, pfad, wer, koerper) {
    const zahlId = pfad.match(/^\/zahlung\/(pi_[A-Za-z0-9]+)$/)?.[1];
    const bekannt =
      zahlId ||
      ['/zahlung/status', '/terminal/token', '/terminal/standort', '/zahlung', '/zahlung/stripe'].includes(pfad);
    if (!bekannt) return undefined;
    const z = stripeDaten(wer.db);

    if (methode === 'GET' && pfad === '/zahlung/status') return { stripe: !!z, betrieb: wer.betrieb.name };

    if (methode === 'POST' && pfad === '/zahlung/stripe') {
      if (wer.mitarbeiter.rolle !== 'verwalter') throw new ZahlFehler(403, 'Den Stripe-Schlüssel hinterlegt nur ein Verwalter.');
      const { schluessel, standort: angaben } = await koerper();
      if (schluessel === null) {
        tabelle(wer.db);
        wer.db.prepare("delete from zahlung where anbieter = 'stripe'").run();
        return { stripe: false };
      }
      if (typeof schluessel !== 'string' || !/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(schluessel)) {
        throw new ZahlFehler(400, 'Das sieht nicht wie ein Stripe-Schlüssel aus (sk_… oder rk_…).');
      }
      // Probeaufruf: Rechte für Terminal vorhanden?
      await stripe(schluessel, 'GET', '/terminal/locations', { limit: '1' });
      tabelle(wer.db);
      wer.db
        .prepare("insert into zahlung values ('stripe', ?, null, ?, ?) on conflict (anbieter) do update set schluessel = excluded.schluessel, standort = null, angaben = excluded.angaben, geaendert = excluded.geaendert")
        .run(verschluesseln(schluessel), angaben ? JSON.stringify(angaben) : null, new Date().toISOString());
      return { stripe: true, test: schluessel.includes('_test_') };
    }

    if (!z) throw new ZahlFehler(503, 'Für diesen Betrieb ist kein Stripe-Schlüssel hinterlegt.');

    if (methode === 'POST' && pfad === '/terminal/token') {
      const t = await stripe(z.schluessel, 'POST', '/terminal/connection_tokens', {});
      return { secret: t.secret };
    }
    if (methode === 'POST' && pfad === '/terminal/standort') return { id: await standort(wer.db, z) };
    if (methode === 'POST' && pfad === '/zahlung') {
      const body = await koerper();
      const cent = Number(body.betragCent);
      if (!Number.isInteger(cent) || cent < MIN_CENT || cent > MAX_CENT) throw new ZahlFehler(400, 'Ungültiger Betrag.');
      const pi = await stripe(z.schluessel, 'POST', '/payment_intents', {
        amount: String(cent),
        currency: 'eur',
        'payment_method_types[]': 'card_present',
        capture_method: 'automatic',
        ...(typeof body.beschreibung === 'string' ? { description: body.beschreibung.slice(0, 200) } : {}),
        'metadata[montix]': '1',
        'metadata[betrieb]': wer.betrieb.id,
        'metadata[mitarbeiter]': wer.mitarbeiter.id,
      });
      return { id: pi.id, clientSecret: pi.client_secret };
    }
    if (methode === 'GET' && zahlId) {
      const pi = await stripe(z.schluessel, 'GET', `/payment_intents/${zahlId}`);
      if (pi.metadata?.montix !== '1' || pi.metadata?.betrieb !== wer.betrieb.id) throw new ZahlFehler(404, 'Unbekannter Vorgang.');
      return { status: pi.status, betragCent: pi.amount_received || pi.amount };
    }
    throw new ZahlFehler(404, 'Unbekannter Weg');
  }

  // Für das Kundenportal (Rechnung online bezahlen): Schlüssel des Betriebs und Aufruf der Stripe-Schnittstelle.
  zahlungsweg.stripeSchluessel = (db) => stripeDaten(db)?.schluessel ?? null;
  zahlungsweg.stripe = stripe;
  return zahlungsweg;
}
