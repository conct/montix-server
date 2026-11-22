/*
 * E-Mails von Montix — ordentlich gesetzt, nach dem Muster der CHOOZY-Mails
 * (D:\Apps\CHOOZY\server\guthaben-mail.js):
 *
 * - TABELLEN STATT FLEXBOX: Outlook rendert mit der Word-Engine und kennt weder Flexbox noch Grid.
 * - STILE INLINE: Gmail entfernt <style>-Blöcke; Klassen wären nach dem Weiterleiten weg.
 * - SYSTEMSCHRIFT: Mailprogramme laden keine Webschriften nach.
 * - VORSCHAUTEXT: steht in der Übersicht neben dem Betreff.
 * - TEXTFASSUNG IMMER DABEI: manche Programme zeigen nur sie, Spamfilter werten ihr Fehlen.
 *
 * Jede Mail: Kopf in Signalfarbe, Inhalt, Hinweis, Fuß mit Grund, Verantwortlichem, Support,
 * Anschrift, Impressum und Datenschutz.
 */

const FARBEN = {
  blau: '#208AEF', // Accent der App (src/constants/theme.ts)
  blauTief: '#0b5fb8',
  rot: '#B91C1C',
  gruen: '#15803D',
  hell: '#f2f6fb',
  tinte: '#0b0e16',
  grau: '#5c6472',
  weiss: '#ffffff',
  rand: '#dbe3ee',
  warnHell: '#fff4f4',
};
const SCHRIFT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";

/** Anbieter laut Impressum der App (src/features/legal/texte.json). */
export const ANBIETER = {
  name: 'feif.space · Daniel von Lühmann',
  anschrift: 'Hauptstraße 154, 01833 Dürrröhrsdorf-Dittersbach',
  support: 'mail@feif.space',
  telefon: '+49 (0) 611 9458 4300',
  impressum: 'https://feif.space/impressum.html',
  datenschutz: 'https://feif.space/apps-software/montix/datenschutz.html',
  web: 'https://feif.space/apps-software/montix/',
};

export const sicher = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const zeitDe = (iso) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });

const absatz = (html, extra = '') => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${FARBEN.tinte};${extra}">${html}</p>`;

const knopf = (href, text, farbe = FARBEN.blau) =>
  `<a href="${sicher(href)}" style="display:inline-block;background:${farbe};color:${FARBEN.weiss};text-decoration:none;font-weight:700;font-size:16px;padding:14px 26px;border-radius:999px;margin:0 8px 10px 0;font-family:${SCHRIFT};">${sicher(text)}</a>`;

const kasten = (inhalt, hintergrund = FARBEN.hell, rand = FARBEN.rand) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${hintergrund};border:1px solid ${rand};border-radius:16px;margin:0 0 18px;"><tr><td style="padding:18px 20px;font-family:${SCHRIFT};">${inhalt}</td></tr></table>`;

/** Wer verantwortlich ist — beim Privatkonto wir, im Betrieb der Betrieb. */
export function verantwortlich(betrieb) {
  return betrieb?.art === 'privat'
    ? `Verantwortlich für diese Daten: ${ANBIETER.name}, ${ANBIETER.anschrift} (Betreiber von Montix).`
    : `Verantwortlich für diese Daten: ${betrieb?.name ?? 'der Betrieb der Person'}. Montix (${ANBIETER.name}) verarbeitet sie im Auftrag.`;
}

