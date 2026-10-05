// Bundles the CLI into one file, dist/claude-switch.mjs, so installing it pulls in no
// dependencies. The version is baked in so the bundle never needs package.json.
import { readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/claude-switch.mjs',
  define: { 'process.env.CDS_VERSION': JSON.stringify(version) },
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __cdsRequire } from "node:module";\nconst require = __cdsRequire(import.meta.url);',
  },
  legalComments: 'none',
});
console.log(`built dist/claude-switch.mjs (v${version})`);
