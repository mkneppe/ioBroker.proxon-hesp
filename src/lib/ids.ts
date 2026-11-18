/**
 * Object IDs and names.
 *
 * Up to 0.5.x the adapter used German object IDs (e.g. "Zentrale.Temperaturen.T1_Zuluft"). Since 0.6.0 all IDs that
 * the adapter defines itself are English. This module holds the rename tables used to migrate existing installations
 * (instance configuration and objects) and the translated names of the default states.
 */

/** Name in English and German */
export interface Translated {
    /** English */
    en: string;
    /** German */
    de: string;
}

/**
 * Translated name helper
 *
 * @param en
 * @param de
 */
export const tr = (en: string, de: string): Translated => ({ en, de });

/** Default module names (instance configuration) that are renamed */
export const MODULE_RENAMES: Record<string, string> = {
    Zentrale: 'unit',
    Raum_10: 'room10',
    Raum_11: 'room11',
    Raum_12: 'room12',
    Raum_13: 'room13',
    Raum_14: 'room14',
    Raum_15: 'room15',
    PTC_Modul: 'ptcModule',
    Teilnehmer_40: 'node40',
};

/**
 * Folder of a module without configured name
 *
 * @param mod
 */
export const fallbackFolder = (mod: number): string => `module${mod}`;
const OLD_FALLBACK = /^Modul_(\d+)$/;

/** Old default mapping names (and fixed states created by the code) -> new names */
export const PATH_RENAMES: Record<string, string> = {
    // room modules
    Temperatur: 'temperature',
    SollTemperaturModul: 'setpointModule',
    SollTemperaturZentrale: 'setpointCentral',
    Fuehlerkorrektur: 'sensorOffset',
    Heizanforderung: 'heatDemand',
    Heizelement_freigegeben: 'heaterEnabled',
    Tastensperre: 'keyLock',
    Sollwert: 'setpoint',
    Heizelement_freigeben: 'heaterEnable',
    // air quality sensor
    Luftfeuchte: 'humidity',
    CO2: 'co2',
    // ventilation unit
    'Temperaturen.T1_Zuluft': 'temperatures.t1SupplyAir',
    'Temperaturen.T7_Abluft': 'temperatures.t7ExtractAir',
    'Temperaturen.T4_Fortluft': 'temperatures.t4ExhaustAir',
    'Temperaturen.T3_Frischluft': 'temperatures.t3OutdoorAir',
    'Temperaturen.T5_vor_Verdampfer': 'temperatures.t5BeforeEvaporator',
    'Temperaturen.T6_Verdampfer': 'temperatures.t6Evaporator',
    'Temperaturen.T8_nach_Vorwaerme': 'temperatures.t8AfterPreheater',
    'Temperaturen.T12_vor_Kondensator': 'temperatures.t12BeforeCondenser',
    'Temperaturen.T10_Kondensator': 'temperatures.t10Condenser',
    'Temperaturen.T13_Kompressor': 'temperatures.t13Compressor',
    'Luefter.Drehzahl_Zuluft': 'fans.speedSupply',
    'Luefter.Drehzahl_Abluft': 'fans.speedExtract',
    'Luefter.Ansteuerung_Zuluft': 'fans.controlSupply',
    'Luefter.Ansteuerung_Abluft': 'fans.controlExtract',
    'Luefter.Kennlinie_Zuluft_Stufe1': 'fans.curveSupplyLevel1',
    'Luefter.Kennlinie_Zuluft_Stufe2': 'fans.curveSupplyLevel2',
    'Luefter.Kennlinie_Zuluft_Stufe3': 'fans.curveSupplyLevel3',
    'Luefter.Kennlinie_Zuluft_Stufe4': 'fans.curveSupplyLevel4',
    'Luefter.Kennlinie_Abluft_Stufe1': 'fans.curveExtractLevel1',
    'Luefter.Kennlinie_Abluft_Stufe2': 'fans.curveExtractLevel2',
    'Luefter.Kennlinie_Abluft_Stufe3': 'fans.curveExtractLevel3',
    'Luefter.Kennlinie_Abluft_Stufe4': 'fans.curveExtractLevel4',
    'Luefter.Stufe_Ist': 'fans.levelActual',
    'Luefter.Stufe_Soll': 'fans.levelTarget',
    'Luefter.Intensivlueftung': 'fans.intensiveVentilation',
    'Betrieb.Waermepumpe_angefordert': 'operation.heatPumpRequested',
    'Betrieb.Waermepumpe_aktiv': 'operation.heatPumpActive',
    'Betrieb.Betriebsart': 'operation.mode',
    'Betrieb.Referenzraum_Temperatur': 'operation.referenceRoomTemperature',
    'Betrieb.Referenzraum_Sollwert': 'operation.referenceRoomSetpoint',
    'Betrieb.Bypass_aktiv': 'operation.bypassActive',
    'Betrieb.Filter_Restlaufzeit': 'operation.filterDaysLeft',
    'Betrieb.Kuehlschwelle': 'operation.coolingThreshold',
    'Betrieb.Max_Heizleistung': 'operation.maxHeatingPower',
    'Betrieb.Max_Kuehlleistung': 'operation.maxCoolingPower',
    'Betrieb.MV_Heizen_Kuehlen_Anzeige': 'operation.valveHeatCoolIndicator',
    'Betrieb.MV_Abtau_Anzeige': 'operation.valveDefrostIndicator',
    'Kompressor.Drehzahl': 'compressor.speed',
    'Geraet.Datum_Uhrzeit': 'device.dateTime',
    'Geraet.Uhrzeit': 'device.time',
    'Geraet.Uhr_stellen': 'device.setClock',
    'Betriebsstunden.Luefterstufe1': 'operatingHours.fanLevel1',
    'Betriebsstunden.Luefterstufe2': 'operatingHours.fanLevel2',
    'Betriebsstunden.Luefterstufe3': 'operatingHours.fanLevel3',
    'Betriebsstunden.Luefterstufe4': 'operatingHours.fanLevel4',
    'Betriebsstunden.Waermepumpe_Heizen': 'operatingHours.heatPumpHeating',
    'Betriebsstunden.Waermepumpe_Kuehlen': 'operatingHours.heatPumpCooling',
    'Betriebsstunden.Steuerung': 'operatingHours.controller',
    'Betriebsstunden.Vorheizung': 'operatingHours.preheater',
    // room of the central control unit, created from the instance root
    '/Wohnen.Temperatur': '/controlPanelRoom.temperature',
    '/Wohnen.Sollwert': '/controlPanelRoom.setpoint',
};

