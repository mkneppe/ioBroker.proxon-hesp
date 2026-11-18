/* Datenquellen für den HESP-Bus: alle liefern einen transparenten Bytestrom und können Telegramme senden.
 *   tcp       – TCP-Client zu einem RS485-TCP-Gateway (z. B. USR-TCP232, Waveshare, ser2net im Raw-Modus)
 *   tcpserver – der Adapter wartet auf das Gateway (Gateway im Modus „TCP-Client“); die jeweils neueste Verbindung gilt
 *   serial    – direkte serielle Schnittstelle, z. B. USB-RS485-Adapter (/dev/ttyUSB0, COM3)
 */
import { EventEmitter } from 'node:events';
import * as net from 'node:net';

export type ConnType = 'tcp' | 'tcpserver' | 'serial';

export interface TransportOptions {
    type: ConnType;
    host?: string;
    port?: number;
    bind?: string;
    serialPath?: string;
    baudRate?: number;
    dataBits?: 5 | 6 | 7 | 8;
    parity?: 'none' | 'even' | 'odd';
    stopBits?: 1 | 2;
    /** TCP: Verbindung gilt nach so vielen ms ohne Daten als tot (0 = aus) */
    idleTimeoutMs?: number;
}

/**
 * Ereignisse: 'open' (Text), 'data' (Buffer), 'lost' (Grund). Nach 'lost' ist die Instanz unbrauchbar.
 */
export abstract class Transport extends EventEmitter {
    protected closed = false;

    /** Telegramm senden; ohne offene Verbindung wird es verworfen */
    abstract write(data: Buffer): void;

    /** Verbindung beenden, ohne 'lost' auszulösen */
    abstract close(): void;

    /** Kurze Beschreibung für Log-Meldungen */
    abstract describe(): string;

    protected fail(reason: string): void {
        if (this.closed) {
            return;
        }
        this.close();
        this.emit('lost', reason);
    }
}

class TcpClientTransport extends Transport {
    private sock: net.Socket;

    constructor(private readonly opts: TransportOptions) {
        super();
        const sock = net.createConnection({ host: opts.host || '', port: opts.port || 502 });
        this.sock = sock;
        if (opts.idleTimeoutMs) {
            sock.setTimeout(opts.idleTimeoutMs);
        }
        // Telegramme müssen in der kurzen Buslücke ankommen -> kein Nagle-Puffer
        sock.setNoDelay(true);
        sock.on('connect', () => {
            sock.setKeepAlive(true, 15000);
            this.emit('open', `Connected to ${this.describe()}`);
        });
        sock.on('data', chunk => this.emit('data', chunk));
        sock.on('timeout', () => this.fail('timeout, no data'));
        sock.on('error', err => this.fail(err.message));
        sock.on('close', () => this.fail('connection closed'));
    }

    write(data: Buffer): void {
        if (!this.closed && this.sock.writable) {
            this.sock.write(data);
        }
    }

    close(): void {
        this.closed = true;
        this.sock.removeAllListeners();
        this.sock.on('error', () => undefined);
        this.sock.destroy();
    }

    describe(): string {
        return `${this.opts.host}:${this.opts.port}`;
    }
}

class TcpServerTransport extends Transport {
    private server: net.Server;
    private client: net.Socket | null = null;

    constructor(private readonly opts: TransportOptions) {
        super();
        this.server = net.createServer(sock => this.accept(sock));
        this.server.on('error', err => this.fail(`Server: ${err.message}`));
        this.server.listen(opts.port ?? 502, opts.bind || '0.0.0.0', () => {
            this.emit('info', `Waiting for the gateway on ${this.describe()}`);
        });
    }

