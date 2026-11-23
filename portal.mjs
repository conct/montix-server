// Kundenportal: ein fester Link je Kunde. Der Kunde sieht im Browser (ohne Konto, ohne Skript) seine
// kommenden Termine, die Angebote und Rechnungen, die der Betrieb ins Portal gestellt hat, seine
// abgeschlossenen Arbeitsberichte und anstehende Wartungen. Er kann ein Angebot annehmen und dem
// Betrieb eine Nachricht schreiben; beides kommt als Push an Verwalter und an die Person, die den
// Link erstellt hat.
//
// Termine, Berichte und Wartungen liest das Portal aus den abgeglichenen Daten des Betriebs. Belege
// stellt die App ausdrücklich ein (PDF), damit nur Ausgestelltes und Gewolltes zu sehen ist.
// Nur für Betriebe mit Server (Abgleich) — ohne Betrieb gibt es kein Portal (keine Daten über uns).
//
// Angemeldet (Betrieb):
//   GET  /portal?kunde=                → { link|null, erstellt, abrufe, letzterAbruf, belege, nachrichten }
//   POST /portal {kunde}               → { link }  (neuer Link; ein alter wird ungültig)
//   POST /portal/widerrufen {kunde}    → Link tot, eingestellte Belege bleiben für einen neuen Link
//   POST /portal/beleg {kunde, beleg, art, nummer, datum, betrag, daten(base64 PDF)} → eingestellt
//   POST /portal/beleg/entfernen {beleg}
//   POST /portal/nachricht/gelesen {id}
//   POST /portal/antwort {kunde, text} → Antwort des Betriebs, erscheint im Portal
//   GET  /portal/datei?id=             → { name, typ, daten(base64) }  Anhang einer Kundennachricht
// Öffentlich (noindex):
//   GET  /kunde/<schlüssel>                 → Seite des Kunden
//   POST /kunde/<schlüssel>  aktion=annehmen&beleg=&name=&ok=1 | aktion=nachricht&name=&text=&rueckruf=[&foto=Datei]
//                            | aktion=termin&datum=&zeit=&text=&name=&rueckruf=   (Terminwunsch)
//   GET  /kunde/<schlüssel>/beleg/<id>      → PDF eines eingestellten Belegs
//   GET  /kunde/<schlüssel>/bericht/<id>    → PDF eines abgeschlossenen Arbeitsberichts
//   GET  /kunde/<schlüssel>/bezahlen/<id>   → weiter zu Stripe Checkout (Rechnung mit Karte bezahlen, Konto des Betriebs)
//   GET  /kunde/<schlüssel>?ok=bezahlt&sitzung=cs_…  → zurück von Stripe; der Server prüft die Zahlung bei Stripe
//
// Der Schlüssel steht im Klartext in der Datenbank des Betriebs (wie die Kundendaten selbst), damit
// jedes Gerät des Betriebs den Link erneut verschicken kann.

import { randomBytes } from 'node:crypto';

import { nachricht as pushNachricht, tokensVon } from './push.mjs';
import { formularMitDatei } from './raeume.mjs';

const MB = 1024 * 1024;
const PDF_MAX = 15 * MB;
const SCHLUESSEL = /^k[A-Za-z0-9_-]{22}$/;
const ARTEN = { angebot: 'Angebot', rechnung: 'Rechnung', lieferschein: 'Lieferschein', auftragsbestaetigung: 'Auftragsbestätigung', formular: 'Formular' };
/** Anhänge, die ein Kunde schicken darf: Fotos und PDF, höchstens 10 MB, höchstens 30 je Kunde. */
const ANHANG = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const ANHANG_MAX = 10 * MB;
const ANHAENGE_JE_KUNDE = 30;
const ZEITEN = { vormittags: 'vormittags', nachmittags: 'nachmittags', egal: 'egal wann' };

export class PortalFehler extends Error {
  constructor(status, text) {
    super(text);
    this.status = status;
  }
}