/** Rahmen einer Montix-Mail. */
function rahmen({ farbe, oberzeile, titel, vorschau, inhalt, grund, betrieb }) {
  return `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${sicher(titel)}</title></head>
<body style="margin:0;padding:0;background:${FARBEN.hell};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${sicher(vorschau)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${FARBEN.hell};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:${FARBEN.weiss};border-radius:24px;overflow:hidden;">
        <tr><td style="background:${farbe};padding:26px 28px 22px;">
          <p style="margin:0;font-family:${SCHRIFT};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffffcc;">${sicher(oberzeile)}</p>
          <p style="margin:8px 0 0;font-family:${SCHRIFT};font-size:24px;line-height:1.25;font-weight:800;color:${FARBEN.weiss};">${sicher(titel)}</p>
        </td></tr>
        <tr><td style="padding:26px 28px 8px;font-family:${SCHRIFT};color:${FARBEN.tinte};">
          ${inhalt}
        </td></tr>
        <tr><td style="padding:18px 28px 26px;border-top:1px solid ${FARBEN.rand};font-family:${SCHRIFT};font-size:12px;line-height:1.6;color:${FARBEN.grau};">
          ${sicher(grund)}<br>
          ${sicher(verantwortlich(betrieb))}<br><br>
          Fragen zu Montix? Schreiben Sie an <a href="mailto:${ANBIETER.support}" style="color:${FARBEN.blauTief};">${ANBIETER.support}</a>
          oder rufen Sie an: ${sicher(ANBIETER.telefon)}.<br><br>
          ${sicher(ANBIETER.name)} · ${sicher(ANBIETER.anschrift)}<br>
          <a href="${ANBIETER.impressum}" style="color:${FARBEN.blauTief};">Impressum</a> ·
          <a href="${ANBIETER.datenschutz}" style="color:${FARBEN.blauTief};">Datenschutz</a> ·
          <a href="${ANBIETER.web}" style="color:${FARBEN.blauTief};">Montix</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Fuß der Textfassung — derselbe Inhalt wie im HTML. */
function textFuss(grund, betrieb) {
  return [
    '',
    '—',
    grund,
    verantwortlich(betrieb),
    `Fragen zu Montix: ${ANBIETER.support} · ${ANBIETER.telefon}`,
    `${ANBIETER.name} · ${ANBIETER.anschrift}`,
    `Impressum: ${ANBIETER.impressum}`,
    `Datenschutz: ${ANBIETER.datenschutz}`,
  ];
}

const links = (ort) => ({
  karte: `https://www.openstreetmap.org/?mlat=${ort.lat}&mlon=${ort.lon}#map=18/${ort.lat}/${ort.lon}`,
  navi: `https://www.google.com/maps/dir/?api=1&destination=${ort.lat},${ort.lon}`,
});

/** Alarm: Frist abgelaufen oder Notruf. */
export function alarmMail(a, betrieb) {
  const ort = a.ort ? (typeof a.ort === 'string' ? JSON.parse(a.ort) : a.ort) : null;
  const notruf = a.grund === 'notruf';
  const titel = notruf ? `${a.name} hat den Notruf ausgelöst` : `${a.name} meldet sich nicht`;
  const wie = notruf ? 'hat bei Alleinarbeit den Notruf ausgelöst' : `hat sich bei Alleinarbeit nicht gemeldet (fällig ${zeitDe(a.frist)})`;
  const grund = `Sie bekommen diese Nachricht, weil ${a.name} Sie in Montix als Notfallkontakt eingetragen hat.`;
  const l = ort ? links(ort) : null;
  const ortZeile = ort ? `${ort.zeit ? zeitDe(ort.zeit) : 'Zeit unbekannt'}${ort.genau ? `, auf etwa ${Math.round(ort.genau)} m genau` : ''}` : '';

  const html = rahmen({
    farbe: FARBEN.rot,
    oberzeile: 'Montix · Alarm',
    titel,
    vorschau: `${a.name} ${wie}. Bitte sofort erreichen.`,
    betrieb,
    grund,
    inhalt: [
      absatz(`<strong>${sicher(a.name)}</strong> ${sicher(wie)}.`),
      absatz('Bitte versuchen Sie, die Person <strong>sofort</strong> zu erreichen — anrufen oder hinfahren.'),
      ort
        ? kasten(
            `<p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${FARBEN.grau};">Letzter bekannter Standort</p>
             <p style="margin:0 0 14px;font-size:15px;color:${FARBEN.tinte};">${sicher(ortZeile)}</p>
             ${knopf(l.navi, 'Hinnavigieren', FARBEN.rot)}${knopf(l.karte, 'Auf der Karte ansehen')}
             <p style="margin:6px 0 0;font-size:12px;color:${FARBEN.grau};">Koordinaten: ${ort.lat.toFixed(5)}, ${ort.lon.toFixed(5)}</p>`,
          )
        : kasten(`<p style="margin:0;font-size:15px;color:${FARBEN.tinte};">Es wurde kein Standort übermittelt.</p>`),
      kasten(
        `<p style="margin:0;font-size:15px;line-height:1.6;color:${FARBEN.rot};"><strong>In Lebensgefahr: Notruf 112.</strong><br>
         <span style="color:${FARBEN.tinte};">Diese Nachricht ersetzt keinen Notruf. Montix meldet nur, dass sich die Person nicht gemeldet oder den Notruf gedrückt hat.</span></p>`,
        FARBEN.warnHell,
        '#f3c4c4',
      ),
    ].join('\n'),
  });

  const text = [
    `ALARM: ${a.name} ${wie}.`,
    '',
    'Bitte versuchen Sie, die Person sofort zu erreichen — anrufen oder hinfahren.',
    '',
    ...(ort
      ? [`Letzter bekannter Standort (${ortZeile}):`, `Hinnavigieren: ${l.navi}`, `Auf der Karte ansehen: ${l.karte}`, `Koordinaten: ${ort.lat.toFixed(5)}, ${ort.lon.toFixed(5)}`]
      : ['Es wurde kein Standort übermittelt.']),
    '',
    'In Lebensgefahr: Notruf 112. Diese Nachricht ersetzt keinen Notruf.',
    ...textFuss(grund, betrieb),
  ].join('\n');

  return { betreff: `ALARM: ${a.name} ${notruf ? 'Notruf' : 'meldet sich nicht'}`, text, html };
}

