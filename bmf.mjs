// Umsatzsteuer-Umrechnungskurse des Bundesfinanzministeriums (§ 16 Abs. 6 UStG), vom Server selbst geholt:
// Das BMF gibt jeden Monat (Anfang des Folgemonats) eine „Monatlich fortgeschriebene Übersicht“ als PDF
// heraus. Der Server schaut einmal am Tag auf der Übersichtsseite nach, lädt nur ein neues PDF, liest die
// Kurse heraus und gibt sie über GET /kurse an die Geräte. Die App bringt eine eigene Tabelle mit; die
// Kurse vom Server kommen nur dazu (neuere Monate) — scheitert das Lesen, bleibt alles beim Alten.
//
// Ohne Abhängigkeiten: Die PDFs des BMF enthalten den Text als WinAnsi-Zeichenketten (Tj/TJ) in
// Flate-Strömen; `pdfText` liest daraus Text mit Position, `kurseAusPdf` ordnet die Werte den Monaten zu.
// Abschalten: MONTIX_BMF=aus.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

export const WAEHRUNGEN = ['CHF', 'GBP', 'USD', 'PLN', 'CZK', 'DKK', 'SEK', 'NOK', 'HUF', 'RON'];
const SEITE = 'https://www.bundesfinanzministerium.de/Web/DE/Themen/Steuern/Steuerarten/Umsatzsteuer/Umsatzsteuer_Umrechnungskurse/umsatzsteuer_umrechnungskurse.html';
const BASIS = 'https://www.bundesfinanzministerium.de/';
const ALTER_MS = 20 * 3600_000;

/** PDF-Zeichenkette ( … ) mit Escapes lesen; gibt [text, ende] zurück. */
function zeichenkette(s, i) {
  let aus = '';
  let tiefe = 1;
  i++;
  while (i < s.length && tiefe > 0) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (/[0-7]/.test(n)) {
        const m = /^[0-7]{1,3}/.exec(s.slice(i + 1))[0];
        aus += String.fromCharCode(parseInt(m, 8));
        i += 1 + m.length;
        continue;
      }
      aus += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[n] ?? n;
      i += 2;
      continue;
    }
    if (c === '(') tiefe++;
    if (c === ')' && --tiefe === 0) break;
    aus += c;
    i++;
  }
  return [aus, i + 1];
}