export function tabelle(db) {
  db.exec(`
    create table if not exists portale (
      kunde text primary key, schluessel text unique, erstellt text not null, von text, von_name text,
      widerrufen text, abrufe integer not null default 0, letzter_abruf text
    );
    create table if not exists portal_belege (
      beleg text primary key, kunde text not null, art text not null, nummer text, datum text, betrag real,
      groesse integer not null, daten blob not null, eingestellt text not null, von text,
      angenommen text
    );
    create table if not exists portal_nachrichten (
      id text primary key, kunde text not null, zeit text not null, name text, text text not null,
      rueckruf text, gelesen text
    );
    create table if not exists portal_dateien (
      id text primary key, kunde text not null, nachricht text, zeit text not null, name text, typ text not null,
      groesse integer not null, daten blob not null
    );
  `);
  const belegSpalten = new Set(db.prepare('pragma table_info(portal_belege)').all().map((c) => c.name));
  // Online bezahlt (Stripe Checkout): { zeit, betrag, sitzung }
  if (!belegSpalten.has('online')) db.exec('alter table portal_belege add column online text');
  // Spätere Spalten: Richtung (Kunde oder Betrieb), Absender im Betrieb, Terminwunsch.
  const da = new Set(db.prepare('pragma table_info(portal_nachrichten)').all().map((c) => c.name));
  for (const [spalte, typ] of [['richtung', "text not null default 'kunde'"], ['von_name', 'text'], ['wunsch', 'text']]) if (!da.has(spalte)) db.exec(`alter table portal_nachrichten add column ${spalte} ${typ}`);
}

const jetzt = () => new Date().toISOString();
const kurz = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
const text = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

function inhalt(db, sammlung, id) {
  const z = db.prepare('select inhalt from daten where sammlung = ? and id = ? and geloescht = 0').get(sammlung, id);
  return z ? JSON.parse(z.inhalt) : null;
}

function alle(db, sammlung, kunde) {
  return db
    .prepare("select inhalt from daten where sammlung = ? and geloescht = 0 and json_extract(inhalt, '$.kundeId') = ?")
    .all(sammlung, kunde)
    .map((z) => JSON.parse(z.inhalt));
}

function pushAnBetrieb(db, push, portal, titel, nachricht) {
  if (!push) return;
  const ids = [portal.von, ...db.prepare("select id from mitarbeiter where rolle = 'verwalter' and aktiv = 1").all().map((z) => z.id)].filter(Boolean);
  void push(tokensVon(db, [...new Set(ids)]).map((t) => pushNachricht(t, titel, nachricht, false, `/clients/${portal.kunde}`)));
}

