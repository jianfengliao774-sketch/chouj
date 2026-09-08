import { build } from 'vite';
import path from 'node:path';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const SITE=path.dirname(fileURLToPath(import.meta.url));
import { playerPageHtml } from './player-page-template.mjs';
import { drawGuideHtml, currentDeploymentEvidence } from './draw-guide-page.mjs';

await build({ configFile: false, root: path.join(SITE, 'web'), logLevel: 'warn',
  plugins: [{ name: 'shared-player-pages', transformIndexHtml: { order: 'pre', handler(html, context) {
    if (context.path === '/draw-guide.html') return drawGuideHtml(html);
    if (!['/index.html', '/burns.html'].includes(context.path)) return html;
    return playerPageHtml(readFileSync(path.join(SITE, 'web/index.html'), 'utf8'),
      readFileSync(path.join(SITE, 'web/burns.html'), 'utf8'), context.path === '/burns.html');
  } }, generateBundle(){this.emitFile({type:'asset',fileName:'sparkdraw/current-contracts.json',source:currentDeploymentEvidence()});} }],
  build: { outDir: path.join(SITE, 'dist'), emptyOutDir: true, sourcemap: false, target: 'es2022',
    rollupOptions: { input: { index: path.join(SITE, 'web/index.html'), admin: path.join(SITE, 'web/admin.html'),
      burns: path.join(SITE, 'web/burns.html'),
      drawGuide: path.join(SITE, 'web/draw-guide.html'),
 } } } });
// Nginx can send these precompressed public assets without recompressing each visit.
const assets = path.join(SITE, 'dist/assets');
for (const name of readdirSync(assets)) {
  if (!/\.(js|css|svg)$/.test(name)) continue;
  const bytes = readFileSync(path.join(assets, name));
  const compressed = gzipSync(bytes, { level: 6 });
  if (compressed.length < bytes.length) writeFileSync(path.join(assets, name + '.gz'), compressed);
}
console.log('Built independent mainnet player website with precompressed assets. No wallets or transactions used.');
