/**
 * Parameter des Lüftungsgeräts (Adresse 2), die per Lese-Anfrage abgefragt werden können.
 * Das Verzeichnis (DP-Liste, Zugriff, Einheit) liefert das Gerät selbst über die Meta-DPs
 * 0x0033/0x0038/0x0039; hier stehen nur Namen für bereits gedeutete Einträge und die Dekodierung.
 */

/** Einheiten-Codes aus Meta-DP 0x0039 */
export const PARAM_UNITS: Record<number, string> = { 8: '°C' };

/** Zugriffs-Codes aus Meta-DP 0x0038 */
export const PARAM_ACCESS: Record<number, string> = {
    0x55: 'nur lesen',
    0xff: 'Benutzer schreibbar',
    0xd5: 'Fachmann schreibbar',
    0xc0: 'Fachmann sichtbar',
    0xf0: 'Fachmann (f0)',
    0xf5: 'Fachmann (f5)',
    0xe0: 'Fachmann (e0)',
    0x40: 'intern (40)',
};

/** Namen für gedeutete Parameter; „(vermutlich)“ = aus Wert/Einheit/Verhalten geschlossen, nicht bestätigt */
export const PARAM_NAMES: Record<number, string> = {
    0x022d: 'T1 Zuluft',
    0x022e: 'T7 Abluft',
    0x0230: 'T4 Fortluft',
    0x0231: 'T3 Frischluft (außen)',
    0x0190: 'T5 vor Verdampfer',
    0x0191: 'T6 Verdampfer',
    0x0192: 'T8 nach Vorwärmung',
    0x0193: 'T12 vor Kondensator',
    0x0194: 'T10 Kondensator',
    0x0195: 'T13 Kompressor',
    0x0226: 'Wohnen Ist-Temperatur (vom Bedienteil)',
    0x0227: 'Wohnen Sollwert (vom Bedienteil)',
    0x0229: 'Referenzraum Ist-Temperatur',
    0x022a: 'Referenzraum Sollwert',
    0x0228: 'Zuluft-Temperatur min (vermutlich)',
    0x022b: 'Zuluft-Temperatur max (vermutlich)',
    0x015f: 'Bypass-Schwelle (vermutlich)',
    0x0160: 'Bypass aktiv',
    0x0110: 'Kühlschwelle',
    0x0116: 'Max. Heiz-/Kühlleistung',
    0x0120: 'Wärmepumpen-Leistung (vermutlich)',
    0x0124: 'Abtau-Kennlinie Außentemperatur (vermutlich)',
    0x0125: 'Abtau-Kennlinie Verdampfer-Schwelle (vermutlich)',
    0x0104: 'Abschaltgrenzen Verdichter (vermutlich)',
    0x00c9: 'Lüfterdrehzahl Zuluft/Abluft',
    0x0068: 'Lüfterdrehzahl Zuluft/Abluft (2. Messung)',
    0x00cd: 'Lüfterdrehzahl min Zuluft/Abluft (vermutlich)',
    0x00ce: 'Lüfterdrehzahl max Zuluft/Abluft (vermutlich)',
    0x00d2: 'Lüfter-Kennlinie Zuluft Stufe 1–4',
    0x00d3: 'Lüfter-Kennlinie Abluft Stufe 1–4',
    0x00d7: 'Lüfter-Ansteuerung Zuluft/Abluft',
    0x00ed: 'Filter-Restlaufzeit',
    0x00e1: 'Lüfterstufe Soll',
    0x0064: 'Fühler-Rohwerte (vermutlich)',
    0x0069: 'Fühler-Korrekturwerte (vermutlich)',
    0x032e: 'Datum/Uhrzeit',
    0x0330: 'Uhrzeit',
};

/** Namen für Raummodule (Adressen 10–15) */
export const ROOM_PARAM_NAMES: Record<number, string> = {
    0x01f4: 'Raumtemperatur',
    0x01f6: 'Sollwert (Modul)',
    0x01fa: 'Sollwert (Zentrale)',
    0x01fb: 'Sollwert-Vorgabe der Zentrale',
    0x01f8: 'Fühlerkorrektur (vermutlich)',
    0x0194: 'Status (Bit 3 Heizelement, Bit 11 Tastensperre)',
    0x0196: 'Heizelement freigegeben',
    0x0199: 'Tastensperre',
    0x019a: 'Heizanforderung',
};

const plausibleFloat = (f: number): boolean => f === 0 || (Number.isFinite(f) && Math.abs(f) >= 1e-4 && Math.abs(f) < 1e7);
const round = (f: number): number => Math.round(f * 10000) / 10000;

/**
 * Dekodiert die Antwort einer Lese-Anfrage heuristisch:
 * 1 Byte = uint8, 2 Byte = int16, 4 Byte = float32 (wenn plausibel) sonst int32 bzw. 2×uint16,
 * längere Antworten als JSON-Liste (float32, uint32 oder int16).
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

/** "0x015F, 0x0228 ; 290" -> [0x015f, 0x0228, 290] */
export function parseDpList(s: string): number[] {
    return String(s || '')
        .split(/[,;\s]+/)
        .map(x => x.trim())
        .filter(Boolean)
        .map(x => (/^0x/i.test(x) ? parseInt(x, 16) : Number(x)))
        .filter(x => Number.isInteger(x) && x >= 0 && x <= 0xffff);
}
