/**
 * ioBroker-Adapter proxon-hesp
 * Liest den HESP-Bus einer Proxon P-Serie über ein RS485->TCP-Gateway passiv mit.
 */
import * as utils from '@iobroker/adapter-core';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { autoDecode, decodeAs, type ValueType } from './lib/decode';
import { buildFrame, buildQuery, type Frame, FrameParser, FrameType, toHex } from './lib/hesp';
import { decodeParam, PARAM_ACCESS, PARAM_NAMES, PARAM_UNITS, parseDpList, ROOM_PARAM_NAMES } from './lib/params';

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

interface Config {
    host: string;
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
    /** Parameter des Lüftungsgeräts regelmäßig per Lese-Anfrage abfragen */
    pollEnabled: boolean;
    pollMinutes: number;
    /** DPs (hex/dez., Komma-getrennt); leer = alle aus dem Verzeichnis */
    pollList: string;
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

/** Ausstehender Sollwert-Schreibauftrag */
interface WriteJob {
    mod: number;
    value: number;
    tries: number;
    sentAt: number;
}

/** DP, nach dessen Antwort (von Adresse 2) eine ~140-ms-Buslücke folgt */
const GAP_TRIGGER_DP = 0x02d9;
const WRITE_TIMEOUT_MS = 30000;
const WRITE_MAX_TRIES = 2;
const QUERY_TIMEOUT_MS = 3000;
const QUERY_MAX_TRIES = 2;
/** Adresse des Lüftungsgeräts */
const UNIT_ADDR = 2;
/** Meta-Listen liefern je Anfrage 64 Einträge ab dem Offset im Sub-Selektor */
const META_PAGE = 64;

/** Meta-Datenpunkte (Selbstauskunft der Module) */
const META: Record<number, { name: string; text: boolean }> = {
    0x0001: { name: 'Name', text: true },
    0x0033: { name: 'DPListe', text: false },
    0x0034: { name: 'Typcodes', text: false },
    0x0038: { name: 'Zugriff', text: false },
    0x0039: { name: 'Einheiten', text: false },
    0x0130: { name: 'Fehlerstatus', text: true },
};
const UNIT_CODES: Record<number, string> = { 5: 's', 8: '°C', 11: 'Text' };
const ACCESS_CODES: Record<number, string> = {
    0x55: 'nur lesen',
    0xff: 'schreibbar',
    0xd5: 'Fachmann schreibbar',
    0xc0: 'Fachmann sichtbar',
};

/** Register, die innerhalb dieser Zeit nach dem Start auftauchen, gelten als „normaler Zyklus“ */
const STARTUP_GRACE_MS = 3 * 60 * 1000;

class ProxonHesp extends utils.Adapter {
    private cfg!: Config;
    private sock: net.Socket | null = null;
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
    private writeQueue: WriteJob[] = [];
    private reportedSetpoint = new Map<number, number>();
    private queryQueue: QueryJob[] = [];
    private paramDirs = new Map<number, ParamDirectory>();
    private paramRunning = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'proxon-hesp' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /* ------------------------------------------------------------------ Start */

    private async onReady(): Promise<void> {
        this.cfg = this.config as unknown as Config;
        this.cfg.port = Number(this.cfg.port) || 502;
        this.cfg.watchdogSec = Number(this.cfg.watchdogSec) || 120;
        this.cfg.refreshSec = Number(this.cfg.refreshSec) || 300;
        this.cfg.captureMinutes = Number(this.cfg.captureMinutes) || 15;
        this.cfg.eventLimit = Number(this.cfg.eventLimit) || 100;

        await this.setState('info.connection', false, true);
        if (!this.cfg.host) {
            this.log.error('Kein Gateway (Host) konfiguriert');
            return;
        }

        for (const m of this.cfg.modules || []) {
            if (m && m.name !== undefined && m.address !== undefined) {
                this.moduleNames.set(Number(m.address), this.cleanId(String(m.name)) || `Modul_${m.address}`);
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
                factor: m.factor === undefined || m.factor === null || (m.factor as unknown) === '' ? 1 : Number(m.factor),
                type: m.type || 'auto',
            });
            this.mappings.set(key, list);
        }

        // bereits vorhandene Objekte merken (keine Neuanlage, keine „neu“-Ereignisse)
        const objs = await this.getAdapterObjectsAsync();
        for (const id of Object.keys(objs)) {
            this.known.add(id.substring(this.namespace.length + 1));
        }
        await this.restoreMeta();
        await this.restoreEvents();

