import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { autoDecode, decodeAs, decodeCalendar, decodeClock } from '../src/lib/decode';
import { buildFrame, crc16, decodeFrame, FrameParser } from '../src/lib/hesp';

const fixture = fs
    .readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'capture-30s.hex'), 'utf8')
    .trim()
    .split('\n')
    .map(h => Buffer.from(h, 'hex'));

test('CRC: Beispiele aus markusmauch.github.io/proxon-hesp', () => {
    assert.equal(crc16(Buffer.from('10800060010000040100', 'hex')), 0xe149);
    assert.equal(crc16(Buffer.from('118000270200000800009841', 'hex')), 0xcd8a);
    assert.equal(crc16(Buffer.from('2340002702000000', 'hex')), 0xa139);
});

test('Parser: kompletter 30-s-Mitschnitt ohne Fehler, beliebige Chunk-Grenzen', () => {
    const all = Buffer.concat(fixture);
    for (const step of [1, 3, 7, 64, all.length]) {
        const p = new FrameParser();
        let n = 0;
        for (let o = 0; o < all.length; o += step) {
            n += p.push(all.subarray(o, o + step)).length;
        }
        assert.equal(n, 595, `chunk ${step}`);
        assert.equal(p.skippedBytes, 0);
    }
});

test('Parser: synchronisiert sich nach Datenmüll neu', () => {
    const p = new FrameParser();
    const good = Buffer.concat(fixture.slice(0, 20));
    const frames = p.push(Buffer.concat([Buffer.from('deadbeef0011', 'hex'), good]));
    assert.ok(frames.length >= 19);
    assert.ok(p.skippedBytes > 0);
});

test('Parser: langes Telegramm mit Längenfeld 00 (128 Byte Nutzdaten)', () => {
    const payload = Buffer.alloc(128);
    for (let i = 0; i < 64; i++) {
        payload.writeUInt16LE(0x0190 + i, i * 2);
    }
    const f = buildFrame(2, 2, 1, 0x0033, payload, 0); // Nibble-Feld läuft über -> 0
    const q = buildFrame(0, 1, 2, 0x0033, Buffer.from([0x40, 0]));
    const p = new FrameParser();
    // Telegramm in zwei Teilen liefern, dazwischen ein normales Telegramm danach
    const out = [...p.push(Buffer.concat([q, f.subarray(0, 50)])), ...p.push(Buffer.concat([f.subarray(50), q]))];
    assert.equal(out.length, 3);
    assert.equal(out[1].payload.length, 128);
    assert.equal(out[1].payload.readUInt16LE(2), 0x0191);
});

test('Header: Typ/Quelle/Ziel', () => {
    const f = decodeFrame(Buffer.from('2240002702000000' + '0000', 'hex'));
    assert.equal(f.type, 2);
    assert.equal(f.src, 2);
    assert.equal(f.dst, 1);
    const g = decodeFrame(Buffer.from('108007910100000400003f00', 'hex'));
    assert.equal(g.dst, 30);
});

test('buildFrame reproduziert alle Mitschnitt-Telegramme', () => {
    const p = new FrameParser();
    for (const f of p.push(Buffer.concat(fixture))) {
        assert.ok(buildFrame(f.type, f.src, f.dst, f.id, f.payload, f.nibbles).equals(f.raw));
    }
});

test('Dekodierung: Temperaturblock 0x03B7 int16 x 0,1', () => {
    const p = Buffer.from('c100da0079006c00790079007000cc00c600ed000000', 'hex');
    assert.equal(decodeAs(p, 'int16', 0), 193);
    assert.equal(decodeAs(p, 'int16', 3), 108);
    assert.equal(decodeAs(Buffer.from('fdff', 'hex'), 'int16', 0), -3);
});

test('Dekodierung: auto', () => {
    assert.equal(autoDecode(Buffer.from('0000a841', 'hex')).value, 21);
    assert.equal(autoDecode(Buffer.from('72000000', 'hex')).value, 114);
    assert.equal(autoDecode(Buffer.from('3333a341', 'hex')).kind, 'number');
    assert.equal(autoDecode(Buffer.from('4b65696e204665686c657200', 'hex')).value, 'Kein Fehler');
    // reale Lüfterdrehzahlen, deren Bytes zufällig alle druckbar sind -> keine Texte
    assert.equal(autoDecode(Buffer.from('40c9fa446adfee44', 'hex'), 2).kind, 'list');
    assert.equal(autoDecode(Buffer.from('b055f94478def544', 'hex'), 0).kind, 'list');
    const l = autoDecode(Buffer.from('c4e3f844e78df344', 'hex'), 2);
    assert.equal(l.kind, 'list');
    assert.equal(Math.round(l.items![0]), 1991);
});

test('Dekodierung: Kalender, Uhrzeit, Lüfterstufe', () => {
    // 2026-09-23 12:50, Mittwoch (3)
    const v = 50 | (12 << 6) | (3 << 11) | (26 << 14) | (9 << 21) | (23 << 25);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    assert.equal(decodeCalendar(b), '2026-09-23T12:50');
    const c = Buffer.alloc(4);
    c.writeUInt32LE(14 | (5 << 5) | (30 << 11));
    assert.equal(decodeClock(c), '14:05:30');
    assert.equal(decodeAs(Buffer.from('1a100080', 'hex'), 'fanlevel'), 3);
    assert.equal(decodeAs(Buffer.from('1a100090', 'hex'), 'fanlevel'), null);
});
