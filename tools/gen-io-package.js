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
    mappings.push(M(r, 'R', 0x01f4, 'Temperatur', { type: 'float32', unit: '°C', history: true, min: -20, max: 60 }));
    mappings.push(M(r, 'R', 0x01f6, 'SollTemperaturModul', { type: 'float32', unit: '°C' }));
    mappings.push(M(r, 'R', 0x01fa, 'SollTemperaturZentrale', { type: 'float32', unit: '°C' }));
    // [OB] per Bedienteil-Tests 2026-11-08 ermittelt
    mappings.push(M(r, 'W', 0x019a, 'Heizanforderung', { type: 'uint8', states: '0:im Sollbereich;1:Heizbedarf;2:zu warm' }));
    mappings.push(M(r, 'R', 0x0194, 'Heizelement_freigegeben', { type: 'uint16', bit: 3 }));
    mappings.push(M(r, 'R', 0x0194, 'Tastensperre', { type: 'uint16', bit: 11 }));
}
// Adresse 40: Luftqualitätssensor in der Abluft (meldet sich per 0x0001 als „LQS-CO2RH-RT0…“)
mappings.push(M(40, 'R', 0x01f4, 'Luftfeuchte', { type: 'float32', unit: '%', history: true, min: 0, max: 100 }));
mappings.push(M(40, 'R', 0x01f6, 'CO2', { type: 'uint16', unit: 'ppm', history: true, min: 1, max: 10000 }));