/** First path segment (channel) renames inside a module folder */
export const SEGMENT_RENAMES: Record<string, string> = {
    Temperaturen: 'temperatures',
    Luefter: 'fans',
    Betrieb: 'operation',
    Kompressor: 'compressor',
    Geraet: 'device',
    Betriebsstunden: 'operatingHours',
    Register: 'registers',
    Meta: 'meta',
    Parameter: 'parameters',
};

/** Leaf renames below <module>.Meta and <module>.Parameter */
export const META_LEAF_RENAMES: Record<string, string> = {
    Name: 'name',
    Name_raw: 'nameRaw',
    DPListe: 'dpList',
    Typcodes: 'typeCodes',
    Zugriff: 'access',
    Einheiten: 'units',
    Fehlerstatus: 'errorStatus',
    Fehlerstatus_raw: 'errorStatusRaw',
    Verzeichnis: 'directory',
};

/** States and channels directly under the instance */
export const ROOT_RENAMES: Record<string, string> = {
    Parameter_lesen: 'paramRead.start',
    Parameter_lesen_aktiv: 'paramRead.running',
    Parameter_lesen_Fortschritt: 'paramRead.progress',
    Parameter_lesen_Status: 'paramRead.status',
    Parameter_lesen_zuletzt: 'paramRead.lastRun',
    Wohnen: 'controlPanelRoom',
    'Wohnen.Temperatur': 'controlPanelRoom.temperature',
    'Wohnen.Sollwert': 'controlPanelRoom.setpoint',
};

/** New value texts / units of default mappings (by new name) */
export const MAPPING_UPDATES: Record<string, { states?: [string, string]; unit?: [string, string] }> = {
    heatDemand: { states: ['0:im Sollbereich;1:Heizbedarf;2:zu warm', '0:in range;1:heating demand;2:too warm'] },
    'operation.mode': {
        states: [
            '0:Aus;1:Eco-Sommer;2:Eco-Winter;3:Komfort;4:Ofen',
            '0:Off;1:Eco summer;2:Eco winter;3:Comfort;4:Stove',
        ],
    },
    'operation.filterDaysLeft': { unit: ['Tage', 'days'] },
    'fans.speedSupply': { unit: ['U/min', 'rpm'] },
    'fans.speedExtract': { unit: ['U/min', 'rpm'] },
    'compressor.speed': { unit: ['U/min', 'rpm'] },
};

