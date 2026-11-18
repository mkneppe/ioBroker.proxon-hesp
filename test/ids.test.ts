import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { migrateId, NAMES, PATH_RENAMES, renameModule, renamePath } from '../src/lib/ids';

const folders = new Map([
    ['Zentrale', 'unit'],
    ['Raum_10', 'room10'],
    ['Diele', 'Diele'],
    ['Luftqualitaet', 'Luftqualitaet'],
    ['Modul_1', 'module1'],
]);

test('migration: module names from the old default configuration', () => {
    assert.equal(renameModule('Zentrale'), 'unit');
    assert.equal(renameModule('Raum_12'), 'room12');
    assert.equal(renameModule('Teilnehmer_40'), 'node40');
    assert.equal(renameModule('Modul_7'), 'module7');
    assert.equal(renameModule('Diele'), 'Diele'); // user-defined name stays
});

test('migration: mapping names', () => {
    assert.equal(renamePath('Temperaturen.T1_Zuluft'), 'temperatures.t1SupplyAir');
    assert.equal(renamePath('/Wohnen.Temperatur'), '/controlPanelRoom.temperature');
    assert.equal(renamePath('Temperatur'), 'temperature');
    assert.equal(renamePath('Betrieb.Eigener_Wert'), 'operation.Eigener_Wert'); // user mapping in a default channel
    assert.equal(renamePath('Heizelement_an'), 'Heizelement_an'); // user-defined
});

test('migration: object IDs', () => {
    const m = (id: string): string => migrateId(id, folders);
    assert.equal(m('Zentrale'), 'unit');
    assert.equal(m('Zentrale.Temperaturen'), 'unit.temperatures');
    assert.equal(m('Zentrale.Temperaturen.T3_Frischluft'), 'unit.temperatures.t3OutdoorAir');
    assert.equal(m('Zentrale.Geraet.Uhr_stellen'), 'unit.device.setClock');
    assert.equal(m('Zentrale.Register.R_971.value'), 'unit.registers.R_971.value');
    assert.equal(m('Zentrale.Parameter.DP_022D'), 'unit.parameters.DP_022D');
    assert.equal(m('Zentrale.Parameter.Verzeichnis'), 'unit.parameters.directory');
    assert.equal(m('Diele.Temperatur'), 'Diele.temperature');
    assert.equal(m('Diele.Sollwert'), 'Diele.setpoint');
    assert.equal(m('Diele.Heizelement_freigeben'), 'Diele.heaterEnable');
    assert.equal(m('Diele.Meta.Name_raw'), 'Diele.meta.nameRaw');
    assert.equal(m('Diele.Meta.DPListe'), 'Diele.meta.dpList');
    assert.equal(m('Raum_10.Tastensperre'), 'room10.keyLock');
    assert.equal(m('Luftqualitaet.CO2'), 'Luftqualitaet.co2');
    assert.equal(m('Modul_1.Register.W_408.raw'), 'module1.registers.W_408.raw');
    assert.equal(m('Wohnen'), 'controlPanelRoom');
    assert.equal(m('Wohnen.Temperatur'), 'controlPanelRoom.temperature');
    assert.equal(m('Parameter_lesen'), 'paramRead.start');
    assert.equal(m('Parameter_lesen_Fortschritt'), 'paramRead.progress');
    assert.equal(m('info.connection'), 'info.connection');
    // already migrated IDs stay unchanged
    for (const id of [
        'unit.temperatures.t1SupplyAir',
        'Diele.setpoint',
        'module1.registers.R_1.value',
        'paramRead.start',
    ]) {
        assert.equal(
            migrateId(
                id,
                new Map([
                    ['unit', 'unit'],
                    ['Diele', 'Diele'],
                    ['module1', 'module1'],
                ]),
            ),
            id,
        );
    }
});

test('default mappings: names are English and translated', () => {
    const io = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'io-package.json'), 'utf8')) as {
        native: { mappings: { name: string }[]; modules: { name: string }[] };
    };
    const renamed = new Set(Object.values(PATH_RENAMES));
    for (const m of io.native.mappings) {
        assert.ok(renamed.has(m.name), `default mapping ${m.name} missing in the rename table`);
        assert.ok(NAMES[m.name], `default mapping ${m.name} has no translated name`);
        assert.match(m.name, /^\/?[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/);
    }
    for (const m of io.native.modules) {
        assert.match(m.name, /^[a-z][A-Za-z0-9]*$/);
    }
});