// Lüftungsgerät / Wärmepumpe (Adresse 2)
const C = 2;
// Zehn Fühler, int16 in 0,1 °C [DN][MM]
const temps = [
    'T1_Zuluft',
    'T7_Abluft',
    'T4_Fortluft',
    'T3_Frischluft',
    'T5_vor_Verdampfer',
    'T6_Verdampfer',
    'T8_nach_Vorwaerme',
    'T12_vor_Kondensator',
    'T10_Kondensator',
    'T13_Kompressor',
];
temps.forEach((n, i) =>
    mappings.push(
        M(C, 'R', 0x03b7, `Temperaturen.${n}`, { type: 'int16', index: i, factor: 0.1, unit: '°C', history: true, ignore: -1, min: -50, max: 150 }),
    ),
);
// Lüfter [DN][MM]
mappings.push(M(C, 'R', 0x00c9, 'Luefter.Drehzahl_Zuluft', { type: 'float32', index: 0, unit: 'U/min', min: 0, max: 10000 }));
mappings.push(M(C, 'R', 0x00c9, 'Luefter.Drehzahl_Abluft', { type: 'float32', index: 1, unit: 'U/min', min: 0, max: 10000 }));
mappings.push(M(C, 'R', 0x00d7, 'Luefter.Ansteuerung_Zuluft', { type: 'float32', index: 0, factor: 0.01, unit: '%', min: 0, max: 100 }));
mappings.push(M(C, 'R', 0x00d7, 'Luefter.Ansteuerung_Abluft', { type: 'float32', index: 1, factor: 0.01, unit: '%', min: 0, max: 100 }));
for (let s = 0; s < 4; s++) {
    mappings.push(M(C, 'R', 0x00d2, `Luefter.Kennlinie_Zuluft_Stufe${s + 1}`, { type: 'float32', index: s, unit: '%', min: 0, max: 100 }));
    mappings.push(M(C, 'R', 0x00d3, `Luefter.Kennlinie_Abluft_Stufe${s + 1}`, { type: 'float32', index: s, unit: '%', min: 0, max: 100 }));
}
mappings.push(M(C, 'R', 0x0208, 'Luefter.Stufe_Ist', { type: 'fanlevel' }));
mappings.push(M(C, 'W', 0x00e1, 'Luefter.Stufe_Soll', { type: 'uint16', min: 0, max: 4 }));
mappings.push(M(C, 'W', 0x01f8, 'Luefter.Intensivlueftung', { type: 'uint32', bit: 6 }));
// Betrieb [DN][MM]
mappings.push(
    M(C, 'W', 0x020a, 'Betrieb.Betriebsart', { type: 'uint16', min: 0, max: 4, states: '0:Aus;1:Eco-Sommer;2:Eco-Winter;3:Komfort;4:Ofen' }),
);
// Raum des zentralen Bedienteils („Wohnen“), ohne eigenes Raummodul [DN][OB]
mappings.push(M(C, 'W', 0x0226, '/Wohnen.Temperatur', { type: 'float32', unit: '°C', history: true, min: -20, max: 60 }));
mappings.push(M(C, 'W', 0x0227, '/Wohnen.Sollwert', { type: 'float32', unit: '°C', min: 10, max: 35 }));
// Ist/Soll eines Raummoduls, die der Master zusätzlich an das Lüftungsgerät gibt (bei der Testanlage Modul 13) [OB]
mappings.push(M(C, 'W', 0x0229, 'Betrieb.Referenzraum_Temperatur', { type: 'float32', unit: '°C', history: true }));
mappings.push(M(C, 'W', 0x022a, 'Betrieb.Referenzraum_Sollwert', { type: 'float32', unit: '°C' }));
mappings.push(M(C, 'R', 0x0160, 'Betrieb.Bypass_aktiv', { type: 'uint8', bit: 0 }));
mappings.push(M(C, 'R', 0x00ed, 'Betrieb.Filter_Restlaufzeit', { type: 'uint32', unit: 'Tage', ignore: 4294967295 }));
mappings.push(M(C, 'R', 0x0110, 'Betrieb.Kuehlschwelle', { type: 'float32', unit: '°C', min: 0, max: 100 }));
mappings.push(M(C, 'R', 0x0116, 'Betrieb.Max_Heizleistung', { type: 'uint16', index: 0, unit: '%', min: 0, max: 100 }));
mappings.push(M(C, 'R', 0x0116, 'Betrieb.Max_Kuehlleistung', { type: 'uint16', index: 1, unit: '%', min: 0, max: 100 }));
mappings.push(M(C, 'R', 0x006c, 'Betrieb.MV_Heizen_Kuehlen_Anzeige', { type: 'uint32', bit: 9 }));
mappings.push(M(C, 'R', 0x006c, 'Betrieb.MV_Abtau_Anzeige', { type: 'uint32', bit: 7 }));
mappings.push(M(C, 'R', 0x051c, 'Kompressor.Drehzahl', { type: 'float32', unit: 'U/min', history: true, min: 0, max: 10000 }));
mappings.push(M(C, 'R', 0x032e, 'Geraet.Datum_Uhrzeit', { type: 'calendar' }));
mappings.push(M(C, 'R', 0x0330, 'Geraet.Uhrzeit', { type: 'clock' }));
// Betriebsstunden [DN]
const counters = [
    [0x02d0, 'Luefterstufe1'],
    [0x02d1, 'Luefterstufe2'],
    [0x02d2, 'Luefterstufe3'],
    [0x02d3, 'Luefterstufe4'],
    [0x02d4, 'Waermepumpe_Heizen'],
    [0x02d5, 'Waermepumpe_Kuehlen'],
    [0x02d7, 'Steuerung'],
    [0x02d9, 'Vorheizung'],
];
for (const [dp, n] of counters) {
    mappings.push(M(C, 'R', dp, `Betriebsstunden.${n}`, { type: 'uint32', unit: 'h', ignore: 4294967295 }));
}