/** Entwarnung, wenn sich die Person nach einem gemeldeten Alarm wieder meldet. */
export function entwarnungMail(a, betrieb) {
  const zeit = zeitDe(new Date().toISOString());
  const grund = `Sie bekommen diese Nachricht, weil ${a.name} Sie in Montix als Notfallkontakt eingetragen hat.`;
  const html = rahmen({
    farbe: FARBEN.gruen,
    oberzeile: 'Montix · Entwarnung',
    titel: `${a.name} hat sich gemeldet`,
    vorschau: `Entwarnung: ${a.name} hat sich in Montix gemeldet.`,
    betrieb,
    grund,
    inhalt: [absatz(`<strong>${sicher(a.name)}</strong> hat sich um ${sicher(zeit)} in Montix gemeldet. Der Alarm ist aufgehoben.`), absatz('Vielen Dank, dass Sie sich gekümmert haben.', `color:${FARBEN.grau};`)].join('\n'),
  });
  const text = [`Entwarnung: ${a.name} hat sich um ${zeit} in Montix gemeldet. Der Alarm ist aufgehoben.`, ...textFuss(grund, betrieb)].join('\n');
  return { betreff: `Entwarnung: ${a.name} hat sich gemeldet`, text, html };
}

/** Einmalige Mitteilung an einen neu eingetragenen Notfallkontakt (Art. 14 DSGVO). */
export function eintragMail(name, betrieb, antwortAn) {
  const grund = `Sie bekommen diese Nachricht einmalig, weil ${name} Ihre Adresse in Montix als Notfallkontakt eingetragen hat.`;
  const html = rahmen({
    farbe: FARBEN.blau,
    oberzeile: 'Montix · Notfallkontakt',
    titel: `${name} hat Sie als Notfallkontakt eingetragen`,
    vorschau: `${name} hat Sie als Notfallkontakt für die Alleinarbeit eingetragen.`,
    betrieb,
    grund,
    inhalt: [
      absatz(`<strong>${sicher(name)}</strong> hat Ihre E-Mail-Adresse als Notfallkontakt für die Alleinarbeit in Montix eingetragen.`),
      kasten(
        `<p style="margin:0 0 8px;font-size:15px;font-weight:700;color:${FARBEN.tinte};">Was bedeutet das?</p>
         <p style="margin:0;font-size:15px;line-height:1.6;color:${FARBEN.tinte};">Meldet sich die Person bei Alleinarbeit nicht rechtzeitig oder löst sie den Notruf aus, bekommen Sie eine E-Mail mit dem Zeitpunkt und — wenn sie es eingeschaltet hat — dem letzten bekannten Standort. Meldet sie sich danach, kommt eine Entwarnung.</p>`,
      ),
      absatz(
        `Möchten Sie das nicht, sagen Sie bitte ${sicher(name)} Bescheid oder antworten Sie auf diese Nachricht${antwortAn ? ` (an <a href="mailto:${sicher(antwortAn)}" style="color:${FARBEN.blauTief};">${sicher(antwortAn)}</a>)` : ''}. Kennen Sie die Person nicht, war es vermutlich ein Tippfehler — dann bitte ebenfalls antworten.`,
      ),
    ].join('\n'),
  });
  const text = [
    `${name} hat Ihre E-Mail-Adresse als Notfallkontakt für die Alleinarbeit in Montix eingetragen.`,
    '',
    'Meldet sich die Person bei Alleinarbeit nicht rechtzeitig oder löst sie den Notruf aus, bekommen Sie eine E-Mail mit dem Zeitpunkt und — wenn sie es eingeschaltet hat — dem letzten bekannten Standort. Meldet sie sich danach, kommt eine Entwarnung.',
    '',
    `Möchten Sie das nicht, sagen Sie bitte ${name} Bescheid oder antworten Sie auf diese Nachricht. Kennen Sie die Person nicht, war es vermutlich ein Tippfehler — dann bitte ebenfalls antworten.`,
    ...textFuss(grund, betrieb),
  ].join('\n');
  return { betreff: `${name} hat Sie als Notfallkontakt in Montix eingetragen`, text, html };
}

