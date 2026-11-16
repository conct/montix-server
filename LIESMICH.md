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
Terminmitteilungen an Kunden und das Postfach je Mitarbeiter.

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
| `MONTIX_PHOTON` | `https://photon.komoot.io` | Adressvorschläge (OpenStreetMap); eine eigene Photon-Instanz geht auch |

## Was den Server verlässt

- **Push** über den Push-Dienst von Expo (`exp.host`): nur Titel und kurzer Text, etwa
  „Nachricht von Erika“.
- **Adressvorschläge**: der eingetippte Text geht an Photon (`MONTIX_PHOTON`).
- **Fehler melden** in der App: Diese Meldung geht per Mail an den Montix-Support, damit wir
  helfen können.
- Mails an Notfallkontakte, Kunden und Firmen gehen über Ihr `sendmail`.

Sonst nichts: keine Statistik, keine Meldung an uns.

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
