import { build } from 'vite';
import path from 'node:path';
import { SITE } from './config.mjs';

await build({ configFile: false, root: path.join(SITE, 'web'), logLevel: 'warn',
  build: { outDir: path.join(SITE, 'dist'), emptyOutDir: true, sourcemap: false, target: 'es2022',
    rollupOptions: { input: { index: path.join(SITE, 'web/index.html'), admin: path.join(SITE, 'web/admin.html') } } } });
console.log('Built independent mainnet player website. No wallets or transactions used.');
