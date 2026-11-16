// E-Mail über das sendmail des Servers (Uberspace: /usr/sbin/sendmail) — kein fremder Dienst.
// Absender aus MONTIX_ABSENDER (Vorgabe: Montix <montix@feif.space>). Gibt es kein sendmail
// (Entwicklung, Windows), wird die Nachricht nur protokolliert.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const kopfzeile = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

/** Nackte Adresse aus „Name <a@b>“ oder „a@b“ — für den Umschlagabsender (-f). */
export const absenderAdresse = (s) => (String(s).match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? String(s).trim());

/** Betreff nach RFC 2047 kodieren, damit Umlaute ankommen. */
const betreffKodiert = (s) => `=?UTF-8?B?${Buffer.from(kopfzeile(s), 'utf8').toString('base64')}?=`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * HTML-Fassung aus dem Text — damit Links überall anklickbar sind (manche Mailprogramme machen das
 * im reinen Text nicht). Zeilen „Bezeichnung: https://…“ werden Knöpfe, andere Adressen Links.
 */
export function htmlAusText(text) {
  const zeilen = String(text).split('\n').map((z) => {
    const knopf = z.match(/^([^:]{2,40}): (https:\/\/\S+)$/);
    if (knopf) {
      return `<a href="${esc(knopf[2])}" style="display:inline-block;margin:4px 0;padding:12px 18px;background:#1f6feb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700">${esc(knopf[1])}</a>`;
    }
    return esc(z).replace(/https:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  });
  return `<!doctype html><html lang="de"><body style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111827"><div style="max-width:560px">${zeilen.join('<br>\n')}</div></body></html>`;
}

/** Text und HTML als multipart/alternative (Zeilen ohne Kopf). */
function alternative(grenze, text, html) {
  return [
    `--${grenze}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    '',
    `--${grenze}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html ?? htmlAusText(text),
    '',
    `--${grenze}--`,
  ];
}

/**
 * Ganze Nachricht: Kopf, Text und HTML (multipart/alternative). Mit `anhaenge`
 * ([{name, typ, daten: Buffer}]) außen herum multipart/mixed; `antwortAn` setzt Reply-To.
 */
export function nachrichtBauen(absender, e, betreff, text, html, { anhaenge = [], antwortAn, bezug } = {}) {
  // bezug: Message-ID der beantworteten Mail (In-Reply-To/References), damit der Faden zusammenbleibt.
  const bezugOk = typeof bezug === 'string' && /^<[^<>\s]+>$/.test(bezug.trim()) ? bezug.trim() : null;
  const grenze = `montix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const kopf = [
    `From: ${kopfzeile(absender)}`,
    `To: ${e.name ? `"${kopfzeile(e.name).replace(/"/g, '')}" ` : ''}<${kopfzeile(e.email)}>`,
    ...(antwortAn ? [`Reply-To: <${kopfzeile(antwortAn)}>`] : []),
    ...(bezugOk ? [`In-Reply-To: ${bezugOk}`, `References: ${bezugOk}`] : []),
    `Subject: ${betreffKodiert(betreff)}`,
    'MIME-Version: 1.0',
  ];
  if (!anhaenge.length) {
    return [...kopf, `Content-Type: multipart/alternative; boundary="${grenze}"`, 'Auto-Submitted: auto-generated', '', ...alternative(grenze, text, html), ''].join('\r\n');
  }
  const aussen = `${grenze}-m`;
  const teile = anhaenge.flatMap((a) => {
    const name = kopfzeile(a.name).replace(/[^A-Za-z0-9._-]/g, '_');
    const b64 = Buffer.from(a.daten).toString('base64').match(/.{1,76}/g) ?? [];
    return [`--${aussen}`, `Content-Type: ${a.typ}; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', ...b64, ''];
  });
  return [
    ...kopf,
    `Content-Type: multipart/mixed; boundary="${aussen}"`,
    'Auto-Submitted: auto-generated',
    '',
    `--${aussen}`,
    `Content-Type: multipart/alternative; boundary="${grenze}"`,
    '',
    ...alternative(grenze, text, html),
    '',
    ...teile,
    `--${aussen}--`,
    '',
  ].join('\r\n');
}

export function erstelleSendmail({ pfad = process.env.MONTIX_SENDMAIL ?? '/usr/sbin/sendmail', absender = process.env.MONTIX_ABSENDER ?? 'Montix <montix@feif.space>' } = {}) {
  const vorhanden = existsSync(pfad);
  return (empfaenger, { betreff, text, html, anhaenge, antwortAn, bezug }) => {
    for (const e of empfaenger) {
      const nachricht = nachrichtBauen(absender, e, betreff, text, html, { anhaenge, antwortAn, bezug });
      if (!vorhanden) {
        console.log(`[post] kein sendmail unter ${pfad} — an ${e.email}: ${kopfzeile(betreff)}`);
        continue;
      }
      // -t: Empfänger aus den Kopfzeilen, -i: einzelne Punkte nicht als Ende werten,
      // -f: Umschlagabsender = From-Adresse. Ohne -f setzt Postfix den Unix-Benutzer ein (…@uberspace.de),
      // SPF ist dann nicht zur From-Domain ausgerichtet, DMARC (p=quarantine) schickt die Mail in den Spam.
      const p = spawn(pfad, ['-t', '-i', '-f', absenderAdresse(absender)], { stdio: ['pipe', 'ignore', 'pipe'] });
      p.on('error', (err) => console.error('[post] sendmail', err));
      p.stderr.on('data', (d) => console.error('[post]', String(d).trim()));
      p.stdin.end(nachricht, 'utf8');
    }
  };
}
