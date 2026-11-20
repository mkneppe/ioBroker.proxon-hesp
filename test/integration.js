const path = require('node:path');
const { expect } = require('chai');
const { tests } = require('@iobroker/testing');

const NS = 'proxon-hesp.0';
const wait = ms => new Promise(r => setTimeout(r, ms));

/** settings that let the adapter start without a gateway (it waits for an incoming connection) */
const base = { connType: 'tcpserver', bind: '127.0.0.1', port: 40502, storeRegisters: false, learnLog: false };

// Startet den Adapter in einer Test-Instanz von js-controller (ohne Gateway: er darf nicht abstürzen)
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('write option disabled', getHarness => {
            it('keeps a writable state with custom settings (read-only) and removes the others', async function () {
                this.timeout(60000);
                const harness = getHarness();
                const state = custom => ({
                    type: 'state',
                    common: { name: 'Setpoint', type: 'number', role: 'level.temperature', read: true, write: true, custom },
                    native: {},
                });
                await harness.objects.setObjectAsync(`${NS}.room10.setpoint`, state({ 'history.0': { enabled: true } }));
                await harness.objects.setObjectAsync(`${NS}.room11.setpoint`, state(undefined));
                await harness.changeAdapterConfig(harness.adapterName, {
                    native: { ...base, allowWrite: false },
                });
                await harness.startAdapterAndWait();
                await wait(3000);

                const kept = await harness.objects.getObjectAsync(`${NS}.room10.setpoint`);
                expect(kept, 'object with custom settings').to.be.ok;
                expect(kept.common.write).to.equal(false);
                expect(kept.common.custom).to.have.property('history.0');
                expect(await harness.objects.getObjectAsync(`${NS}.room11.setpoint`)).to.not.be.ok;
            });
        });

        suite('duplicate module names', getHarness => {
            it('uses the fallback folder for a name that is already used (case-insensitive)', async function () {
                this.timeout(60000);
                const harness = getHarness();
                await harness.changeAdapterConfig(harness.adapterName, {
                    native: {
                        ...base,
                        allowWrite: true,
                        controlModules: '10,11',
                        modules: [
                            { address: 2, name: 'unit' },
                            { address: 10, name: 'Room' },
                            { address: 11, name: 'room' },
                        ],
                    },
                });
                await harness.startAdapterAndWait();
                await wait(3000);

                expect(await harness.objects.getObjectAsync(`${NS}.Room.setpoint`)).to.be.ok;
                expect(await harness.objects.getObjectAsync(`${NS}.module11.setpoint`)).to.be.ok;
                expect(await harness.objects.getObjectAsync(`${NS}.room.setpoint`)).to.not.be.ok;
            });
        });
    },
});
