#!/usr/bin/env python3
"""IMAP und SMTP für den Mail-Client in Montix (aufgerufen von mail.mjs, je Anfrage ein Lauf).

Liest einen JSON-Auftrag von stdin und schreibt ein JSON-Ergebnis nach stdout. Das Passwort
kommt nur über stdin, nie über die Befehlszeile. Nur Standardbibliothek (wie postfach-abruf.py).

Auftrag: {"aktion": ..., "konto": {imapHost, imapPort, smtpHost, smtpPort, benutzer, passwort,
          adresse, name}, ...}
Aktionen: pruefen, ordner, liste, nachricht, anhang, markieren, loeschen, senden
Ergebnis: {"ok": true, ...} oder {"ok": false, "fehler": "…"}
"""
from __future__ import annotations

import email
import email.header
import email.policy
import email.utils
import imaplib
import json
import re
import smtplib
import socket
import ssl
import sys
import time
from base64 import b64decode, b64encode
from email.message import EmailMessage
from html import unescape

ZEITLIMIT = 25
LISTE_MAX = 50
socket.setdefaulttimeout(ZEITLIMIT)


class Fehler(Exception):
    pass


# ---------- IMAP ----------

def imap_verbinden(k: dict) -> imaplib.IMAP4:
    host, port = k["imapHost"], int(k.get("imapPort") or 993)
    kontext = ssl.create_default_context()
    try:
        if port == 993:
            m = imaplib.IMAP4_SSL(host, port, ssl_context=kontext, timeout=ZEITLIMIT)
        else:
            m = imaplib.IMAP4(host, port, timeout=ZEITLIMIT)
            m.starttls(ssl_context=kontext)
    except (OSError, imaplib.IMAP4.error) as e:
        raise Fehler(f"Posteingangsserver {host}:{port} nicht erreichbar ({e.__class__.__name__}).")
    try:
        m.login(k["benutzer"], k["passwort"])
    except imaplib.IMAP4.error:
        raise Fehler("Anmeldung am Posteingangsserver abgelehnt — Benutzername oder Passwort prüfen.")
    return m


def ordner_kodieren(name: str) -> str:
    """Ordnername für IMAP: modifiziertes UTF-7 (RFC 3501) und in Anführungszeichen."""
    aus, puffer = [], []

    def leeren():
        if puffer:
            b = "".join(puffer).encode("utf-16-be")
            aus.append("&" + b64encode(b).decode().rstrip("=").replace("/", ",") + "-")
            puffer.clear()

    for z in name:
        if 0x20 <= ord(z) <= 0x7E:
            leeren()
            aus.append("&-" if z == "&" else z)
        else:
            puffer.append(z)
    leeren()
    return '"' + "".join(aus).replace("\\", "\\\\").replace('"', '\\"') + '"'


def ordner_dekodieren(s: str) -> str:
    def ersetze(t):
        teil = t.group(1)
        if not teil:
            return "&"
        teil = teil.replace(",", "/")
        teil += "=" * (-len(teil) % 4)
        return b64decode(teil).decode("utf-16-be")

    return re.sub(r"&([^-]*)-", ersetze, s)


LIST_ZEILE = re.compile(rb'\((?P<flags>[^)]*)\) (?P<trenner>"[^"]*"|NIL) (?P<name>.+)')

ROLLEN = {b"\\sent": "gesendet", b"\\drafts": "entwuerfe", b"\\trash": "papierkorb", b"\\junk": "spam", b"\\archive": "archiv"}


