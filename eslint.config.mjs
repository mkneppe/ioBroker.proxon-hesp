import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: ['build/', 'admin/', 'tools/', 'test/**/*.js', '**/node_modules/', '*.config.mjs', '.dev-server/'],
    },
    {
        // node:test: test() liefert ein Promise, das der Runner selbst verwaltet
        files: ['test/**/*.ts'],
        rules: { '@typescript-eslint/no-floating-promises': 'off' },
    },
];
