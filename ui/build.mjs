// Static bundle build. The output is committed, so `npm install` is NOT required to RUN anything —
// node_modules never appears in a running process, and the acquisition path has zero dependencies of
// any kind, which is the claim that actually matters.
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
fs.mkdirSync(dist, { recursive: true });

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(here, 'src/main.tsx')],
  bundle: true,
  outfile: path.join(dist, 'bundle.js'),
  format: 'iife',
  target: ['es2022', 'safari16', 'chrome110'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

function buildCss() {
  execFileSync(
    path.join(here, '..', 'node_modules', '.bin', 'tailwindcss'),
    ['-i', path.join(here, 'src/styles.css'), '-o', path.join(dist, 'styles.css'), ...(watch ? [] : ['--minify'])],
    { stdio: 'inherit' }
  );
}

fs.copyFileSync(path.join(here, 'index.html'), path.join(dist, 'index.html'));
buildCss();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await esbuild.build(options);
  const size = fs.statSync(path.join(dist, 'bundle.js')).size;
  console.log(`bundle.js ${(size / 1024).toFixed(1)} KiB`);
}