        await this.ensureObject('info.capture', {
            type: 'state',
            common: {
                name: `Telegramm-Mitschnitt in Datei (${this.cfg.captureMinutes} min)`,
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
            this.cfg.writeMin = Number(this.cfg.writeMin) || 15;
            this.cfg.writeMax = Number(this.cfg.writeMax) || 28;
            this.cfg.writeStep = Number(this.cfg.writeStep) === 0.5 ? 0.5 : 1;
            for (const s of String(this.cfg.controlModules || '').split(',')) {
                const n = Number(s.trim());
                if (Number.isInteger(n) && n > 0) {
                    this.controlMods.add(n);
                }
            }
            for (const mod of this.controlMods) {
                await this.ensureModule(mod);
                await this.ensureObject(`${this.moduleFolder(mod)}.Sollwert`, {
                    type: 'state',
                    common: {
                        name: 'Sollwert (schreibbar, wird als SET 0x01FB an das Raummodul gesendet)',
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
                await this.extendObjectAsync(`${this.moduleFolder(mod)}.Sollwert`, { common: { step: this.cfg.writeStep } });
                this.subscribeStates(`${this.moduleFolder(mod)}.Sollwert`);
            }
            this.log.info(`Schreiben aktiv für Raummodule ${[...this.controlMods].join(', ')} (${this.cfg.writeMin}–${this.cfg.writeMax} °C, Schritt ${this.cfg.writeStep} °C)`);
        }

        await this.setupParameters();

        this.setInterval(() => this.flushStats(), this.cfg.refreshSec * 1000);
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
        const sock = net.createConnection({ host: this.cfg.host, port: this.cfg.port });
        this.sock = sock;
        sock.setTimeout(60000);
        sock.on('connect', () => {
            this.log.info(`Verbunden mit ${this.cfg.host}:${this.cfg.port}`);
            sock.setKeepAlive(true, 15000);
            this.backoffMs = 1000;
            this.lastValid = Date.now();
        });
        sock.on('data', chunk => this.onData(chunk));
        sock.on('timeout', () => this.lost('Timeout, keine Daten'));
        sock.on('error', err => this.lost(err.message));
        sock.on('close', () => this.lost('Verbindung geschlossen'));
    }

    private shutdownSocket(): void {
        if (!this.sock) {
            return;
        }
        this.sock.removeAllListeners();
        this.sock.on('error', () => undefined);
        this.sock.destroy();
        this.sock = null;
    }

    private lost(reason: string): void {
        this.shutdownSocket();
        this.setConnected(false);
        if (this.stopping || this.reconnectTimer) {
            return;
        }
        const msg = `Verbindung getrennt (${reason}), neuer Versuch in ${Math.round(this.backoffMs / 1000)} s`;
        this.backoffMs >= 30000 ? this.log.warn(msg) : this.log.info(msg);
        this.reconnectTimer = this.setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 60000);
    }

    private watchdog(): void {
        if (this.sock && Date.now() - this.lastValid > this.cfg.watchdogSec * 1000) {
            this.log.warn(`Seit ${this.cfg.watchdogSec} s keine gültigen Telegramme – baue Verbindung neu auf`);
            this.lost('Watchdog');
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
                this.log.warn(`Fehler bei Telegramm ${toHex(f.raw)}: ${(e as Error).message}`);
            }
        }
    }

    private onFrame(f: Frame): void {
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
                this.gapTick(f);
                const qj = this.queryQueue[0];
                if (qj && qj.sentAt && f.src === qj.dst && f.dst === 1 && f.id === qj.id) {
                    this.queryQueue.shift();
                    qj.resolve(f.payload);
                }
                if (f.dp === 0x01f6 && f.payload.length === 4 && this.controlMods.has(f.src)) {
                    void this.onSetpointReport(f.src, Math.round(f.payload.readFloatLE(0) * 10) / 10);
                }
                const key = `${f.dst}>${f.src}`;
                const q = this.queries.get(key);
                this.queries.delete(key);
                const count = q && q.id === f.id ? q.count : 0;
                if (META[f.dp]) {
                    void this.handleMeta(f.src, f, count);
                } else {
                    void this.handleValue('R', f.src, f, count);
                }
                return;
            }
            case FrameType.Set:
                void this.handleValue('W', f.dst, f, 0);
                return;
            default:
                // Quittungen enthalten keine Werte
                return;
        }
    }

    /* ------------------------------------------------------------- Werte */

