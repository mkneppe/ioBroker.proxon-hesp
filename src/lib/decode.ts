/**
 * Automatische Deutung von Nutzdaten unbekannter Register.
 * Das Ergebnis ist eine Vermutung; die Rohdaten werden immer zusätzlich abgelegt.
 */

export type ValueType =
    | 'auto'
    | 'float32'
    | 'int32'
    | 'uint32'
    | 'int16'
    | 'uint16'
    | 'uint8'
    | 'text'
    | 'calendar'
    | 'clock'
    | 'fanlevel';

/**
 * Vollständige Statuswörter von DP 0x0208, die per Anzeigevergleich einer Lüfterstufe
 * zugeordnet wurden (Quelle: DNier/proxon-hesp-homeassistant, MIT). Andere Wörter -> null.
 */
const CONTROLLER_FAN_LEVELS: Record<number, number> = {
    0x8000100a: 1,
    0x80001012: 2,
    0x82001312: 2,
    0x8000101a: 3,
    0x8000131a: 3,
    0x8000921a: 3,
    0x8000931a: 3,
    0x8200131a: 3,
    0x8200111a: 3,
    0x80001022: 4,
    0x80001122: 4,
    0x80001422: 4,
    0x80001522: 4,
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** DP 0x032E: gepacktes lokales Datum/Uhrzeit (Minutenauflösung) -> "JJJJ-MM-TTTHH:MM" */
export function decodeCalendar(p: Buffer): string | null {
    if (p.length !== 4) {
        return null;
    }
    const v = p.readUInt32LE(0);
    if (v >>> 30) {
        return null;
    }
    const minute = v & 63;
    const hour = (v >>> 6) & 31;
    const weekday = (v >>> 11) & 7;
    const year = 2000 + ((v >>> 14) & 127);
    const month = (v >>> 21) & 15;
    const day = (v >>> 25) & 31;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (
        minute > 59 ||
        hour > 23 ||
        d.getUTCMonth() !== month - 1 ||
        d.getUTCDate() !== day ||
        d.getUTCDay() !== weekday
    ) {
        return null;
    }
    return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/** DP 0x0330: gepackte lokale Uhrzeit -> "HH:MM:SS" */
export function decodeClock(p: Buffer): string | null {
    if (p.length !== 4) {
        return null;
    }
    const v = p.readUInt32LE(0);
    const hour = v & 31;
    const minute = (v >>> 5) & 63;
    const second = (v >>> 11) & 63;
    if (v >>> 17 || hour > 23 || minute > 59 || second > 59) {
        return null;
    }
    return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

export interface Decoded {
    kind: 'empty' | 'text' | 'number' | 'list';
    value: string | number | null;
    /** bei Listen: die einzelnen Elemente */
    items?: number[];
    /** verwendete Elementgröße in Bytes */
    elemSize?: number;
}

const round = (v: number, d = 3): number => Math.round(v * 10 ** d) / 10 ** d;

/** Plausibler float32 (keine Denormalen, keine Riesenwerte) */
export function plausibleFloat(v: number): boolean {
    if (!Number.isFinite(v)) {
        return false;
    }
    if (v === 0) {
        return true;
    }
    const a = Math.abs(v);
    return a >= 1e-3 && a <= 1e6;
}

/** Text: mindestens 3 druckbare Zeichen, optional mit Null-Bytes aufgefüllt */
export function asText(p: Buffer): string | null {
    let end = p.length;
    while (end > 0 && p[end - 1] === 0) {
        end--;
    }
    if (end < 3) {
        return null;
    }
    for (let i = 0; i < end; i++) {
        const c = p[i];
        const printable = (c >= 0x20 && c < 0x7f) || c >= 0xa0 || c === 0x0a || c === 0x0d;
        if (!printable) {
            return null;
        }
    }
    return p.subarray(0, end).toString('latin1').trim();
}

function readElem(p: Buffer, off: number, type: ValueType): number {
    switch (type) {
        case 'float32':
            return round(p.readFloatLE(off));
        case 'int32':
            return p.readInt32LE(off);
        case 'uint32':
            return p.readUInt32LE(off);
        case 'int16':
            return p.readInt16LE(off);
        case 'uint16':
            return p.readUInt16LE(off);
        case 'uint8':
            return p[off];
        default:
            return NaN;
    }
}

export function typeSize(type: ValueType): number {
    switch (type) {
        case 'float32':
        case 'int32':
        case 'uint32':
        case 'calendar':
        case 'clock':
        case 'fanlevel':
            return 4;
        case 'int16':
        case 'uint16':
            return 2;
        case 'uint8':
            return 1;
        default:
            return 0;
    }
}

/** Ein Element bestimmter Größe deuten: 4 Byte -> float32 falls plausibel, sonst int32 */
function autoElem(p: Buffer, off: number, size: number): number {
    if (size === 4) {
        const f = p.readFloatLE(off);
        const i = p.readInt32LE(off);
        // kleine Ganzzahlen ergeben denormale Floats -> als int deuten
        return plausibleFloat(f) && !(Math.abs(i) < 0x00800000 && i !== 0) ? round(f) : i;
    }
    if (size === 2) {
        return p.readUInt16LE(off);
    }
    return p[off];
}

/**
 * @param p      Nutzdaten
 * @param count  Elementanzahl aus der zugehörigen Anfrage (0 = unbekannt)
 */
export function autoDecode(p: Buffer, count = 0): Decoded {
    if (p.length === 0) {
        return { kind: 'empty', value: null };
    }
    // Text nur, wenn lang genug (kurze Zahlenwerte können zufällig druckbar sein)
    // oder die Anfrage ausdrücklich Einzelbytes angefordert hat.
    // Zusätzlich: Hat die Anfrage mehrere Elemente > 1 Byte angefordert, ist es kein Text;
    // und der Text muss überwiegend aus ASCII bestehen (Gleitkommazahlen enthalten oft Bytes >= 0x80).
    const text = asText(p);
    const multiElem = count > 1 && p.length !== count;
    let ascii = 0;
    for (const c of p) {
        if ((c >= 0x20 && c < 0x7f) || c === 0) {
            ascii++;
        }
    }
    if (
        text !== null &&
        !multiElem &&
        ascii / p.length >= 0.9 &&
        /[A-Za-z]{2}/.test(text) &&
        (p.length >= 8 || (count >= 3 && p.length === count))
    ) {
        return { kind: 'text', value: text };
    }
    let size = count > 0 && p.length % count === 0 ? p.length / count : 0;
    if (![1, 2, 4].includes(size)) {
        size = p.length === 1 ? 1 : p.length === 2 ? 2 : p.length % 4 === 0 ? 4 : p.length % 2 === 0 ? 2 : 1;
    }
    const items: number[] = [];
    for (let o = 0; o + size <= p.length; o += size) {
        items.push(autoElem(p, o, size));
    }
    if (items.length === 1) {
        return { kind: 'number', value: items[0], elemSize: size };
    }
    return { kind: 'list', value: JSON.stringify(items), items, elemSize: size };
}

/** Wert gemäß Zuordnung lesen (Index in Elementen des Typs) */
export function decodeAs(p: Buffer, type: ValueType, index = 0, count = 0): string | number | null {
    if (type === 'text') {
        return p.toString('latin1').replace(/\0[\s\S]*$/, '').trim();
    }
    if (type === 'calendar') {
        return decodeCalendar(p);
    }
    if (type === 'clock') {
        return decodeClock(p);
    }
    if (type === 'fanlevel') {
        return p.length === 4 ? (CONTROLLER_FAN_LEVELS[p.readUInt32LE(0)] ?? null) : null;
    }
    if (type === 'auto') {
        const d = autoDecode(p, count);
        if (d.kind === 'list') {
            return d.items && index < d.items.length ? d.items[index] : null;
        }
        return index === 0 ? d.value : null;
    }
    const size = typeSize(type);
    const off = index * size;
    if (off + size > p.length) {
        return null;
    }
    return readElem(p, off, type);
}
