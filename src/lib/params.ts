/**
 * Parameter des Lüftungsgeräts (Adresse 2), die per Lese-Anfrage abgefragt werden können.
 * Das Verzeichnis (DP-Liste, Zugriff, Einheit) liefert das Gerät selbst über die Meta-DPs
 * 0x0033/0x0038/0x0039; hier stehen nur Namen für bereits gedeutete Einträge und die Dekodierung.
 */

import { tr, type Translated } from './ids';

/** Einheiten-Codes aus Meta-DP 0x0039 */
export const PARAM_UNITS: Record<number, string> = { 8: '°C' };

/** Zugriffs-Codes aus Meta-DP 0x0038 */
export const PARAM_ACCESS: Record<number, string> = {
    0x55: 'read only',
    0xff: 'writable (user)',
    0xd5: 'writable (installer)',
    0xc0: 'visible (installer)',
    0xf0: 'installer (f0)',
    0xf5: 'installer (f5)',
    0xe0: 'installer (e0)',
    0x40: 'internal (40)',
};

/** Names of decoded parameters; "(presumably)" = inferred from value/unit/behaviour, not confirmed */
export const PARAM_NAMES: Record<number, Translated> = {
    0x022d: tr('T1 supply air', 'T1 Zuluft'),
    0x022e: tr('T7 extract air', 'T7 Abluft'),
    0x0230: tr('T4 exhaust air', 'T4 Fortluft'),
    0x0231: tr('T3 outdoor air', 'T3 Frischluft (außen)'),
    0x0190: tr('T5 before evaporator', 'T5 vor Verdampfer'),
    0x0191: tr('T6 evaporator', 'T6 Verdampfer'),
    0x0192: tr('T8 after preheater', 'T8 nach Vorwärmung'),
    0x0193: tr('T12 before condenser', 'T12 vor Kondensator'),
    0x0194: tr('T10 condenser', 'T10 Kondensator'),
    0x0195: tr('T13 compressor', 'T13 Kompressor'),
    0x0226: tr(
        'Temperature of the central control unit room (from the central control unit)',
        'Ist-Temperatur im Raum des zentralen Bedienelements',
    ),
    0x0227: tr(
        'Setpoint of the central control unit room (from the central control unit)',
        'Sollwert im Raum des zentralen Bedienelements',
    ),
    0x0229: tr('Reference room temperature', 'Referenzraum Ist-Temperatur'),
    0x022a: tr('Reference room setpoint', 'Referenzraum Sollwert'),
    0x0228: tr('Supply air temperature min (presumably)', 'Zuluft-Temperatur min (vermutlich)'),
    0x022b: tr('Supply air temperature max (presumably)', 'Zuluft-Temperatur max (vermutlich)'),
    0x015f: tr('Bypass threshold (presumably)', 'Bypass-Schwelle (vermutlich)'),
    0x0160: tr('Bypass active', 'Bypass aktiv'),
    0x0110: tr('Cooling threshold', 'Kühlschwelle'),
    0x0115: tr('Heat pump switch-on threshold', 'WP-Einschaltschwelle'),
    0x011c: tr('Heat pump continuous operation temperature', 'WP-Dauerlauf-Temperatur'),
    0x0116: tr('Max. heating/cooling power', 'Max. Heiz-/Kühlleistung'),
    0x0120: tr('Heat pump power (presumably)', 'Wärmepumpen-Leistung (vermutlich)'),
    0x0124: tr('Defrost curve outdoor temperature (presumably)', 'Abtau-Kennlinie Außentemperatur (vermutlich)'),
    0x0125: tr('Defrost curve evaporator threshold (presumably)', 'Abtau-Kennlinie Verdampfer-Schwelle (vermutlich)'),
    0x0104: tr('Compressor cut-off limits (presumably)', 'Abschaltgrenzen Verdichter (vermutlich)'),
    0x00c9: tr('Fan speed supply/extract air', 'Lüfterdrehzahl Zuluft/Abluft'),
    0x0068: tr('Fan speed supply/extract air (2nd measurement)', 'Lüfterdrehzahl Zuluft/Abluft (2. Messung)'),
    0x00cd: tr('Fan speed min supply/extract air (presumably)', 'Lüfterdrehzahl min Zuluft/Abluft (vermutlich)'),
    0x00ce: tr('Fan speed max supply/extract air (presumably)', 'Lüfterdrehzahl max Zuluft/Abluft (vermutlich)'),
    0x00d2: tr('Fan curve supply air levels 1–4', 'Lüfter-Kennlinie Zuluft Stufe 1–4'),
    0x00d3: tr('Fan curve extract air levels 1–4', 'Lüfter-Kennlinie Abluft Stufe 1–4'),
    0x00d7: tr('Fan control supply/extract air', 'Lüfter-Ansteuerung Zuluft/Abluft'),
    0x00ed: tr('Filter: remaining days', 'Filter-Restlaufzeit'),
    0x00e1: tr('Fan level (target)', 'Lüfterstufe Soll'),
    0x0064: tr('Sensor raw values (presumably)', 'Fühler-Rohwerte (vermutlich)'),
    0x0069: tr('Sensor offsets (presumably)', 'Fühler-Korrekturwerte (vermutlich)'),
    0x032e: tr('Date/time', 'Datum/Uhrzeit'),
    0x0330: tr('Time', 'Uhrzeit'),
};

