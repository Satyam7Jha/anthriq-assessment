// Builds the viewer into ui/dist. The output is committed, so running the system needs no install.

import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const dist = path.join(here, 'dist');
const watch = process.argv.includes('--watch');
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(here, 'index.html'), path.join(dist, 'index.html'));

execFileSync(path.join(here, '..', 'node_modules', '.bin', 'tailwindcss'), ['-i', path.join(here, 'src/styles.css'), '-o', path.join(dist, 'styles.css'), ...(watch ? [] : ['--minify'])], { stdio: 'inherit' });

const options: esbuild.BuildOptions = {
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

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
