/**
 * ioBroker adapter proxon-hesp
 * Listens passively to the HESP bus of a Proxon unit via an RS485 gateway or serial interface.
 */
import * as utils from '@iobroker/adapter-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { autoDecode, decodeAs, decodeCalendar, decodeClock, encodeCalendar, type ValueType } from './lib/decode';
import { buildFrame, buildQuery, type Frame, FrameParser, FrameType, toHex } from './lib/hesp';
import { type ConnType, createTransport, listSerialPorts, type Transport } from './lib/transport';
import { decodeParam, PARAM_ACCESS, PARAM_NAMES, PARAM_UNITS, parseDpList, ROOM_PARAM_NAMES } from './lib/params';
import {
    fallbackFolder,
    MAPPING_UPDATES,
    migrateId,
    NAMES,
    renameModule,
    renamePath,
    tr,
    type Translated,
} from './lib/ids';

interface ModuleCfg {
    address: number;
    name: string;
}

interface MappingCfg {
    module: number;
    kind: 'R' | 'W';
    register: number;
    index: number;
    name: string;
    unit: string;
    type: ValueType;
    factor: number;
    history: boolean;
    /** einzelnes Bit (0 = LSB) des Ganzzahlwerts als Wahrheitswert; leer/-1 = aus */
    bit?: number | string;
    /** Rohwert (vor Faktor), der ignoriert wird, z. B. -1 für 0xFFFF */
    ignore?: number | string;
    /** Gültigkeitsbereich nach Faktor; außerhalb wird nicht aktualisiert */
    min?: number | string;
    max?: number | string;
    /** Wertetexte, z. B. "0:Aus;1:Eco-Sommer" */
    states?: string;
}

const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/**
 * Number from the configuration, limited to [min, max]; invalid or empty -> default
 *
 * @param v configured value
 * @param def default
 * @param min lower limit
 * @param max upper limit
 */