/** Names for room modules (addresses 10–15) */
export const ROOM_PARAM_NAMES: Record<number, Translated> = {
    0x01f4: tr('Room temperature', 'Raumtemperatur'),
    0x01f6: tr('Setpoint (module)', 'Sollwert (Modul)'),
    0x01fa: tr('Setpoint (central control unit)', 'Sollwert (Zentrale)'),
    0x01fb: tr('Setpoint from the central control unit', 'Sollwert-Vorgabe der Zentrale'),
    0x01f8: tr('Sensor offset (presumably)', 'Fühlerkorrektur (vermutlich)'),
    0x0194: tr('Status (bit 3 heater, bit 11 key lock)', 'Status (Bit 3 Heizelement, Bit 11 Tastensperre)'),
    0x0196: tr('Electric heater enabled', 'Heizelement freigegeben'),
    0x0199: tr('Key lock', 'Tastensperre'),
    0x019a: tr('Heat demand', 'Heizanforderung'),
};

const plausibleFloat = (f: number): boolean =>
    f === 0 || (Number.isFinite(f) && Math.abs(f) >= 1e-4 && Math.abs(f) < 1e7);
const round = (f: number): number => Math.round(f * 10000) / 10000;

/**
 * Dekodiert die Antwort einer Lese-Anfrage heuristisch:
 * 1 Byte = uint8, 2 Byte = int16, 4 Byte = float32 (wenn plausibel) sonst int32 bzw. 2×uint16,
 * längere Antworten als JSON-Liste (float32, uint32 oder int16).
 *
 * @param b
 */
export function decodeParam(b: Buffer): number | string {
    const n = b.length;
    if (n === 0) {
        return '';
    }
    if (n === 1) {
        return b[0];
    }
    if (n === 2) {
        return b.readInt16LE(0);
    }
    if (n === 4) {
        const i = b.readInt32LE(0);
        const f = b.readFloatLE(0);
        if (i === 0) {
            return 0;
        }
        if (plausibleFloat(f)) {
            return round(f);
        }
        const hi = b.readUInt16LE(2);
        if (hi !== 0 && hi < 10000 && i > 0) {
            return JSON.stringify([b.readUInt16LE(0), hi]);
        }
        return i;
    }
    if (n % 4 === 0) {
        const f: number[] = [];
        const u: number[] = [];
        for (let o = 0; o < n; o += 4) {
            f.push(b.readFloatLE(o));
            u.push(b.readUInt32LE(o));
        }
        if (u.every(x => x < 0x10000)) {
            return JSON.stringify(u);
        }
        if (f.every(plausibleFloat)) {
            return JSON.stringify(f.map(round));
        }
    }
    const a: number[] = [];
    for (let o = 0; o + 2 <= n; o += 2) {
        a.push(b.readInt16LE(o));
    }
    return JSON.stringify(a);
}

/**
 * "0x015F, 0x0228 ; 290" -> [0x015f, 0x0228, 290]
 *
 * @param s
 */
export function parseDpList(s: string): number[] {
    return String(s || '')
        .split(/[,;\s]+/)
        .map(x => x.trim())
        .filter(Boolean)
        .map(x => (/^0x/i.test(x) ? parseInt(x, 16) : Number(x)))
        .filter(x => Number.isInteger(x) && x >= 0 && x <= 0xffff);
}
