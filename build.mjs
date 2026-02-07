/**
 * build.mjs – PolyPaste build pipeline
 *
 * 1. Bundles src/code.ts  → dist/code.js   (Figma sandbox)
 * 2. Bundles src/ui.ts    → dist/ui.js     (temporary)
 * 3. Reads   src/ui.html + src/ui.css
 * 4. Inlines CSS + JS into the HTML → dist/ui.html
 *
 * Usage:
 *   node build.mjs          # one-shot production build
 *   node build.mjs --watch  # rebuild on change
 */
import * as esbuild from 'esbuild';
import * as fs from 'fs';

const isWatch = process.argv.includes('--watch');

// ── Plugin controller (runs in Figma's main thread sandbox) ──
// Figma's sandbox uses a JS parser that lags behind V8.
// Target ES2017 to avoid optional catch binding, nullish coalescing, etc.
const codeCtx = await esbuild.context({
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  format: 'iife',
  target: 'es2017',
  sourcemap: false,
  minify: false,
});

// ── UI script (runs in the plugin iframe) ──
const uiCtx = await esbuild.context({
  entryPoints: ['src/ui.ts'],
  bundle: true,
  outfile: 'dist/ui.js',
  format: 'iife',
  target: 'es2020',
  sourcemap: false,
  minify: false,
});

/**
 * Inline CSS and JS into the HTML template and write dist/ui.html.
 */
async function buildUI() {
  await uiCtx.rebuild();

  const html = fs.readFileSync('src/ui.html', 'utf8');
  const css  = fs.readFileSync('src/ui.css', 'utf8');
  const js   = fs.readFileSync('dist/ui.js', 'utf8');

  const output = html
    .replace('/* __INLINE_CSS__ */', css)
    .replace('/* __INLINE_JS__ */', js);

  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync('dist/ui.html', output);
  console.log('✓ dist/ui.html');
}

async function buildAll() {
  await codeCtx.rebuild();
  console.log('✓ dist/code.js');
  await buildUI();
}

// ── Initial build ──
await buildAll();

// ── Watch mode ──
if (isWatch) {
  console.log('Watching src/ for changes…');
  const rebuild = async (_eventType, filename) => {
    if (!filename) return;
    if (!/\.(ts|html|css)$/.test(filename)) return;
    console.log(`\n⟳ ${filename} changed`);
    try { await buildAll(); }
    catch (e) { console.error('Build error:', e.message); }
  };
  fs.watch('src', { recursive: true }, rebuild);
  process.on('SIGINT', () => { codeCtx.dispose(); uiCtx.dispose(); process.exit(0); });
} else {
  await codeCtx.dispose();
  await uiCtx.dispose();
}
