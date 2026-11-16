const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Validiert package.json und io-package.json
tests.packageFiles(path.join(__dirname, '..'));