/** Objektraum: Einladung eines Teilnehmers (Firma oder Auftraggeber). */
export function raumEinladungMail({ name, raum, objekt, link }, betrieb) {
  const grund = `Sie bekommen diese Nachricht, weil ${betrieb?.name ?? 'ein Betrieb'} Sie in Montix zu einem gemeinsamen Bereich eingeladen hat.`;
  const html = rahmen({
    farbe: FARBEN.blau,
    oberzeile: `Montix · ${betrieb?.name ?? ''}`,
    titel: `Einladung: ${raum}`,
    vorschau: `${betrieb?.name ?? 'Ein Betrieb'} lädt Sie zu „${raum}“ ein — Punkte, Notizen, erledigte Arbeiten.`,
    betrieb,
    grund,
    inhalt: [
      absatz(`Guten Tag${name ? ` ${sicher(name)}` : ''},`),
      absatz(`<strong>${sicher(betrieb?.name ?? 'Ein Betrieb')}</strong> hat Sie zum gemeinsamen Bereich <strong>„${sicher(raum)}“</strong>${objekt ? ` (${sicher(objekt)})` : ''} eingeladen. Dort sehen Sie offene und erledigte Punkte, können selbst Punkte anlegen, abhaken und Notizen schreiben — im Browser, ohne Konto.`),
      `<p style="margin:0 0 18px;">${knopf(link, 'Bereich öffnen')}</p>`,
      kasten(`<p style="margin:0;font-size:14px;line-height:1.6;color:${FARBEN.tinte};">Der Link ist Ihr persönlicher Zugang — bitte nicht weitergeben. Alles, was Sie dort schreiben, steht mit Ihrem Namen.</p>`),
    ].join('\n'),
  });
  const text = [
    `Guten Tag${name ? ` ${name}` : ''},`,
    '',
    `${betrieb?.name ?? 'Ein Betrieb'} hat Sie zum gemeinsamen Bereich „${raum}“${objekt ? ` (${objekt})` : ''} eingeladen. Dort sehen Sie offene und erledigte Punkte, können selbst Punkte anlegen, abhaken und Notizen schreiben — im Browser, ohne Konto.`,
    '',
    `Bereich öffnen: ${link}`,
    '',
    'Der Link ist Ihr persönlicher Zugang — bitte nicht weitergeben.',
    ...textFuss(grund, betrieb),
  ].join('\n');
  return { betreff: `Einladung: ${raum} (${betrieb?.name ?? 'Montix'})`, text, html };
}

/** Objektraum: gesammelte Neuigkeiten für einen Teilnehmer. Vertrauliches steht nie im Text. */
export function raumNeuMail({ raum, zeilen, link }, betrieb) {
  const grund = `Sie bekommen diese Nachricht, weil Sie am Bereich „${raum}“ von ${betrieb?.name ?? 'einem Betrieb'} in Montix teilnehmen.`;
  const html = rahmen({
    farbe: FARBEN.blau,
    oberzeile: `Montix · ${betrieb?.name ?? ''}`,
    titel: `Neu in „${raum}“`,
    vorschau: zeilen.slice(0, 2).join(' · '),
    betrieb,
    grund,
    inhalt: [
      kasten(zeilen.map((z) => `<p style="margin:0 0 8px;font-size:15px;line-height:1.5;color:${FARBEN.tinte};">• ${sicher(z)}</p>`).join('')),
      `<p style="margin:0 0 18px;">${knopf(link, 'Bereich öffnen')}</p>`,
    ].join('\n'),
  });
  const text = [`Neu in „${raum}“:`, '', ...zeilen.map((z) => `• ${z}`), '', `Bereich öffnen: ${link}`, ...textFuss(grund, betrieb)].join('\n');
  return { betreff: `Neu in „${raum}“`, text, html };
}