/** Wege für die App (angemeldet). */
export function portalWeg(methode, pfad, url, wer, koerper, basis) {
  if (pfad !== '/portal' && !pfad.startsWith('/portal/')) return undefined;
  const { db } = wer;
  tabelle(db);
  const link = (p) => (p?.schluessel && !p.widerrufen ? `${basis}/kunde/${p.schluessel}` : null);
  return (async () => {
    if (methode === 'GET' && pfad === '/portal') {
      const kunde = url.searchParams.get('kunde') ?? '';
      const p = db.prepare('select * from portale where kunde = ?').get(kunde);
      return {
        link: link(p),
        erstellt: p?.erstellt ?? null,
        abrufe: p?.abrufe ?? 0,
        letzterAbruf: p?.letzter_abruf ?? null,
        belege: db
          .prepare('select beleg, art, nummer, datum, betrag, eingestellt, angenommen, online from portal_belege where kunde = ? order by eingestellt desc')
          .all(kunde)
          .map((b) => ({ ...b, angenommen: b.angenommen ? JSON.parse(b.angenommen) : null, online: b.online ? JSON.parse(b.online) : null })),
        nachrichten: db
          .prepare('select n.*, d.id as anhang, d.name as anhang_name, d.typ as anhang_typ from portal_nachrichten n left join portal_dateien d on d.nachricht = n.id where n.kunde = ? order by n.zeit desc limit 50')
          .all(kunde)
          .map(({ anhang, anhang_name, anhang_typ, wunsch, von_name, ...n }) => ({ ...n, vonName: von_name ?? undefined, wunsch: wunsch ? JSON.parse(wunsch) : undefined, anhang: anhang ? { id: anhang, name: anhang_name, typ: anhang_typ } : undefined })),
      };
    }
    if (methode === 'GET' && pfad === '/portal/datei') {
      const d = db.prepare('select name, typ, daten from portal_dateien where id = ?').get(url.searchParams.get('id') ?? '');
      if (!d) throw new PortalFehler(404, 'Anhang nicht gefunden.');
      return { name: d.name, typ: d.typ, daten: Buffer.from(d.daten).toString('base64') };
    }
    const k = (await koerper(pfad === '/portal/beleg' ? 20 * MB : undefined)) ?? {};
    if (methode !== 'POST') throw new PortalFehler(405, 'Nur POST');
    if (pfad === '/portal') {
      const kunde = text(k.kunde, 100);
      if (!kunde || !inhalt(db, 'kunden', kunde)) throw new PortalFehler(404, 'Kunde nicht gefunden — erst abgleichen.');
      const schluessel = `k${randomBytes(17).toString('base64url').slice(0, 22)}`;
      db.prepare(
        'insert into portale (kunde, schluessel, erstellt, von, von_name) values (?, ?, ?, ?, ?) on conflict (kunde) do update set schluessel = excluded.schluessel, erstellt = excluded.erstellt, von = excluded.von, von_name = excluded.von_name, widerrufen = null, abrufe = 0, letzter_abruf = null',
      ).run(kunde, schluessel, jetzt(), wer.mitarbeiter.id, wer.mitarbeiter.name);
      return { link: `${basis}/kunde/${schluessel}` };
    }
    if (pfad === '/portal/widerrufen') {
      db.prepare('update portale set widerrufen = ?, schluessel = null where kunde = ?').run(jetzt(), text(k.kunde, 100));
      return { ok: true };
    }
    if (pfad === '/portal/beleg') {
      const kunde = text(k.kunde, 100);
      const beleg = text(k.beleg, 100);
      if (!kunde || !beleg) throw new PortalFehler(400, 'kunde und beleg fehlen');
      if (!(k.art in ARTEN)) throw new PortalFehler(400, 'Unbekannte Belegart');
      const daten = Buffer.from(String(k.daten ?? ''), 'base64');
      if (daten.length < 100 || daten.length > PDF_MAX || daten.subarray(0, 4).toString('latin1') !== '%PDF') throw new PortalFehler(400, 'Kein PDF oder zu groß (höchstens 15 MB).');
      const betrag = Number(k.betrag);
      // Ein neu eingestelltes Angebot (andere Fassung) muss neu angenommen werden — ein altes Ja gilt dann nicht.
      db.prepare(
        'insert into portal_belege (beleg, kunde, art, nummer, datum, betrag, groesse, daten, eingestellt, von) values (?,?,?,?,?,?,?,?,?,?) on conflict (beleg) do update set kunde = excluded.kunde, art = excluded.art, nummer = excluded.nummer, datum = excluded.datum, betrag = excluded.betrag, groesse = excluded.groesse, daten = excluded.daten, eingestellt = excluded.eingestellt, von = excluded.von, angenommen = case when portal_belege.daten = excluded.daten then portal_belege.angenommen else null end',
      ).run(beleg, kunde, k.art, text(k.nummer, 40) || null, text(k.datum, 10) || null, Number.isFinite(betrag) ? betrag : null, daten.length, daten, jetzt(), wer.mitarbeiter.id);
      return { ok: true };
    }
    if (pfad === '/portal/beleg/entfernen') {
      db.prepare('delete from portal_belege where beleg = ?').run(text(k.beleg, 100));
      return { ok: true };
    }
    if (pfad === '/portal/antwort') {
      const kunde = text(k.kunde, 100);
      const t2 = text(k.text, 2000);
      if (!kunde || !t2) throw new PortalFehler(400, 'kunde und text fehlen');
      if (!db.prepare('select 1 from portale where kunde = ?').get(kunde)) throw new PortalFehler(404, 'Für diesen Kunden gibt es kein Portal.');
      const id = `pn_${randomBytes(6).toString('hex')}`;
      db.prepare("insert into portal_nachrichten (id, kunde, zeit, text, gelesen, richtung, von_name) values (?,?,?,?,?, 'betrieb', ?)").run(id, kunde, jetzt(), t2, jetzt(), wer.mitarbeiter.name);
      return { ok: true, id };
    }
    if (pfad === '/portal/nachricht/gelesen') {
      db.prepare('update portal_nachrichten set gelesen = coalesce(gelesen, ?) where id = ?').run(jetzt(), text(k.id, 60));
      return { ok: true };
    }
    throw new PortalFehler(404, 'Unbekannter Weg');
  })();
}

// ——— Öffentliche Seite ———

const KOPF = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tagDe = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '');
const eur = (n) => (Number.isFinite(n) ? `${n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €` : '');
const WOCHENTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function seite(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", ...KOPF });
  res.end(html);
}

