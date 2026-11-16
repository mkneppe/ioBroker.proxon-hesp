const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Startet den Adapter in einer Test-Instanz von js-controller (ohne Gateway: er darf nicht abstürzen)
tests.integration(path.join(__dirname, '..'));