/** Freigabe per E-Mail: Link zu einer geteilten Mappe (Plan, PDF, Buchungsstapel …). */
export function freigabeMail({ titel, objekt, nachricht, link, pin, ablauf, absenderName }, betrieb) {
  const von = betrieb?.name ?? 'Ein Betrieb';
  const grund = `Sie bekommen diese Nachricht, weil ${absenderName ? `${absenderName} von ` : ''}${von} Ihnen über Montix Unterlagen freigegeben hat.`;
  const bis = ablauf ? `Abrufbar bis ${zeitDe(ablauf)}.` : '';
  const html = rahmen({
    farbe: FARBEN.blau,
    oberzeile: `Montix · ${von}`,
    titel,
    vorschau: `${von} hat Ihnen „${titel}“ freigegeben.`,
    betrieb,
    grund,
    inhalt: [
      absatz(`<strong>${sicher(von)}</strong> hat Ihnen <strong>„${sicher(titel)}“</strong>${objekt ? ` (${sicher(objekt)})` : ''} freigegeben.`),
      nachricht ? kasten(`<p style="margin:0;font-size:15px;line-height:1.6;color:${FARBEN.tinte};">${sicher(nachricht).replace(/\n/g, '<br>')}</p>`) : '',
      `<p style="margin:0 0 18px;">${knopf(link, 'Unterlagen öffnen')}</p>`,
      absatz(`Ansehen und herunterladen im Browser, ohne Konto. ${sicher(bis)}${pin ? ' Die Unterlagen sind mit einer PIN geschützt — sie kommt getrennt von dieser Nachricht.' : ''}`, `color:${FARBEN.grau};font-size:14px;`),
    ].join('\n'),
  });
  const text = [
    `${von} hat Ihnen „${titel}“${objekt ? ` (${objekt})` : ''} freigegeben.`,
    ...(nachricht ? ['', nachricht] : []),
    '',
    `Unterlagen öffnen: ${link}`,
    '',
    `Ansehen und herunterladen im Browser, ohne Konto. ${bis}${pin ? ' Die PIN kommt getrennt von dieser Nachricht.' : ''}`,
    ...textFuss(grund, betrieb),
  ].join('\n');
  return { betreff: `${titel} — von ${von}`, text, html };
}

/** Termin an den Kunden: Einladung, Änderung, Absage oder Erinnerung am Vortag. */
export function terminMail({ art, titel, wann, ort, nachricht, link, kunde, von_name }, betrieb) {
  const von = betrieb?.name ?? 'Ihr Handwerksbetrieb';
  const TITEL = { einladung: 'Ihr Termin', aenderung: 'Ihr Termin hat sich geändert', absage: 'Termin abgesagt', erinnerung: 'Erinnerung an Ihren Termin' };
  const SATZ = {
    einladung: 'wir haben folgenden Termin für Sie eingeplant:',
    aenderung: 'Ihr Termin hat sich geändert. Neu ist:',
    absage: 'leider müssen wir folgenden Termin absagen:',
    erinnerung: 'wir erinnern Sie an Ihren Termin:',
  };
  const kopf = TITEL[art] ?? TITEL.einladung;
  const anrede = kunde ? `Guten Tag ${kunde},` : 'Guten Tag,';
  const grund = `Sie bekommen diese Nachricht, weil ${von} mit Ihnen einen Termin vereinbart hat.`;
  const bitte =
    art === 'absage'
      ? 'Wir melden uns bei Ihnen, um einen neuen Termin abzustimmen.'
      : art === 'erinnerung'
        ? 'Falls etwas dazwischenkommt, sagen Sie uns bitte über den Link Bescheid.'
        : 'Bitte bestätigen Sie den Termin mit einem Klick – oder sagen Sie uns, wenn er nicht passt.';
  const html = rahmen({
    farbe: art === 'absage' ? FARBEN.rot : FARBEN.blau,
    oberzeile: `Termin · ${von}`,
    titel: kopf,
    vorschau: `${wann} – ${titel}`,
    betrieb,
    grund,
    inhalt: [
      absatz(sicher(anrede)),
      absatz(sicher(SATZ[art] ?? SATZ.einladung)),
      kasten(
        `<p style="margin:0 0 6px;font-size:18px;font-weight:800;color:${FARBEN.tinte};">${sicher(wann)}</p><p style="margin:0;font-size:15px;line-height:1.6;color:${FARBEN.tinte};">${sicher(titel)}${ort ? `<br>${sicher(ort)}` : ''}</p>`,
      ),
      nachricht ? absatz(sicher(nachricht).replace(/\n/g, '<br>')) : '',
      absatz(sicher(bitte)),
      art === 'absage' ? '' : `<p style="margin:0 0 18px;">${knopf(link, art === 'erinnerung' ? 'Termin ansehen' : 'Termin bestätigen', FARBEN.gruen)}</p>`,
      absatz(`Viele Grüße<br>${von_name ? `${sicher(von_name)}, ` : ''}${sicher(von)}`),
    ].join('\n'),
  });
  const text = [
    anrede,
    '',
    SATZ[art] ?? SATZ.einladung,
    '',
    wann,
    titel,
    ...(ort ? [ort] : []),
    ...(nachricht ? ['', nachricht] : []),
    '',
    bitte,
    ...(art === 'absage' ? [] : [`${art === 'erinnerung' ? 'Termin ansehen' : 'Bestätigen oder absagen'}: ${link}`]),
    '',
    'Viele Grüße',
    `${von_name ? `${von_name}, ` : ''}${von}`,
    ...textFuss(grund, betrieb),
  ].join('\n');
  return { betreff: `${kopf}: ${wann.replace(/, (jeweils )?\d\d:\d\d–.*$/, '')} – ${von}`, text, html };
}

