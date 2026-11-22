// Touren an einen Partnerbetrieb weitergeben (Verbund Server zu Server, docs/ideen.md).
//
// Spedition (Server A) teilt eine Tour einem Partnerbetrieb zu (`partnerId` an der Tour; der
// Partner ist dort ein Konto mit Rolle 'partner', eingeladen wie ein Fremdfahrer). Der Disponent
// des Partners sieht die Tour in seiner App über die Verbindung zu A und übernimmt sie in den
// EIGENEN Betrieb (Server B):
//
//   POST /touren/uebernehmen {adresse, token, tour}  → legt bei B eine Kopie an und merkt die Weiterleitung
//   POST /touren/weiterleitung/ende {tour}            → Weiterleitung beenden (Kopie bleibt)
//
// Danach teilt B die Tour einem eigenen Fahrer zu. Was dessen Gerät meldet (Ereignisse, Position),
// schickt B jede Minute an A weiter — mit dem Konto des Partners bei A, also nur für die Touren,
// die A diesem Partner gegeben hat. Änderungen der Spedition an Stopps holt B von A und übernimmt
// sie in die Kopie (Fahrer, Fahrzeug und Notiz bleiben die des Partners).
//
// Der Zugang des Partners bei A liegt nur auf dem eigenen Server des Partners, nicht auf Geräten
// seiner Fahrer. A sieht von B nichts außer dieser einen Tour.

import { createHash } from 'node:crypto';

import { darfDispo } from './touren.mjs';

export class PartnerFehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

function tabellen(db) {
  db.exec(`
    create table if not exists weiterleitung (
      lokal text primary key, adresse text not null, token text not null, fern text not null,
      fern_ich text not null, fern_betrieb text, rev integer not null default 0, ort_zeit text, erstellt text not null, ende text
    );
    create table if not exists weiter_gesendet (ereignis text primary key, zeit text not null);
  `);
}

