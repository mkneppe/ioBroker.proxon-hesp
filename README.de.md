# ioBroker.proxon-hesp

*[English version](README.md)*

Liest den internen HESP-Bus von Proxon-Lüftungsanlagen (P-Serie) über ein
RS485-TCP-Gateway **passiv** mit und legt alle Werte in ioBroker ab.
Standardmäßig sendet der Adapter nichts auf den Bus. Optional (Reiter **Steuerung**) können Raum-Sollwerte geschrieben werden.

## Voraussetzungen

- RS485-TCP-Gateway am HESP-Bus (19200 Baud, 8N1), transparenter TCP-Server-Modus
  (z. B. Port 502). Mehrere TCP-Clients gleichzeitig sind unkritisch, solange nur gelesen wird.
- js-controller ≥ 6, Admin ≥ 7.

## Installation

> **Hinweis:** Inoffizielles Community-Projekt, nicht vom Hersteller. Alle Zuordnungen beruhen auf Beobachtungen am Bus. Nutzung auf eigene Gefahr – insbesondere die optionalen Schreibfunktionen.

### 1. Gateway anschließen

- Ein RS485-TCP-Gateway (getestet: USR-TCP232-Serie) an die HESP-Busleitung (A/B) des Lüftungsgeräts anschließen.
- Schnittstelle: **19200 Baud, 8 Datenbits, keine Parität, 1 Stoppbit**.
- Betriebsart **TCP-Server**, transparent (keine Modbus-Umsetzung), z. B. Port 502.
- Mit einem Programm wie `nc <gateway> 502 | xxd` prüfen, ob laufend Bytes ankommen.

### 2. Adapter installieren

- Im Admin unter **Adapter** auf das GitHub-Symbol („Benutzerdefiniert“) klicken.
- Den Reiter **Beliebig** wählen und die URL des Release-Pakets eintragen, z. B.
  `https://github.com/mkneppe/ioBroker.proxon-hesp/releases/download/v0.4.0/iobroker.proxon-hesp-0.4.0.tgz`
- Alternativ auf der Konsole:
  ```
  iob url https://github.com/mkneppe/ioBroker.proxon-hesp/releases/download/v0.4.0/iobroker.proxon-hesp-0.4.0.tgz
  ```
- Danach eine Instanz anlegen.

### 3. Instanz einrichten

- **Verbindung:** IP-Adresse und Port des Gateways.
- **Module:** Busadresse → Ordnername. Übliche Belegung:
  - `2` = Lüftungsgerät
  - `10`–`15` = Raummodule
  - Bei der untersuchten Anlage entsprachen 10–15 der Reihenfolge im zentralen Bedienteil: Diele, Schlafen, Kind 1–4.
  - Unbekannte Teilnehmer erscheinen als `Modul_<Adresse>`.
- **Zuordnungen:** Die Standardzeilen passen für eine FWT 2-R mit BDE Comfort. Sie lassen sich beliebig ergänzen.
- **Steuerung** (optional): Schreiben von Raum-Sollwerten freigeben, regelmäßige Parameter-Abfrage.

Nach dem Start erscheinen die Werte innerhalb weniger Sekunden. `info.connection` zeigt, ob gültige Telegramme ankommen.

## Datenpunkte

| Pfad | Inhalt |
|---|---|
| `info.connection` | Verbunden und gültige Telegramme |
| `info.events`, `info.lastEvent` | Seltene Ereignisse: neue Register, geänderte Texte, Meta-Antworten |
| `info.capture` | Schalter: schreibt alle Telegramme für *n* Minuten in eine Datei im Instanz-Datenordner (`iobroker-data/proxon-hesp.0/`) |
| `info.framesPerHour`, `info.skippedBytesPerHour` | Statistik |
| `<Modul>.<Name>` | Benannte Werte gemäß Tabelle **Zuordnungen** (Name mit führendem `/` = ab Instanzwurzel, z. B. `/Wohnen.Temperatur`) |
| `<Modul>.Register.<R/W>_<DP>` | Jedes mitgelesene Register: `value` (automatisch gedeutet: Zahl, Text oder Liste), `raw` (hex), `lastSeen`, `count` |
| `<Raum>.Sollwert` | nur bei „Schreiben erlauben“: schreibbarer Sollwert; wird einmalig als SET `0x01FB` an das Raummodul gesendet und nach dessen Rückmeldung bestätigt |
| `<Modul>.Meta.*` | Selbstauskunft der Module (Name, DP-Liste, Typcodes, Zugriff, Einheiten, Fehlertext), durch „Parameter lesen“ oder wenn der Master sie abfragt |
| `<Modul>.Parameter.*` | Mit „Parameter lesen“ abgefragte Werte aller Register eines Moduls |
| `Parameter_lesen*` | Knopf und Status (aktiv, Fortschritt, Text, Zeitpunkt) des Parameter-Lesens |