const STUFE_NAME = { einzel: 'Einzel', mehrplatz: 'Mehrplatz', betrieb: 'Betrieb', enterprise: 'Enterprise' };
const datumDe = (iso) => iso.split('-').reverse().join('.');

/**
 * Lizenz nach dem Kauf: Schlüssel, Aktivierungslink und was gekauft ist. Kauf (Einzel, Mehrplatz)
 * läuft nie ab, Aktualisierungen bis `pflege`; Betrieb und Enterprise sind ein Abo bis `bis`.
 * Ausgestellt mit tools/lizenz/ausstellen.mjs.
 */
export function lizenzMail({ stufe, plaetze, email, ab, pflege, bis, schluessel, name, firma }) {
  const abo = stufe === 'betrieb' || stufe === 'enterprise';
  const stufeName = STUFE_NAME[stufe] ?? stufe;
  // https statt montix://: in jedem Mail-Programm anklickbar; die Seite öffnet Montix mit dem Schlüssel.
  const link = `https://feif.space/apps-software/montix/lizenz.html?k=${encodeURIComponent(schluessel)}`;
  const titel = abo ? `Ihr Montix-Abo ${stufeName}` : `Ihre Montix-Lizenz ${stufeName}`;
  const grund = `Sie bekommen diese Nachricht, weil Sie Montix ${abo ? 'abonniert' : 'gekauft'} haben (${email}).`;
  const plaetzeText = stufe === 'enterprise' || plaetze === 0 ? 'beliebig viele Mitarbeiter' : plaetze === 1 ? '1 Gerät' : `${plaetze} Plätze`;
  const zeilen = [
    ['Stufe', stufeName],
    ...(firma ? [['Firma', `${firma} – steht so als Absender auf Berichten und Belegen`]] : []),
    ['Umfang', plaetzeText],
    ['Ausgestellt für', email],
    ['Gültig ab', datumDe(ab)],
    abo ? ['Läuft bis', `${datumDe(bis)} – wir erinnern Sie rechtzeitig an die Verlängerung`] : ['Nutzung', 'dauerhaft, ohne Ablauf'],
    ...(!abo && pflege ? [['Aktualisierungen bis', `${datumDe(pflege)} – danach läuft Montix in diesem Stand weiter`]] : []),
  ];
  const tabelle = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${SCHRIFT};font-size:14px;line-height:1.5;color:${FARBEN.tinte};">${zeilen
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:${FARBEN.grau};white-space:nowrap;vertical-align:top;">${sicher(k)}</td><td style="padding:4px 0;font-weight:600;">${sicher(v)}</td></tr>`)
    .join('')}</table>`;
  const schritte = [
    'Montix auf dem Handy oder Tablet öffnen, auf dem es laufen soll.',
    'Die E-Mail auf diesem Gerät öffnen und „Lizenz aktivieren“ antippen – oder in Montix unter Einstellungen → Lizenz den Schlüssel einfügen.',
    abo || stufe === 'mehrplatz' ? 'Weitere Geräte des Betriebs melden sich mit einem Einladungscode an (Einstellungen → Abgleich); die Lizenz gilt dann für alle.' : 'Fertig – Montix ist freigeschaltet, auch ohne Netz.',
  ];
  const html = rahmen({
    farbe: FARBEN.gruen,
    oberzeile: 'Montix · Lizenz',
    titel,
    vorschau: `Vielen Dank! Ihr Lizenzschlüssel für Montix ${stufeName} ist da.`,
    betrieb: { art: 'privat' },
    grund,
    inhalt: [
      absatz(`${name ? `Guten Tag ${sicher(name)},` : 'Guten Tag,'}`),
      absatz(`vielen Dank für Ihr${abo ? ' Abo' : 'en Kauf'}! Hier ist Ihr Lizenzschlüssel für <strong>Montix ${sicher(stufeName)}</strong>.`),
      kasten(tabelle),
      `<p style="margin:0 0 18px;">${knopf(link, 'Lizenz aktivieren', FARBEN.gruen)}</p>`,
      absatz('<strong>So geht’s:</strong>'),
      `<ol style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;color:${FARBEN.tinte};">${schritte.map((s) => `<li style="margin:0 0 6px;">${sicher(s)}</li>`).join('')}</ol>`,
      absatz('Ihr Lizenzschlüssel (falls der Knopf nicht geht, kopieren und in Montix einfügen):', `font-size:14px;color:${FARBEN.grau};margin-bottom:6px;`),
      kasten(`<p style="margin:0;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:1.5;word-break:break-all;color:${FARBEN.tinte};">${sicher(schluessel)}</p>`),
      absatz('Bewahren Sie diese E-Mail auf: Mit dem Schlüssel aktivieren Sie Montix auch auf einem neuen Gerät. Die Rechnung kommt mit gesonderter E-Mail.', `font-size:14px;color:${FARBEN.grau};`),
      absatz(`Viele Grüße<br>${sicher(ANBIETER.name)}`),
    ].join('\n'),
  });
  const text = [
    name ? `Guten Tag ${name},` : 'Guten Tag,',
    '',
    `vielen Dank für Ihr${abo ? ' Abo' : 'en Kauf'}! Hier ist Ihr Lizenzschlüssel für Montix ${stufeName}.`,
    '',
    ...zeilen.map(([k, v]) => `${k}: ${v}`),
    '',
    'So geht’s:',
    ...schritte.map((s, i) => `${i + 1}. ${s}`),
    '',
    `Lizenz aktivieren: ${link}`,
    '',
    'Lizenzschlüssel:',
    schluessel,
    '',
    'Bewahren Sie diese E-Mail auf: Mit dem Schlüssel aktivieren Sie Montix auch auf einem neuen Gerät. Die Rechnung kommt mit gesonderter E-Mail.',
    '',
    'Viele Grüße',
    ANBIETER.name,
    ...textFuss(grund, { art: 'privat' }),
  ].join('\n');
  return { betreff: `${titel} – Ihr Lizenzschlüssel`, text, html };
}