def ordner_liste(m) -> list[dict]:
    typ, daten = m.list()
    if typ != "OK":
        raise Fehler("Ordnerliste nicht lesbar.")
    ergebnis = []
    for zeile in daten:
        if not isinstance(zeile, bytes):
            continue
        t = LIST_ZEILE.match(zeile)
        if not t:
            continue
        flags = t.group("flags").lower().split()
        if b"\\noselect" in flags:
            continue
        roh = t.group("name").decode("utf-8", "replace").strip()
        if roh.startswith('"') and roh.endswith('"'):
            roh = roh[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        rolle = next((ROLLEN[f] for f in flags if f in ROLLEN), None)
        if roh.upper() == "INBOX":
            rolle = "eingang"
        ergebnis.append({"pfad": roh, "name": "Posteingang" if rolle == "eingang" else ordner_dekodieren(roh), "rolle": rolle})
    reihenfolge = {"eingang": 0, "entwuerfe": 1, "gesendet": 2, "archiv": 3, "spam": 4, "papierkorb": 5}
    ergebnis.sort(key=lambda o: (reihenfolge.get(o["rolle"], 9), o["name"].lower()))
    return ergebnis


def ordner_mit_rolle(m, rolle: str, namen: tuple[str, ...]) -> str | None:
    liste = ordner_liste(m)
    for o in liste:
        if o["rolle"] == rolle:
            return o["pfad"]
    for o in liste:
        if o["name"].lower() in namen:
            return o["pfad"]
    return None


def waehlen(m, ordner: str, nur_lesen: bool = True) -> int:
    typ, daten = m.select(ordner_kodieren(ordner), readonly=nur_lesen)
    if typ != "OK":
        raise Fehler(f"Ordner „{ordner}“ nicht gefunden.")
    return int(daten[0] or 0)


def kopf(text) -> str:
    if text is None:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(str(text))))
    except Exception:
        return str(text)


def adressen(text) -> list[dict]:
    return [{"name": kopf(n), "adresse": a} for n, a in email.utils.getaddresses([str(text or "")]) if a]


def datum_iso(text) -> str:
    try:
        return email.utils.parsedate_to_datetime(str(text)).isoformat()
    except Exception:
        return ""


def liste(m, ordner: str, vor: int | None) -> dict:
    gesamt = waehlen(m, ordner)
    if not gesamt:
        return {"gesamt": 0, "mails": []}
    typ, daten = m.uid("search", None, "ALL" if not vor else f"UID 1:{vor - 1}")
    uids = [int(u) for u in (daten[0] or b"").split()]
    uids = sorted(uids)[-LISTE_MAX:]
    if not uids:
        return {"gesamt": gesamt, "mails": []}
    menge = ",".join(str(u) for u in uids)
    typ, daten = m.uid("fetch", menge, "(UID FLAGS RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])")
    mails = []
    i = 0
    while i < len(daten):
        teil = daten[i]
        i += 1
        if not isinstance(teil, tuple):
            continue
        meta, roh = teil
        uid = re.search(rb"UID (\d+)", meta)
        flags = re.search(rb"FLAGS \(([^)]*)\)", meta)
        if not uid:
            continue
        k = email.message_from_bytes(roh, policy=email.policy.compat32)
        flagliste = (flags.group(1).decode() if flags else "").lower().split()
        von = adressen(k.get("From"))
        mails.append({
            "uid": int(uid.group(1)),
            "von": von[0] if von else {"name": "", "adresse": ""},
            "an": adressen(k.get("To")),
            "betreff": kopf(k.get("Subject")),
            "datum": datum_iso(k.get("Date")),
            "gelesen": "\\seen" in flagliste,
            "beantwortet": "\\answered" in flagliste,
            "anhang": bool(re.search(rb'"attachment"', meta, re.I)),
        })
    mails.sort(key=lambda x: x["uid"], reverse=True)
    return {"gesamt": gesamt, "mails": mails}


def html_zu_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", "", html)
    html = re.sub(r"(?is)<a\s[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", lambda t: t.group(2) if t.group(1) in t.group(2) else f"{t.group(2)} ({t.group(1)})", html)
    html = re.sub(r"(?i)<br\s*/?>", "\n", html)
    html = re.sub(r"(?i)</(p|div|tr|h[1-6]|li|table)>", "\n", html)
    html = re.sub(r"(?i)<li[^>]*>", "• ", html)
    text = unescape(re.sub(r"<[^>]+>", "", html))
    text = re.sub(r"[ \t ]+", " ", text)
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()


def teile(nachricht):
    """Text und Anhänge einer Mail (Anhänge nummeriert in der Reihenfolge von walk())."""
    text, html, anhaenge = None, None, []
    for nr, teil in enumerate(nachricht.walk()):
        if teil.is_multipart():
            continue
        art = teil.get_content_type()
        dispo = (teil.get_content_disposition() or "").lower()
        name = teil.get_filename()
        if dispo == "attachment" or (name and dispo != "inline") or (name and not art.startswith("text/")):
            nutz = teil.get_payload(decode=True) or b""
            anhaenge.append({"nr": nr, "name": kopf(name) or f"anhang-{nr}", "typ": art, "groesse": len(nutz)})
            continue
        if art == "text/plain" and text is None:
            text = teil.get_content()
        elif art == "text/html" and html is None:
            html = teil.get_content()
    return text, html, anhaenge