`R` = Antwort des Moduls auf eine Leseanfrage, `W` = Wert, den der Master an das Modul schreibt.
Registernummern sind dezimal (z. B. `R_951` = DP `0x03B7`).

## Zuordnungen

In den Instanzeinstellungen lassen sich Register beliebig benennen: Modul, Art,
Register, Element-Index, Typ (`float32`, `int16`, …, `Text`, Kalender, Uhrzeit,
Lüfterstufe), Faktor, Einheit, Bit, zu ignorierender Rohwert, Gültigkeitsbereich,
Wertetexte und History. Die Standardzeilen decken Temperaturfühler T1–T13,
Lüfterdrehzahlen/-ansteuerung/-kennlinien, Betriebsart, Bypass, Filter,
Betriebsstunden, Verdichterdrehzahl, Gerätezeit und Raummodule ab.

## Parameter lesen

Der Knopf `Parameter_lesen` direkt unter der Instanz fragt nacheinander jedes konfigurierte Modul ab, zuerst das Lüftungsgerät:
- **Name** (Meta `0x0001`)
- **Verzeichnis** (Meta `0x0033` DP-Liste, `0x0034` Typ, `0x0038` Zugriff, `0x0039` Einheit), abgelegt unter `<Modul>.Meta`
- **jeden Parameter** einmal, abgelegt unter `<Modul>.Parameter.DP_xxxx`. Zugriffsrecht und Rohdaten stehen in der Beschreibung des Datenpunkts.

Es werden **nur Lese-Anfragen** gesendet, eine je Buslücke (ca. alle 12 s). Ein Durchlauf über alle Module dauert deshalb über eine Stunde. Den Stand zeigen diese Datenpunkte:
- `Parameter_lesen_aktiv`
- `Parameter_lesen_Fortschritt` (%)
- `Parameter_lesen_Status`
- `Parameter_lesen_zuletzt`

Meta-Listen liefern je Anfrage 64 Einträge ab dem Offset im Sub-Selektor. Das Gerät antwortet nur, solange Offset + 64 ≤ Listenlänge ist. Daraus wird die Länge ermittelt.

Unter „Steuerung“ lässt sich eine regelmäßige Abfrage des Lüftungsgeräts einschalten (standardmäßig **aus**).

## Protokoll (Kurzfassung)

```
h0 h1 h2 | id (uint32 LE) | len (Nibbles) | Nutzdaten | CRC16 LE
```

- Kopf: 24 Bit LE, Bit 0–3 Typ (0 Anfrage, 1 Setzen, 2 Antwort, 3 Quittung),
  Bit 4–13 Quelle, Bit 14–23 Ziel (vermutete Deutung, mit Mitschnitten konsistent)
- CRC: Init `0xFFFF`, Polynom `0x8048` reflektiert, 16 Schiebeschritte je Byte
- Längenfeld läuft bei 128-Byte-Antworten vermutlich über (`0x00`)

Quellen und Danksagung: siehe [NOTICE.md](NOTICE.md).

## Changelog

### 0.4.0 (2026-11-09)

- Parameter lesen für alle Module; Knopf und Status direkt unter der Instanz; Meta-Listen zusammengeführt

### 0.3.2 (2026-11-09)

- Parameter lesen: robuster gegen ausbleibende Antworten, Abbruch wird gemeldet

### 0.3.1 (2026-11-09)

- Sollwert-Schrittweite einstellbar, Standard 1 °C: Raummodule übernehmen 20,5 °C nicht (getestet)

### 0.3.0 (2026-11-09)

- Knopf „Parameter lesen“ (nur Lese-Anfragen), optional regelmäßige Abfrage (Standard: aus)

### 0.2.1 (2026-11-09)

- Adresse 40 als Luftqualitätssensor erkannt (Luftfeuchte, CO2), Meta-Texte mit Längenbyte

### 0.2.0 (2026-11-08)

- Optional: Raum-Sollwerte schreiben (SET `0x01FB`), gesendet in einer ruhigen Buslücke, Bestätigung über die Rückmeldung des Raummoduls

### 0.1.2 (2026-11-08)

- Raummodule: Heizanforderung (`0x019A`), Heizelement freigegeben und Tastensperre (`0x0194` Bit 3/11)
- „Wohnen“ (Raum des zentralen Bedienteils) als eigener Ordner, Referenzraum-Werte `0x0229`/`0x022A`
- Zuordnungsnamen mit führendem `/` werden ab der Instanzwurzel angelegt

### 0.1.1 (2026-11-08)

- Fehlerbehebung: Gleitkommawerte (z. B. Lüfterdrehzahlen) wurden teils fälschlich als Text erkannt

### 0.1.0 (2026-11-08)

- Erste Version: passives Mitlesen, CRC-Prüfung mit Neusynchronisation,
  konfigurierbare Zuordnungen, Registerablage, Meta-Datenpunkte, Ereignisse, Mitschnitt

## Lizenz

MIT, siehe [LICENSE](LICENSE).