/** Translated names of the default mapping states and their channels (by new path) */
export const NAMES: Record<string, Translated> = {
    temperature: tr('Room temperature', 'Raumtemperatur'),
    setpointModule: tr('Setpoint of the room module', 'Sollwert des Raummoduls'),
    setpointCentral: tr('Setpoint from the central control unit', 'Sollwert vom zentralen Bedienelement'),
    sensorOffset: tr('Sensor offset', 'Fühlerkorrektur'),
    heatDemand: tr('Heat demand', 'Heizanforderung'),
    heaterEnabled: tr('Electric heater enabled', 'Heizelement freigegeben'),
    keyLock: tr('Key lock', 'Tastensperre'),
    humidity: tr('Relative humidity', 'Relative Luftfeuchte'),
    co2: tr('CO2', 'CO2'),
    temperatures: tr('Temperatures', 'Temperaturen'),
    'temperatures.t1SupplyAir': tr('T1 supply air', 'T1 Zuluft'),
    'temperatures.t7ExtractAir': tr('T7 extract air', 'T7 Abluft'),
    'temperatures.t4ExhaustAir': tr('T4 exhaust air', 'T4 Fortluft'),
    'temperatures.t3OutdoorAir': tr('T3 outdoor air', 'T3 Frischluft (außen)'),
    'temperatures.t5BeforeEvaporator': tr('T5 before evaporator', 'T5 vor Verdampfer'),
    'temperatures.t6Evaporator': tr('T6 evaporator', 'T6 Verdampfer'),
    'temperatures.t8AfterPreheater': tr('T8 after preheater', 'T8 nach Vorwärmung'),
    'temperatures.t12BeforeCondenser': tr('T12 before condenser', 'T12 vor Kondensator'),
    'temperatures.t10Condenser': tr('T10 condenser', 'T10 Kondensator'),
    'temperatures.t13Compressor': tr('T13 compressor', 'T13 Kompressor'),
    fans: tr('Fans', 'Lüfter'),
    'fans.speedSupply': tr('Fan speed supply air', 'Lüfterdrehzahl Zuluft'),
    'fans.speedExtract': tr('Fan speed extract air', 'Lüfterdrehzahl Abluft'),
    'fans.controlSupply': tr('Fan control supply air', 'Lüfteransteuerung Zuluft'),
    'fans.controlExtract': tr('Fan control extract air', 'Lüfteransteuerung Abluft'),
    'fans.curveSupplyLevel1': tr('Fan curve supply air level 1', 'Lüfterkennlinie Zuluft Stufe 1'),
    'fans.curveSupplyLevel2': tr('Fan curve supply air level 2', 'Lüfterkennlinie Zuluft Stufe 2'),
    'fans.curveSupplyLevel3': tr('Fan curve supply air level 3', 'Lüfterkennlinie Zuluft Stufe 3'),
    'fans.curveSupplyLevel4': tr('Fan curve supply air level 4', 'Lüfterkennlinie Zuluft Stufe 4'),
    'fans.curveExtractLevel1': tr('Fan curve extract air level 1', 'Lüfterkennlinie Abluft Stufe 1'),
    'fans.curveExtractLevel2': tr('Fan curve extract air level 2', 'Lüfterkennlinie Abluft Stufe 2'),
    'fans.curveExtractLevel3': tr('Fan curve extract air level 3', 'Lüfterkennlinie Abluft Stufe 3'),
    'fans.curveExtractLevel4': tr('Fan curve extract air level 4', 'Lüfterkennlinie Abluft Stufe 4'),
    'fans.levelActual': tr('Fan level (actual)', 'Lüfterstufe (Ist)'),
    'fans.levelTarget': tr('Fan level (target)', 'Lüfterstufe (Soll)'),
    'fans.intensiveVentilation': tr('Intensive ventilation', 'Intensivlüftung'),
    operation: tr('Operation', 'Betrieb'),
    'operation.heatPumpRequested': tr('Heat pump requested', 'Wärmepumpe angefordert'),
    'operation.heatPumpActive': tr('Heat pump active', 'Wärmepumpe aktiv'),
    'operation.mode': tr('Operating mode', 'Betriebsart'),
    'operation.referenceRoomTemperature': tr('Reference room temperature', 'Referenzraum Temperatur'),
    'operation.referenceRoomSetpoint': tr('Reference room setpoint', 'Referenzraum Sollwert'),
    'operation.bypassActive': tr('Bypass active', 'Bypass aktiv'),
    'operation.filterDaysLeft': tr('Filter: remaining days', 'Filter-Restlaufzeit'),
    'operation.coolingThreshold': tr('Cooling threshold', 'Kühlschwelle'),
    'operation.maxHeatingPower': tr('Maximum heating power', 'Maximale Heizleistung'),
    'operation.maxCoolingPower': tr('Maximum cooling power', 'Maximale Kühlleistung'),
    'operation.valveHeatCoolIndicator': tr('Valve heating/cooling (indicator)', 'Magnetventil Heizen/Kühlen (Anzeige)'),
    'operation.valveDefrostIndicator': tr('Valve defrost (indicator)', 'Magnetventil Abtauen (Anzeige)'),
    compressor: tr('Compressor', 'Kompressor'),
    'compressor.speed': tr('Compressor speed', 'Kompressordrehzahl'),
    device: tr('Device', 'Gerät'),
    'device.dateTime': tr('Date and time of the unit', 'Datum und Uhrzeit des Geräts'),
    'device.time': tr('Time of the unit', 'Uhrzeit des Geräts'),
    operatingHours: tr('Operating hours', 'Betriebsstunden'),
    'operatingHours.fanLevel1': tr('Operating hours fan level 1', 'Betriebsstunden Lüfterstufe 1'),
    'operatingHours.fanLevel2': tr('Operating hours fan level 2', 'Betriebsstunden Lüfterstufe 2'),
    'operatingHours.fanLevel3': tr('Operating hours fan level 3', 'Betriebsstunden Lüfterstufe 3'),
    'operatingHours.fanLevel4': tr('Operating hours fan level 4', 'Betriebsstunden Lüfterstufe 4'),
    'operatingHours.heatPumpHeating': tr('Operating hours heat pump heating', 'Betriebsstunden Wärmepumpe Heizen'),
    'operatingHours.heatPumpCooling': tr('Operating hours heat pump cooling', 'Betriebsstunden Wärmepumpe Kühlen'),
    'operatingHours.controller': tr('Operating hours controller', 'Betriebsstunden Steuerung'),
    'operatingHours.preheater': tr('Operating hours preheater', 'Betriebsstunden Vorheizung'),
    '/controlPanelRoom': tr('Room of the central control unit', 'Raum des zentralen Bedienelements'),
    '/controlPanelRoom.temperature': tr(
        'Temperature of the central control unit room',
        'Temperatur im Raum des zentralen Bedienelements',
    ),
    '/controlPanelRoom.setpoint': tr(
        'Setpoint of the central control unit room',
        'Sollwert im Raum des zentralen Bedienelements',
    ),
};