/** Textstücke mit Position (x, y) aus allen Inhaltsströmen; Seiten untereinander (seite). */
export function pdfText(bytes) {
  const roh = Buffer.from(bytes).toString('latin1');
  const stuecke = [];
  let seite = 0;
  for (const m of roh.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const ende = roh.indexOf('endstream', start);
    let s;
    try {
      s = inflateSync(Buffer.from(roh.slice(start, ende), 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    if (!/\bBT\b/.test(s) || !/T[jJ]/.test(s)) continue;
    // Eine Seite kann aus mehreren Strömen bestehen; eine neue beginnt mit der Kopfzeile „Seite N von M“.
    if (!seite || s.includes('/Pagination')) seite++;
    // Einfacher Leser: Zahlen auf einen Stapel, Operatoren werten ihn aus.
    let stapel = [];
    let tm = [1, 0, 0, 1, 0, 0];
    let zeile = [1, 0, 0, 1, 0, 0];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '(') {
        const [t, j] = zeichenkette(s, i);
        stapel.push({ str: t });
        i = j;
      } else if (c === '[') {
        // TJ-Feld: Zeichenketten aneinander, Abstände dazwischen ignorieren.
        let j = i + 1;
        let t = '';
        while (j < s.length && s[j] !== ']') {
          if (s[j] === '(') {
            const [u, k] = zeichenkette(s, j);
            t += u;
            j = k;
          } else j++;
        }
        stapel.push({ str: t });
        i = j + 1;
      } else if (c === '<' && s[i + 1] === '<') {
        const j = s.indexOf('>>', i);
        i = j < 0 ? s.length : j + 2;
      } else if (/[-+.\d]/.test(c)) {
        const m = /^[-+]?(\d+\.?\d*|\.\d+)/.exec(s.slice(i, i + 32));
        if (m) {
          stapel.push(Number(m[0]));
          i += m[0].length;
        } else i++;
      } else if (/[A-Za-z'"*]/.test(c)) {
        const op = /^[A-Za-z'"*]+/.exec(s.slice(i))[0];
        i += op.length;
        const z = stapel.filter((x) => typeof x === 'number');
        if (op === 'BT') tm = zeile = [1, 0, 0, 1, 0, 0];
        else if (op === 'Tm' && z.length >= 6) tm = zeile = z.slice(-6);
        else if ((op === 'Td' || op === 'TD') && z.length >= 2) {
          const [tx, ty] = z.slice(-2);
          zeile = [zeile[0], zeile[1], zeile[2], zeile[3], zeile[4] + tx * zeile[0] + ty * zeile[2], zeile[5] + tx * zeile[1] + ty * zeile[3]];
          tm = zeile;
        } else if ((op === 'Tj' || op === 'TJ' || op === "'") && stapel.length) {
          const t = stapel.filter((x) => typeof x === 'object').at(-1)?.str;
          if (t && t.trim()) stuecke.push({ seite, x: tm[4], y: tm[5], text: t.trim() });
        }
        stapel = [];
      } else if (c === '/') {
        const m = /^\/[^\s/<>[\]()]+/.exec(s.slice(i));
        i += m ? m[0].length : 1;
      } else i++;
    }
  }
  return stuecke;
}

const zahl = (t) => (/^\d{1,3}(\.\d{3})*,\d+$|^\d+,\d+$/.test(t) ? Number(t.replace(/\./g, '').replace(',', '.')) : null);

/**
 * Kurse eines BMF-PDFs: { 'JJJJ-MM': { CHF: 0.9282, … } }. Je Währung steht unter jedem Kurs der Code;
 * der Kurs gehört zum Code in derselben Spalte, die Monate laufen von links nach rechts.
 */
export function kurseAusPdf(bytes, jahr) {
  const t = pdfText(bytes);
  const aus = {};
  for (const code of WAEHRUNGEN) {
    const codes = t.filter((s) => s.text === code);
    const werte = [];
    for (const c of codes) {
      // Kurs in derselben Tabellenzelle: gleiche Seite, fast gleiches x, darüber (größeres y), höchstens eine Zeile.
      const k = t
        .filter((s) => s.seite === c.seite && Math.abs(s.x - c.x) < 15 && s.y > c.y && s.y - c.y < 25 && zahl(s.text) !== null)
        .sort((a, b) => a.y - b.y)[0];
      if (k) werte.push({ x: c.x, seite: c.seite, kurs: zahl(k.text) });
    }
    werte.sort((a, b) => a.seite - b.seite || a.x - b.x);
    werte.slice(0, 12).forEach((w, i) => ((aus[`${jahr}-${String(i + 1).padStart(2, '0')}`] ??= {})[code] = w.kurs));
  }
  return aus;
}

/** Plausibel: jeder Monat mit allen zehn Währungen, Kurse im üblichen Bereich (gegen Lesefehler). */
const BEREICH = { CHF: [0.5, 2], GBP: [0.5, 1.5], USD: [0.6, 2], PLN: [2, 8], CZK: [15, 40], DKK: [7, 8], SEK: [7, 16], NOK: [7, 16], HUF: [250, 600], RON: [3, 8] };
export function plausibel(kurse) {
  const monate = Object.keys(kurse);
  return monate.length > 0 && monate.every((m) => WAEHRUNGEN.every((c) => kurse[m][c] >= BEREICH[c][0] && kurse[m][c] <= BEREICH[c][1]));
}

/** Links auf die PDFs: [{ datum: 'JJJJ-MM-TT', jahr: 2026, url }], neueste zuerst. */
export function pdfLinks(html) {
  const aus = new Map();
  for (const m of html.matchAll(/href="\/?(Content\/DE\/Downloads\/BMF_Schreiben\/Steuerarten\/Umsatzsteuer\/Umsatzsteuer-Umrechnungskurse\/(\d{4}-\d{2}-\d{2})-umsatzsteuer-umrechnungskurse-(\d{4})\.pdf[^"]*)"/g)) {
    const url = BASIS + m[1].replace(/&amp;/g, '&');
    if (!aus.has(m[2] + m[3])) aus.set(m[2] + m[3], { datum: m[2], jahr: Number(m[3]), url });
  }
  return [...aus.values()].sort((a, b) => b.datum.localeCompare(a.datum));
}

/**
 * @param {string} ordner Datenordner des Servers
 * @param {{ holen?: typeof fetch, umgebung?: Record<string, string|undefined> }} o
 */
export function erstelleBmf(ordner, { holen = fetch, umgebung = process.env } = {}) {
  const datei = join(ordner, 'bmf-kurse.json');
  const aus = umgebung.MONTIX_BMF === 'aus';
  let stand = null;
  try {
    stand = JSON.parse(readFileSync(datei, 'utf8'));
  } catch {
    stand = null;
  }
  let laufend = null;
  const lauf = async (jetzt) => {
    const kopf = { headers: { 'user-agent': 'Montix-Server' }, signal: AbortSignal.timeout(30_000) };
    const r = await holen(SEITE, kopf);
    if (!r.ok) throw new Error(`BMF antwortet mit ${r.status}`);
    // Das jüngste Schreiben je Jahr (laufendes Jahr fortgeschrieben, Vorjahr als Gesamtübersicht).
    const links = pdfLinks(await r.text());
    const jeJahr = [...new Map(links.map((l) => [l.jahr, l])).values()].filter((l) => !links.some((x) => x.jahr === l.jahr && x.datum > l.datum)).slice(0, 2);
    if (!jeJahr.length) throw new Error('Keine Kurs-PDFs auf der BMF-Seite gefunden');
    const quellen = stand?.quellen ?? {};
    let kurse = { ...(stand?.kurse ?? {}) };
    for (const l of jeJahr) {
      if (quellen[l.jahr] === l.datum) continue;
      const p = await holen(l.url, kopf);
      if (!p.ok) throw new Error(`BMF-PDF ${l.datum}: ${p.status}`);
      const neu = kurseAusPdf(new Uint8Array(await p.arrayBuffer()), l.jahr);
      if (!plausibel(neu)) throw new Error(`BMF-PDF ${l.datum} nicht sicher lesbar, Kurse nicht übernommen`);
      kurse = { ...kurse, ...neu };
      quellen[l.jahr] = l.datum;
    }
    const neuStand = Object.values(quellen).sort().at(-1);
    stand = { stand: neuStand, quellen, kurse: Object.fromEntries(Object.entries(kurse).sort()), geprueft: new Date(jetzt).toISOString() };
    writeFileSync(datei, JSON.stringify(stand));
    return stand;
  };
  return {
    stand: () => (aus ? null : stand),
    /** Höchstens einmal am Tag nachsehen; Fehler lassen den alten Stand stehen (und werden protokolliert). */
    auffrischen(jetzt = Date.now()) {
      if (aus || (stand?.geprueft && jetzt - Date.parse(stand.geprueft) < ALTER_MS)) return Promise.resolve(stand);
      laufend ??= lauf(jetzt)
        .catch((e) => {
          console.error('[bmf]', e instanceof Error ? e.message : e);
          // Nicht bei jeder Anfrage neu versuchen: der Fehlversuch zählt als Prüfung.
          if (stand) stand = { ...stand, geprueft: new Date(jetzt).toISOString() };
          return stand;
        })
        .finally(() => (laufend = null));
      return laufend;
    },
  };
}