/**
 * Einladung für einen neuen Betrieb auf dem Montix-Server (aus der Verwaltung): Code für den
 * ersten Verwalter, Link zur Einladungsseite, bei einem Testbetrieb das Enddatum.
 */
export function betriebEinladungMail({ name, betrieb, code, gueltigBis, link, testBis }) {
  const titel = testBis ? `Ihr Montix-Testbetrieb „${betrieb}“` : `Ihr Betrieb „${betrieb}“ auf dem Montix-Server`;
  const grund = `Sie bekommen diese Nachricht, weil wir für Sie ${testBis ? 'einen Testbetrieb' : 'einen Betrieb'} auf dem Montix-Server eingerichtet haben.`;
  const schritte = [
    'Montix auf dem Handy oder Tablet installieren und öffnen.',
    '„Einladung annehmen“ antippen – oder in Montix unter Einstellungen → Abgleich den Code eingeben.',
    'Einmal dem Vertrag zur Auftragsverarbeitung zustimmen (Abgleich mit dem Betrieb), dann gleicht Montix ab.',
    'Weitere Mitarbeiter laden Sie danach selbst ein: Einstellungen → Abgleich mit dem Betrieb → Mitarbeiter.',
  ];
  const bisDe = (iso) => iso.slice(0, 10).split('-').reverse().join('.');
  const html = rahmen({
    farbe: FARBEN.blau,
    oberzeile: 'Montix · Betrieb',
    titel,
    vorschau: `Ihr Einladungscode für Montix: ${code}`,
    betrieb: { art: 'privat' },
    grund,
    inhalt: [
      absatz(`${name ? `Guten Tag ${sicher(name)},` : 'Guten Tag,'}`),
      absatz(
        testBis
          ? `wie besprochen haben wir für Sie einen Testbetrieb auf dem Montix-Server eingerichtet. Er läuft kostenlos bis <strong>${bisDe(testBis)}</strong>. Danach buchen Sie den Server dazu oder lassen es – dann löschen wir den Testbetrieb nach weiteren 30 Tagen, bis dahin können Sie Ihre Daten herausholen.`
          : 'wir haben Ihren Betrieb auf dem Montix-Server eingerichtet.',
      ),
      kasten(`<p style="margin:0 0 6px;font-size:13px;color:${FARBEN.grau};">Einladungscode für den ersten Verwalter</p><p style="margin:0;font-family:Consolas,'Courier New',monospace;font-size:22px;letter-spacing:2px;font-weight:700;color:${FARBEN.tinte};">${sicher(code)}</p><p style="margin:6px 0 0;font-size:13px;color:${FARBEN.grau};">einmal einlösbar, gültig bis ${bisDe(gueltigBis)}</p>`),
      `<p style="margin:0 0 18px;">${knopf(link, 'Einladung annehmen')}</p>`,
      absatz('<strong>So geht’s:</strong>'),
      `<ol style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;color:${FARBEN.tinte};">${schritte.map((s) => `<li style="margin:0 0 6px;">${sicher(s)}</li>`).join('')}</ol>`,
      absatz(`Fragen beantworten wir gern unter ${sicher(ANBIETER.support)}.`, `font-size:14px;color:${FARBEN.grau};`),
      absatz(`Viele Grüße<br>${sicher(ANBIETER.name)}`),
    ].join('\n'),
  });
  const text = [
    name ? `Guten Tag ${name},` : 'Guten Tag,',
    '',
    testBis
      ? `wie besprochen haben wir für Sie einen Testbetrieb auf dem Montix-Server eingerichtet. Er läuft kostenlos bis ${bisDe(testBis)}. Danach buchen Sie den Server dazu oder lassen es – dann löschen wir den Testbetrieb nach weiteren 30 Tagen; bis dahin können Sie Ihre Daten herausholen.`
      : 'wir haben Ihren Betrieb auf dem Montix-Server eingerichtet.',
    '',
    `Einladungscode für den ersten Verwalter: ${code} (einmal einlösbar, gültig bis ${bisDe(gueltigBis)})`,
    `Einladung annehmen: ${link}`,
    '',
    'So geht’s:',
    ...schritte.map((s, i) => `${i + 1}. ${s}`),
    '',
    `Fragen beantworten wir gern unter ${ANBIETER.support}.`,
    '',
    'Viele Grüße',
    ANBIETER.name,
    ...textFuss(grund, { art: 'privat' }),
  ].join('\n');
  return { betreff: titel, text, html };
}