/**
 * Rename a path inside a module folder (or an absolute mapping name starting with "/")
 *
 * @param p path as used in a mapping name or object ID below the module folder
 */
export function renamePath(p: string): string {
    if (PATH_RENAMES[p]) {
        return PATH_RENAMES[p];
    }
    if (p.startsWith('/')) {
        return p;
    }
    const parts = p.split('.');
    const first = parts[0];
    if (SEGMENT_RENAMES[first]) {
        parts[0] = SEGMENT_RENAMES[first];
        if ((first === 'Meta' || first === 'Parameter') && parts.length === 2 && META_LEAF_RENAMES[parts[1]]) {
            parts[1] = META_LEAF_RENAMES[parts[1]];
        }
    }
    return parts.join('.');
}

/**
 * Rename a module name from the configuration (only the old defaults)
 *
 * @param name
 */
export function renameModule(name: string): string {
    if (MODULE_RENAMES[name]) {
        return MODULE_RENAMES[name];
    }
    const m = OLD_FALLBACK.exec(name);
    return m ? fallbackFolder(Number(m[1])) : name;
}

/**
 * Old object ID (relative to the instance) -> new ID; returns the input if nothing changes
 *
 * @param rel ID without "proxon-hesp.N."
 * @param folders old module folder -> new module folder (for all configured and unconfigured modules)
 */
export function migrateId(rel: string, folders: Map<string, string>): string {
    if (ROOT_RENAMES[rel]) {
        return ROOT_RENAMES[rel];
    }
    if (rel === 'info' || rel.startsWith('info.')) {
        return rel;
    }
    const dot = rel.indexOf('.');
    const head = dot < 0 ? rel : rel.slice(0, dot);
    const rest = dot < 0 ? '' : rel.slice(dot + 1);
    const folder = folders.get(head) ?? renameModule(head);
    if (folder === head && !folders.has(head) && !OLD_FALLBACK.test(head) && !MODULE_RENAMES[head]) {
        // not a module folder (e.g. a channel from an absolute mapping name)
        return rel;
    }
    return rest ? `${folder}.${renamePath(rest)}` : folder;
}