    private accept(sock: net.Socket): void {
        // nur eine Verbindung: die neueste ersetzt eine ältere (Gateway nach Neustart)
        if (this.client) {
            this.client.removeAllListeners();
            this.client.on('error', () => undefined);
            this.client.destroy();
        }
        this.client = sock;
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 15000);
        if (this.opts.idleTimeoutMs) {
            sock.setTimeout(this.opts.idleTimeoutMs);
        }
        sock.on('data', chunk => this.emit('data', chunk));
        sock.on('timeout', () => this.dropClient(sock, 'timeout, no data'));
        sock.on('error', err => this.dropClient(sock, err.message));
        sock.on('close', () => this.dropClient(sock, 'Gateway hat die Verbindung geschlossen'));
        this.emit('open', `Gateway ${sock.remoteAddress}:${sock.remotePort} connected (${this.describe()})`);
    }

    /**
     * Verlust der Gateway-Verbindung: Server läuft weiter, das Gateway verbindet sich selbst neu
     *
     * @param sock
     * @param reason
     */
    private dropClient(sock: net.Socket, reason: string): void {
        if (this.client !== sock) {
            return;
        }
        sock.removeAllListeners();
        sock.on('error', () => undefined);
        sock.destroy();
        this.client = null;
        this.emit('info', `Gateway disconnected (${reason}) – waiting for a new connection`);
        this.emit('down');
    }

    write(data: Buffer): void {
        if (!this.closed && this.client?.writable) {
            this.client.write(data);
        }
    }

    close(): void {
        this.closed = true;
        if (this.client) {
            this.client.removeAllListeners();
            this.client.on('error', () => undefined);
            this.client.destroy();
            this.client = null;
        }
        this.server.removeAllListeners();
        this.server.on('error', () => undefined);
        this.server.close();
    }

    describe(): string {
        return `TCP server ${this.opts.bind || '0.0.0.0'}:${this.opts.port}`;
    }
}

/** serialport wird erst bei Bedarf geladen (natives Modul) */
interface SerialPortLike {
    write(data: Buffer): boolean;
    close(cb?: (err?: Error | null) => void): void;
    removeAllListeners(): void;
    on(ev: string, fn: (...args: any[]) => void): void;
    isOpen: boolean;
}

class SerialTransport extends Transport {
    private port: SerialPortLike | null = null;

    constructor(private readonly opts: TransportOptions) {
        super();
        let SerialPort: new (o: Record<string, unknown>) => SerialPortLike;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            SerialPort = require('serialport').SerialPort;
        } catch (e) {
            setImmediate(() => this.fail(`Module serialport not available: ${(e as Error).message}`));
            return;
        }
        const port = new SerialPort({
            path: opts.serialPath || '',
            baudRate: opts.baudRate || 19200,
            dataBits: opts.dataBits || 8,
            parity: opts.parity || 'none',
            stopBits: opts.stopBits || 1,
            autoOpen: true,
        });
        this.port = port;
        port.on('open', () => this.emit('open', `Serial interface ${this.describe()} opened`));
        port.on('data', (chunk: Buffer) => this.emit('data', chunk));
        port.on('error', (err: Error) => this.fail(err.message));
        port.on('close', () => this.fail('interface closed'));
    }

    write(data: Buffer): void {
        if (!this.closed && this.port?.isOpen) {
            this.port.write(data);
        }
    }

    close(): void {
        this.closed = true;
        if (this.port) {
            this.port.removeAllListeners();
            this.port.on('error', () => undefined);
            if (this.port.isOpen) {
                this.port.close();
            }
            this.port = null;
        }
    }

    describe(): string {
        const o = this.opts;
        const parity = { none: 'N', even: 'E', odd: 'O' }[o.parity || 'none'];
        return `${o.serialPath} ${o.baudRate || 19200} ${o.dataBits || 8}${parity}${o.stopBits || 1}`;
    }
}

export function createTransport(opts: TransportOptions): Transport {
    switch (opts.type) {
        case 'serial':
            return new SerialTransport(opts);
        case 'tcpserver':
            return new TcpServerTransport(opts);
        default:
            return new TcpClientTransport(opts);
    }
}

/** Verfügbare serielle Schnittstellen (für die Auswahl im Admin) */
export async function listSerialPorts(): Promise<{ label: string; value: string }[]> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { SerialPort } = require('serialport');
        const ports: { path: string; manufacturer?: string; serialNumber?: string }[] = await SerialPort.list();
        return ports.map(p => ({
            value: p.path,
            label: [p.path, p.manufacturer, p.serialNumber].filter(Boolean).join(' – '),
        }));
    } catch {
        return [];
    }
}