const io = {
    common: {
        name: 'proxon-hesp',
        version: pkg.version,
        news: {
            '0.4.0': {
                en: 'Parameter reading covers all modules (name, directory, values); button and status (active, progress) directly under the instance; meta lists merged into one state each',
                de: 'Parameter lesen für alle Module (Name, Verzeichnis, Werte); Knopf und Status (aktiv, Fortschritt) direkt unter der Instanz; Meta-Listen zu je einem Datenpunkt zusammengeführt',
            },
            '0.3.2': {
                en: 'Parameter reading: more retries for directory pages, interruption reported as aborted',
                de: 'Parameter lesen: mehr Wiederholungen für Verzeichnisseiten, Abbruch wird als „abgebrochen“ gemeldet',
            },
            '0.3.1': {
                en: 'Setpoint step configurable (default 1 °C; room modules ignored 0.5 °C in tests)',
                de: 'Sollwert-Schrittweite einstellbar (Standard 1 °C; Raummodule haben 0,5 °C im Test ignoriert)',
            },
            '0.3.0': {
                en: 'Button "read parameters": reads the self-description and all parameters of the ventilation unit (read queries only); optional periodic polling (off by default)',
                de: 'Knopf „Parameter lesen“: liest Selbstauskunft und alle Parameter des Lüftungsgeräts (nur Lese-Anfragen); optional regelmäßige Abfrage (standardmäßig aus)',
            },
            '0.2.1': {
                en: 'Address 40 identified as air-quality sensor (humidity, CO2); length-prefixed meta texts decoded',
                de: 'Adresse 40 als Luftqualitätssensor erkannt (Feuchte, CO2); Meta-Texte mit Längenbyte werden korrekt gelesen',
            },
            '0.2.0': {
                en: 'Optional writing of room setpoints (SET 0x01FB), sent in a safe bus gap and confirmed by the room module',
                de: 'Optional: Raum-Sollwerte schreiben (SET 0x01FB), gesendet in einer sicheren Buslücke und vom Raummodul bestätigt',
            },
            '0.1.2': {
                en: 'Room module status (heat demand, heater enable, key lock), absolute mapping paths with leading "/"',
                de: 'Raummodul-Status (Heizanforderung, Heizelement-Freigabe, Tastensperre), Zuordnungspfade ab Wurzel mit führendem "/"',
            },
            '0.1.1': {
                en: 'Fix: floating-point values were sometimes misdetected as text',
                de: 'Fehlerbehebung: Gleitkommawerte wurden teils fälschlich als Text erkannt',
            },
            '0.1.0': {
                en: 'Initial version: passive listening on the Proxon HESP bus',
                de: 'Erste Version: passives Mitlesen des Proxon-HESP-Busses',
            },
        },
        titleLang: { en: 'Proxon HESP', de: 'Proxon HESP' },
        desc: {
            en: 'Passively reads the HESP bus of Proxon P-series ventilation units via an RS485-to-TCP gateway',
            de: 'Liest den HESP-Bus von Proxon-Lüftungsanlagen (P-Serie) passiv über ein RS485-TCP-Gateway mit',
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
        mode: 'daemon',
        type: 'climate-control',
        compact: true,
        connectionType: 'local',
        dataSource: 'push',
        adminUI: { config: 'json' },
        dependencies: [{ 'js-controller': '>=6.0.11' }],
        globalDependencies: [{ admin: '>=7.0.23' }],
    },
    native: {
        host: '',
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
        pollEnabled: false,
        pollMinutes: 60,
        pollList: '',
        modules: [
            { address: 2, name: 'Zentrale' },
            { address: 10, name: 'Raum_10' },
            { address: 11, name: 'Raum_11' },
            { address: 12, name: 'Raum_12' },
            { address: 13, name: 'Raum_13' },
            { address: 14, name: 'Raum_14' },
            { address: 15, name: 'Raum_15' },
            { address: 30, name: 'Bedienteil' },
            { address: 40, name: 'Teilnehmer_40' },
        ],
        mappings,
    },
    objects: [],
    instanceObjects: [
        { _id: 'info', type: 'channel', common: { name: 'Information' }, native: {} },
        {
            _id: 'info.connection',
            type: 'state',
            common: { role: 'indicator.connected', name: 'Verbunden und gültige Telegramme', type: 'boolean', read: true, write: false, def: false },
            native: {},
        },
    ],
};

fs.writeFileSync(path.join(__dirname, '..', 'io-package.json'), `${JSON.stringify(io, null, 4)}\n`);
console.log(`io-package.json geschrieben, ${mappings.length} Standard-Zuordnungen`);
