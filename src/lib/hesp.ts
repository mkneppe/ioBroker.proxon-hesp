/**
 * HESP-Protokoll der Proxon P-Serie (aus Busmitschnitten ermittelt).
 *
 * Telegramm:
 *   Byte 0..2  24 Bit LE: Bit 0-3 Typ, Bit 4-13 Quelle, Bit 14-23 Ziel (vermutete Deutung)
 *   Byte 3..6  Register-ID (uint32 LE; untere 16 Bit = Datenpunkt, obere 16 Bit = Sub-Selektor)
 *   Byte 7     Länge der Nutzdaten in Nibbles
 *   Byte 8..   Nutzdaten (ceil(nibbles / 2) Bytes)
 *   2 Bytes    CRC-16 LE (Init 0xFFFF, Polynom 0x8048 reflektiert, 16 Schiebeschritte je Byte)
 */

export enum FrameType {
    Query = 0,
    Set = 1,
    Response = 2,
    Confirm = 3,
}

export interface Frame {
    type: number;
    src: number;
    dst: number;
    /** vollständige 32-Bit-Register-ID */
    id: number;
    /** Datenpunkt (untere 16 Bit) */
    dp: number;
    /** Sub-Selektor (obere 16 Bit) */
    sub: number;
    nibbles: number;
    payload: Buffer;
    raw: Buffer;
}

export const HEADER_LEN = 8;
export const MIN_FRAME_LEN = HEADER_LEN + 2;

export function crc16(buf: Uint8Array, start = 0, end = buf.length): number {
    let c = 0xffff;
    for (let i = start; i < end; i++) {
        c ^= buf[i];
        for (let k = 0; k < 16; k++) {
            c = c & 1 ? (c >>> 1) ^ 0x8048 : c >>> 1;
        }
    }
    return c;
}

export function frameLength(nibbles: number): number {
    return MIN_FRAME_LEN + Math.ceil(nibbles / 2);
}

export function decodeFrame(raw: Buffer): Frame {
    const h = raw[0] | (raw[1] << 8) | (raw[2] << 16);
    const id = raw.readUInt32LE(3);
    return {
        type: h & 0x0f,
        src: (h >>> 4) & 0x3ff,
        dst: (h >>> 14) & 0x3ff,
        id,
        dp: id & 0xffff,
        sub: id >>> 16,
        nibbles: raw[7],
        payload: raw.subarray(HEADER_LEN, raw.length - 2),
        raw,
    };
}

export function buildFrame(
    type: number,
    src: number,
    dst: number,
    id: number,
    payload: Buffer = Buffer.alloc(0),
    nibbles = payload.length * 2,
): Buffer {
    const f = Buffer.alloc(MIN_FRAME_LEN + payload.length);
    const h = (type & 0x0f) | ((src & 0x3ff) << 4) | ((dst & 0x3ff) << 14);
    f[0] = h & 0xff;
    f[1] = (h >>> 8) & 0xff;
    f[2] = (h >>> 16) & 0xff;
    f.writeUInt32LE(id >>> 0, 3);
    f[7] = nibbles;
    payload.copy(f, HEADER_LEN);
    f.writeUInt16LE(crc16(f, 0, f.length - 2), f.length - 2);
    return f;
}

/** Lese-Anfrage; count = Anzahl Elemente */
export function buildQuery(src: number, dst: number, id: number, count = 1): Buffer {
    const p = Buffer.alloc(2);
    p.writeUInt16LE(count);
    return buildFrame(FrameType.Query, src, dst, id, p);
}

/**
 * Zerlegt einen Bytestrom in Telegramme. Bei CRC-Fehlern wird byteweise
 * weitergeschoben, bis wieder ein gültiges Telegramm gefunden wird.
 */
export class FrameParser {
    private buf: Buffer = Buffer.alloc(0);
    public validFrames = 0;
    public skippedBytes = 0;

    constructor(private readonly maxBuffer = 4096) {}

    public reset(): void {
        this.buf = Buffer.alloc(0);
    }

    private crcOk(o: number, total: number): boolean {
        return crc16(this.buf, o, o + total - 2) === this.buf.readUInt16LE(o + total - 2);
    }

    public push(chunk: Buffer): Frame[] {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
        const out: Frame[] = [];
        let o = 0;
        while (this.buf.length - o >= MIN_FRAME_LEN) {
            const nib = this.buf[o + 7];
            const total = frameLength(nib);
            // Lange Antworten (z. B. Meta-Listen mit 128 Byte) tragen im Längenfeld
            // vermutlich nur die unteren 8 Bit der Nibble-Anzahl (256 -> 0x00).
            const totalLong = frameLength(nib + 256);
            const avail = this.buf.length - o;
            if (avail < total) {
                break;
            }
            let len = 0;
            if (this.crcOk(o, total)) {
                len = total;
            } else if (avail >= totalLong) {
                len = this.crcOk(o, totalLong) ? totalLong : 0;
            } else {
                // könnte ein noch unvollständiges langes Telegramm sein -> auf mehr Daten warten
                // (begrenzt: spätestens bei totalLong Bytes fällt die Entscheidung)
                break;
            }
            if (len) {
                out.push(decodeFrame(Buffer.from(this.buf.subarray(o, o + len))));
                o += len;
                this.validFrames++;
            } else {
                o++;
                this.skippedBytes++;
            }
        }
        this.buf = this.buf.subarray(o);
        if (this.buf.length > this.maxBuffer) {
            this.skippedBytes += this.buf.length;
            this.buf = Buffer.alloc(0);
        }
        return out;
    }
}

export function toHex(b: Uint8Array): string {
    return Array.from(b, x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
