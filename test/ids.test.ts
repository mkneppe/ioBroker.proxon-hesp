import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { migrateId, NAMES, PATH_RENAMES, renameModule, renamePath, tr } from '../src/lib/ids';
import { I18N, OTHER_LANGS } from '../src/lib/i18n';

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

test('names: every tr() text has translations with the same placeholders', () => {
    const src = ['main.ts', 'lib/ids.ts', 'lib/params.ts'].map(f =>
        fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8'),
    );
    const lit = /\btr\(\s*'((?:[^'\\]|\\.)*)'/g;
    const keys = new Set<string>();
    for (const s of src) {
        for (const m of s.matchAll(lit)) {
            keys.add(m[1].replace(/\\'/g, "'"));
        }
    }
    assert.ok(keys.size > 100, `only ${keys.size} texts found`);
    const ph = (s: string): string =>
        [...s.matchAll(/\{\d+\}/g)]
            .map(m => m[0])
            .sort()
            .join();
    for (const en of keys) {
        const row = I18N[en];
        assert.ok(row, `missing translation: ${en}`);
        assert.equal(row.length, OTHER_LANGS.length, en);
        for (const t of row) {
            assert.ok(t.trim(), `empty translation: ${en}`);
            assert.equal(ph(t), ph(en), `placeholders differ: ${en} -> ${t}`);
        }
    }
    for (const en of Object.keys(I18N)) {
        assert.ok(keys.has(en) || en === 'Information', `unused translation: ${en}`);
    }
});

test('names: tr() fills all languages and nested names', () => {
    const inner = tr('T1 supply air', 'T1 Zuluft');
    const n = tr('{0} – last seen', '{0} – zuletzt gesehen', inner);
    assert.deepEqual(Object.keys(n).sort(), ['de', 'en', ...OTHER_LANGS].sort());
    assert.equal(n.en, 'T1 supply air – last seen');
    assert.equal(n.de, 'T1 Zuluft – zuletzt gesehen');
    assert.equal(n.fr, 'T1 air soufflé – vu pour la dernière fois');
    const m = tr('{0} (bus address {1})', '{0} (Busadresse {1})', 'room10', 10);
    assert.equal(m['zh-cn'], 'room10（总线地址 10）');
});
