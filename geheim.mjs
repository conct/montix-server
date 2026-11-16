// AES-256-GCM mit einem Schlüssel je Instanz (Datei im Datenordner, 0600) — wie zahlung.mjs.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function erstelleGeheim(ordner, dateiname) {
  const datei = ordner === ':memory:' ? null : join(ordner, dateiname);
  let geheim;
  if (datei && existsSync(datei)) geheim = readFileSync(datei);
  else {
    geheim = randomBytes(32);
    if (datei) writeFileSync(datei, geheim, { mode: 0o600 });
  }
  return {
    verschluesseln(text) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', geheim, iv);
      const daten = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), daten]).toString('base64');
    },
    entschluesseln(b64) {
      const roh = Buffer.from(b64, 'base64');
      const d = createDecipheriv('aes-256-gcm', geheim, roh.subarray(0, 12));
      d.setAuthTag(roh.subarray(12, 28));
      return Buffer.concat([d.update(roh.subarray(28)), d.final()]).toString('utf8');
    },
  };
}