def nachricht(m, ordner: str, uid: int) -> dict:
    waehlen(m, ordner, nur_lesen=False)
    typ, daten = m.uid("fetch", str(uid), "(FLAGS BODY[])")  # BODY[] setzt \Seen — gewollt beim Öffnen
    roh = next((t[1] for t in daten if isinstance(t, tuple)), None)
    if roh is None:
        raise Fehler("Diese Mail gibt es nicht mehr.")
    n = email.message_from_bytes(roh, policy=email.policy.default)
    text, html, anhaenge = teile(n)
    if text is None and html is not None:
        text = html_zu_text(html)
    von = adressen(n.get("From"))
    return {
        "uid": uid,
        "von": von[0] if von else {"name": "", "adresse": ""},
        "an": adressen(n.get("To")),
        "cc": adressen(n.get("Cc")),
        "antwortAn": adressen(n.get("Reply-To")),
        "betreff": kopf(n.get("Subject")),
        "datum": datum_iso(n.get("Date")),
        "text": (text or "").strip(),
        "html": html is not None,
        "anhaenge": anhaenge,
        "messageId": str(n.get("Message-ID") or ""),
        "referenzen": " ".join(x for x in [str(n.get("References") or ""), str(n.get("Message-ID") or "")] if x).strip(),
    }


def anhang(m, ordner: str, uid: int, nr: int) -> dict:
    waehlen(m, ordner)
    typ, daten = m.uid("fetch", str(uid), "(BODY.PEEK[])")
    roh = next((t[1] for t in daten if isinstance(t, tuple)), None)
    if roh is None:
        raise Fehler("Diese Mail gibt es nicht mehr.")
    n = email.message_from_bytes(roh, policy=email.policy.default)
    for i, teil in enumerate(n.walk()):
        if i == nr and not teil.is_multipart():
            nutz = teil.get_payload(decode=True) or b""
            return {"name": kopf(teil.get_filename()) or f"anhang-{nr}", "typ": teil.get_content_type(), "daten": b64encode(nutz).decode()}
    raise Fehler("Anhang nicht gefunden.")


def ungelesen(m) -> dict:
    """Zahl der ungelesenen Mails im Posteingang (STATUS, ohne den Ordner zu öffnen)."""
    typ, daten = m.status("INBOX", "(UNSEEN)")
    t = re.search(rb"UNSEEN (\d+)", daten[0] or b"") if typ == "OK" else None
    return {"ungelesen": int(t.group(1)) if t else 0}


def markieren(m, ordner: str, uid: int, gelesen: bool) -> dict:
    waehlen(m, ordner, nur_lesen=False)
    m.uid("store", str(uid), "+FLAGS" if gelesen else "-FLAGS", "(\\Seen)")
    return {}


def loeschen(m, ordner: str, uid: int) -> dict:
    papierkorb = ordner_mit_rolle(m, "papierkorb", ("papierkorb", "trash", "gelöschte elemente", "deleted items", "deleted messages"))
    waehlen(m, ordner, nur_lesen=False)
    if papierkorb and papierkorb != ordner:
        typ, _ = m.uid("copy", str(uid), ordner_kodieren(papierkorb))
        if typ != "OK":
            raise Fehler("Verschieben in den Papierkorb fehlgeschlagen.")
    m.uid("store", str(uid), "+FLAGS", "(\\Deleted)")
    m.expunge()
    return {"papierkorb": bool(papierkorb and papierkorb != ordner)}


# ---------- SMTP ----------