    private moduleFolder(mod: number): string {
        return this.moduleNames.get(mod) || `Modul_${mod}`;
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
            // Name mit führendem "/" wird ab der Instanzwurzel angelegt (z. B. "/Wohnen.Temperatur")
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
            await this.ensureParents(id, m.name.startsWith('/') ? 1 : 2);
            await this.ensureObject(id, {
                type: 'state',
                common: {
                    name: m.name,
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
                    custom: m.history && this.cfg.historyInstance
                        ? { [this.cfg.historyInstance]: { enabled: true, changesOnly: true, changesMinDelta: 0.05, debounce: 0, retention: 0, maxLength: 0, blockTime: 0 } }
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
        const base = `${folder}.Register.${regName}`;
        const isNew = !this.known.has(base);
        const desc = `Modul ${mod} ${kind === 'R' ? 'liest' : 'erhält'} DP ${f.dp} (0x${f.dp.toString(16).padStart(4, '0')})${f.sub ? ` Sub ${f.sub}` : ''}`;

        if (isNew) {
            await this.ensureChannel(`${folder}.Register`, 'Alle mitgelesenen Register');
            await this.ensureChannel(base, desc);
        }
        const d = autoDecode(f.payload, count);
        const unit = this.unitFromMeta(mod, f.dp);
        await this.ensureObject(`${base}.value`, {
            type: 'state',
            common: {
                name: `${desc} – Wert (automatisch gedeutet)`,
                type: d.kind === 'number' ? 'number' : 'string',
                role: d.kind === 'number' ? 'value' : d.kind === 'list' ? 'json' : 'text',
                unit,
                read: true,
                write: false,
            },
        });
        await this.ensureObject(`${base}.raw`, {
            type: 'state',
            common: { name: `${desc} – Rohdaten (hex)`, type: 'string', role: 'text', read: true, write: false },
        });
        // Typwechsel (z. B. Zahl -> Text) erkennen und Objekt anpassen
        const val = d.value === null ? '' : d.value;
        const prev = this.lastWritten.get(`${base}.value`);
        if (prev && typeof prev.val !== typeof val) {
            await this.extendObject(`${base}.value`, { common: { type: typeof val === 'number' ? 'number' : 'string' } });
        }
        if (d.kind === 'text' && prev && prev.val !== val) {
            this.addEvent(`${folder} ${regName}: Text geändert auf „${val}“`);
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
                this.addEvent(`Neues Register ${folder} ${regName} = ${d.kind === 'empty' ? '(leer)' : val} [${toHex(f.payload)}]`);
            }
        }
    }

    private async ensureStatObjects(base: string, desc: string): Promise<void> {
        await this.ensureObject(`${base}.lastSeen`, {
            type: 'state',
            common: { name: `${desc} – zuletzt gesehen`, type: 'number', role: 'date', read: true, write: false },
        });
        await this.ensureObject(`${base}.count`, {
            type: 'state',
            common: { name: `${desc} – Anzahl Telegramme seit Adapterstart`, type: 'number', role: 'value', read: true, write: false },
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
            common: { name: 'Gültige Telegramme (letzte Stunde)', type: 'number', role: 'value', read: true, write: false },
        }).then(() => this.write('info.framesPerHour', this.hourOk, true));
        void this.ensureObject('info.skippedBytesPerHour', {
            type: 'state',
            common: { name: 'Verworfene Bytes / CRC-Fehler (letzte Stunde)', type: 'number', role: 'value', read: true, write: false },
        }).then(() => this.write('info.skippedBytesPerHour', this.hourBad, true));
        this.hourOk = 0;
        this.hourBad = 0;
    }

    /* ------------------------------------------------------------- Meta */

    private async handleMeta(mod: number, f: Frame, count: number): Promise<void> {
        const def = META[f.dp];
        const folder = `${this.moduleFolder(mod)}.Meta`;
        await this.ensureModule(mod);
        await this.ensureChannel(folder, 'Selbstauskunft des Moduls (Meta-Datenpunkte)');
        const id = `${folder}.${def.name}`;
        if (def.text) {
            // Text mit führendem Längenbyte (z. B. 0x0E „LQS-CO2RH…“)
            let body = f.payload;
            if (body.length > 1 && body[0] < 0x20) {
                body = body.subarray(1, 1 + body[0]);
            }
            const txt = body.toString('latin1').replace(/\0[\s\S]*$/, '').trim();
            await this.ensureObject(`${id}_raw`, {
                type: 'state',
                common: { name: `${def.name} – Rohdaten (hex)`, type: 'string', role: 'text', read: true, write: false },
            });
            await this.write(`${id}_raw`, toHex(f.payload), true);
            await this.ensureObject(id, {
                type: 'state',
                common: { name: def.name, type: 'string', role: 'text', read: true, write: false },
            });
            const prev = (await this.getStateAsync(id))?.val;
            if (prev !== txt) {
                this.addEvent(`${this.moduleFolder(mod)}: ${def.name} = „${txt}“`);
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
        void count;
        await this.ensureObject(id, {
            type: 'state',
            common: { name: `${def.name} (Liste)`, type: 'string', role: 'json', read: true, write: false },
        });
        await this.write(id, JSON.stringify(Array.from(merged, v => v ?? null)), true);
        await this.buildDirectory(mod);
    }

    private joinMeta(mod: number, name: string): number[] | null {
        const list = this.meta[mod]?.[name];
        return list && list.length ? list : null;
    }

    private async buildDirectory(mod: number): Promise<void> {
        const dps = this.joinMeta(mod, 'DPListe');
        if (!dps) {
            return;
        }
        const types = this.joinMeta(mod, 'Typcodes');
        const acc = this.joinMeta(mod, 'Zugriff');
        const units = this.joinMeta(mod, 'Einheiten');
        const dir = dps.map((dp, i) => ({
            dp: `0x${dp.toString(16).padStart(4, '0')}`,
            typ: types ? types[i] : undefined,
            zugriff: acc ? ACCESS_CODES[acc[i]] || acc[i] : undefined,
            einheit: units ? UNIT_CODES[units[i]] || units[i] : undefined,
        }));
        const id = `${this.moduleFolder(mod)}.Meta.Verzeichnis`;
        await this.ensureObject(id, {
            type: 'state',
            common: { name: 'DP-Verzeichnis (aus Meta-Datenpunkten)', type: 'string', role: 'json', read: true, write: false },
        });
        await this.write(id, JSON.stringify(dir), true);
    }

    private unitFromMeta(mod: number, dp: number): string | undefined {
        const dps = this.joinMeta(mod, 'DPListe');
        const units = this.joinMeta(mod, 'Einheiten');
        if (!dps || !units) {
            return undefined;
        }
        const i = dps.indexOf(dp);
        const u = i >= 0 ? units[i] : undefined;
        return u !== undefined && UNIT_CODES[u] && UNIT_CODES[u] !== 'Text' ? UNIT_CODES[u] : undefined;
    }

    /** Meta-Listen aus gespeicherten States wiederherstellen */
    private async restoreMeta(): Promise<void> {
        const states = await this.getStatesAsync('*.Meta.*');
        for (const [fullId, st] of Object.entries(states || {})) {
            const m = fullId.match(/^[^.]+\.\d+\.([^.]+)\.Meta\.([A-Za-z]+)$/);
            if (!m || !st || typeof st.val !== 'string') {
                continue;
            }
            const def = Object.values(META).find(x => x.name === m[2]);
            if (!def || def.text) {
                continue;
            }
            const mod = [...this.moduleNames.entries()].find(([, n]) => n === m[1])?.[0] ?? Number(m[1].replace('Modul_', ''));
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
            common: { name: 'Seltene Ereignisse (neue Register, Texte, Meta)', type: 'string', role: 'json', read: true, write: false, def: '[]' },
        });
        await this.ensureObject('info.lastEvent', {
            type: 'state',
            common: { name: 'Letztes seltenes Ereignis', type: 'string', role: 'text', read: true, write: false, def: '' },
        });
        const st = await this.getStateAsync('info.events');
        try {
            this.events = st && typeof st.val === 'string' ? JSON.parse(st.val) : [];
        } catch {
            this.events = [];
        }
    }

    private addEvent(text: string): void {
        this.log.info(`Ereignis: ${text}`);
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
        if (id.endsWith('.Sollwert')) {
            this.requestSetpoint(id, state.val);
            return;
        }
        if (id === `${this.namespace}.Parameter_lesen` && state.val) {
            void this.readParameters();
        }
    }

    /* ------------------------------------------------------------- Sollwert schreiben */

    private requestSetpoint(id: string, val: ioBroker.StateValue): void {
        const rel = id.substring(this.namespace.length + 1).replace(/\.Sollwert$/, '');
        const mod = [...this.controlMods].find(m => this.moduleFolder(m) === rel);
        const step = this.cfg.writeStep;
        const value = Math.round(Number(val) / step) * step;
        if (mod === undefined || !Number.isFinite(value)) {
            this.log.warn(`Ungültiger Sollwert-Auftrag ${id} = ${val}`);
            return;
        }
        if (value < this.cfg.writeMin || value > this.cfg.writeMax) {
            this.log.warn(`Sollwert ${value} °C für ${rel} außerhalb ${this.cfg.writeMin}–${this.cfg.writeMax} °C – ignoriert`);
            this.restoreSetpoint(mod);
            return;
        }
        // einen evtl. noch wartenden Auftrag für dasselbe Modul ersetzen
        this.writeQueue = this.writeQueue.filter(j => j.mod !== mod || j.sentAt !== 0);
        this.writeQueue.push({ mod, value, tries: 0, sentAt: 0 });
        this.log.info(`Sollwert-Auftrag ${rel} (Modul ${mod}) = ${value} °C eingereiht`);
    }

    /** bei jeder Antwort aufgerufen: Zeitüberschreitung prüfen, in der Buslücke senden */
    /** bei jeder Antwort: Zeitüberschreitungen prüfen und in der Buslücke höchstens EIN Telegramm senden (Schreiben vor Lesen) */
    private gapTick(f: Frame): void {
        const sent = this.writeQueue.length ? this.writeTick(f) : false;
        const q = this.queryQueue[0];
        if (!q) {
            return;
        }
        if (q.sentAt && Date.now() - q.sentAt > QUERY_TIMEOUT_MS) {
            if (q.tries >= q.maxTries) {
                this.queryQueue.shift();
                q.resolve(null);
                return;
            }
            q.sentAt = 0;
        }
        if (!sent && !q.sentAt && f.src === UNIT_ADDR && f.dp === GAP_TRIGGER_DP && this.sock) {
            this.sock.write(buildQuery(1, q.dst, q.id, q.count));
            q.sentAt = Date.now();
            q.tries++;
        }
    }

    /** Lese-Anfrage einreihen; liefert die Nutzdaten der Antwort oder null */
    private query(dst: number, dp: number, sub = 0, count = 1, maxTries = QUERY_MAX_TRIES): Promise<Buffer | null> {
        return new Promise(resolve => {
            this.queryQueue.push({ dst, id: (dp | (sub << 16)) >>> 0, count, tries: 0, maxTries, sentAt: 0, resolve });
        });
    }

    /** gibt true zurück, wenn in dieser Lücke gesendet wurde */
    private writeTick(f: Frame): boolean {
        const job = this.writeQueue[0];
        if (job.sentAt && Date.now() - job.sentAt > WRITE_TIMEOUT_MS) {
            if (job.tries >= WRITE_MAX_TRIES) {
                this.log.warn(`Sollwert ${job.value} °C an Modul ${job.mod} nicht bestätigt – aufgegeben`);
                this.writeQueue.shift();
                this.restoreSetpoint(job.mod);
                return false;
            }
            job.sentAt = 0;
        }
        if (!job.sentAt && f.src === 2 && f.dp === GAP_TRIGGER_DP && this.sock) {
            const p = Buffer.alloc(4);
            p.writeFloatLE(job.value);
            this.sock.write(buildFrame(FrameType.Set, 1, job.mod, 0x01fb, p));
            job.sentAt = Date.now();
            job.tries++;
            this.log.debug(`SET 0x01FB = ${job.value} an Modul ${job.mod} gesendet (Versuch ${job.tries})`);
            return true;
        }
        return false;
    }

    private async onSetpointReport(mod: number, value: number): Promise<void> {
        this.reportedSetpoint.set(mod, value);
        const job = this.writeQueue[0];
        let confirmed = false;
        if (job && job.mod === mod && job.sentAt && Math.abs(job.value - value) < 0.05) {
            this.writeQueue.shift();
            confirmed = true;
            this.log.info(`Sollwert ${value} °C von ${this.moduleFolder(mod)} bestätigt`);
        }
        // solange ein Auftrag für dieses Modul aussteht, den gewünschten Wert nicht überschreiben
        if (!this.writeQueue.some(j => j.mod === mod)) {
            await this.write(`${this.moduleFolder(mod)}.Sollwert`, value, confirmed);
        }
    }

    private restoreSetpoint(mod: number): void {
        const v = this.reportedSetpoint.get(mod);
        if (v !== undefined) {
            void this.setState(`${this.moduleFolder(mod)}.Sollwert`, v, true);
            this.lastWritten.set(`${this.moduleFolder(mod)}.Sollwert`, { val: v, ts: Date.now() });
        }
    }

    /* ------------------------------------------------------------- Parameter lesen */

    private paramFolder(mod: number): string {
        return `${this.moduleFolder(mod)}.Parameter`;
    }

    /** Module, die beim Parameter-Lesen abgefragt werden: Lüftungsgerät zuerst, ohne Master (1) */
    private paramModules(): number[] {
        const mods = [...this.moduleNames.keys()].filter(m => m !== 1 && m !== UNIT_ADDR).sort((x, y) => x - y);
        return [UNIT_ADDR, ...mods];
    }

    private async setupParameters(): Promise<void> {
        // Bedienung und Status direkt unter der Instanz
        await this.ensureObject('Parameter_lesen', {
            type: 'state',
            common: { name: 'Parameter aller Module einmalig lesen (nur Lese-Anfragen, dauert über eine Stunde)', type: 'boolean', role: 'button', read: false, write: true },
        });
        await this.ensureObject('Parameter_lesen_aktiv', {
            type: 'state',
            common: { name: 'Parameter-Lesen läuft', type: 'boolean', role: 'indicator.working', read: true, write: false, def: false },
        });
        await this.ensureObject('Parameter_lesen_Fortschritt', {
            type: 'state',
            common: { name: 'Fortschritt des Parameter-Lesens', type: 'number', role: 'value', unit: '%', min: 0, max: 100, read: true, write: false, def: 0 },
        });
        await this.ensureObject('Parameter_lesen_Status', {
            type: 'state',
            common: { name: 'Status des Parameter-Lesens', type: 'string', role: 'text', read: true, write: false, def: '' },
        });
        await this.ensureObject('Parameter_lesen_zuletzt', {
            type: 'state',
            common: { name: 'Zeitpunkt des letzten vollständigen Parameter-Lesens', type: 'number', role: 'date', read: true, write: false },
        });
        this.subscribeStates('Parameter_lesen');
        await this.setStateAsync('Parameter_lesen_aktiv', false, true);
        await this.cleanupOldObjects();

        for (const mod of this.paramModules()) {
            const dir = await this.getStateAsync(`${this.paramFolder(mod)}.Verzeichnis`);
            if (dir && typeof dir.val === 'string' && dir.val) {
                try {
                    this.paramDirs.set(mod, JSON.parse(dir.val) as ParamDirectory);
                } catch {
                    // ignorieren
                }
            }
        }
        if (this.cfg.pollEnabled) {
            this.cfg.pollMinutes = Math.max(5, Number(this.cfg.pollMinutes) || 60);
            this.log.info(`Regelmäßige Parameter-Abfrage alle ${this.cfg.pollMinutes} min aktiv`);
            this.setInterval(() => void this.pollParameters(), this.cfg.pollMinutes * 60 * 1000);
        }
    }

    /** Reste älterer Versionen entfernen: seitenweise Meta-States und den alten Knopf */
    private async cleanupOldObjects(): Promise<void> {
        const lists = Object.values(META)
            .filter(d => !d.text)
            .map(d => d.name)
            .join('|');
        const re = new RegExp(`\\.Meta\\.(?:(?:${lists})_\\d+(?:_raw)?|(?:${lists})_raw)$`);
        const old = new Set([`${this.paramFolder(UNIT_ADDR)}.Lesen`, `${this.paramFolder(UNIT_ADDR)}.Status`, `${this.paramFolder(UNIT_ADDR)}.Zuletzt`]);
        const objs = await this.getAdapterObjectsAsync();
        let n = 0;
        for (const full of Object.keys(objs)) {
            const rel = full.substring(this.namespace.length + 1);
            if (re.test(rel) || old.has(rel)) {
                await this.delObjectAsync(rel);
                this.known.delete(rel);
                n++;
            }
        }
        if (n) {
            this.log.info(`${n} veraltete Objekte (seitenweise Meta-Daten, alter Parameter-Knopf) entfernt`);
        }
    }

    private async setParamStatus(text: string, percent?: number): Promise<void> {
        await this.setStateAsync('Parameter_lesen_Status', text, true);
        if (percent !== undefined) {
            await this.setStateAsync('Parameter_lesen_Fortschritt', Math.max(0, Math.min(100, Math.round(percent))), true);
        }
    }

    /** eine Meta-Liste seitenweise lesen (die Antworten legt handleMeta zusätzlich unter <Modul>.Meta ab) */
    private async readMetaList(mod: number, dp: number, offsets: number[]): Promise<number[] | null> {
        const list: number[] = [];
        for (const o of offsets) {
            const p = await this.query(mod, dp, o, 1, 4);
            if (!p) {
                return null;
            }
            for (let i = 0; i * 2 + 1 < p.length; i++) {
                list[o + i] = p.readUInt16LE(i * 2);
            }
        }
        return list;
    }

    /** Länge des Verzeichnisses ermitteln: das Gerät antwortet nur, solange Offset + 64 <= Länge */
    private async findDirectoryOffsets(mod: number, status: (t: string) => Promise<void>): Promise<number[] | null> {
        const first = await this.query(mod, 0x0033, 0, 1, 3);
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
            await status(`Verzeichnis, prüfe Offset ${o}`);
            const p = await this.query(mod, 0x0033, o, 1, 4);
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
            await status(`Verzeichnis, prüfe Offset ${mid}`);
            // ausbleibende Antwort kann auch eine Kollision sein: hier mehr Versuche
            if (await this.query(mod, 0x0033, mid, 1, 4)) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        // Gegenprobe nach oben, falls eine Antwort trotz allem verloren ging
        while (lo + 1 < fail && (await this.query(mod, 0x0033, lo + 1, 1, 4))) {
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
        await status('Verzeichnis (DP-Liste, Typ, Zugriff, Einheit)');
        const dps = await this.readMetaList(mod, 0x0033, offsets);
        if (!dps) {
            return null;
        }
        await this.readMetaList(mod, 0x0034, offsets);
        const access = await this.readMetaList(mod, 0x0038, offsets);
        const units = await this.readMetaList(mod, 0x0039, offsets);
        return { dps, access: access || [], units: units || [] };
    }

    /** Name (Meta 0x0001) lesen: Text mit Längenbyte; manche Module verlangen genau die passende Anzahl */
    private async readName(mod: number): Promise<void> {
        const p = await this.query(mod, 0x0001, 0, 1, 2);
        if (!p || !p.length || p[0] >= 0x20 || p.length > p[0]) {
            return;
        }
        for (const c of [p[0] + 1, p[0]]) {
            if (await this.query(mod, 0x0001, 0, c, 2)) {
                return;
            }
        }
    }

    /** Knopf „Parameter_lesen“: je Modul Name, Verzeichnis und alle Parameter einmal abfragen */
    private async readParameters(): Promise<void> {
        if (this.paramRunning) {
            this.log.info('Parameter-Lesen läuft bereits');
            return;
        }
        if (!this.busConnected) {
            await this.setParamStatus('Fehler: keine Verbindung zum Gateway');
            return;
        }
        this.paramRunning = true;
        await this.setStateAsync('Parameter_lesen_aktiv', true, true);
        const mods = this.paramModules();
        const summary: string[] = [];
        try {
            this.addEvent('Parameter-Lesen gestartet');
            for (let mi = 0; mi < mods.length && !this.stopping; mi++) {
                const mod = mods[mi];
                const label = `${this.moduleFolder(mod)} (${mi + 1}/${mods.length})`;
                const status = (t: string, frac = 0): Promise<void> => this.setParamStatus(`${label}: ${t}`, ((mi + frac) / mods.length) * 100);
                await status('Name');
                await this.readName(mod);
                const dir = await this.readDirectory(mod, t => status(t));
                if (!dir) {
                    summary.push(`${this.moduleFolder(mod)}: kein Verzeichnis`);
                    continue;
                }
                this.paramDirs.set(mod, dir);
                await this.ensureModule(mod);
                await this.ensureChannel(this.paramFolder(mod), 'Parameter (per Lese-Anfrage)');
                await this.ensureObject(`${this.paramFolder(mod)}.Verzeichnis`, {
                    type: 'state',
                    common: { name: 'Verzeichnis (DP, Zugriff, Einheit) aus den Meta-DPs', type: 'string', role: 'json', read: true, write: false },
                });
                await this.write(`${this.paramFolder(mod)}.Verzeichnis`, JSON.stringify(dir), true);
                const ok = await this.readParamList(mod, dir.dps, (i, n, dp) =>
                    status(`Parameter ${i}/${n} (0x${dp.toString(16).padStart(4, '0')})`, i / n),
                );
                summary.push(`${this.moduleFolder(mod)}: ${ok}/${dir.dps.length}`);
            }
            if (this.stopping) {
                await this.setParamStatus(`abgebrochen (Adapter beendet) – ${summary.join(', ')}`);
                return;
            }
            await this.setStateAsync('Parameter_lesen_zuletzt', Date.now(), true);
            const text = `fertig – ${summary.join(', ')}`;
            await this.setParamStatus(text, 100);
            this.addEvent(`Parameter-Lesen ${text}`);
        } finally {
            this.paramRunning = false;
            if (!this.stopping) {
                await this.setStateAsync('Parameter_lesen_aktiv', false, true);
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
            this.log.debug('Parameter-Abfrage: noch kein Verzeichnis – bitte einmal „Parameter_lesen“ auslösen');
            return;
        }
        this.paramRunning = true;
        try {
            await this.readParamList(UNIT_ADDR, dps);
        } finally {
            this.paramRunning = false;
        }
    }

    private async readParamList(mod: number, dps: number[], progress?: (i: number, n: number, dp: number) => Promise<void>): Promise<number> {
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
        await this.ensureObject(id, {
            type: 'state',
            common: {
                name: names[dp] ? `${names[dp]} (0x${hex})` : `DP 0x${hex}`,
                desc: `Zugriff: ${acc === undefined ? '?' : PARAM_ACCESS[acc] || `0x${acc.toString(16)}`}, Einheitencode ${unitCode ?? '?'}, Rohdaten ${toHex(payload)}`,
                type: typeof val === 'number' ? 'number' : 'string',
                role: typeof val === 'number' ? 'value' : 'json',
                unit: unitCode !== undefined ? PARAM_UNITS[unitCode] : undefined,
                read: true,
                write: false,
            },
        });
        await this.write(id, val, true);
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
            stream.write('# Proxon-HESP-Mitschnitt: ISO-Zeit Typ Quelle>Ziel Register-ID Telegramm(hex)\n');
            const timer = this.setTimeout(() => this.stopCapture(true), this.cfg.captureMinutes * 60000);
            this.capture = { stream, file, timer };
            this.log.info(`Mitschnitt gestartet: ${file} (${this.cfg.captureMinutes} min)`);
            void this.setState('info.capture', true, true);
        } catch (e) {
            this.log.warn(`Mitschnitt nicht möglich: ${(e as Error).message}`);
            void this.setState('info.capture', false, true);
        }
    }

    private stopCapture(updateState: boolean): void {
        if (this.capture) {
            if (this.capture.timer) {
                this.clearTimeout(this.capture.timer);
            }
            this.capture.stream.end();
            this.log.info(`Mitschnitt beendet: ${this.capture.file}`);
            this.capture = null;
        }
        if (updateState) {
            void this.setState('info.capture', false, true);
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
        return s.split('.').map(p => this.cleanId(p)).filter(Boolean).join('.');
    }

    private async ensureModule(mod: number): Promise<void> {
        const folder = this.moduleFolder(mod);
        await this.ensureObject(folder, {
            type: 'device',
            common: { name: `${folder} (Busadresse ${mod})` },
        });
    }

    private async ensureChannel(id: string, name: string): Promise<void> {
        await this.ensureObject(id, { type: 'channel', common: { name } });
    }

    /** Zwischenebenen von Zuordnungsnamen mit Punkten als Kanal anlegen */
    private async ensureParents(id: string, from = 2): Promise<void> {
        const parts = id.split('.');
        for (let i = from; i < parts.length; i++) {
            const pid = parts.slice(0, i).join('.');
            await this.ensureChannel(pid, parts[i - 1]);
        }
    }

    private async ensureObject(id: string, obj: Omit<ioBroker.SettableObject, '_id' | 'native'> & { native?: Record<string, unknown> }): Promise<void> {
        if (this.known.has(id)) {
            return;
        }
        const pending = this.pendingCreate.get(id);
        if (pending) {
            return pending;
        }
        const p = (async () => {
            const common = Object.fromEntries(Object.entries(obj.common as Record<string, unknown>).filter(([, v]) => v !== undefined));
            await this.setObjectNotExistsAsync(id, { ...obj, common, native: obj.native || {} } as ioBroker.SettableObject);
            this.known.add(id);
        })().finally(() => this.pendingCreate.delete(id));
        this.pendingCreate.set(id, p);
        return p;
    }

    /** Schreibt nur bei Änderung, spätestens aber nach refreshSec */
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
            this.log.warn(`setState ${id} fehlgeschlagen: ${(e as Error).message}`);
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new ProxonHesp(options);
} else {
    (() => new ProxonHesp())();
}
