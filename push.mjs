// Push-Mitteilungen über den Push-Dienst von Expo (https://exp.host) — der einzige fremde Dienst
// des Servers, freigegeben vom Nutzer am 13.11.2026. Übertragen werden nur Titel und kurzer Text
// der Mitteilung und das Push-Token des Geräts; keine Kundendaten.
//
//   POST /push/token {token, plattform}   → dieses Gerät bekommt Push (ersetzt ein früheres Token)
//   POST /push/aus                         → dieses Gerät bekommt keinen Push mehr
//
// Gesendet wird bei Alleinarbeits-Alarm und Entwarnung (an Kollegen und die Empfänger der Person)
// und bei neuen Nachrichten (an die Empfänger der Nachricht).

const EXPO = 'https://exp.host/--/api/v2/push/send';
const TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,}\]$/;

export const tabelle = (db) =>
  db.exec('create table if not exists push (token text primary key, mitarbeiter text not null, geraet text not null, plattform text, erstellt text not null)');

/** Standard-Versand an Expo; in Tests ersetzt. Fehler werden protokolliert, nie geworfen. */
export function erstelleExpoPush(f = fetch) {
  return async (nachrichten) => {
    if (!nachrichten.length) return;
    for (let i = 0; i < nachrichten.length; i += 100) {
      try {
        const r = await f(EXPO, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(nachrichten.slice(i, i + 100)),
        });
        if (!r.ok) console.error('[push] Expo antwortet', r.status);
      } catch (e) {
        console.error('[push]', e);
      }
    }
  };
}

/** Ziele: Tokens der genannten Mitarbeiter. */
export function tokensVon(db, mitarbeiterIds) {
  tabelle(db);
  if (!mitarbeiterIds.length) return [];
  const platz = mitarbeiterIds.map(() => '?').join(',');
  return db.prepare(`select token from push where mitarbeiter in (${platz})`).all(...mitarbeiterIds).map((z) => z.token);
}

/** Wer einen Alarm einer Person sehen soll: alle aktiven Kollegen (ohne sie) und ihre Empfänger. */
export function alarmZiele(db, person) {
  return db
    .prepare("select id from mitarbeiter where aktiv = 1 and id != ? and (rolle != 'empfaenger' or fuer = ?)")
    .all(person, person)
    .map((z) => z.id);
}

/** url: Ziel in der App beim Antippen (z. B. /alleinarbeit). */
export const nachricht = (to, title, body, alarm = false, url = alarm ? '/alleinarbeit' : '/nachrichten') => ({
  to,
  title,
  body,
  data: { url },
  sound: 'default',
  priority: 'high',
  ...(alarm ? { channelId: 'alarm' } : {}),
});

export function pushWeg(methode, pfad, wer, koerper, geraetHash) {
  if (pfad !== '/push/token' && pfad !== '/push/aus') return undefined;
  if (methode !== 'POST') return undefined;
  tabelle(wer.db);
  return (async () => {
    if (pfad === '/push/aus') {
      wer.db.prepare('delete from push where geraet = ?').run(geraetHash);
      return { ok: true };
    }
    const { token, plattform } = (await koerper()) ?? {};
    if (typeof token !== 'string' || !TOKEN.test(token)) throw Object.assign(new Error('Ungültiges Push-Token'), { status: 400 });
    wer.db.prepare('delete from push where geraet = ? or token = ?').run(geraetHash, token);
    wer.db.prepare('insert into push values (?, ?, ?, ?, ?)').run(token, wer.mitarbeiter.id, geraetHash, String(plattform ?? '').slice(0, 10), new Date().toISOString());
    return { ok: true };
  })();
}