const cfgNum = (v: unknown, def: number, min: number, max: number): number => {
    const n = isSet(v) ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
/** German parameter descriptions of versions before 0.6.0 -> English */
const OLD_ACCESS: Record<string, string> = {
    'nur lesen': 'read only',
    'Benutzer schreibbar': 'writable (user)',
    'Fachmann schreibbar': 'writable (installer)',
    'Fachmann sichtbar': 'visible (installer)',
};
const translateParamDesc = (d: string): string => {
    const m = /^Zugriff: (.*), Einheitencode (.*), Rohdaten (.*)$/.exec(d);
    if (!m) {
        return d;
    }
    const acc = OLD_ACCESS[m[1]] ?? m[1].replace(/^Fachmann/, 'installer').replace(/^intern/, 'internal');
    return `Access: ${acc}, unit code ${m[2]}, raw data ${m[3]}`;
};

/** Largest delay setTimeout/setInterval accept (ms) */
const MAX_TIMER_MS = 2147483647;

interface Config {
    /** Datenquelle: TCP-Client zum Gateway, TCP-Server (Gateway verbindet sich) oder serielle Schnittstelle */
    connType: ConnType;
    host: string;
    /** TCP-Server: lokale Adresse (leer = alle) */
    bind: string;
    serialPath: string;
    serialBaud: number;
    serialDataBits: 5 | 6 | 7 | 8;
    serialParity: 'none' | 'even' | 'odd';
    serialStopBits: 1 | 2;
    port: number;
    watchdogSec: number;
    refreshSec: number;
    storeRegisters: boolean;
    captureMinutes: number;
    historyInstance: string;
    eventLimit: number;
    modules: ModuleCfg[];
    mappings: MappingCfg[];
    /** Schreiben von Raum-Sollwerten (SET 0x01FB) erlauben */
    allowWrite: boolean;
    /** Busadressen der Raummodule mit beschreibbarem Sollwert, z. B. "10,11,12" */
    controlModules: string;
    writeMin: number;
    writeMax: number;
    /** Schrittweite der Sollwerte (die meisten Raummodule kennen nur ganze Grad) */
    writeStep: number;
    /** Heizelement der Raummodule freigeben/sperren (SET 0x0196) erlauben */
    allowHeaterWrite: boolean;
    /** Uhr des Lüftungsgeräts stellen (SET 1>2 0x032E) erlauben */
    allowClockWrite: boolean;
    /** gewünschter Versatz der Geräteuhr gegenüber der Systemzeit in Minuten */
    clockOffsetMin: number;
    /** Parameter des Lüftungsgeräts regelmäßig per Lese-Anfrage abfragen */
    pollEnabled: boolean;
    pollMinutes: number;
    /** DPs (hex/dez., Komma-getrennt); leer = alle aus dem Verzeichnis */
    pollList: string;
    /** Lernprotokoll: jede Wertänderung und alle nicht erkannten Bytes in Tagesdateien */
    learnLog: boolean;
    /** Aufbewahrung der Lernprotokolle in Tagen (0 = unbegrenzt) */
    learnLogDays: number;
}

/** Ausstehende Lese-Anfrage (Typ 0, Quelle 1) */
interface QueryJob {
    dst: number;
    id: number;
    count: number;
    tries: number;
    maxTries: number;
    sentAt: number;
    resolve: (payload: Buffer | null) => void;
}

/** Verzeichnis eines Moduls aus den Meta-DPs */
interface ParamDirectory {
    dps: number[];
    access: number[];
    units: number[];
}

/** Ausstehender Schreibauftrag: Sollwert (SET 0x01FB) oder Heizelement-Freigabe (SET 0x0196) */
interface WriteJob {
    /** clock: value = Versatz in Minuten, die Uhrzeit wird erst im Sendemoment ermittelt */
    kind: 'setpoint' | 'heater' | 'clock';
    mod: number;
    value: number;
    tries: number;
    sentAt: number;
    /** clock: gesendete Uhrzeit (ms) */
    clockSent?: number;
    /** frühester Sendezeitpunkt (ms): Schieberegler senden beim Ziehen Zwischenwerte, gesendet wird nur der letzte */
    notBefore?: number;
}

/** DP, nach dessen Antwort (von Adresse 2) eine kurze Buslücke folgt (~70–80 ms bis zur nächsten Anfrage des zentralen Bedienelements (BDE)) */
const GAP_TRIGGER_DP = 0x02d9;
const WRITE_TIMEOUT_MS = 22000;
/**
 * Schreiben bevorzugt in der längeren Lücke nach der Antwort des Luftqualitätsmoduls (40>1 0x0194: gemessen min. 88 ms, meist ~100 ms;
 *  nach 0x02D9 nur 65–72 ms, dort kollidierten Schreibbefehle mit der nächsten Anfrage der BDE)
 */
const WRITE_GAP_SRC = 40;
const WRITE_GAP_DP = 0x0194;
/** Schreibbefehle kollidieren oft mit der BDE (Lücke nur ~70 ms, TCP-Laufzeit schwankt) – mehrere Versuche */
const WRITE_MAX_TRIES = 10;
/** Uhr stellen: Quittung kommt sofort, sonst in der nächsten passenden Lücke wiederholen */
const CLOCK_TIMEOUT_MS = 2000;
/** Wartezeit nach der letzten Sollwert-Änderung, bevor gesendet wird */
const SETPOINT_SETTLE_MS = 2000;
const QUERY_TIMEOUT_MS = 3000;
/** Lese-Anfragen gehen oft verloren (nur ~40 % Treffer): die Lücke nach 0x02D9 ist nur ~70–80 ms lang */
const QUERY_MAX_TRIES = 8;
/** so viele unbeantwortete Versuche in Folge deuten auf einen hängenden Sendeweg im Gateway -> Verbindung neu aufbauen */
const QUERY_FAIL_RECONNECT = 12;
/** Adresse des Lüftungsgeräts */
const UNIT_ADDR = 2;
/** Meta-Listen liefern je Anfrage 64 Einträge ab dem Offset im Sub-Selektor */
const META_PAGE = 64;

/** Meta-Datenpunkte (Selbstauskunft der Module) */
const META: Record<number, { name: string; title: Translated; text: boolean }> = {
    0x0001: { name: 'name', title: tr('Name', 'Name'), text: true },
    0x0033: { name: 'dpList', title: tr('DP list', 'DP-Liste'), text: false },
    0x0034: { name: 'typeCodes', title: tr('Type codes', 'Typcodes'), text: false },
    0x0038: { name: 'access', title: tr('Access codes', 'Zugriffscodes'), text: false },
    0x0039: { name: 'units', title: tr('Unit codes', 'Einheitencodes'), text: false },
    0x0130: { name: 'errorStatus', title: tr('Error status', 'Fehlerstatus'), text: true },
};
const UNIT_CODES: Record<number, string> = { 5: 's', 8: '°C', 11: 'text' };
const ACCESS_CODES: Record<number, string> = {
    0x55: 'read only',
    0xff: 'writable',
    0xd5: 'writable (installer)',
    0xc0: 'visible (installer)',
};

/** Register, die innerhalb dieser Zeit nach dem Start auftauchen, gelten als „normaler Zyklus“ */
const STARTUP_GRACE_MS = 3 * 60 * 1000;

class ProxonHesp extends utils.Adapter {
    private cfg!: Config;
    private sock: Transport | null = null;
    private parser = new FrameParser();
    private reconnectTimer: ioBroker.Timeout | undefined;
    private backoffMs = 1000;
    private stopping = false;
    private lastValid = 0;
    private startedAt = Date.now();
    private busConnected = false;

    private moduleNames = new Map<number, string>();
    private mappings = new Map<string, MappingCfg[]>();
    private known = new Set<string>();
    /** common of existing objects, removed after the first comparison in ensureObject */
    private knownCommon = new Map<string, Partial<ioBroker.StateCommon>>();
    private pendingCreate = new Map<string, Promise<void>>();
    private lastWritten = new Map<string, { val: ioBroker.StateValue; ts: number }>();
    private queries = new Map<string, { id: number; count: number }>();
    private regStats = new Map<string, { count: number; last: number; base: string }>();
    private meta: Record<number, Record<string, number[]>> = {};
    private events: { ts: string; text: string }[] = [];
    private capture: { stream: fs.WriteStream; file: string; timer: ioBroker.Timeout | undefined } | null = null;
    private hourOk = 0;
    private hourBad = 0;
    private controlMods = new Set<number>();
    /** zuletzt gemeldete Sekunden der Geräteuhr (0x0330) */
    private unitClock?: { sec: number; at: number };
    private writeQueue: WriteJob[] = [];
    private reportedSetpoint = new Map<number, number>();
    /** Raummodule mit schaltbarem Heizelement und zuletzt gemeldete Freigabe (0x0194 Bit 3) */
    private heaterMods = new Set<number>();
    private reportedHeater = new Map<number, boolean>();
    private queryQueue: QueryJob[] = [];
    /** unbeantwortete Anfrage-Versuche in Folge */
    private queryFailStreak = 0;
    /** Lernprotokoll: letzter Inhalt je Register und offene Tagesdateien */
    private learnLast = new Map<string, string>();
    private learnFiles = new Map<string, { day: string; stream: fs.WriteStream }>();
    private learnCleanupTimer: ioBroker.Interval | undefined;
    private paramDirs = new Map<number, ParamDirectory>();
    private paramRunning = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'proxon-hesp' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));
    }

    /* ------------------------------------------------------------------ Start */

    private async onReady(): Promise<void> {
        this.cfg = this.config as unknown as Config;
        this.cfg.port = Number(this.cfg.port) || 502;
        this.cfg.connType = (['tcp', 'tcpserver', 'serial'] as ConnType[]).includes(this.cfg.connType)
            ? this.cfg.connType
            : 'tcp';
        this.cfg.serialBaud = Number(this.cfg.serialBaud) || 19200;
        this.cfg.serialDataBits = ([5, 6, 7, 8] as const).find(b => b === Number(this.cfg.serialDataBits)) ?? 8;
        this.cfg.serialStopBits = Number(this.cfg.serialStopBits) === 2 ? 2 : 1;
        this.cfg.serialParity = (['none', 'even', 'odd'] as const).find(p => p === this.cfg.serialParity) ?? 'none';
        // all timer settings are limited so that every derived delay stays below MAX_TIMER_MS
        this.cfg.watchdogSec = cfgNum(this.cfg.watchdogSec, 120, 10, 86400);
        this.cfg.refreshSec = cfgNum(this.cfg.refreshSec, 300, 10, 86400);
        this.cfg.captureMinutes = cfgNum(this.cfg.captureMinutes, 15, 1, 1440);
        this.cfg.eventLimit = Math.round(cfgNum(this.cfg.eventLimit, 100, 1, 1000));
        this.cfg.learnLogDays = Math.round(cfgNum(this.cfg.learnLogDays, 90, 0, 3650));
        this.cfg.pollMinutes = cfgNum(this.cfg.pollMinutes, 60, 5, 1440);

        // IDs before 0.6.0 were German: migrate configuration and objects once (restarts the adapter if needed)
        if (await this.migrateToEnglishIds()) {
            return;
        }

        if (this.cfg.learnLog) {
            this.parser.onJunk = junk => this.learnWrite('unknown', `${Date.now()} ${junk.toString('hex')}`);
            this.learnCleanup();
            this.learnCleanupTimer = this.setInterval(() => this.learnCleanup(), 6 * 3600e3);
            this.log.info(`Learning log active: ${this.learnDir()}`);
        }

        await this.setState('info.connection', false, true);
        if (this.cfg.connType === 'tcp' && !this.cfg.host) {
            this.log.error('No gateway (host) configured');
            return;
        }
        if (this.cfg.connType === 'serial' && !this.cfg.serialPath) {
            this.log.error('No serial interface configured');
            return;
        }

        for (const m of this.cfg.modules || []) {
            if (m && m.name !== undefined && m.address !== undefined) {
                this.moduleNames.set(Number(m.address), this.cleanId(String(m.name)) || fallbackFolder(m.address));
            }
        }
        for (const m of this.cfg.mappings || []) {
            if (!m || !m.name) {
                continue;
            }
            const key = `${m.kind || 'R'}:${Number(m.module)}:${Number(m.register)}`;
            const list = this.mappings.get(key) || [];
            list.push({
                ...m,
                module: Number(m.module),
                register: Number(m.register),
                index: Number(m.index) || 0,
                factor:
                    m.factor === undefined || m.factor === null || (m.factor as unknown) === '' ? 1 : Number(m.factor),
                type: m.type || 'auto',
            });
            this.mappings.set(key, list);
        }

        // bereits vorhandene Objekte merken (keine Neuanlage, keine „neu“-Ereignisse)
        const objs = await this.getAdapterObjectsAsync();
        for (const [id, o] of Object.entries(objs)) {
            const rel = id.substring(this.namespace.length + 1);
            this.known.add(rel);
            const c = o.common as Partial<ioBroker.StateCommon>;
            this.knownCommon.set(rel, { name: c.name, unit: c.unit, states: c.states, desc: c.desc });
        }
        await this.removeDisabledControls();
        await this.restoreMeta();
        await this.refreshNames();
        await this.restoreEvents();

        await this.ensureObject('info.connection', {
            type: 'state',
            common: {
                name: tr('Connected and receiving valid telegrams', 'Verbunden und gültige Telegramme'),
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
        });
        await this.ensureObject('info.capture', {
            type: 'state',
            common: {
                name: tr(
                    `Capture telegrams to a file (${this.cfg.captureMinutes} min)`,
                    `Telegramm-Mitschnitt in Datei (${this.cfg.captureMinutes} min)`,
                ),
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
                def: false,
            },
        });
        await this.setState('info.capture', false, true);
        this.subscribeStates('info.capture');

        if (this.cfg.allowWrite) {
            this.cfg.writeMin = cfgNum(this.cfg.writeMin, 15, 5, 35);
            this.cfg.writeMax = cfgNum(this.cfg.writeMax, 28, 5, 35);
            this.cfg.writeStep = Number(this.cfg.writeStep) === 0.5 ? 0.5 : 1;
            for (const s of String(this.cfg.controlModules || '').split(',')) {
                const n = Number(s.trim());
                if (Number.isInteger(n) && n > 0) {
                    this.controlMods.add(n);
                }
            }
            for (const mod of this.controlMods) {
                await this.ensureModule(mod);
                await this.ensureObject(`${this.moduleFolder(mod)}.setpoint`, {
                    type: 'state',
                    common: {
                        name: tr(
                            'Setpoint (writable, sent as SET 0x01FB to the room module)',
                            'Sollwert (schreibbar, wird als SET 0x01FB an das Raummodul gesendet)',
                        ),
                        type: 'number',
                        role: 'level.temperature',
                        unit: '°C',
                        min: this.cfg.writeMin,
                        max: this.cfg.writeMax,
                        step: this.cfg.writeStep,
                        read: true,
                        write: true,
                    },
                });
                // Schrittweite auch bei bestehenden Objekten aktualisieren
                await this.extendObjectAsync(`${this.moduleFolder(mod)}.setpoint`, {
                    common: { min: this.cfg.writeMin, max: this.cfg.writeMax, step: this.cfg.writeStep },
                });
                this.subscribeStates(`${this.moduleFolder(mod)}.setpoint`);
            }
            this.log.info(
                `Writing enabled for room modules ${[...this.controlMods].join(', ')} (${this.cfg.writeMin}–${this.cfg.writeMax} °C, step ${this.cfg.writeStep} °C)`,
            );
            if (this.cfg.allowHeaterWrite) {
                for (const mod of this.controlMods) {
                    this.heaterMods.add(mod);
                    const id = `${this.moduleFolder(mod)}.heaterEnable`;
                    await this.ensureObject(id, {
                        type: 'state',
                        common: {
                            name: tr(
                                'Enable electric heater (writable, sent as SET 0x0196 to the room module)',
                                'Heizelement freigeben (schreibbar, wird als SET 0x0196 an das Raummodul gesendet)',
                            ),
                            type: 'boolean',
                            role: 'switch',
                            read: true,
                            write: true,
                        },
                    });
                    this.subscribeStates(id);
                }
                this.log.info(`Electric heater switchable for room modules ${[...this.heaterMods].join(', ')}`);
            }
        }
        if (this.cfg.allowWrite && this.cfg.allowClockWrite) {
            this.cfg.clockOffsetMin = Math.round(Number(this.cfg.clockOffsetMin) || 0);
            await this.ensureModule(UNIT_ADDR);
            await this.ensureParents(this.clockButtonId());
            await this.ensureObject(this.clockButtonId(), {
                type: 'state',
                common: {
                    name: tr(
                        'Set the clock of the ventilation unit to system time + offset (settings)',
                        'Uhr des Lüftungsgeräts auf Systemzeit + Versatz (Einstellungen) stellen',
                    ),
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                },
            });
            this.subscribeStates(this.clockButtonId());
        }

        await this.setupParameters();

        this.setInterval(() => this.flushStats(), Math.min(this.cfg.refreshSec * 1000, MAX_TIMER_MS));
        this.setInterval(() => this.hourly(), 60 * 60 * 1000);
        this.setInterval(() => this.watchdog(), 30 * 1000);

        this.connect();
    }

    private onUnload(callback: () => void): void {
        try {
            this.stopping = true;
            for (const q of this.queryQueue.splice(0)) {
                q.resolve(null);
            }
            if (this.reconnectTimer) {
                this.clearTimeout(this.reconnectTimer);
            }
            this.stopCapture(false);
            if (this.learnCleanupTimer) {
                this.clearInterval(this.learnCleanupTimer);
            }
            for (const f of this.learnFiles.values()) {
                f.stream.end();
            }
            this.learnFiles.clear();
            this.shutdownSocket();
            void this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }

    /* ------------------------------------------------------------- Verbindung */

    private connect(): void {
        this.shutdownSocket();
        this.parser.reset();
        const c = this.cfg;
        const t = createTransport({
            type: c.connType,
            host: c.host,
            port: c.port,
            bind: c.bind,
            serialPath: c.serialPath,
            baudRate: c.serialBaud,
            dataBits: c.serialDataBits,
            parity: c.serialParity,
            stopBits: c.serialStopBits,
            idleTimeoutMs: 60000,
        });
        this.sock = t;
        t.on('open', (msg: string) => {
            this.log.info(msg);
            this.backoffMs = 1000;
            this.lastValid = Date.now();
        });
        t.on('info', (msg: string) => this.log.info(msg));
        // TCP-Server: Gateway weg, Server wartet weiter
        t.on('down', () => this.setConnected(false));
        t.on('data', (chunk: Buffer) => this.onData(chunk));
        t.on('lost', (reason: string) => this.lost(reason));
    }

    private shutdownSocket(): void {
        if (!this.sock) {
            return;
        }
        this.sock.removeAllListeners();
        this.sock.close();
        this.sock = null;
    }

    private lost(reason: string): void {
        this.shutdownSocket();
        this.setConnected(false);
        if (this.stopping || this.reconnectTimer) {
            return;
        }
        const msg = `Connection lost (${reason}), retrying in ${Math.round(this.backoffMs / 1000)} s`;
        this.backoffMs >= 30000 ? this.log.warn(msg) : this.log.info(msg);
        this.reconnectTimer = this.setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 60000);
    }

    private watchdog(): void {
        if (this.sock && Date.now() - this.lastValid > this.cfg.watchdogSec * 1000) {
            this.log.warn(`No valid telegrams for ${this.cfg.watchdogSec} s – reconnecting`);
            this.lost('watchdog');
        }
    }

    private setConnected(on: boolean): void {
        if (this.busConnected !== on) {
            this.busConnected = on;
            void this.setState('info.connection', on, true);
        }
    }

    /* ------------------------------------------------------------- Empfang */

    private onData(chunk: Buffer): void {
        const before = this.parser.skippedBytes;
        const frames = this.parser.push(chunk);
        this.hourBad += this.parser.skippedBytes - before;
        for (const f of frames) {
            this.hourOk++;
            this.lastValid = Date.now();
            this.setConnected(true);
            try {
                this.onFrame(f);
            } catch (e) {
                this.log.warn(`Error processing telegram ${toHex(f.raw)}: ${(e as Error).message}`);
            }
        }
    }

    private onFrame(f: Frame): void {
        // zeitkritisch: in der Buslücke zuerst senden, dann auswerten
        if (f.type === FrameType.Response) {
            this.gapTick(f);
        }
        if (this.cfg.learnLog) {
            this.learnFrame(f);
        }
        if (this.capture) {
            this.capture.stream.write(
                `${new Date().toISOString()} ${f.type} ${f.src}>${f.dst} 0x${f.id.toString(16)} ${f.raw.toString('hex')}\n`,
            );
        }
        switch (f.type) {
            case FrameType.Query:
                this.queries.set(`${f.src}>${f.dst}`, {
                    id: f.id,
                    count: f.payload.length >= 2 ? f.payload.readUInt16LE(0) : 1,
                });
                return;
            case FrameType.Response: {
                const qj = this.queryQueue[0];
                if (qj && qj.sentAt && f.src === qj.dst && f.dst === 1 && f.id === qj.id) {
                    this.queryQueue.shift();
                    this.queryFailStreak = 0;
                    qj.resolve(f.payload);
                }
                if (f.dp === 0x0330 && f.src === UNIT_ADDR && f.payload.length === 4) {
                    const sec = Number(decodeClock(f.payload)?.slice(6));
                    if (Number.isFinite(sec)) {
                        this.unitClock = { sec, at: Date.now() };
                    }
                }
                if (f.dp === 0x0194 && f.payload.length >= 2 && this.heaterMods.has(f.src)) {
                    void this.onHeaterReport(f.src, (f.payload.readUInt16LE(0) & 0x0008) !== 0);
                }
                if (f.dp === 0x01f6 && f.payload.length === 4 && this.controlMods.has(f.src)) {
                    void this.onSetpointReport(f.src, Math.round(f.payload.readFloatLE(0) * 10) / 10);
                }
                const key = `${f.dst}>${f.src}`;
                const q = this.queries.get(key);
                this.queries.delete(key);
                const count = q && q.id === f.id ? q.count : 0;
                if (META[f.dp]) {
                    void this.handleMeta(f.src, f);
                } else {
                    void this.handleValue('R', f.src, f, count);
                }
                return;
            }
            case FrameType.Set:
                void this.handleValue('W', f.dst, f, 0);
                return;
            case FrameType.Reject: {
                // Ablehnung unserer Anfrage: nicht wiederholen
                const qj = this.queryQueue[0];
                if (qj && qj.sentAt && f.src === qj.dst && f.dst === 1 && f.id === qj.id) {
                    this.queryQueue.shift();
                    this.queryFailStreak = 0;
                    qj.resolve(null);
                }
                return;
            }
            case FrameType.Confirm: {
                const wj = this.writeQueue[0];
                if (
                    wj &&
                    wj.kind === 'clock' &&
                    wj.sentAt &&
                    Date.now() - wj.sentAt < 1500 &&
                    f.src === UNIT_ADDR &&
                    f.dst === 1 &&
                    f.dp === 0x032e
                ) {
                    this.writeQueue.shift();
                    this.log.info(
                        `Clock of the ventilation unit set (${this.clockLabel(wj)}, acknowledged after ${Date.now() - wj.sentAt} ms)`,
                    );
                    return;
                }
                // nur Quittungen kurz nach unserem Senden zählen (die BDE schreibt 0x0199 selbst alle ~11 s)
                if (
                    wj &&
                    wj.sentAt &&
                    Date.now() - wj.sentAt < 300 &&
                    f.src === wj.mod &&
                    f.dst === 1 &&
                    [0x0199, 0x01fb, 0x0196].includes(f.dp)
                ) {
                    this.log.debug(
                        `Module ${this.moduleFolder(wj.mod)} acknowledged SET 0x${f.dp.toString(16).padStart(4, '0')} (${Date.now() - wj.sentAt} ms)`,
                    );
                }
                return;
            }
            default:
                return;
        }
    }

    /* ------------------------------------------------------------- Werte */

    private moduleFolder(mod: number): string {
        return this.moduleNames.get(mod) || fallbackFolder(mod);
    }

    private async handleValue(kind: 'R' | 'W', mod: number, f: Frame, count: number): Promise<void> {
        const folder = this.moduleFolder(mod);
        await this.ensureModule(mod);

        // 1. konfigurierte Zuordnungen
        const maps = f.sub === 0 ? this.mappings.get(`${kind}:${mod}:${f.dp}`) : undefined;
        for (const m of maps || []) {
            const raw = decodeAs(f.payload, m.type, m.index, count);
            if (raw === null || (isSet(m.ignore) && raw === Number(m.ignore))) {
                continue;
            }
            let v: ioBroker.StateValue = raw;
            if (typeof v === 'number' && isSet(m.bit) && Number(m.bit) >= 0) {
                v = ((v >>> Number(m.bit)) & 1) === 1;
            } else if (typeof v === 'number') {
                if (m.factor !== 1) {
                    v = Math.round(v * m.factor * 1000) / 1000;
                }
                if ((isSet(m.min) && v < Number(m.min)) || (isSet(m.max) && v > Number(m.max)) || !Number.isFinite(v)) {
                    continue;
                }
            }
            // a name with a leading "/" is created from the instance root (e.g. "/controlPanelRoom.temperature")
            const id = m.name.startsWith('/') ? this.cleanPath(m.name.slice(1)) : `${folder}.${this.cleanPath(m.name)}`;
            const states = m.states
                ? Object.fromEntries(
                      m.states
                          .split(';')
                          .map(s => s.split(':').map(x => x.trim()))
                          .filter(p => p.length === 2 && p[0] !== ''),
                  )
                : undefined;
            const vt = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'string';
            await this.ensureParents(id, m.name.startsWith('/') ? 1 : 2, m.name.startsWith('/') ? '/' : '');
            await this.ensureObject(id, {
                type: 'state',
                common: {
                    name: NAMES[m.name] || m.name,
                    type: vt,
                    role:
                        vt === 'boolean'
                            ? 'indicator'
                            : vt === 'number'
                              ? m.unit === '°C'
                                  ? 'value.temperature'
                                  : 'value'
                              : 'text',
                    unit: m.unit || undefined,
                    states,
                    read: true,
                    write: false,
                    custom:
                        m.history && this.cfg.historyInstance
                            ? {
                                  [this.cfg.historyInstance]: {
                                      enabled: true,
                                      changesOnly: true,
                                      changesMinDelta: 0.05,
                                      debounce: 0,
                                      retention: 0,
                                      maxLength: 0,
                                      blockTime: 0,
                                  },
                              }
                            : undefined,
                },
            });
            await this.write(id, v);
        }

        // 2. jedes Register zusätzlich generisch ablegen
        if (this.cfg.storeRegisters !== false) {
            await this.storeRegister(kind, mod, f, count);
        }
    }

    private async storeRegister(kind: 'R' | 'W', mod: number, f: Frame, count: number): Promise<void> {
        const folder = this.moduleFolder(mod);
        const regName = `${kind}_${f.dp}${f.sub ? `_${f.sub}` : ''}`;
        const base = `${folder}.registers.${regName}`;
        const isNew = !this.known.has(base);
        const desc = this.registerDesc(mod, kind, f.dp, f.sub);

        if (isNew) {
            await this.ensureChannel(
                `${folder}.registers`,
                tr('All registers seen on the bus', 'Alle mitgelesenen Register'),
            );
            await this.ensureChannel(base, desc);
        }
        const d = autoDecode(f.payload, count);
        const unit = this.unitFromMeta(mod, f.dp);
        await this.ensureObject(`${base}.value`, {
            type: 'state',
            common: {
                name: tr(`${desc.en} – value (auto-decoded)`, `${desc.de} – Wert (automatisch gedeutet)`),
                type: d.kind === 'number' ? 'number' : 'string',
                role: d.kind === 'number' ? 'value' : d.kind === 'list' ? 'json' : 'text',
                unit,
                read: true,
                write: false,
            },
        });
        await this.ensureObject(`${base}.raw`, {
            type: 'state',
            common: {
                name: tr(`${desc.en} – raw data (hex)`, `${desc.de} – Rohdaten (hex)`),
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
        });
        // detect a type change (e.g. number -> text) and adapt type and role
        const val = d.value === null ? '' : d.value;
        const prev = this.lastWritten.get(`${base}.value`);
        if (prev && typeof prev.val !== typeof val) {
            await this.extendObject(`${base}.value`, {
                common:
                    typeof val === 'number'
                        ? { type: 'number', role: 'value' }
                        : { type: 'string', role: d.kind === 'list' ? 'json' : 'text' },
            });
        }
        if (d.kind === 'text' && prev && prev.val !== val) {
            this.addEvent(`${folder} ${regName}: text changed to "${val}"`);
        }
        await this.write(`${base}.value`, val);
        await this.write(`${base}.raw`, toHex(f.payload));

        const st = this.regStats.get(base) || { count: 0, last: 0, base };
        st.count++;
        st.last = Date.now();
        this.regStats.set(base, st);

        if (isNew) {
            await this.ensureStatObjects(base, desc);
            if (Date.now() - this.startedAt > STARTUP_GRACE_MS) {
                this.addEvent(
                    `New register ${folder} ${regName} = ${d.kind === 'empty' ? '(empty)' : val} [${toHex(f.payload)}]`,
                );
            }
        }
    }

    private async ensureStatObjects(base: string, desc: Translated): Promise<void> {
        await this.ensureObject(`${base}.lastSeen`, {
            type: 'state',
            common: {
                name: tr(`${desc.en} – last seen`, `${desc.de} – zuletzt gesehen`),
                type: 'number',
                role: 'date',
                read: true,
                write: false,
            },
        });
        await this.ensureObject(`${base}.count`, {
            type: 'state',
            common: {
                name: tr(
                    `${desc.en} – telegrams since adapter start`,
                    `${desc.de} – Anzahl Telegramme seit Adapterstart`,
                ),
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
        });
    }

    private flushStats(): void {
        for (const st of this.regStats.values()) {
            void this.write(`${st.base}.lastSeen`, st.last, true);
            void this.write(`${st.base}.count`, st.count, true);
        }
    }

    private hourly(): void {
        void this.ensureObject('info.framesPerHour', {
            type: 'state',
            common: {
                name: tr('Valid telegrams (last hour)', 'Gültige Telegramme (letzte Stunde)'),
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
        }).then(() => this.write('info.framesPerHour', this.hourOk, true));
        void this.ensureObject('info.skippedBytesPerHour', {
            type: 'state',
            common: {
                name: tr('Discarded bytes / CRC errors (last hour)', 'Verworfene Bytes / CRC-Fehler (letzte Stunde)'),
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
        }).then(() => this.write('info.skippedBytesPerHour', this.hourBad, true));
        this.hourOk = 0;
        this.hourBad = 0;
    }

    /* ------------------------------------------------------------- Meta */

    private async handleMeta(mod: number, f: Frame): Promise<void> {
        const def = META[f.dp];
        const folder = `${this.moduleFolder(mod)}.meta`;
        await this.ensureModule(mod);
        await this.ensureChannel(
            folder,
            tr('Self-description of the module (meta DPs)', 'Selbstauskunft des Moduls (Meta-Datenpunkte)'),
        );
        const id = `${folder}.${def.name}`;
        if (def.text) {
            // Text mit führendem Längenbyte (z. B. 0x0E „LQS-CO2RH…“)
            let body = f.payload;
            if (body.length > 1 && body[0] < 0x20) {
                body = body.subarray(1, 1 + body[0]);
            }
            const txt = body
                .toString('latin1')
                .replace(/\0[\s\S]*$/, '')
                .trim();
            await this.ensureObject(`${id}Raw`, {
                type: 'state',
                common: {
                    name: tr(`${def.title.en} – raw data (hex)`, `${def.title.de} – Rohdaten (hex)`),
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                },
            });
            await this.write(`${id}Raw`, toHex(f.payload), true);
            await this.ensureObject(id, {
                type: 'state',
                common: { name: def.title, type: 'string', role: 'text', read: true, write: false },
            });
            const prev = (await this.getStateAsync(id))?.val;
            if (prev !== txt) {
                this.addEvent(`${this.moduleFolder(mod)}: ${def.name} = "${txt}"`);
            }
            await this.write(id, txt, true);
            return;
        }

        // Listen kommen seitenweise (Sub-Selektor = Element-Offset) und werden zu einer Liste zusammengeführt
        const size = 2;
        const m = (this.meta[mod] = this.meta[mod] || {});
        const merged = (m[def.name] = m[def.name] || []);
        for (let i = 0; i * size + size <= f.payload.length; i++) {
            merged[f.sub + i] = f.payload.readUInt16LE(i * size);
        }
        await this.ensureObject(id, {
            type: 'state',
            common: {
                name: tr(`${def.title.en} (list)`, `${def.title.de} (Liste)`),
                type: 'string',
                role: 'json',
                read: true,
                write: false,
            },
        });
        await this.write(id, JSON.stringify(Array.from(merged, v => v ?? null)), true);
        await this.buildDirectory(mod);
    }

    private joinMeta(mod: number, name: string): number[] | null {
        const list = this.meta[mod]?.[name];
        return list && list.length ? list : null;
    }

    private async buildDirectory(mod: number): Promise<void> {
        const dps = this.joinMeta(mod, 'dpList');
        if (!dps) {
            return;
        }
        const types = this.joinMeta(mod, 'typeCodes');
        const acc = this.joinMeta(mod, 'access');
        const units = this.joinMeta(mod, 'units');
        const dir = dps.map((dp, i) => ({
            dp: `0x${dp.toString(16).padStart(4, '0')}`,
            type: types ? types[i] : undefined,
            access: acc ? ACCESS_CODES[acc[i]] || acc[i] : undefined,
            unit: units ? UNIT_CODES[units[i]] || units[i] : undefined,
        }));
        const id = `${this.moduleFolder(mod)}.meta.directory`;
        await this.ensureObject(id, {
            type: 'state',
            common: {
                name: tr('DP directory (from the meta DPs)', 'DP-Verzeichnis (aus Meta-Datenpunkten)'),
                type: 'string',
                role: 'json',
                read: true,
                write: false,
            },
        });
        await this.write(id, JSON.stringify(dir), true);
    }

    private unitFromMeta(mod: number, dp: number): string | undefined {
        const dps = this.joinMeta(mod, 'dpList');
        const units = this.joinMeta(mod, 'units');
        if (!dps || !units) {
            return undefined;
        }
        const i = dps.indexOf(dp);
        const u = i >= 0 ? units[i] : undefined;
        return u !== undefined && UNIT_CODES[u] && UNIT_CODES[u] !== 'text' ? UNIT_CODES[u] : undefined;
    }

    /** Meta-Listen aus gespeicherten States wiederherstellen */
    private async restoreMeta(): Promise<void> {
        const states = await this.getStatesAsync('*.meta.*');
        for (const [fullId, st] of Object.entries(states || {})) {
            const m = fullId.match(/^[^.]+\.\d+\.([^.]+)\.meta\.([A-Za-z]+)$/);
            if (!m || !st || typeof st.val !== 'string') {
                continue;
            }
            const def = Object.values(META).find(x => x.name === m[2]);
            if (!def || def.text) {
                continue;
            }
            const mod =
                [...this.moduleNames.entries()].find(([, n]) => n === m[1])?.[0] ?? Number(m[1].replace('module', ''));
            if (!Number.isFinite(mod)) {
                continue;
            }
            try {
                const list = JSON.parse(st.val) as number[];
                const entry = (this.meta[mod] = this.meta[mod] || {});
                entry[m[2]] = list.map(v => (v === null ? (undefined as unknown as number) : v));
            } catch {
                // ignorieren
            }
        }
    }

    /* ------------------------------------------------------------- Ereignisse */

    private async restoreEvents(): Promise<void> {
        await this.ensureObject('info.events', {
            type: 'state',
            common: {
                name: tr('Rare events (new registers, texts, meta)', 'Seltene Ereignisse (neue Register, Texte, Meta)'),
                type: 'string',
                role: 'json',
                read: true,
                write: false,
                def: '[]',
            },
        });
        await this.ensureObject('info.lastEvent', {
            type: 'state',
            common: {
                name: tr('Last rare event', 'Letztes seltenes Ereignis'),
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
        });
        const st = await this.getStateAsync('info.events');
        try {
            this.events = st && typeof st.val === 'string' ? JSON.parse(st.val) : [];
        } catch {
            this.events = [];
        }
    }

    private addEvent(text: string): void {
        this.log.info(`Event: ${text}`);
        this.events.unshift({ ts: new Date().toISOString(), text });
        this.events = this.events.slice(0, this.cfg.eventLimit);
        void this.setState('info.events', JSON.stringify(this.events), true);
        void this.setState('info.lastEvent', text, true);
    }

    /* ------------------------------------------------------------- Mitschnitt */

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack) {
            return;
        }
        if (id.endsWith('.info.capture')) {
            state.val ? this.startCapture() : this.stopCapture(true);
            return;
        }
        if (id.endsWith('.setpoint')) {
            this.requestSetpoint(id, state.val);
            return;
        }
        if (id === `${this.namespace}.${this.clockButtonId()}`) {
            if (state.val) {
                this.requestClock(this.cfg.clockOffsetMin);
            }
            return;
        }
        if (id.endsWith('.heaterEnable')) {
            this.requestHeater(id, state.val);
            return;
        }
        if (id === `${this.namespace}.paramRead.start` && state.val) {
            void this.readParameters();
        }
    }

    /* ------------------------------------------------------------- Sollwert schreiben */

    private requestSetpoint(id: string, val: ioBroker.StateValue): void {
        const rel = id.substring(this.namespace.length + 1).replace(/\.setpoint$/, '');
        const mod = [...this.controlMods].find(m => this.moduleFolder(m) === rel);
        const step = this.cfg.writeStep;
        const value = Math.round(Number(val) / step) * step;
        if (mod === undefined || !Number.isFinite(value)) {
            this.log.warn(`Invalid setpoint request ${id} = ${val}`);
            return;
        }
        if (value < this.cfg.writeMin || value > this.cfg.writeMax) {
            this.log.warn(
                `Setpoint ${value} °C for ${rel} outside ${this.cfg.writeMin}–${this.cfg.writeMax} °C – ignored`,
            );
            this.restoreSetpoint(mod);
            return;
        }
        // einen evtl. noch wartenden Auftrag für dasselbe Modul ersetzen
        this.writeQueue = this.writeQueue.filter(j => j.kind !== 'setpoint' || j.mod !== mod || j.sentAt !== 0);
        this.writeQueue.push({
            kind: 'setpoint',
            mod,
            value,
            tries: 0,
            sentAt: 0,
            notBefore: Date.now() + SETPOINT_SETTLE_MS,
        });
        this.log.info(`Setpoint request ${rel} (module ${mod}) = ${value} °C queued`);
    }

    private clockButtonId(): string {
        return `${this.moduleFolder(UNIT_ADDR)}.device.setClock`;
    }

    private clockLabel(job: WriteJob): string {
        const t = job.clockSent ? new Date(job.clockSent).toLocaleString() : '?';
        return `${t}${job.value ? `, offset ${job.value > 0 ? '+' : ''}${job.value} min` : ''}`;
    }

    private requestClock(offsetMin: number): boolean {
        if (!this.cfg.allowWrite || !this.cfg.allowClockWrite) {
            this.log.warn('Setting the clock is not enabled (settings: allow writing + allow setting the clock)');
            return false;
        }
        const value = Math.round(Number(offsetMin) || 0);
        if (Math.abs(value) > 24 * 60) {
            this.log.warn(`Clock offset ${value} min too large – ignored`);
            return false;
        }
        this.writeQueue = this.writeQueue.filter(j => j.kind !== 'clock' || j.sentAt !== 0);
        this.writeQueue.push({ kind: 'clock', mod: UNIT_ADDR, value, tries: 0, sentAt: 0 });
        this.log.info(`Clock request (offset ${value} min) queued`);
        return true;
    }

    private onMessage(obj: ioBroker.Message): void {
        if (obj?.command === 'listSerial') {
            void listSerialPorts().then(list => {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, list, obj.callback);
                }
            });
            return;
        }
        if (obj?.command !== 'setClock') {
            return;
        }
        const msg = (obj.message ?? {}) as { offset?: unknown };
        const offset = msg.offset === undefined || msg.offset === '' ? this.cfg.clockOffsetMin : Number(msg.offset);
        const ok = this.requestClock(offset);
        if (obj.callback) {
            this.sendTo(
                obj.from,
                obj.command,
                ok
                    ? {
                          result: `Request queued: clock = system time ${offset ? `${offset > 0 ? '+' : ''}${offset} min` : ''} (result in the log)`,
                      }
                    : {
                          error: 'Setting the clock is not possible – enable "allow writing" and "allow setting the clock" and save',
                      },
                obj.callback,
            );
        }
    }

    private requestHeater(id: string, val: ioBroker.StateValue): void {
        const rel = id.substring(this.namespace.length + 1).replace(/\.heaterEnable$/, '');
        const mod = [...this.heaterMods].find(m => this.moduleFolder(m) === rel);
        if (mod === undefined || (typeof val !== 'boolean' && val !== 0 && val !== 1)) {
            this.log.warn(`Invalid heater request ${id} = ${val}`);
            return;
        }
        const value = val ? 1 : 0;
        this.writeQueue = this.writeQueue.filter(j => j.kind !== 'heater' || j.mod !== mod || j.sentAt !== 0);
        this.writeQueue.push({ kind: 'heater', mod, value, tries: 0, sentAt: 0 });
        this.log.info(`Heater request ${rel} (module ${mod}) = ${value ? 'enable' : 'disable'} queued`);
    }

    /**
     * bei jeder Antwort: Zeitüberschreitungen prüfen und in der Buslücke höchstens EIN Telegramm senden (Schreiben vor Lesen)
     *
     * @param f
     */
    private gapTick(f: Frame): void {
        const sent = this.writeQueue.length ? this.writeTick(f) : false;
        const q = this.queryQueue[0];
        if (!q) {
            return;
        }
        if (q.sentAt && Date.now() - q.sentAt > QUERY_TIMEOUT_MS) {
            q.sentAt = 0;
            if (++this.queryFailStreak >= QUERY_FAIL_RECONNECT) {
                // beobachtet: Gateway nahm Anfragen an, sendete sie aber nicht auf den Bus, bis die Verbindung neu aufgebaut war
                this.queryFailStreak = 0;
                this.log.info(`${QUERY_FAIL_RECONNECT} queries in a row unanswered – reconnecting to the gateway`);
                this.lost('no replies to queries');
                return;
            }
            if (q.tries >= q.maxTries) {
                this.queryQueue.shift();
                q.resolve(null);
                return;
            }
        }
        if (!sent && !q.sentAt && f.src === UNIT_ADDR && f.dp === GAP_TRIGGER_DP && this.sock) {
            this.sock.write(buildQuery(1, q.dst, q.id, q.count));
            q.sentAt = Date.now();
            q.tries++;
        }
    }

    /**
     * Lese-Anfrage einreihen; liefert die Nutzdaten der Antwort oder null
     *
     * @param dst
     * @param dp
     * @param sub
     * @param count
     * @param maxTries
     */
    private query(dst: number, dp: number, sub = 0, count = 1, maxTries = QUERY_MAX_TRIES): Promise<Buffer | null> {
        return new Promise(resolve => {
            this.queryQueue.push({ dst, id: (dp | (sub << 16)) >>> 0, count, tries: 0, maxTries, sentAt: 0, resolve });
        });
    }

    /**
     * gibt true zurück, wenn in dieser Lücke gesendet wurde
     *
     * @param f
     */
    private writeTick(f: Frame): boolean {
        const job = this.writeQueue[0];
        if (!job.sentAt && job.notBefore && Date.now() < job.notBefore) {
            // noch in der Wartezeit: einen bereits fälligen Auftrag dahinter vorziehen
            const i = this.writeQueue.findIndex(j => !j.notBefore || Date.now() >= j.notBefore);
            if (i > 0) {
                this.writeQueue.unshift(...this.writeQueue.splice(i, 1));
                return this.writeTick(f);
            }
            return false;
        }
        const timeout = job.kind === 'clock' ? CLOCK_TIMEOUT_MS : WRITE_TIMEOUT_MS;
        if (job.tries >= WRITE_MAX_TRIES && !job.sentAt) {
            job.sentAt = Date.now() - timeout - 1;
        }
        if (job.sentAt && Date.now() - job.sentAt > timeout) {
            if (job.tries >= WRITE_MAX_TRIES) {
                this.writeQueue.shift();
                if (job.kind === 'clock') {
                    this.log.warn('Clock setting not acknowledged – giving up');
                } else if (job.kind === 'heater') {
                    this.log.warn(`Heater enable ${job.value} for module ${job.mod} not confirmed – giving up`);
                    this.restoreHeater(job.mod);
                } else {
                    this.log.warn(`Setpoint ${job.value} °C for module ${job.mod} not confirmed – giving up`);
                    this.restoreSetpoint(job.mod);
                }
                return false;
            }
            job.sentAt = 0;
        }
        // Lücken: nach 40>1 0x0194 (Zyklus +7,9 s) und nach 2>1 0x02D9 (Zyklus 0 s), je nur ~70 ms lang – Kollisionen mit dem
        // zentralen Bedienelement sind häufig, daher mehrere Versuche. Die Tastensperre (0x0199) blockiert Fernsollwerte nicht.
        const gap40 = f.src === WRITE_GAP_SRC && f.dp === WRITE_GAP_DP && f.dst === 1;
        const gap2d9 = f.src === 2 && f.dp === GAP_TRIGGER_DP;
        if (!job.sentAt && (gap40 || gap2d9) && this.sock) {
            if (job.kind === 'clock') {
                // 0x032E setzt nur Datum/Stunde/Minute, der Sekundenzähler des Geräts läuft weiter (beobachtet): die Minute so
                // wählen, dass Minute + Gerätesekunden der Sollzeit am nächsten kommt (Restfehler ≤ 30 s)
                const t = Date.now() + job.value * 60000;
                let unitSec: number;
                if (this.unitClock && Date.now() - this.unitClock.at < 120000) {
                    unitSec = (this.unitClock.sec + (Date.now() - this.unitClock.at) / 1000) % 60;
                } else {
                    // Sekunden unbekannt: nur nahe einer vollen Minute senden
                    unitSec = 0;
                    const r = t % 60000;
                    if (r > 8000 && r < 52000) {
                        return false;
                    }
                }
                const minute = Math.round((t - unitSec * 1000) / 60000) * 60000;
                const p = Buffer.alloc(4);
                p.writeUInt32LE(encodeCalendar(new Date(minute)));
                this.sock.write(buildFrame(FrameType.Set, 1, UNIT_ADDR, 0x032e, p));
                job.sentAt = Date.now();
                job.clockSent = minute;
                job.tries++;
                this.log.debug(`SET 0x032E = ${decodeCalendar(p)} sent (try ${job.tries})`);
                return true;
            }
            // Formate wie vom zentralen Bedienelement (BDE) gesendet: 0x01FB float32, 0x0196 uint16 (0/1)
            const dp = job.kind === 'heater' ? 0x0196 : 0x01fb;
            const p = Buffer.alloc(job.kind === 'heater' ? 2 : 4);
            job.kind === 'heater' ? p.writeUInt16LE(job.value) : p.writeFloatLE(job.value);
            this.sock.write(buildFrame(FrameType.Set, 1, job.mod, dp, p));
            job.sentAt = Date.now();
            job.tries++;
            this.log.debug(
                `SET 0x${dp.toString(16).padStart(4, '0')} = ${job.value} sent to module ${job.mod} (try ${job.tries})`,
            );
            return true;
        }
        return false;
    }

    private async onSetpointReport(mod: number, value: number): Promise<void> {
        this.reportedSetpoint.set(mod, value);
        const job = this.writeQueue[0];
        let confirmed = false;
        if (job && job.kind === 'setpoint' && job.mod === mod && job.sentAt && Math.abs(job.value - value) < 0.05) {
            this.writeQueue.shift();
            confirmed = true;
            this.log.info(`Setpoint ${value} °C confirmed by ${this.moduleFolder(mod)}`);
        }
        // solange ein Auftrag für dieses Modul aussteht, den gewünschten Wert nicht überschreiben
        if (!this.writeQueue.some(j => j.kind === 'setpoint' && j.mod === mod)) {
            await this.write(`${this.moduleFolder(mod)}.setpoint`, value, confirmed);
        }
    }

    /**
     * das Modul meldet die Freigabe ~10 s nach dem SET in 0x0194 Bit 3
     *
     * @param mod
     * @param on
     */
    private async onHeaterReport(mod: number, on: boolean): Promise<void> {
        this.reportedHeater.set(mod, on);
        const job = this.writeQueue[0];
        let confirmed = false;
        if (job && job.kind === 'heater' && job.mod === mod && job.sentAt && (job.value === 1) === on) {
            this.writeQueue.shift();
            confirmed = true;
            this.log.info(`Heater ${this.moduleFolder(mod)} ${on ? 'enabled' : 'disabled'} (confirmed)`);
        }
        if (!this.writeQueue.some(j => j.kind === 'heater' && j.mod === mod)) {
            await this.write(`${this.moduleFolder(mod)}.heaterEnable`, on, confirmed);
        }
    }

    private restoreHeater(mod: number): void {
        const v = this.reportedHeater.get(mod);
        if (v !== undefined) {
            void this.setState(`${this.moduleFolder(mod)}.heaterEnable`, v, true);
            this.lastWritten.set(`${this.moduleFolder(mod)}.heaterEnable`, { val: v, ts: Date.now() });
        }
    }

    private restoreSetpoint(mod: number): void {
        const v = this.reportedSetpoint.get(mod);
        if (v !== undefined) {
            void this.setState(`${this.moduleFolder(mod)}.setpoint`, v, true);
            this.lastWritten.set(`${this.moduleFolder(mod)}.setpoint`, { val: v, ts: Date.now() });
        }
    }

    /* ------------------------------------------------------------- Parameter lesen */

    private paramFolder(mod: number): string {
        return `${this.moduleFolder(mod)}.parameters`;
    }

    /** Module, die beim Parameter-Lesen abgefragt werden: Lüftungsgerät zuerst, ohne Master (1) */
    private paramModules(): number[] {
        const mods = [...this.moduleNames.keys()].filter(m => m !== 1 && m !== UNIT_ADDR).sort((x, y) => x - y);
        return [UNIT_ADDR, ...mods];
    }

    private async setupParameters(): Promise<void> {
        // controls and status in the channel paramRead directly under the instance
        await this.ensureChannel('paramRead', tr('Read parameters of all modules', 'Parameter aller Module lesen'));
        await this.ensureObject('paramRead.start', {
            type: 'state',
            common: {
                name: tr(
                    'Read the parameters of all modules once (read queries only, takes more than an hour)',
                    'Parameter aller Module einmalig lesen (nur Lese-Anfragen, dauert über eine Stunde)',
                ),
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            },
        });
        await this.ensureObject('paramRead.running', {
            type: 'state',
            common: {
                name: tr('Reading parameters is running', 'Parameter-Lesen läuft'),
                type: 'boolean',
                role: 'indicator.working',
                read: true,
                write: false,
                def: false,
            },
        });
        await this.ensureObject('paramRead.progress', {
            type: 'state',
            common: {
                name: tr('Progress of reading parameters', 'Fortschritt des Parameter-Lesens'),
                type: 'number',
                role: 'value',
                unit: '%',
                min: 0,
                max: 100,
                read: true,
                write: false,
                def: 0,
            },
        });
        await this.ensureObject('paramRead.status', {
            type: 'state',
            common: {
                name: tr('Status of reading parameters', 'Status des Parameter-Lesens'),
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
        });
        await this.ensureObject('paramRead.lastRun', {
            type: 'state',
            common: {
                name: tr(
                    'Time of the last complete parameter read',
                    'Zeitpunkt des letzten vollständigen Parameter-Lesens',
                ),
                type: 'number',
                role: 'date',
                read: true,
                write: false,
            },
        });
        this.subscribeStates('paramRead.start');
        await this.setStateAsync('paramRead.running', false, true);

        for (const mod of this.paramModules()) {
            const dir = await this.getStateAsync(`${this.paramFolder(mod)}.directory`);
            if (dir && typeof dir.val === 'string' && dir.val) {
                try {
                    this.paramDirs.set(mod, JSON.parse(dir.val) as ParamDirectory);
                } catch {
                    // ignorieren
                }
            }
        }
        if (this.cfg.pollEnabled) {
            this.log.info(`Periodic parameter polling every ${this.cfg.pollMinutes} min enabled`);
            this.setInterval(
                () => void this.pollParameters(),
                Math.min(this.cfg.pollMinutes * 60 * 1000, MAX_TIMER_MS),
            );
        }
    }

    /**
     * Reste älterer Versionen (vor 0.4.0) entfernen: seitenweise Meta-States und den alten Knopf
     *
     * @param objs
     */
    private async cleanupOldObjects(objs: Record<string, ioBroker.Object>): Promise<void> {
        const lists = 'DPListe|Typcodes|Zugriff|Einheiten';
        const re = new RegExp(`\\.Meta\\.(?:(?:${lists})_\\d+(?:_raw)?|(?:${lists})_raw)$`);
        const old = /^[^.]+\.Parameter\.(?:Lesen|Status|Zuletzt)$/;
        let n = 0;
        for (const full of Object.keys(objs)) {
            const rel = full.substring(this.namespace.length + 1);
            if (re.test(rel) || old.test(rel)) {
                await this.delObjectAsync(rel);
                delete objs[full];
                n++;
            }
        }
        if (n) {
            this.log.info(`${n} obsolete objects (paged meta data, old parameter button) removed`);
        }
    }

    private async setParamStatus(text: string, percent?: number): Promise<void> {
        await this.setStateAsync('paramRead.status', text, true);
        if (percent !== undefined) {
            await this.setStateAsync('paramRead.progress', Math.max(0, Math.min(100, Math.round(percent))), true);
        }
    }

    /**
     * eine Meta-Liste seitenweise lesen (die Antworten legt handleMeta zusätzlich unter <Modul>.Meta ab)
     *
     * @param mod
     * @param dp
     * @param offsets
     */
    private async readMetaList(mod: number, dp: number, offsets: number[]): Promise<number[] | null> {
        const list: number[] = [];
        for (const o of offsets) {
            const p = await this.query(mod, dp, o, 1);
            if (!p) {
                return null;
            }
            for (let i = 0; i * 2 + 1 < p.length; i++) {
                list[o + i] = p.readUInt16LE(i * 2);
            }
        }
        return list;
    }

    /**
     * Länge des Verzeichnisses ermitteln: das Gerät antwortet nur, solange Offset + 64 <= Länge
     *
     * @param mod
     * @param status
     */
    private async findDirectoryOffsets(mod: number, status: (t: string) => Promise<void>): Promise<number[] | null> {
        const first = await this.query(mod, 0x0033, 0, 1);
        if (!first) {
            return null;
        }
        if (first.length / 2 < META_PAGE) {
            return [0];
        }
        const offsets = [0];
        let ok = 0;
        let fail = -1;
        for (let o = META_PAGE; o < 4096; o += META_PAGE) {
            await status(`directory, checking offset ${o}`);
            const p = await this.query(mod, 0x0033, o, 1);
            if (!p) {
                fail = o;
                break;
            }
            offsets.push(o);
            ok = o;
            if (p.length / 2 < META_PAGE) {
                return offsets;
            }
        }
        if (fail < 0) {
            return offsets;
        }
        let lo = ok;
        let hi = fail;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            await status(`directory, checking offset ${mid}`);
            // Offset außerhalb der Liste beantwortet das Gerät mit Typ 4 (Ablehnung) -> sofort bekannt
            if (await this.query(mod, 0x0033, mid, 1)) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        // Gegenprobe nach oben, falls eine Antwort trotz allem verloren ging
        while (lo + 1 < fail && (await this.query(mod, 0x0033, lo + 1, 1))) {
            lo++;
        }
        if (lo !== ok) {
            offsets.push(lo);
        }
        return offsets;
    }

    private async readDirectory(mod: number, status: (t: string) => Promise<void>): Promise<ParamDirectory | null> {
        const offsets = await this.findDirectoryOffsets(mod, status);
        if (!offsets) {
            return null;
        }
        await status('directory (DP list, type, access, unit)');
        const dps = await this.readMetaList(mod, 0x0033, offsets);
        if (!dps) {
            return null;
        }
        await this.readMetaList(mod, 0x0034, offsets);
        const access = await this.readMetaList(mod, 0x0038, offsets);
        const units = await this.readMetaList(mod, 0x0039, offsets);
        return { dps, access: access || [], units: units || [] };
    }

    /**
     * Name (Meta 0x0001) lesen: Text mit Längenbyte; manche Module verlangen genau die passende Anzahl
     *
     * @param mod
     */
    private async readName(mod: number): Promise<void> {
        const p = await this.query(mod, 0x0001, 0, 1);
        if (!p || !p.length || p[0] >= 0x20 || p.length > p[0]) {
            return;
        }
        for (const c of [p[0] + 1, p[0]]) {
            if (await this.query(mod, 0x0001, 0, c)) {
                return;
            }
        }
    }

    /** Knopf „Parameter_lesen“: je Modul Name, Verzeichnis und alle Parameter einmal abfragen */
    private async readParameters(): Promise<void> {
        if (this.paramRunning) {
            this.log.info('Reading parameters is already running');
            return;
        }
        if (!this.busConnected) {
            await this.setParamStatus('error: no connection to the gateway');
            return;
        }
        this.paramRunning = true;
        await this.setStateAsync('paramRead.running', true, true);
        const mods = this.paramModules();
        const summary: string[] = [];
        try {
            this.addEvent('Reading parameters started');
            for (let mi = 0; mi < mods.length && !this.stopping; mi++) {
                const mod = mods[mi];
                const label = `${this.moduleFolder(mod)} (${mi + 1}/${mods.length})`;
                const status = (t: string, frac = 0): Promise<void> =>
                    this.setParamStatus(`${label}: ${t}`, ((mi + frac) / mods.length) * 100);
                await status('name');
                await this.readName(mod);
                const dir = await this.readDirectory(mod, t => status(t));
                if (!dir) {
                    summary.push(`${this.moduleFolder(mod)}: no directory`);
                    continue;
                }
                this.paramDirs.set(mod, dir);
                await this.ensureModule(mod);
                await this.ensureParamChannel(mod);
                await this.ensureObject(`${this.paramFolder(mod)}.directory`, {
                    type: 'state',
                    common: {
                        name: tr(
                            'Directory (DP, access, unit) from the meta DPs',
                            'Verzeichnis (DP, Zugriff, Einheit) aus den Meta-DPs',
                        ),
                        type: 'string',
                        role: 'json',
                        read: true,
                        write: false,
                    },
                });
                await this.write(`${this.paramFolder(mod)}.directory`, JSON.stringify(dir), true);
                const ok = await this.readParamList(mod, dir.dps, (i, n, dp) =>
                    status(`parameter ${i}/${n} (0x${dp.toString(16).padStart(4, '0')})`, i / n),
                );
                summary.push(`${this.moduleFolder(mod)}: ${ok}/${dir.dps.length}`);
            }
            if (this.stopping) {
                await this.setParamStatus(`aborted (adapter stopped) – ${summary.join(', ')}`);
                return;
            }
            await this.setStateAsync('paramRead.lastRun', Date.now(), true);
            const text = `finished – ${summary.join(', ')}`;
            await this.setParamStatus(text, 100);
            this.addEvent(`Reading parameters ${text}`);
        } finally {
            this.paramRunning = false;
            if (!this.stopping) {
                await this.setStateAsync('paramRead.running', false, true);
            }
        }
    }

    /** Regelmäßige Abfrage (optional, nur Lüftungsgerät): konfigurierte Liste oder alle aus dem Verzeichnis */
    private async pollParameters(): Promise<void> {
        if (this.paramRunning || !this.busConnected) {
            return;
        }
        const list = parseDpList(this.cfg.pollList);
        const dps = list.length ? list : this.paramDirs.get(UNIT_ADDR)?.dps || [];
        if (!dps.length) {
            this.log.debug('Parameter polling: no directory yet – please trigger "paramRead.start" once');
            return;
        }
        this.paramRunning = true;
        try {
            await this.readParamList(UNIT_ADDR, dps);
        } finally {
            this.paramRunning = false;
        }
    }

    private async readParamList(
        mod: number,
        dps: number[],
        progress?: (i: number, n: number, dp: number) => Promise<void>,
    ): Promise<number> {
        let ok = 0;
        for (let i = 0; i < dps.length; i++) {
            if (this.stopping) {
                break;
            }
            const dp = dps[i];
            if (dp === undefined) {
                continue;
            }
            if (progress) {
                await progress(i + 1, dps.length, dp);
            }
            const p = await this.query(mod, dp);
            if (p) {
                ok++;
                await this.storeParam(mod, dp, p);
            }
        }
        return ok;
    }

    private async storeParam(mod: number, dp: number, payload: Buffer): Promise<void> {
        const hex = dp.toString(16).toUpperCase().padStart(4, '0');
        const id = `${this.paramFolder(mod)}.DP_${hex}`;
        const dir = this.paramDirs.get(mod);
        const idx = dir ? dir.dps.indexOf(dp) : -1;
        const acc = dir && idx >= 0 ? dir.access[idx] : undefined;
        const unitCode = dir && idx >= 0 ? dir.units[idx] : undefined;
        const names = mod === UNIT_ADDR ? PARAM_NAMES : ROOM_PARAM_NAMES;
        const val = decodeParam(payload);
        await this.ensureParamChannel(mod);
        await this.ensureObject(id, {
            type: 'state',
            common: {
                name: names[dp] ? tr(`${names[dp].en} (0x${hex})`, `${names[dp].de} (0x${hex})`) : `DP 0x${hex}`,
                desc: `Access: ${acc === undefined ? '?' : PARAM_ACCESS[acc] || `0x${acc.toString(16)}`}, unit code ${unitCode ?? '?'}, raw data ${toHex(payload)}`,
                type: typeof val === 'number' ? 'number' : 'string',
                role: typeof val === 'number' ? 'value' : 'json',
                unit: unitCode !== undefined ? PARAM_UNITS[unitCode] : undefined,
                read: true,
                write: false,
            },
        });
        await this.write(id, val, true);
    }

    /* ------------------------------------------------------- Lernprotokoll */
    /**
     * SET/Antwort: nur Änderungen protokollieren; unbekannte Telegrammtypen immer
     *
     * @param f
     */
    private learnFrame(f: Frame): void {
        if (f.type === FrameType.Set || f.type === FrameType.Response) {
            const mod = f.type === FrameType.Response ? f.src : f.dst;
            const key = `${f.type === FrameType.Response ? 'R' : 'W'}${mod}:${f.dp.toString(16)}:${f.sub}`;
            const hex = f.payload.toString('hex');
            if (this.learnLast.get(key) !== hex) {
                this.learnLast.set(key, hex);
                this.learnWrite('changes', `${Date.now()} ${key} ${hex}`);
            }
        } else if (f.type > FrameType.Reject) {
            this.learnWrite('unknown', `${Date.now()} type${f.type} ${f.raw.toString('hex')}`);
        }
    }

    private learnWrite(kind: string, line: string): void {
        const day = new Date().toLocaleDateString('sv-SE');
        let f = this.learnFiles.get(kind);
        if (!f || f.day !== day) {
            f?.stream.end();
            try {
                const dir = this.learnDir();
                fs.mkdirSync(dir, { recursive: true });
                const stream = fs.createWriteStream(path.join(dir, `${kind}_${day}.log`), { flags: 'a' });
                stream.on('error', e => this.log.warn(`Learning log: ${e.message}`));
                f = { day, stream };
                this.learnFiles.set(kind, f);
                if (kind === 'changes') {
                    // jede Tagesdatei beginnt mit dem vollständigen Stand
                    this.learnLast.clear();
                }
            } catch (e) {
                this.log.warn(`Learning log not possible: ${(e as Error).message}`);
                return;
            }
        }
        f.stream.write(`${line}\n`);
    }

    /** Lernprotokolle älter als learnLogDays löschen */
    private learnCleanup(): void {
        if (!this.cfg.learnLogDays) {
            return;
        }
        const dir = this.learnDir();
        const limit = new Date(Date.now() - this.cfg.learnLogDays * 86400e3).toLocaleDateString('sv-SE');
        try {
            for (const name of fs.readdirSync(dir)) {
                const m = /_(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
                if (m && m[1] < limit) {
                    fs.unlinkSync(path.join(dir, name));
                }
            }
        } catch {
            // Ordner existiert noch nicht
        }
    }

    private startCapture(): void {
        if (this.capture) {
            void this.setState('info.capture', true, true);
            return;
        }
        try {
            const dir = utils.getAbsoluteInstanceDataDir(this);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `capture_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
            const stream = fs.createWriteStream(file, { flags: 'a' });
            stream.write('# Proxon HESP capture: ISO time, type, source>destination, register ID, telegram (hex)\n');
            const timer = this.setTimeout(() => this.stopCapture(true), this.cfg.captureMinutes * 60000);
            this.capture = { stream, file, timer };
            this.log.info(`Capture started: ${file} (${this.cfg.captureMinutes} min)`);
            void this.setState('info.capture', true, true);
        } catch (e) {
            this.log.warn(`Capture not possible: ${(e as Error).message}`);
            void this.setState('info.capture', false, true);
        }
    }

    private stopCapture(updateState: boolean): void {
        if (this.capture) {
            if (this.capture.timer) {
                this.clearTimeout(this.capture.timer);
            }
            this.capture.stream.end();
            this.log.info(`Capture finished: ${this.capture.file}`);
            this.capture = null;
        }
        if (updateState) {
            void this.setState('info.capture', false, true);
        }
    }

    private registerDesc(mod: number, kind: string, dp: number, subSel: number): Translated {
        const hex = `0x${dp.toString(16).padStart(4, '0')}`;
        const sub = subSel ? ` sub ${subSel}` : '';
        return tr(
            `Module ${mod} ${kind === 'R' ? 'reports' : 'receives'} DP ${dp} (${hex})${sub}`,
            `Modul ${mod} ${kind === 'R' ? 'liest' : 'erhält'} DP ${dp} (${hex})${sub}`,
        );
    }

    /**
     * Names of existing objects that are only created once (register channels and statistics, meta data,
     * parameters) are brought up to date at start, e.g. after the migration from German names.
     * Meta directories are rebuilt from the stored lists.
     */
    private async refreshNames(): Promise<void> {
        const addr = new Map([...this.moduleNames].map(([a, f]) => [f, a]));
        const metaByName = new Map(Object.values(META).map(d => [d.name, d]));
        const want = (rel: string): Partial<ioBroker.StateCommon> | null => {
            const p = rel.split('.');
            const mod = addr.get(p[0]) ?? Number(/^module(\d+)$/.exec(p[0])?.[1]);
            if (!Number.isFinite(mod)) {
                return null;
            }
            if (p[1] === 'registers') {
                if (p.length === 2) {
                    return { name: tr('All registers seen on the bus', 'Alle mitgelesenen Register') };
                }
                const m = /^([RW])_(\d+)(?:_(\d+))?$/.exec(p[2]);
                if (!m) {
                    return null;
                }
                const d = this.registerDesc(mod, m[1], Number(m[2]), Number(m[3] || 0));
                const leaf: Record<string, Translated> = {
                    value: tr(`${d.en} – value (auto-decoded)`, `${d.de} – Wert (automatisch gedeutet)`),
                    raw: tr(`${d.en} – raw data (hex)`, `${d.de} – Rohdaten (hex)`),
                    lastSeen: tr(`${d.en} – last seen`, `${d.de} – zuletzt gesehen`),
                    count: tr(
                        `${d.en} – telegrams since adapter start`,
                        `${d.de} – Anzahl Telegramme seit Adapterstart`,
                    ),
                };
                return p.length === 3 ? { name: d } : p.length === 4 && leaf[p[3]] ? { name: leaf[p[3]] } : null;
            }
            if (p[1] === 'meta') {
                if (p.length === 2) {
                    return {
                        name: tr(
                            'Self-description of the module (meta DPs)',
                            'Selbstauskunft des Moduls (Meta-Datenpunkte)',
                        ),
                    };
                }
                if (p[2] === 'directory') {
                    return { name: tr('DP directory (from the meta DPs)', 'DP-Verzeichnis (aus Meta-Datenpunkten)') };
                }
                const raw = p[2].endsWith('Raw');
                const def = metaByName.get(raw ? p[2].slice(0, -3) : p[2]);
                if (!def) {
                    return null;
                }
                if (raw) {
                    return { name: tr(`${def.title.en} – raw data (hex)`, `${def.title.de} – Rohdaten (hex)`) };
                }
                return { name: def.text ? def.title : tr(`${def.title.en} (list)`, `${def.title.de} (Liste)`) };
            }
            if (p[1] === 'parameters') {
                if (p.length === 2) {
                    return { name: tr('Parameters (read queries)', 'Parameter (per Lese-Anfrage)') };
                }
                if (p[2] === 'directory') {
                    return {
                        name: tr(
                            'Directory (DP, access, unit) from the meta DPs',
                            'Verzeichnis (DP, Zugriff, Einheit) aus den Meta-DPs',
                        ),
                    };
                }
                const m = /^DP_([0-9A-F]{4})$/.exec(p[2]);
                if (!m) {
                    return null;
                }
                const names = mod === UNIT_ADDR ? PARAM_NAMES : ROOM_PARAM_NAMES;
                const n = names[parseInt(m[1], 16)];
                return { name: n ? tr(`${n.en} (0x${m[1]})`, `${n.de} (0x${m[1]})`) : `DP 0x${m[1]}` };
            }
            return null;
        };
        let n = 0;
        for (const [rel, old] of this.knownCommon) {
            const c = want(rel);
            if (!c) {
                continue;
            }
            const upd: Partial<ioBroker.StateCommon> = {};
            if (JSON.stringify(c.name) !== JSON.stringify(old.name)) {
                upd.name = c.name;
            }
            const desc = typeof old.desc === 'string' ? translateParamDesc(old.desc) : undefined;
            if (desc && desc !== old.desc) {
                upd.desc = desc;
            }
            if (Object.keys(upd).length) {
                await this.extendObjectAsync(rel, { common: upd });
                this.knownCommon.set(rel, { ...old, ...upd });
                n++;
            }
        }
        if (n) {
            this.log.info(`Names of ${n} objects updated`);
        }
        for (const mod of Object.keys(this.meta)) {
            await this.buildDirectory(Number(mod));
        }
    }

    /* ------------------------------------------------------------- Migration */

    private learnDir(): string {
        return path.join(utils.getAbsoluteInstanceDataDir(this), 'learn');
    }

    /**
     * Up to 0.5.x the object IDs, the default module/mapping names and the learning log files were German.
     * Renames them once: configuration (only the former default names), objects (with state value and custom
     * settings such as history) and the learning log. Old and new IDs are written to migration-0.6.0.json in the
     * instance data directory. Returns true if the configuration was changed (the adapter is restarted).
     */
    private async migrateToEnglishIds(): Promise<boolean> {
        const cfgModules = this.cfg.modules || [];
        const cfgMappings = this.cfg.mappings || [];
        const modules = cfgModules.map(m => (m && isSet(m.name) ? { ...m, name: renameModule(String(m.name)) } : m));
        const mappings = cfgMappings.map(m => {
            if (!m || !m.name) {
                return m;
            }
            const n = { ...m, name: renamePath(String(m.name)) };
            const u = MAPPING_UPDATES[n.name];
            if (u?.states && m.states === u.states[0]) {
                n.states = u.states[1];
            }
            if (u?.unit && m.unit === u.unit[0]) {
                n.unit = u.unit[1];
            }
            return n;
        });
        const cfgChanged =
            JSON.stringify(modules) !== JSON.stringify(cfgModules) ||
            JSON.stringify(mappings) !== JSON.stringify(cfgMappings);

        // module folders old -> new
        const folders = new Map<string, string>();
        cfgModules.forEach((m, i) => {
            if (m && m.address !== undefined) {
                const before = this.cleanId(String(m.name ?? '')) || `Modul_${m.address}`;
                folders.set(before, this.cleanId(String(modules[i].name ?? '')) || fallbackFolder(Number(m.address)));
            }
        });

        const objs = await this.getAdapterObjectsAsync();
        await this.cleanupOldObjects(objs);
        const moves: [string, string][] = [];
        for (const full of Object.keys(objs)) {
            const rel = full.substring(this.namespace.length + 1);
            const to = migrateId(rel, folders);
            if (to !== rel) {
                moves.push([rel, to]);
            }
        }
        this.migrateLearnLog();

        if (moves.length) {
            this.log.info(`Migrating ${moves.length} objects to the English IDs of version 0.6.0 …`);
            const depth = (id: string): number => id.split('.').length;
            moves.sort((a, b) => depth(a[0]) - depth(b[0]));
            const map: Record<string, string> = {};
            for (const [from, to] of moves) {
                const oldFull = `${this.namespace}.${from}`;
                const newFull = `${this.namespace}.${to}`;
                map[oldFull] = newFull;
                const obj = objs[oldFull];
                const existing = objs[newFull] || (await this.getForeignObjectAsync(newFull));
                if (!existing) {
                    const { _id, ...rest } = obj as ioBroker.Object & { _id?: string };
                    void _id;
                    await this.setForeignObjectAsync(newFull, rest);
                } else if (obj.common?.custom && !existing.common?.custom) {
                    await this.extendForeignObjectAsync(newFull, { common: { custom: obj.common.custom } });
                }
                if (obj.type === 'state') {
                    const st = await this.getForeignStateAsync(oldFull);
                    const target = existing ? await this.getForeignStateAsync(newFull) : null;
                    if (st && !target) {
                        await this.setForeignStateAsync(newFull, {
                            val: st.val,
                            ack: st.ack,
                            ts: st.ts,
                            lc: st.lc,
                            q: st.q,
                        });
                    }
                }
            }
            // before deleting: deleting an object also removes it from all enums
            await this.migrateReferences(map);
            for (const [from] of [...moves].reverse()) {
                const oldFull = `${this.namespace}.${from}`;
                try {
                    await this.delForeignObjectAsync(oldFull);
                    if (objs[oldFull]?.type === 'state') {
                        await this.delForeignStateAsync(oldFull);
                    }
                } catch (e) {
                    this.log.warn(`Could not delete ${oldFull}: ${(e as Error).message}`);
                }
            }
            try {
                const dir = utils.getAbsoluteInstanceDataDir(this);
                fs.mkdirSync(dir, { recursive: true });
                const file = path.join(dir, 'migration-0.6.0.json');
                const before = fs.existsSync(file)
                    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>)
                    : {};
                fs.writeFileSync(file, JSON.stringify({ ...before, ...map }, null, 2));
            } catch (e) {
                this.log.warn(`Could not write the migration list: ${(e as Error).message}`);
            }
            this.log.info(
                `${moves.length} objects migrated (list in migration-0.6.0.json). Recorded history stays under the old IDs.`,
            );
        }
        if (cfgChanged) {
            this.log.info('Module and mapping names in the configuration migrated to English – restarting');
            await this.updateConfig({ modules, mappings });
            return true;
        }
        return false;
    }

    /**
     * enum memberships (rooms, functions) and alias targets that point to migrated IDs are switched to the new IDs
     *
     * @param map old ID -> new ID (full IDs)
     */
    private async migrateReferences(map: Record<string, string>): Promise<void> {
        let n = 0;
        const remap = (t: unknown): unknown => (typeof t === 'string' && map[t] ? map[t] : t);
        try {
            const enums = await this.getForeignObjectsAsync('enum.*', 'enum');
            for (const [id, e] of Object.entries(enums || {})) {
                const members = e.common?.members;
                if (Array.isArray(members) && members.some(m => map[m])) {
                    await this.extendForeignObjectAsync(id, {
                        common: { members: members.map(m => map[m] || m) },
                    });
                    n++;
                }
            }
            const aliases = await this.getForeignObjectsAsync('alias.*', 'state');
            for (const [id, a] of Object.entries(aliases || {})) {
                const target = (a.common as ioBroker.StateCommon & { alias?: { id?: unknown } })?.alias?.id;
                let next: unknown = target;
                if (typeof target === 'string') {
                    next = remap(target);
                } else if (target && typeof target === 'object') {
                    const t = target as { read?: unknown; write?: unknown };
                    next = { ...t, read: remap(t.read), write: remap(t.write) };
                }
                if (JSON.stringify(next) !== JSON.stringify(target)) {
                    await this.extendForeignObjectAsync(id, {
                        common: { alias: { id: next } },
                    });
                    n++;
                }
            }
        } catch (e) {
            this.log.warn(`Could not update enums/aliases: ${(e as Error).message}`);
        }
        if (n) {
            this.log.info(`${n} enums/aliases switched to the new IDs`);
        }
    }

    /** learning log: folder "lernen" -> "learn", files aenderungen_* -> changes_*, unbekannt_* -> unknown_*/
    private migrateLearnLog(): void {
        const base = utils.getAbsoluteInstanceDataDir(this);
        const oldDir = path.join(base, 'lernen');
        const newDir = this.learnDir();
        try {
            if (!fs.existsSync(oldDir)) {
                return;
            }
            fs.mkdirSync(newDir, { recursive: true });
            for (const name of fs.readdirSync(oldDir)) {
                const to = name.replace(/^aenderungen_/, 'changes_').replace(/^unbekannt_/, 'unknown_');
                if (!fs.existsSync(path.join(newDir, to))) {
                    fs.renameSync(path.join(oldDir, name), path.join(newDir, to));
                }
            }
            if (!fs.readdirSync(oldDir).length) {
                fs.rmdirSync(oldDir);
            }
        } catch (e) {
            this.log.warn(`Could not migrate the learning log: ${(e as Error).message}`);
        }
    }

    /** writable states of control options that are switched off are removed */
    private async removeDisabledControls(): Promise<void> {
        const control = new Set(
            String(this.cfg.controlModules || '')
                .split(',')
                .map(x => Number(x.trim())),
        );
        const folders = new Map(this.moduleNames);
        for (const mod of control) {
            if (Number.isInteger(mod) && mod > 0 && !folders.has(mod)) {
                folders.set(mod, fallbackFolder(mod));
            }
        }
        for (const [mod, folder] of folders) {
            const keep = {
                setpoint: !!this.cfg.allowWrite && control.has(mod),
                heaterEnable: !!this.cfg.allowWrite && !!this.cfg.allowHeaterWrite && control.has(mod),
            };
            for (const [leaf, ok] of Object.entries(keep)) {
                const id = `${folder}.${leaf}`;
                if (!ok && this.known.has(id)) {
                    await this.delObjectAsync(id);
                    this.known.delete(id);
                    this.log.info(`${id} removed (option disabled)`);
                }
            }
        }
        const clock = this.clockButtonId();
        if (!(this.cfg.allowWrite && this.cfg.allowClockWrite) && this.known.has(clock)) {
            await this.delObjectAsync(clock);
            this.known.delete(clock);
            this.log.info(`${clock} removed (option disabled)`);
        }
    }

    /* ------------------------------------------------------------- Hilfen */

    private cleanId(s: string): string {
        return s
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .replace(this.FORBIDDEN_CHARS, '_')
            .replace(/[^A-Za-z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
    }

    private cleanPath(s: string): string {
        return s
            .split('.')
            .map(p => this.cleanId(p))
            .filter(Boolean)
            .join('.');
    }

    private async ensureModule(mod: number): Promise<void> {
        const folder = this.moduleFolder(mod);
        await this.ensureObject(folder, {
            type: 'device',
            common: { name: tr(`${folder} (bus address ${mod})`, `${folder} (Busadresse ${mod})`) },
        });
    }

    private async ensureChannel(id: string, name: ioBroker.StringOrTranslated): Promise<void> {
        await this.ensureObject(id, { type: 'channel', common: { name } });
    }

    private async ensureParamChannel(mod: number): Promise<void> {
        await this.ensureChannel(
            this.paramFolder(mod),
            tr('Parameters (read queries)', 'Parameter (per Lese-Anfrage)'),
        );
    }

    /**
     * Zwischenebenen von Zuordnungsnamen mit Punkten als Kanal anlegen
     *
     * @param id object ID
     * @param from first level to create (2 = below the module folder)
     * @param prefix prefix of the name lookup in NAMES ("/" for names from the instance root)
     */
    private async ensureParents(id: string, from = 2, prefix = ''): Promise<void> {
        const parts = id.split('.');
        for (let i = from; i < parts.length; i++) {
            const pid = parts.slice(0, i).join('.');
            const key = prefix + parts.slice(from - 1, i).join('.');
            await this.ensureChannel(pid, NAMES[key] || parts[i - 1]);
        }
    }

    private async ensureObject(
        id: string,
        obj: Omit<ioBroker.SettableObject, '_id' | 'native'> & { native?: Record<string, unknown> },
    ): Promise<void> {
        if (this.known.has(id)) {
            // existing object: update name, unit and value texts once if they changed (e.g. after the ID migration)
            const old = this.knownCommon.get(id);
            if (old) {
                this.knownCommon.delete(id);
                const c = obj.common as Partial<ioBroker.StateCommon>;
                const upd: Partial<ioBroker.StateCommon> = {};
                for (const k of ['name', 'unit', 'states'] as const) {
                    if (c[k] !== undefined && JSON.stringify(c[k]) !== JSON.stringify(old[k])) {
                        (upd as Record<string, unknown>)[k] = c[k];
                    }
                }
                if (Object.keys(upd).length) {
                    if (upd.name && c.desc !== undefined) {
                        upd.desc = c.desc;
                    }
                    await this.extendObjectAsync(id, { common: upd });
                }
            }
            return;
        }
        const pending = this.pendingCreate.get(id);
        if (pending) {
            return pending;
        }
        const p = (async () => {
            const common = Object.fromEntries(
                Object.entries(obj.common as Record<string, unknown>).filter(([, v]) => v !== undefined),
            );
            await this.setObjectNotExistsAsync(id, {
                ...obj,
                common,
                native: obj.native || {},
            } as ioBroker.SettableObject);
            this.known.add(id);
        })().finally(() => this.pendingCreate.delete(id));
        this.pendingCreate.set(id, p);
        return p;
    }

    /**
     * Schreibt nur bei Änderung, spätestens aber nach refreshSec
     *
     * @param id
     * @param val
     * @param force
     */
    private async write(id: string, val: ioBroker.StateValue, force = false): Promise<void> {
        const prev = this.lastWritten.get(id);
        const now = Date.now();
        if (!force && prev && prev.val === val && now - prev.ts < this.cfg.refreshSec * 1000) {
            return;
        }
        this.lastWritten.set(id, { val, ts: now });
        try {
            await this.setStateAsync(id, val, true);
        } catch (e) {
            this.log.warn(`setState ${id} failed: ${(e as Error).message}`);
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new ProxonHesp(options);
} else {
    (() => new ProxonHesp())();
}
