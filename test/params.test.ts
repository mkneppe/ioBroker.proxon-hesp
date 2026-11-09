import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decodeParam, parseDpList } from '../src/lib/params';
import { buildQuery, decodeFrame } from '../src/lib/hesp';

const h = (s: string): Buffer => Buffer.from(s, 'hex');

test('decodeParam: Grundtypen', () => {
    assert.equal(decodeParam(h('03')), 3);
    assert.equal(decodeParam(h('4b00')), 75);
    assert.equal(decodeParam(h('00004041')), 12); // float32 12.0 (Bypass-Schwelle)
    assert.equal(decodeParam(h('1e000000')), 30); // int32 30
    assert.equal(decodeParam(h('00000000')), 0);
    assert.equal(decodeParam(h('64005a00')), '[100,90]'); // 2×uint16
});

test('decodeParam: Listen', () => {
    assert.equal(decodeParam(h('0000c8410000ac42')), '[25,86]'); // float32-Liste
    assert.equal(decodeParam(h('b80b0000b80b0000')), '[3000,3000]'); // uint32-Liste
});

test('parseDpList', () => {
    assert.deepEqual(parseDpList('0x015F, 0x0228; 290 foo'), [0x015f, 0x0228, 290]);
    assert.deepEqual(parseDpList(''), []);
});

test('Lese-Anfrage mit Offset im Sub-Selektor', () => {
    const f = decodeFrame(buildQuery(1, 2, (0x0033 | (64 << 16)) >>> 0, 1));
    assert.ok(f);
    assert.equal(f.dp, 0x0033);
    assert.equal(f.sub, 64);
    assert.equal(f.dst, 2);
    assert.equal(f.type, 0);
});
