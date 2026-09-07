import { build } from 'vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const SITE=path.dirname(fileURLToPath(import.meta.url));
import { playerPageHtml } from './player-page-template.mjs';

await build({ configFile: false, root: path.join(SITE, 'web'), logLevel: 'warn',
  plugins: [{ name: 'shared-player-pages', transformIndexHtml: { order: 'pre', handler(html, context) {
    if (!['/index.html', '/burns.html'].includes(context.path)) return html;
    return playerPageHtml(readFileSync(path.join(SITE, 'web/index.html'), 'utf8'),
      readFileSync(path.join(SITE, 'web/burns.html'), 'utf8'), context.path === '/burns.html');
  } } }],
  build: { outDir: path.join(SITE, 'dist'), emptyOutDir: true, sourcemap: false, target: 'es2022',
    rollupOptions: { input: { index: path.join(SITE, 'web/index.html'), admin: path.join(SITE, 'web/admin.html'),
      burns: path.join(SITE, 'web/burns.html'),
      deploySparkDraw: path.join(SITE, 'web/deploy-sparkdraw.html'),
 } } } });
console.log('Built independent mainnet player website. No wallets or transactions used.');
