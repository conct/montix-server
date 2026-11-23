# Montix-Server

Der Abgleich-Server für [Montix](https://feif.space/apps-software/montix/) zum Selbstbetrieb.
Damit bleiben die Daten Ihres Betriebs auf Ihrem eigenen Server. Montix selbst kostet dabei nichts
extra: Jede Montix-Lizenz darf ihn nutzen, auch Einzel, und der Privatbereich der App auch ohne
Lizenz.

Die Geräte gleichen über diesen Server Kunden, Artikel, Termine, Pläne mit Zeichnung,
Arbeitsberichte, Unterschriften und Belege ab, und **nur der Server vergibt Belegnummern**. So
ziehen zwei Geräte nie dieselbe. Offline arbeitet jedes Gerät weiter und schickt seine Änderungen
beim nächsten Kontakt nach. Ändern zwei Geräte dasselbe, gewinnt die jüngere Änderung. Dazu
kommen Alleinarbeit mit Alarm, Nachrichten, Push, Freigaben an andere Firmen, Objekträume,
Terminmitteilungen an Kunden, das Postfach je Mitarbeiter, die Barkasse mit TSE und Touren für
Speditionen mit Live-Lage, Empfänger-Link und Partnerbetrieben.

- **Node.js 24** oder neuer, **keine Pakete**: `node:sqlite` und `node:http` sind eingebaut.
- Eine SQLite-Datei je Betrieb unter `daten/`. Sichern heißt: den Ordner `daten/` kopieren.
- Ein Server kann einen Betrieb tragen oder mehrere.

## Holen

Mit git, empfohlen, weil Updates dann mit `git pull` kommen:

```
git clone https://github.com/conct/montix-server.git
cd montix-server
```

Ohne git: unter **Releases** die neueste ZIP-Datei laden und entpacken.

## Starten

```
MONTIX_DATEN=./daten PORT=8790 MONTIX_OEFFENTLICH=https://montix.ihre-firma.de npm start
```

Davor gehört **HTTPS**, etwa ein Reverse-Proxy wie nginx, Caddy oder Apache mit einem Zertifikat
von Let's Encrypt. Die App spricht nur HTTPS. Als Dienst unter Linux (systemd): Vorlage
`montix-abgleich.service.beispiel`.

Probe: `https://montix.ihre-firma.de/status` antwortet mit `{"dienst":"montix-abgleich",…}`.

## Betrieb anlegen und Geräte einladen

Auf dem Server, über die Kommandozeile:

```
MONTIX_DATEN=./daten node verwalten.mjs betrieb "Muster GmbH"
MONTIX_DATEN=./daten node verwalten.mjs einladung <kennung> "Erika Muster" verwalter
```

In der App: Einstellungen → Abgleich → „eigenen Server eintragen“, die Adresse
(`https://montix.ihre-firma.de`) und den Code eintragen. Jeder Code lässt sich **sieben Tage
lang einmal** einlösen. Das Gerät bleibt danach angemeldet, bis ein Verwalter es abmeldet. Weitere
Kollegen lädt der Verwalter danach direkt in der App ein (Einstellungen → Benutzer).

Für die **private Nutzung** genauso: ein „Betrieb“ für sich selbst, dann Handy, Tablet und
Browser mit Codes anmelden (in der App im Privatbereich unter Einstellungen → Abgleich der eigenen
Geräte).

## Einstellungen (Umgebungsvariablen)

| Variable | Vorgabe | Zweck |
|---|---|---|
| `MONTIX_DATEN` | `./daten` | Ordner für die Daten |
| `PORT` | `8790` | Port hinter dem Proxy |
| `MONTIX_OEFFENTLICH` | aus der Anfrage | Öffentliche Adresse; steht in Links an Kunden (Freigaben, Termine, „Unterwegs“) |
| `MONTIX_ABSENDER` | `Montix <montix@feif.space>` | **Bitte setzen**, auf eine Adresse Ihrer Domain. Sonst scheitern Mails an SPF und DMARC. |
| `MONTIX_SENDMAIL` | `/usr/sbin/sendmail` | Versand von Alarmen, Freigaben und Terminen; fehlt es, wird nur protokolliert |
| `MONTIX_PRAEFIX` | leer | Wenn der Dienst unter einem Pfad läuft, z. B. `/montix` |
| `MONTIX_PYTHON` | `python3` | Für das Postfach je Mitarbeiter (IMAP/SMTP über `mail-helfer.py`) |
| `MONTIX_ADRESSEN` | `adressen/adressen.sqlite` | Adressdatei für Adressvorschläge und Orte der Tour-Stopps (siehe unten) |
| `MONTIX_ADRESSEN_QUELLE` | `https://montix.feif.space/adressen/adressen.sqlite` | Woher `node verwalten.mjs adressen` die Datei holt |
| `MONTIX_ORS_KEY` | leer | Touren: Lkw-Fahrzeiten über openrouteservice; ohne Schlüssel schätzt der Server aus der Luftlinie |
| `MONTIX_KARTE` | `karte/karte.pmtiles` | Kartendatei für die Touren-Karten (siehe unten) |
| `MONTIX_DATEN_AUTO` | aus | `an`: neue Karten- und Adressdaten nachts selbst holen (sonst nur Hinweis) |
| `MONTIX_KARTE_QUELLE` | `https://montix.feif.space/karte/karte.pmtiles` | Woher `node verwalten.mjs karte` die Datei holt |
| `TSE_ANBIETER`, `TSE_API_KEY`, `TSE_API_SECRET`, `TSE_TSS_ID` | leer | Barkasse: Vorgabe für die TSE bei fiskaly (sonst in der App einrichten) |
| `MONTIX_EZB` | an | `aus`: keine EZB-Referenzkurse holen (dann zeigt die App bei Fremdwährung keinen ungefähren Euro-Betrag) |

## Was den Server verlässt

- **Push** über den Push-Dienst von Expo (`exp.host`): nur Titel und kurzer Text, etwa
  „Nachricht von Erika“.
- **Touren**: mit `MONTIX_ORS_KEY` zwei Koordinatenpaare an openrouteservice. Ohne Kartendatei laden die Browser der Disposition und der
  Empfänger die Kartenbilder von OpenStreetMap.
- **Barkasse**: die Signaturanfragen an fiskaly, wenn eine TSE eingerichtet ist.
- **Kartenzahlung und Online-Zahlung im Kundenportal**: Anfragen an Stripe mit dem Schlüssel Ihres Stripe-Kontos, wenn Sie einen hinterlegt haben. Offene Zahlungen fragt der Server bis zu 24 Stunden lang selbst bei Stripe nach.
- **Wechselkurse**: höchstens zweimal am Tag ein Abruf der Referenzkurse bei der Europäischen Zentralbank (`ecb.europa.eu`), ohne Daten von Ihnen. Abschalten mit `MONTIX_EZB=aus`.
- **Partnerbetriebe**: übernimmt Ihr Betrieb eine Tour einer anderen Firma, schickt der Server deren
  Server die Meldungen und die Position zu dieser Tour.
- **Fehler melden** in der App: Diese Meldung geht per Mail an den Montix-Support, damit wir
  helfen können.
- Mails an Notfallkontakte, Kunden und Firmen gehen über Ihr `sendmail`.

Sonst nichts: keine Statistik, keine Meldung an uns.

## Adressen

Adressvorschläge beim Tippen und die Orte der Tour-Stopps sucht der Server in einer eigenen
Adressdatei (Adressen, Straßen und Orte aus OpenStreetMap, vorerst Deutschland). Kein fremder Dienst sieht dabei eine Anschrift. Die Datei
ist mehrere GB groß und liegt deshalb nicht im Repository; holen Sie sie vom Montix-Server:

```
MONTIX_DATEN=./daten node verwalten.mjs adressen
```

Wie bei der Karte fortsetzbar und nur bei neuerem Stand; ohne Datei gibt es keine Vorschläge, und
der Start des Servers weist darauf hin.

## Touren und Karten

Die Karten (Live-Lage der Disposition, Seite für den Empfänger) liefert der Server selbst aus:
Leaflet und protomaps-leaflet liegen in `karte/`. Für die Kartenbilder gehört eine Datei
`karte/karte.pmtiles` dazu, mehrere GB groß und deshalb nicht im Repository. Am einfachsten holen
Sie sie fertig vom Montix-Server:

```
MONTIX_DATEN=./daten node verwalten.mjs karte
```

Der Befehl setzt einen abgebrochenen Download fort und lädt nur, wenn es einen neueren Stand gibt —
monatlich per Cron aufgerufen, bleibt die Karte aktuell. Ohne Datei weisen der Start des Servers und
die Live-Lage in der App darauf hin.

**Neue Stände:** Ein eigener Server sieht beim Start und danach einmal am Tag beim Montix-Server nach,
ob es neue Karten- oder Adressdaten gibt (nur die Kennung des Stands, kein Download). Neues steht im
Protokoll, und der Verwalter sieht in der App unter Einstellungen → Abgleich einen Hinweis mit dem
Befehl. Mit `MONTIX_DATEN_AUTO=an` holt der Server neue Stände selbst, nachts zwischen 2 und 5 Uhr.

Selbst erzeugen (etwa für ein anderes Gebiet) geht mit dem
Programm [pmtiles](https://github.com/protomaps/go-pmtiles/releases) aus dem täglichen Build von
Protomaps (Liste der Stände: https://build-metadata.protomaps.dev/builds.json):

```
pmtiles extract https://build.protomaps.com/<JJJJMMTT>.pmtiles karte/karte-neu.pmtiles --bbox=5.86,47.27,15.04,55.06 --maxzoom=15
mv karte/karte-neu.pmtiles karte/karte.pmtiles
```

Die bbox ist Deutschland (etwa 7 GB). Ohne Datei nehmen die Karten die Kacheln von OpenStreetMap;
`/karte/info` sagt, was gilt. Ein Neustart ist nicht nötig.

## Aktualisieren

```
git pull
```

Danach den Dienst neu starten. `daten/` bleibt dabei unberührt. Am besten nach jedem App-Update
einmal holen.

## Nur auf dem Montix-Server

Abos über Google Play und den App Store, Testbetriebe direkt aus der App und unsere Verwaltung
(Postfach, Lizenzausstellung) gibt es hier nicht. Der Rest ist derselbe Code, der auch auf
`montix.feif.space` läuft.

## Prüfen

```
npm test
```

## Hilfe

mail@feif.space · https://feif.space/apps-software/montix/

Lizenz: siehe `LIZENZ.md`.