def senden(k: dict, a: dict) -> dict:
    msg = EmailMessage()
    absender = email.utils.formataddr((k.get("name") or "", k["adresse"]))
    msg["From"] = absender
    an = [x.strip() for x in a.get("an", []) if x.strip()]
    cc = [x.strip() for x in a.get("cc", []) if x.strip()]
    if not an:
        raise Fehler("Bitte mindestens einen Empfänger angeben.")
    msg["To"] = ", ".join(an)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = a.get("betreff") or ""
    msg["Date"] = email.utils.formatdate(localtime=True)
    domain = k["adresse"].split("@")[-1]
    msg["Message-ID"] = email.utils.make_msgid(domain=domain)
    if a.get("antwortAuf"):
        msg["In-Reply-To"] = a["antwortAuf"]
        msg["References"] = a.get("referenzen") or a["antwortAuf"]
    msg.set_content(a.get("text") or "")
    for d in a.get("anhaenge", []):
        haupt, _, unter = (d.get("typ") or "application/octet-stream").partition("/")
        msg.add_attachment(b64decode(d["daten"]), maintype=haupt, subtype=unter or "octet-stream", filename=d.get("name") or "anhang")

    host, port = k["smtpHost"], int(k.get("smtpPort") or 465)
    kontext = ssl.create_default_context()
    try:
        s = smtplib.SMTP_SSL(host, port, context=kontext, timeout=ZEITLIMIT) if port == 465 else smtplib.SMTP(host, port, timeout=ZEITLIMIT)
        if port != 465:
            s.starttls(context=kontext)
    except OSError as e:
        raise Fehler(f"Postausgangsserver {host}:{port} nicht erreichbar ({e.__class__.__name__}).")
    try:
        s.login(k.get("smtpBenutzer") or k["benutzer"], k["passwort"])
        s.send_message(msg, from_addr=k["adresse"], to_addrs=an + cc)
    except smtplib.SMTPAuthenticationError:
        raise Fehler("Anmeldung am Postausgangsserver abgelehnt — Benutzername oder Passwort prüfen.")
    except smtplib.SMTPRecipientsRefused:
        raise Fehler("Der Server hat einen Empfänger abgelehnt — Adresse prüfen.")
    except smtplib.SMTPException as e:
        raise Fehler(f"Versand abgelehnt: {e}")
    finally:
        try:
            s.quit()
        except Exception:
            pass

    # Kopie in „Gesendet“ — viele Anbieter tun das nicht von selbst. Scheitert es, ist die Mail trotzdem raus.
    gesendet_abgelegt = False
    try:
        m = imap_verbinden(k)
        ziel = ordner_mit_rolle(m, "gesendet", ("gesendet", "sent", "gesendete elemente", "sent items", "sent messages"))
        if ziel:
            typ, _ = m.append(ordner_kodieren(ziel), "(\\Seen)", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
            gesendet_abgelegt = typ == "OK"
        if a.get("antwortUid") and a.get("antwortOrdner"):
            waehlen(m, a["antwortOrdner"], nur_lesen=False)
            m.uid("store", str(int(a["antwortUid"])), "+FLAGS", "(\\Answered)")
        m.logout()
    except Exception:
        pass
    return {"messageId": msg["Message-ID"], "gesendetAbgelegt": gesendet_abgelegt}


def ausfuehren(auftrag: dict) -> dict:
    k = auftrag["konto"]
    aktion = auftrag["aktion"]
    if aktion == "senden":
        return senden(k, auftrag)
    m = imap_verbinden(k)
    try:
        if aktion == "pruefen":
            return {"ordner": ordner_liste(m)}
        if aktion == "ordner":
            return {"ordner": ordner_liste(m)}
        if aktion == "ungelesen":
            return ungelesen(m)
        if aktion == "liste":
            return liste(m, auftrag.get("ordner") or "INBOX", auftrag.get("vor"))
        if aktion == "nachricht":
            return nachricht(m, auftrag.get("ordner") or "INBOX", int(auftrag["uid"]))
        if aktion == "anhang":
            return anhang(m, auftrag.get("ordner") or "INBOX", int(auftrag["uid"]), int(auftrag["nr"]))
        if aktion == "markieren":
            return markieren(m, auftrag.get("ordner") or "INBOX", int(auftrag["uid"]), bool(auftrag.get("gelesen")))
        if aktion == "loeschen":
            return loeschen(m, auftrag.get("ordner") or "INBOX", int(auftrag["uid"]))
        raise Fehler(f"Unbekannte Aktion {aktion}")
    finally:
        try:
            m.logout()
        except Exception:
            pass


def main():
    try:
        auftrag = json.loads(sys.stdin.read())
        ergebnis = {"ok": True, **ausfuehren(auftrag)}
    except Fehler as e:
        ergebnis = {"ok": False, "fehler": str(e)}
    except socket.timeout:
        ergebnis = {"ok": False, "fehler": "Der Mailserver antwortet nicht rechtzeitig."}
    except Exception as e:  # nichts vom Auftrag (Passwort!) in die Meldung
        ergebnis = {"ok": False, "fehler": f"Mailserver: {e.__class__.__name__}"}
    sys.stdout.write(json.dumps(ergebnis, ensure_ascii=False))


if __name__ == "__main__":
    main()