const rahmen = (titel, inhaltHtml) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(titel)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;background:#f4f6f8;color:#111827}main{max-width:760px;margin:0 auto}
.karte{background:#fff;border-radius:12px;padding:18px;box-shadow:0 1px 4px #0001;margin-bottom:14px}h1{font-size:22px;margin:4px 0 6px}h2{font-size:17px;margin:0 0 10px}
.grau,small{color:#6b7280}.zeile{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:10px 0;border-top:1px solid #eef0f3}.zeile:first-of-type{border-top:0}
.zeile .inhalt{flex:1}.titel{font-weight:700}a{color:#0b5fb8;font-weight:600}
button{font-size:15px;padding:9px 14px;border-radius:8px;border:1px solid #208aef;background:#208aef;color:#fff;font-weight:700;cursor:pointer}
input[type=text],input[type=tel],input[type=date],select,textarea{width:100%;box-sizing:border-box;font-size:16px;padding:10px;border:1px solid #d1d5db;border-radius:8px;margin:4px 0 10px;font-family:inherit}
textarea{min-height:90px}label{font-size:14px;font-weight:600;color:#374151}
.marke{font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;background:#e8f2fe;color:#0b5fb8;white-space:nowrap}.ok{background:#e7f6ea;color:#1e6b2c}
.hinweis{background:#e7f6ea;border:1px solid #b6e0bf;color:#1e6b2c;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-weight:700}
.fehler{background:#fdecec;border:1px solid #f5b5b5;color:#9b1c1c;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-weight:700}
a.knopf{display:inline-block;margin-top:6px;padding:9px 14px;border-radius:8px;background:#208aef;color:#fff;text-decoration:none}details summary{cursor:pointer;font-weight:700;color:#208aef;margin:8px 0}input[type=file]{display:block;margin:6px 0 12px}
.nachricht{border-radius:10px;padding:8px 12px;margin:0 0 10px;max-width:85%}.nachricht.kunde{background:#e8f2fe;margin-left:auto}.nachricht.betrieb{background:#f1f2f4}</style></head>
<body><main>${inhaltHtml}</main></body></html>`;

function finden(speicher, schluessel) {
  if (!SCHLUESSEL.test(schluessel)) return null;
  for (const b of speicher.alleBetriebe()) {
    tabelle(b.db);
    const p = b.db.prepare('select * from portale where schluessel = ? and widerrufen is null').get(schluessel);
    if (p) return { b, p };
  }
  return null;
}

const zaehler = new Map();
function zuViel(id) {
  const k = `${id}|${Math.floor(Date.now() / 60000)}`;
  const n = (zaehler.get(k) ?? 0) + 1;
  if (zaehler.size > 5000) zaehler.clear();
  zaehler.set(k, n);
  return n > 10;
}

/** Bezahlt laut Zahlungen am abgeglichenen Beleg? */
function bezahlt(db, belegId, betrag) {
  const b = inhalt(db, 'belege', belegId);
  const summe = (b?.zahlungen ?? []).reduce((s, z) => s + (Number(z.betrag) || 0) + (Number(z.skonto) || 0), 0);
  return betrag > 0 && summe >= betrag - 0.005;
}

export function portalSeiteDaten(db, kunde, heute = new Date().toISOString().slice(0, 10)) {
  const firma = inhalt(db, 'roh', 'firma') ?? {};
  const k = inhalt(db, 'kunden', kunde);
  const termine = alle(db, 'termine', kunde)
    .filter((t) => (t.bis ?? t.start?.slice(0, 10) ?? '') >= heute)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 20);
  const berichte = alle(db, 'berichte', kunde)
    .filter((b) => b.status === 'abgeschlossen' && b.pdf)
    .sort((a, b) => String(b.datum).localeCompare(String(a.datum)))
    .slice(0, 30);
  const wartungen = alle(db, 'wartungen', kunde).filter((w) => !w.endet || w.endet >= heute);
  const belege = db.prepare('select beleg, art, nummer, datum, betrag, angenommen, online from portal_belege where kunde = ? order by datum desc, eingestellt desc').all(kunde);
  // Gesprächsverlauf: die letzten 20 Nachrichten beider Seiten, älteste zuerst.
  const verlauf = db
    .prepare('select n.zeit, n.name, n.text, n.richtung, n.von_name, n.wunsch, d.name as anhang from portal_nachrichten n left join portal_dateien d on d.nachricht = n.id where n.kunde = ? order by n.zeit desc limit 20')
    .all(kunde)
    .reverse();
  return { firma, kunde: k, termine, berichte, wartungen, belege, verlauf };
}

function kundenSeite(b, p, schluessel, { meldung, fehler, karte = false }) {
  const d = portalSeiteDaten(b.db, p.kunde);
  const firmaName = d.firma.party?.name || b.name;
  const kontakt = [d.firma.party?.contact?.phone, d.firma.party?.contact?.email].filter(Boolean).map(esc).join(' · ');
  // Relativ zur Seite /kunde/<schlüssel>: funktioniert auch hinter einem Pfad-Präfix.
  const basis = schluessel;
  const angebote = d.belege.filter((x) => x.art === 'angebot');
  const andere = d.belege.filter((x) => x.art !== 'angebot');

  const terminHtml = d.termine.length
    ? d.termine
        .map((t) => {
          const tag = new Date(`${t.start.slice(0, 10)}T12:00:00`);
          const uhr = t.start.slice(11, 16);
          return `<div class="zeile"><div class="inhalt"><div class="titel">${WOCHENTAG[tag.getDay()]}, ${tagDe(t.start)}${uhr ? `, ${uhr} Uhr` : ''}${t.bis && t.bis !== t.start.slice(0, 10) ? ` bis ${tagDe(t.bis)}` : ''}</div><div class="grau">${esc(t.titel)}</div></div></div>`;
        })
        .join('')
    : '<p class="grau">Zurzeit ist kein Termin geplant.</p>';

  const angebotHtml = angebote
    .map((a) => {
      const an = a.angenommen ? JSON.parse(a.angenommen) : null;
      return `<div class="zeile"><div class="inhalt"><div class="titel">Angebot ${esc(a.nummer ?? '')}</div><div class="grau">${tagDe(a.datum)}${a.betrag != null ? ` · ${eur(a.betrag)}` : ''}</div>
<a href="${basis}/beleg/${encodeURIComponent(a.beleg)}">PDF ansehen</a>
${an ? `<div><span class="marke ok">angenommen von ${esc(an.name)} am ${tagDe(an.zeit)}</span></div>` : `<details><summary>Angebot annehmen</summary><form method="post" action="${basis}"><input type="hidden" name="aktion" value="annehmen"><input type="hidden" name="beleg" value="${esc(a.beleg)}"><label>Ihr Name</label><input type="text" name="name" required maxlength="80" autocomplete="name"><label><input type="checkbox" name="ok" value="1" required> Ich nehme das Angebot ${esc(a.nummer ?? '')} verbindlich an.</label><p><button>Angebot annehmen</button></p></form></details>`}</div></div>`;
    })
    .join('');

  const belegHtml = andere
    .map((x) => {
      const istBezahlt = x.art === 'rechnung' && (bezahlt(b.db, x.beleg, x.betrag) || !!x.online);
      const status = istBezahlt ? '<span class="marke ok">bezahlt</span>' : '';
      // Online bezahlen nur mit Stripe-Konto des Betriebs und offenem Betrag.
      const zahlen = x.art === 'rechnung' && !istBezahlt && karte && x.betrag >= 0.5 ? `<p><a class="knopf" href="${basis}/bezahlen/${encodeURIComponent(x.beleg)}">Jetzt online bezahlen</a></p>` : '';
      return `<div class="zeile"><div class="inhalt"><div class="titel">${ARTEN[x.art] ?? 'Beleg'} ${esc(x.nummer ?? '')}</div><div class="grau">${tagDe(x.datum)}${x.betrag != null ? ` · ${eur(x.betrag)}` : ''}</div><a href="${basis}/beleg/${encodeURIComponent(x.beleg)}">PDF ansehen</a>${zahlen}</div>${status}</div>`;
    })
    .join('');

  const berichtHtml = d.berichte
    .map((r) => `<div class="zeile"><div class="inhalt"><div class="titel">Arbeitsbericht vom ${tagDe(r.datum)}</div><div class="grau">${esc(kurz(r.taetigkeiten, 120))}</div><a href="${basis}/bericht/${encodeURIComponent(r.id)}">PDF ansehen</a></div></div>`)
    .join('');

  const uhrzeit = (iso) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const verlaufHtml = d.verlauf
    .map((n) => {
      const vomBetrieb = n.richtung === 'betrieb';
      const w = n.wunsch ? JSON.parse(n.wunsch) : null;
      const wer = vomBetrieb ? `${esc(firmaName)}${n.von_name ? ` (${esc(n.von_name)})` : ''}` : esc(n.name || 'Sie');
      return `<div class="nachricht ${vomBetrieb ? 'betrieb' : 'kunde'}"><small>${wer} · ${uhrzeit(n.zeit)}</small>${w ? `<div class="titel">Terminwunsch: ${WOCHENTAG[new Date(`${w.datum}T12:00:00`).getDay()]}, ${tagDe(w.datum)}, ${esc(ZEITEN[w.zeit] ?? '')}</div>` : ''}<div>${esc(n.text).replace(/\n/g, '<br>')}</div>${n.anhang ? `<small>Anhang: ${esc(n.anhang)}</small>` : ''}</div>`;
    })
    .join('');
  const morgen = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const wartungHtml = d.wartungen
    .map((w) => `<div class="zeile"><div class="inhalt"><div class="titel">${esc(w.titel)}</div><div class="grau">nächster Termin fällig ${tagDe(w.naechste)}</div></div></div>`)
    .join('');

  return rahmen(
    `${firmaName} – Kundenportal`,
    `<div class="karte"><small>Kundenportal</small><h1>${esc(firmaName)}</h1>${kontakt ? `<p class="grau">${kontakt}</p>` : ''}${d.kunde?.party?.name ? `<p>für ${esc(d.kunde.party.name)}</p>` : ''}</div>
${meldung ? `<div class="hinweis">${esc(meldung)}</div>` : ''}${fehler ? `<div class="fehler">${esc(fehler)}</div>` : ''}
<div class="karte" id="termine"><h2>Termine</h2>${terminHtml}
<details><summary>Termin anfragen</summary><form method="post" action="${basis}"><input type="hidden" name="aktion" value="termin">
<label>Wunschtag</label><input type="date" name="datum" min="${morgen}" required>
<label>Uhrzeit</label><select name="zeit"><option value="egal">egal wann</option><option value="vormittags">vormittags</option><option value="nachmittags">nachmittags</option></select>
<label>Worum geht es?</label><textarea name="text" required maxlength="2000" placeholder="z. B. Heizung macht Geräusche, Wartung fällig"></textarea>
<label>Ihr Name</label><input type="text" name="name" maxlength="80" autocomplete="name">
<label>Rückruf unter (freiwillig)</label><input type="tel" name="rueckruf" maxlength="40" autocomplete="tel">
<p class="grau"><small>Das ist eine Anfrage. Der Termin steht erst, wenn ${esc(firmaName)} ihn bestätigt.</small></p><p><button>Termin anfragen</button></p></form></details></div>
${angebote.length ? `<div class="karte"><h2>Angebote</h2>${angebotHtml}</div>` : ''}
${andere.length ? `<div class="karte"><h2>Rechnungen und Dokumente</h2>${belegHtml}</div>` : ''}
${d.berichte.length ? `<div class="karte"><h2>Arbeitsberichte</h2>${berichtHtml}</div>` : ''}
${d.wartungen.length ? `<div class="karte"><h2>Wartung</h2>${wartungHtml}</div>` : ''}
<div class="karte" id="nachricht"><h2>Nachrichten</h2>${verlaufHtml}<form method="post" action="${basis}" enctype="multipart/form-data"><input type="hidden" name="aktion" value="nachricht">
<label>Ihr Name</label><input type="text" name="name" maxlength="80" autocomplete="name"><label>Nachricht an ${esc(firmaName)}</label><textarea name="text" required maxlength="2000" placeholder="z. B. Frage zur Rechnung"></textarea>
<label>Foto oder PDF anhängen (freiwillig, höchstens 10 MB)</label><input type="file" name="foto" accept="image/jpeg,image/png,image/webp,application/pdf">
<label>Rückruf unter (freiwillig)</label><input type="tel" name="rueckruf" maxlength="40" autocomplete="tel"><p><button>Senden</button></p></form></div>
<p class="grau"><small>Dieser Link ist persönlich. Bitte nicht weitergeben. Bereitgestellt mit Montix.</small></p>`,
  );
}

function weiter(res, schluessel, ok) {
  res.writeHead(303, { location: `${schluessel}?ok=${ok}`, ...KOPF });
  res.end();
  return true;
}

/** Öffentliche Wege /kunde/…; `true`, wenn bearbeitet. */
export async function portalOeffentlich(speicher, req, res, pfad, url, push, { basis = '', zahlung = null } = {}) {
  const m = pfad.match(/^\/kunde\/([A-Za-z0-9_-]+)(?:\/(beleg|bericht|bezahlen)\/([A-Za-z0-9_.-]+))?$/);
  if (!m) return false;
  const [, schluessel, art, id] = m;
  const t = finden(speicher, schluessel);
  if (!t) {
    seite(res, 404, rahmen('Montix', '<div class="karte"><h1>Diesen Zugang gibt es nicht (mehr).</h1><p class="grau">Bitte bei der Firma nach einem neuen Link fragen.</p></div>'));
    return true;
  }
  const { b, p } = t;
  const db = b.db;
  const stripeSchluessel = zahlung?.stripeSchluessel?.(db) ?? null;

  // Rechnung online bezahlen: Stripe-Checkout-Sitzung beim Konto des Betriebs, dann dorthin weiter.
  if (art === 'bezahlen') {
    const x = db.prepare("select * from portal_belege where beleg = ? and kunde = ? and art = 'rechnung'").get(id, p.kunde);
    const fehlerSeite = (text) => (seite(res, 400, rahmen('Montix', `<div class="karte"><h1>${esc(text)}</h1><p><a href="${esc(`${basis}/kunde/${schluessel}`)}">Zurück zum Kundenportal</a></p></div>`)), true);
    if (!x || !stripeSchluessel) return fehlerSeite('Online bezahlen ist für diese Rechnung nicht möglich.');
    if (x.online || bezahlt(db, x.beleg, x.betrag)) return fehlerSeite('Diese Rechnung ist schon bezahlt.');
    if (zuViel(p.kunde)) return fehlerSeite('Zu viele Versuche. Bitte eine Minute warten.');
    const zurueck = `${basis}/kunde/${schluessel}`;
    try {
      const s = await zahlung.stripe(stripeSchluessel, 'POST', '/checkout/sessions', {
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'eur',
        'line_items[0][price_data][unit_amount]': String(Math.round(x.betrag * 100)),
        'line_items[0][price_data][product_data][name]': `Rechnung ${x.nummer ?? ''}`.trim(),
        success_url: `${zurueck}?ok=bezahlt&sitzung={CHECKOUT_SESSION_ID}`,
        cancel_url: zurueck,
        locale: 'de',
        'metadata[montix]': '1',
        'metadata[betrieb]': b.id,
        'metadata[kunde]': p.kunde,
        'metadata[beleg]': x.beleg,
        'payment_intent_data[description]': `Rechnung ${x.nummer ?? ''}`.trim(),
        'payment_intent_data[metadata][beleg]': x.beleg,
      });
      res.writeHead(303, { location: s.url, ...KOPF });
      res.end();
      return true;
    } catch (e) {
      console.error(`Kundenportal ${b.id}: Stripe-Checkout fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
      return fehlerSeite('Online bezahlen geht gerade nicht. Bitte überweisen oder später noch einmal versuchen.');
    }
  }

  if (art === 'beleg' || art === 'bericht') {
    let daten = null;
    let name = 'dokument.pdf';
    if (art === 'beleg') {
      const z = db.prepare('select daten, art, nummer from portal_belege where beleg = ? and kunde = ?').get(id, p.kunde);
      if (z) [daten, name] = [Buffer.from(z.daten), `${ARTEN[z.art] ?? 'Beleg'}-${z.nummer ?? id}.pdf`];
    } else {
      const r = inhalt(db, 'berichte', id);
      if (r && r.kundeId === p.kunde && r.status === 'abgeschlossen' && r.pdf) {
        const datei = inhalt(db, 'dateien', String(r.pdf).split(/[\\/]/).pop());
        if (datei?.daten) [daten, name] = [Buffer.from(datei.daten, 'base64'), `Arbeitsbericht-${r.datum ?? id}.pdf`];
      }
    }
    if (!daten) {
      seite(res, 404, rahmen('Montix', '<div class="karte"><p>Dieses Dokument gibt es nicht (mehr).</p></div>'));
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': daten.length, 'content-disposition': `inline; filename="${name.replace(/[^\w.-]+/g, '_')}"`, 'content-security-policy': "default-src 'none'; sandbox", ...KOPF });
    res.end(daten);
    return true;
  }

  // Zurück von Stripe: die Sitzung bei Stripe prüfen (nie dem Aufruf glauben) und die Rechnung als bezahlt vermerken.
  let bezahltMeldung = null;
  const sitzung = url.searchParams.get('sitzung') ?? '';
  if (url.searchParams.get('ok') === 'bezahlt' && /^cs_[A-Za-z0-9_]+$/.test(sitzung) && stripeSchluessel) {
    try {
      const s = await zahlung.stripe(stripeSchluessel, 'GET', `/checkout/sessions/${sitzung}`);
      const x = s.metadata?.montix === '1' && s.metadata?.betrieb === b.id && s.metadata?.kunde === p.kunde ? db.prepare('select * from portal_belege where beleg = ? and kunde = ?').get(s.metadata.beleg, p.kunde) : null;
      if (x && s.payment_status === 'paid') {
        if (!x.online) {
          const betrag = (s.amount_total ?? 0) / 100;
          db.prepare('update portal_belege set online = ? where beleg = ?').run(JSON.stringify({ zeit: jetzt(), betrag, sitzung }), x.beleg);
          pushAnBetrieb(db, push, p, 'Rechnung online bezahlt', `Rechnung ${x.nummer ?? ''} über ${eur(betrag)} ist im Kundenportal bezahlt worden.`);
        }
        bezahltMeldung = 'Vielen Dank! Die Zahlung ist eingegangen.';
      } else if (x) bezahltMeldung = 'Die Zahlung ist noch nicht bestätigt. Sie erscheint hier, sobald Stripe sie meldet.';
    } catch (e) {
      console.error(`Kundenportal ${b.id}: Stripe-Sitzung nicht prüfbar: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Nach dem Absenden neu laden lassen (kein doppeltes Absenden beim Aktualisieren).
  const meldung = bezahltMeldung ?? { angenommen: 'Vielen Dank! Das Angebot ist angenommen. Wir melden uns bei Ihnen.', nachricht: 'Vielen Dank, Ihre Nachricht ist angekommen.', termin: 'Vielen Dank! Ihr Terminwunsch ist angekommen. Wir melden uns mit einem Termin.' }[url.searchParams.get('ok') ?? ''] ?? null;
  let fehler = null;
  if (req.method === 'POST') {
    if (zuViel(p.kunde)) {
      seite(res, 429, rahmen('Montix', '<div class="karte"><h1>Zu viele Eingaben.</h1><p>Bitte eine Minute warten.</p></div>'));
      return true;
    }
    try {
      const f = await formularMitDatei(req);
      const name = text(f.get('name'), 80);
      if (f.get('aktion') === 'annehmen') {
        const a = db.prepare("select * from portal_belege where beleg = ? and kunde = ? and art = 'angebot'").get(text(f.get('beleg'), 100), p.kunde);
        if (!a) throw new PortalFehler(404, 'Dieses Angebot gibt es nicht (mehr).');
        if (!name || f.get('ok') !== '1') throw new PortalFehler(400, 'Bitte Ihren Namen eintragen und das Häkchen setzen.');
        if (!a.angenommen) {
          db.prepare('update portal_belege set angenommen = ? where beleg = ?').run(JSON.stringify({ name, zeit: jetzt() }), a.beleg);
          pushAnBetrieb(db, push, p, 'Angebot angenommen', `${name} hat Angebot ${a.nummer ?? ''} im Kundenportal angenommen.`);
        }
        return weiter(res, schluessel, 'angenommen');
      } else if (f.get('aktion') === 'nachricht') {
        const t2 = text(f.get('text'), 2000);
        if (!t2) throw new PortalFehler(400, 'Bitte eine Nachricht schreiben.');
        const datei = f.datei?.daten?.length ? f.datei : null;
        if (datei) {
          if (!(datei.typ in ANHANG)) throw new PortalFehler(400, 'Bitte nur Fotos (JPG, PNG, WebP) oder PDF anhängen.');
          if (datei.daten.length > ANHANG_MAX) throw new PortalFehler(413, 'Der Anhang ist zu groß (höchstens 10 MB).');
          if (db.prepare('select count(*) as n from portal_dateien where kunde = ?').get(p.kunde).n >= ANHAENGE_JE_KUNDE) throw new PortalFehler(400, 'Es sind schon viele Dateien eingegangen. Bitte schicken Sie weitere direkt an die Firma.');
        }
        const id = `pn_${randomBytes(6).toString('hex')}`;
        db.prepare('insert into portal_nachrichten (id, kunde, zeit, name, text, rueckruf) values (?,?,?,?,?,?)').run(id, p.kunde, jetzt(), name || null, t2, text(f.get('rueckruf'), 40) || null);
        if (datei) db.prepare('insert into portal_dateien (id, kunde, nachricht, zeit, name, typ, groesse, daten) values (?,?,?,?,?,?,?,?)').run(`pd_${randomBytes(6).toString('hex')}`, p.kunde, id, jetzt(), `Anhang-${jetzt().slice(0, 10)}.${ANHANG[datei.typ]}`, datei.typ, datei.daten.length, datei.daten);
        pushAnBetrieb(db, push, p, 'Nachricht aus dem Kundenportal', `${name || 'Kunde'}: ${kurz(t2, 100)}${datei ? ' (mit Anhang)' : ''}`);
        return weiter(res, schluessel, 'nachricht');
      } else if (f.get('aktion') === 'termin') {
        const datum = text(f.get('datum'), 10);
        const zeit = f.get('zeit') in ZEITEN ? f.get('zeit') : 'egal';
        const t2 = text(f.get('text'), 2000);
        const heute = new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || datum <= heute) throw new PortalFehler(400, 'Bitte einen Tag ab morgen wählen.');
        if (!t2) throw new PortalFehler(400, 'Bitte kurz schreiben, worum es geht.');
        db.prepare('insert into portal_nachrichten (id, kunde, zeit, name, text, rueckruf, wunsch) values (?,?,?,?,?,?,?)').run(`pn_${randomBytes(6).toString('hex')}`, p.kunde, jetzt(), name || null, t2, text(f.get('rueckruf'), 40) || null, JSON.stringify({ datum, zeit }));
        pushAnBetrieb(db, push, p, 'Terminwunsch aus dem Kundenportal', `${name || 'Kunde'} möchte einen Termin am ${tagDe(datum)} (${ZEITEN[zeit]}): ${kurz(t2, 80)}`);
        return weiter(res, schluessel, 'termin');
      }
    } catch (e) {
      // Fehler der Eingabe (auch zu große Formulare aus dem gemeinsamen Formularleser) als Hinweis zeigen.
      if (!(e instanceof PortalFehler) && !(e?.status >= 400 && e.status < 500)) throw e;
      fehler = e.message;
    }
  } else {
    db.prepare('update portale set abrufe = abrufe + 1, letzter_abruf = ? where kunde = ?').run(jetzt(), p.kunde);
  }
  seite(res, fehler ? 400 : 200, kundenSeite(b, p, schluessel, { meldung, fehler, karte: !!stripeSchluessel }));
  return true;
}
