/* Erzeugt io-package.json inkl. Standard-Zuordnungen.
 * Quellen der Zuordnungen:
 *   [MM] markusmauch.github.io/proxon-hesp (CC BY 4.0)
 *   [DN] github.com/DNier/proxon-hesp-homeassistant (MIT)
 *   [OB] eigene Mitschnitte dieser Anlage
 * Aufruf: node tools/gen-io-package.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
// news, titleLang und desc (inkl. Übersetzungen) pflegen release-script und translate-adapter direkt in io-package.json
const ioPath = path.join(__dirname, '..', 'io-package.json');
const prev = fs.existsSync(ioPath) ? JSON.parse(fs.readFileSync(ioPath, 'utf8')).common || {} : {};

const M = (module, kind, register, name, extra = {}) => ({
    module,
    kind,
    register,
    index: 0,
    name,
    unit: '',
    type: 'auto',
    factor: 1,
    history: false,
    bit: '',
    ignore: '',
    min: '',
    max: '',
    states: '',
    ...extra,
});

const mappings = [];

// Raummodule [OB]
const rooms = [10, 11, 12, 13, 14, 15];
for (const r of rooms) {
    mappings.push(M(r, 'R', 0x01f4, 'temperature', { type: 'float32', unit: '°C', history: true, min: -20, max: 60 }));
    mappings.push(M(r, 'R', 0x01f6, 'setpointModule', { type: 'float32', unit: '°C' }));
    mappings.push(M(r, 'R', 0x01fa, 'setpointCentral', { type: 'float32', unit: '°C' }));
    // [OB] per Tests am zentralen Bedienelement 2026-11-08 ermittelt
    mappings.push(M(r, 'W', 0x01f8, 'sensorOffset', { type: 'float32', unit: '°C', min: -10, max: 10 }));
    mappings.push(M(r, 'W', 0x019a, 'heatDemand', { type: 'uint8', states: '0:in range;1:heating demand;2:too warm' }));
    mappings.push(M(r, 'R', 0x0194, 'heaterEnabled', { type: 'uint16', bit: 3 }));
    mappings.push(M(r, 'R', 0x0194, 'keyLock', { type: 'uint16', bit: 11 }));
}
// Adresse 40: Luftqualitätssensor in der Abluft (meldet sich per 0x0001 als „LQS-CO2RH-RT0…“)
mappings.push(M(40, 'R', 0x01f4, 'humidity', { type: 'float32', unit: '%', history: true, min: 0, max: 100 }));
mappings.push(M(40, 'R', 0x01f6, 'co2', { type: 'uint16', unit: 'ppm', history: true, min: 1, max: 10000 }));

// Lüftungsgerät / Wärmepumpe (Adresse 2)
const C = 2;
// Zehn Fühler, int16 in 0,1 °C [DN][MM]
const temps = [
    't1SupplyAir',
    't7ExtractAir',
    't4ExhaustAir',
    't3OutdoorAir',
    't5BeforeEvaporator',
    't6Evaporator',
    't8AfterPreheater',
    't12BeforeCondenser',
    't10Condenser',
    't13Compressor',
];
temps.forEach((n, i) =>
    mappings.push(
        M(C, 'R', 0x03b7, `temperatures.${n}`, { type: 'int16', index: i, factor: 0.1, unit: '°C', history: true, ignore: -1, min: -50, max: 150 }),
    ),
);
// Lüfter [DN][MM]
mappings.push(M(C, 'R', 0x00c9, 'fans.speedSupply', { type: 'float32', index: 0, unit: 'rpm', min: 0, max: 10000 }));
mappings.push(M(C, 'R', 0x00c9, 'fans.speedExtract', { type: 'float32', index: 1, unit: 'rpm', min: 0, max: 10000 }));
mappings.push(M(C, 'R', 0x00d7, 'fans.controlSupply', { type: 'float32', index: 0, factor: 0.01, unit: '%', min: 0, max: 100 }));
mappings.push(M(C, 'R', 0x00d7, 'fans.controlExtract', { type: 'float32', index: 1, factor: 0.01, unit: '%', min: 0, max: 100 }));
for (let s = 0; s < 4; s++) {
    mappings.push(M(C, 'R', 0x00d2, `fans.curveSupplyLevel${s + 1}`, { type: 'float32', index: s, unit: '%', min: 0, max: 100 }));
    mappings.push(M(C, 'R', 0x00d3, `fans.curveExtractLevel${s + 1}`, { type: 'float32', index: s, unit: '%', min: 0, max: 100 }));
}
mappings.push(M(C, 'R', 0x0208, 'fans.levelActual', { type: 'fanlevel' }));
// Statuswort 0x0208, 2. Byte: Start 0x10 -> 0x12 -> 0x13, Stopp 0x13 -> 0x11 -> 0x10 (eigene Beobachtung, Deutung vermutet)
mappings.push(M(C, 'R', 0x0208, 'operation.heatPumpRequested', { type: 'uint32', bit: 9 }));
mappings.push(M(C, 'R', 0x0208, 'operation.heatPumpActive', { type: 'uint32', bit: 8 }));
mappings.push(M(C, 'W', 0x00e1, 'fans.levelTarget', { type: 'uint16', min: 0, max: 4 }));
mappings.push(M(C, 'W', 0x01f8, 'fans.intensiveVentilation', { type: 'uint32', bit: 6 }));
// Betrieb [DN][MM]
mappings.push(
    M(C, 'W', 0x020a, 'operation.mode', { type: 'uint16', min: 0, max: 4, states: '0:Off;1:Eco summer;2:Eco winter;3:Comfort;4:Stove' }),
);
// Raum des zentralen Bedienelements (BDE) („Wohnen“), ohne eigenes Raummodul [DN][OB]
mappings.push(M(C, 'W', 0x0226, '/controlPanelRoom.temperature', { type: 'float32', unit: '°C', history: true, min: -20, max: 60 }));
mappings.push(M(C, 'W', 0x0227, '/controlPanelRoom.setpoint', { type: 'float32', unit: '°C', min: 10, max: 35 }));
// Ist/Soll eines Raummoduls, die der Master zusätzlich an das Lüftungsgerät gibt (bei der Testanlage Modul 13) [OB]
mappings.push(M(C, 'W', 0x0229, 'operation.referenceRoomTemperature', { type: 'float32', unit: '°C', history: true }));
mappings.push(M(C, 'W', 0x022a, 'operation.referenceRoomSetpoint', { type: 'float32', unit: '°C' }));
mappings.push(M(C, 'R', 0x0160, 'operation.bypassActive', { type: 'uint8', bit: 0 }));
mappings.push(M(C, 'R', 0x00ed, 'operation.filterDaysLeft', { type: 'uint32', unit: 'days', ignore: 4294967295 }));
mappings.push(M(C, 'R', 0x0110, 'operation.coolingThreshold', { type: 'float32', unit: '°C', min: 0, max: 100 }));
mappings.push(M(C, 'R', 0x0116, 'operation.maxHeatingPower', { type: 'uint16', index: 0, unit: '%', min: 0, max: 100 }));
mappings.push(M(C, 'R', 0x0116, 'operation.maxCoolingPower', { type: 'uint16', index: 1, unit: '%', min: 0, max: 100 }));
mappings.push(M(C, 'R', 0x006c, 'operation.valveHeatCoolIndicator', { type: 'uint32', bit: 9 }));
mappings.push(M(C, 'R', 0x006c, 'operation.valveDefrostIndicator', { type: 'uint32', bit: 7 }));
mappings.push(M(C, 'R', 0x051c, 'compressor.speed', { type: 'float32', unit: 'rpm', history: true, min: 0, max: 10000 }));
mappings.push(M(C, 'R', 0x032e, 'device.dateTime', { type: 'calendar' }));
mappings.push(M(C, 'R', 0x0330, 'device.time', { type: 'clock' }));
// Betriebsstunden [DN]
const counters = [
    [0x02d0, 'fanLevel1'],
    [0x02d1, 'fanLevel2'],
    [0x02d2, 'fanLevel3'],
    [0x02d3, 'fanLevel4'],
    [0x02d4, 'heatPumpHeating'],
    [0x02d5, 'heatPumpCooling'],
    [0x02d7, 'controller'],
    [0x02d9, 'preheater'],
];
for (const [dp, n] of counters) {
    mappings.push(M(C, 'R', dp, `operatingHours.${n}`, { type: 'uint32', unit: 'h', ignore: 4294967295 }));
}

const io = {
    common: {
        name: 'proxon-hesp',
        version: pkg.version,
        news: prev.news || {},
        titleLang: prev.titleLang || { en: 'Proxon HESP', de: 'Proxon HESP' },
        desc: prev.desc || {
            en: 'Reads (and optionally writes) the HESP bus of Proxon ventilation/heat-pump units via an RS485 interface',
            de: 'Liest (und schreibt optional) den HESP-Bus von Proxon-Lüftungsanlagen/Wärmepumpen über eine RS485-Schnittstelle',
        },
        authors: ['Martin <mkspam@kneppe.org>'],
        keywords: ['proxon', 'hesp', 'ventilation', 'lüftung', 'heat pump', 'rs485'],
        licenseInformation: { type: 'free', license: 'MIT' },
        platform: 'Javascript/Node.js',
        icon: 'proxon-hesp.svg',
        enabled: true,
        extIcon: 'https://raw.githubusercontent.com/mkneppe/ioBroker.proxon-hesp/main/admin/proxon-hesp.svg',
        readme: 'https://github.com/mkneppe/ioBroker.proxon-hesp/blob/main/README.md',
        loglevel: 'info',
        tier: 3,
        messagebox: true,
        nogit: true,
        mode: 'daemon',
        type: 'climate-control',
        compact: true,
        connectionType: 'local',
        dataSource: 'push',
        adminUI: { config: 'json' },
        dependencies: [{ 'js-controller': '>=6.0.11' }],
        globalDependencies: [{ admin: '>=7.6.20' }],
    },
    native: {
        connType: 'tcp',
        host: '',
        bind: '',
        serialPath: '',
        serialBaud: 19200,
        serialDataBits: 8,
        serialParity: 'none',
        serialStopBits: 1,
        port: 502,
        watchdogSec: 120,
        refreshSec: 300,
        storeRegisters: true,
        captureMinutes: 15,
        historyInstance: 'history.0',
        eventLimit: 100,
        allowWrite: false,
        controlModules: '10,11,12,13,14,15',
        writeMin: 15,
        writeMax: 28,
        writeStep: 1,
        allowHeaterWrite: false,
        allowClockWrite: false,
        clockOffsetMin: 0,
        pollEnabled: false,
        pollMinutes: 60,
        pollList: '',
        learnLog: false,
        learnLogDays: 90,
        modules: [
            { address: 2, name: 'unit' },
            { address: 10, name: 'room10' },
            { address: 11, name: 'room11' },
            { address: 12, name: 'room12' },
            { address: 13, name: 'room13' },
            { address: 14, name: 'room14' },
            { address: 15, name: 'room15' },
            { address: 30, name: 'ptcModule' },
            { address: 40, name: 'node40' },
        ],
        mappings,
    },
    objects: [],
    instanceObjects: [
        { _id: 'info', type: 'channel', common: { name: { en: 'Information', de: 'Information' } }, native: {} },
        {
            _id: 'info.connection',
            type: 'state',
            common: {
                role: 'indicator.connected',
                name: { en: 'Connected and receiving valid telegrams', de: 'Verbunden und gültige Telegramme' },
                type: 'boolean',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        },
    ],
};

fs.writeFileSync(ioPath, `${JSON.stringify(io, null, 2)}\n`);
console.log(`io-package.json geschrieben, ${mappings.length} Standard-Zuordnungen`);
