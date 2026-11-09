# Quellen und Danksagung

Dieser Adapter ist ein unabhängiges Community-Projekt und nicht mit Zimmermann
Lüftungs- und Wärmesysteme verbunden. „PROXON“ ist eine Marke ihres Inhabers.

Protokoll- und Datenpunktwissen stammt aus folgenden Quellen:

- **Markus Mauch – Proxon P-Serie · HESP-Bus**, https://markusmauch.github.io/proxon-hesp/
  (Inhalte unter CC BY 4.0): Telegrammaufbau, Typ-Nibble, Meta-Datenpunkte,
  Temperaturfühler-Namen, Bypass, Filter-Restlaufzeit.
- **David Nierhaus – proxon-hesp-homeassistant**, https://github.com/DNier/proxon-hesp-homeassistant
  (MIT-Lizenz): Zuordnungen u. a. für Temperaturblock 0x03B7, Lüfteransteuerung und
  -kennlinien, Lüfterstufen-Statuswörter 0x0208, Betriebsstunden, Kalender/Uhrzeit
  0x032E/0x0330, Ventilanzeigen 0x006C, Längenfeld-Überlauf bei 128-Byte-Antworten.
  Dessen byteweise Prüfsummen-Rekursion ist mathematisch identisch mit der hier
  verwendeten CRC-16-Formulierung (Polynom 0x8048 reflektiert, 16 Schiebeschritte je Byte).
- Eigene Busmitschnitte und Lese-Anfragen an einer Anlage (FWT 2-R, BDE Comfort) mit Raummodulen (Adressen 10–15) und einem Luftqualitätssensor (Adresse 40, meldet sich als „LQS-CO2RH…“).

Alle Zuordnungen beruhen auf Beobachtungen, nicht auf Herstellerunterlagen.