/** Touren: Link für den Empfänger einer Lieferung (Status, voraussichtliche Ankunft, Zustellnachweis). */
export function sendungMail({ empfaenger, sendung, datum, fenster, link }, betrieb) {
  const von = betrieb?.name ?? 'Ihre Spedition';
  const tag = datum ? new Date(`${datum}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' }) : '';
  const wann = [tag, fenster?.von ? `${fenster.von}${fenster.bis ? `–${fenster.bis}` : ''} Uhr` : ''].filter(Boolean).join(', ');
  const grund = `Sie bekommen diese Nachricht, weil ${von} eine Lieferung an Sie ausführt.`;
  const html = rahmen({
    farbe: FARBEN.blau,
    oberzeile: `Lieferung · ${von}`,
    titel: sendung ? `Ihre Sendung ${sendung}` : 'Ihre Lieferung',
    vorschau: wann ? `Geplant: ${wann}` : 'Verfolgen Sie Ihre Lieferung',
    betrieb,
    grund,
    inhalt: [
      absatz(sicher(empfaenger ? `Guten Tag ${empfaenger},` : 'Guten Tag,')),
      absatz(`${sicher(von)} liefert an Sie${wann ? ` – geplant <strong>${sicher(wann)}</strong>` : ''}. Über den Link sehen Sie, wann das Fahrzeug voraussichtlich ankommt, und nach der Zustellung den Nachweis.`),
      `<p style="margin:0 0 18px;">${knopf(link, 'Lieferung verfolgen')}</p>`,
    ].join('\n'),
  });
  const text = [empfaenger ? `Guten Tag ${empfaenger},` : 'Guten Tag,', '', `${von} liefert an Sie${wann ? ` – geplant ${wann}` : ''}.`, '', `Lieferung verfolgen: ${link}`, ...textFuss(grund, betrieb)].join('\n');
  return { betreff: `${sendung ? `Sendung ${sendung}` : 'Ihre Lieferung'} – ${von}`, text, html };
}