const ID = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function fern(holen, adresse, token, pfad, body) {
  const r = await holen(`${adresse}${pfad}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const daten = await r.json().catch(() => ({}));
  if (!r.ok) throw new PartnerFehler(r.status === 401 ? 403 : 502, daten?.fehler ?? `Server der Spedition antwortet mit ${r.status}`);
  return daten;
}

/** Felder, die der Partner selbst pflegt und die ein Abgleich von der Spedition nicht überschreibt. */
const EIGEN = ['fahrerId', 'fahrerName', 'kennzeichen', 'anhaenger', 'notiz', 'status'];

function kopie(fernTour, lokalId, vorher, herkunft) {
  const neu = { ...fernTour, id: lokalId, partnerId: undefined, partnerName: undefined, herkunft };
  for (const k of EIGEN) if (vorher && vorher[k] !== undefined) neu[k] = vorher[k];
  if (!vorher) {
    delete neu.fahrerId;
    delete neu.fahrerName;
    neu.status = 'geplant';
  }
  return neu;
}

export function erstellePartner({ speicher, holen = fetch }) {
  async function weg(methode, pfad, wer, koerper) {
    if (pfad !== '/touren/uebernehmen' && pfad !== '/touren/weiterleitung/ende') return undefined;
    if (methode !== 'POST') return undefined;
    const ich = { ...wer.mitarbeiter, bereiche: wer.roh?.bereiche ?? null };
    if (!darfDispo(ich)) throw new PartnerFehler(403, 'Nur die Disposition übernimmt Touren.');
    const db = wer.db;
    tabellen(db);
    const k = (await koerper()) ?? {};

    if (pfad === '/touren/weiterleitung/ende') {
      db.prepare('update weiterleitung set ende = ? where lokal = ?').run(new Date().toISOString(), String(k.tour ?? ''));
      return { ok: true };
    }

    const adresse = String(k.adresse ?? '').replace(/\/+$/, '');
    const token = String(k.token ?? '');
    const fernTour = k.tour;
    if (!/^https?:\/\//.test(adresse) || !token || !fernTour?.id || !Array.isArray(fernTour.stopps)) throw new PartnerFehler(400, 'Angaben fehlen');
    // Zugang prüfen: Das Konto bei der Spedition muss diese Tour sehen dürfen.
    const fernIch = await fern(holen, adresse, token, '/ich');
    if (fernIch?.mitarbeiter?.rolle !== 'partner') throw new PartnerFehler(403, 'Die Verbindung ist kein Partnerzugang der Spedition.');
    const lokal = `p_${ID(`${adresse}|${fernTour.id}`)}`;
    const vorher = db.prepare("select inhalt from daten where sammlung = 'touren' and id = ? and geloescht = 0").get(lokal);
    const inhalt = kopie(fernTour, lokal, vorher ? JSON.parse(vorher.inhalt) : null, { adresse, tour: fernTour.id, betrieb: fernIch.betrieb?.name ?? '' });
    speicher.schreiben(db, wer.mitarbeiter.id, [{ sammlung: 'touren', id: lokal, geaendert: new Date().toISOString(), geloescht: false, inhalt }]);
    db.prepare(
      `insert into weiterleitung (lokal, adresse, token, fern, fern_ich, fern_betrieb, erstellt) values (?, ?, ?, ?, ?, ?, ?)
       on conflict (lokal) do update set token = excluded.token, fern_ich = excluded.fern_ich, ende = null`,
    ).run(lokal, adresse, token, fernTour.id, fernIch.mitarbeiter.id, fernIch.betrieb?.name ?? null, new Date().toISOString());
    return { id: lokal };
  }

  /** Einmal je Minute (Zeitgeber): Meldungen und Position weiterleiten, Änderungen der Spedition holen. */
  async function weiterleiten() {
    for (const b of speicher.alleBetriebe()) {
      tabellen(b.db);
      for (const w of b.db.prepare('select * from weiterleitung where ende is null').all()) {
        try {
          await eineWeiterleiten(b.db, w);
        } catch (e) {
          console.error('Partner-Weiterleitung', w.lokal, e?.message ?? e);
        }
      }
    }
  }

  async function eineWeiterleiten(db, w) {
    // 1. Meldungen der eigenen Fahrer zur Kopie → an die Spedition (als Partner, Absender = Partnerkonto).
    const ereignisse = db
      .prepare("select id, inhalt, geaendert from daten where sammlung = 'tourereignisse' and geloescht = 0 and json_extract(inhalt, '$.tourId') = ?")
      .all(w.lokal)
      .filter((z) => !db.prepare('select 1 from weiter_gesendet where ereignis = ?').get(z.id));
    if (ereignisse.length) {
      const aenderungen = ereignisse.map((z) => {
        const e = JSON.parse(z.inhalt);
        const id = `p${ID(`${w.lokal}|${e.id}`)}`;
        return { sammlung: 'tourereignisse', id, geaendert: z.geaendert, inhalt: { ...e, id, tourId: w.fern, von: w.fern_ich, vonName: e.vonName ?? '' } };
      });
      await fern(holen, w.adresse, w.token, '/abgleich', { aenderungen });
      const zeit = new Date().toISOString();
      for (const z of ereignisse) db.prepare('insert or ignore into weiter_gesendet values (?, ?)').run(z.id, zeit);
    }
    // 2. Letzte Position → an die Spedition.
    const ort = db.prepare("select * from tour_letzte where tour = ? and (? is null or zeit > ?)").get(w.lokal, w.ort_zeit, w.ort_zeit);
    if (ort) {
      await fern(holen, w.adresse, w.token, '/touren/ort', { tour: w.fern, orte: [{ lat: ort.lat, lon: ort.lon, genau: ort.genau ?? undefined, zeit: ort.zeit, quelle: 'partner' }] });
      db.prepare('update weiterleitung set ort_zeit = ? where lokal = ?').run(ort.zeit, w.lokal);
    }
    // 3. Änderungen der Spedition an der Tour holen (nur diese Tour; die Spedition schickt dem Partner nichts anderes).
    let rev = w.rev;
    for (let i = 0; i < 10; i++) {
      const r = await fern(holen, w.adresse, w.token, `/abgleich?seit=${rev}`);
      const t = [...(r.aenderungen ?? [])].reverse().find((a) => a.sammlung === 'touren' && a.id === w.fern);
      if (t?.geloescht) {
        db.prepare('update weiterleitung set ende = ? where lokal = ?').run(new Date().toISOString(), w.lokal);
      } else if (t?.inhalt) {
        const vorher = db.prepare("select inhalt from daten where sammlung = 'touren' and id = ? and geloescht = 0").get(w.lokal);
        const v = vorher ? JSON.parse(vorher.inhalt) : null;
        const neu = kopie(t.inhalt, w.lokal, v, v?.herkunft ?? { adresse: w.adresse, tour: w.fern, betrieb: w.fern_betrieb ?? '' });
        if (JSON.stringify(neu) !== JSON.stringify(v)) speicher.schreiben(db, 'partner', [{ sammlung: 'touren', id: w.lokal, geaendert: new Date().toISOString(), geloescht: false, inhalt: neu }]);
      }
      rev = r.rev ?? rev;
      if (!r.mehr) break;
    }
    if (rev !== w.rev) db.prepare('update weiterleitung set rev = ? where lokal = ?').run(rev, w.lokal);
  }

  return { weg, weiterleiten };
}
