import assert from 'node:assert/strict';
import * as net from 'node:net';
import test from 'node:test';
import { createTransport, type Transport } from '../src/lib/transport';

const once = <T>(t: Transport, ev: string): Promise<T> => new Promise(resolve => t.once(ev, resolve));

test('Transport TCP-Client: empfängt und sendet', async () => {
    let peer: net.Socket | undefined;
    const got: Buffer[] = [];
    const server = net.createServer(s => {
        peer = s;
        s.on('data', d => got.push(d));
        s.write(Buffer.from('a1b2', 'hex'));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const t = createTransport({ type: 'tcp', host: '127.0.0.1', port });
    await once(t, 'open');
    const data = await once<Buffer>(t, 'data');
    assert.equal(data.toString('hex'), 'a1b2');
    t.write(Buffer.from('c3', 'hex'));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(Buffer.concat(got).toString('hex'), 'c3');
    const lost = once<string>(t, 'lost');
    peer?.destroy();
    assert.match(await lost, /geschlossen/);
    server.close();
});

test('Transport TCP-Server: Gateway verbindet sich, neueste Verbindung gilt', async () => {
    const t = createTransport({ type: 'tcpserver', port: 0, bind: '127.0.0.1' });
    await once(t, 'info');
    // Port des Servers über die private Instanz ermitteln
    const port = ((t as unknown as { server: net.Server }).server.address() as net.AddressInfo).port;
    const c1 = net.createConnection({ host: '127.0.0.1', port });
    await once(t, 'open');
    const c2 = net.createConnection({ host: '127.0.0.1', port });
    await once(t, 'open');
    const got: Buffer[] = [];
    c2.on('data', d => got.push(d));
    t.write(Buffer.from('55', 'hex'));
    c2.write(Buffer.from('66', 'hex'));
    const data = await once<Buffer>(t, 'data');
    assert.equal(data.toString('hex'), '66');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(Buffer.concat(got).toString('hex'), '55');
    const down = once(t, 'down');
    c2.destroy();
    await down;
    c1.destroy();
    t.close();
});
