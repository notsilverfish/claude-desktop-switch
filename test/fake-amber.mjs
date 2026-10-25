// A stand-in for the amber CLI in tests: "snapshots" are folder copies under FAKE_AMBER_STORE.
//   --version | backup <dir> | list [project] | restore <project|id> <dir> [--no-git]
import fs from 'node:fs';
import path from 'node:path';

const store = process.env.FAKE_AMBER_STORE;
const [cmd, ...args] = process.argv.slice(2);
const snapshots = () => (fs.existsSync(store) ? fs.readdirSync(store).sort() : []);

if (cmd === '--version') {
  console.log('0.9.0');
} else if (cmd === 'backup') {
  const dir = args[0];
  const name = JSON.parse(fs.readFileSync(path.join(dir, '.amber.json'), 'utf8')).name;
  const id = `s${String(snapshots().length + 1).padStart(4, '0')}`;
  fs.cpSync(dir, path.join(store, `${id}__${name}`), { recursive: true });
  console.error(`  ✓ Backed up ${name} (${id})`);
} else if (cmd === 'list') {
  console.log('ID            PROJECT              PACKED            FILES');
  for (const s of snapshots().reverse()) {
    const [id, name] = s.split('__');
    if (!args[0] || args[0] === name) console.log(`${id.padEnd(12)}  ${name.padEnd(19)}  2026-10-25 12:00  1 MB`);
  }
} else if (cmd === 'restore') {
  const [target, dir] = args;
  const match = snapshots().reverse().find((s) => s.startsWith(`${target}__`) || s.endsWith(`__${target}`));
  if (!match) {
    console.error(`No snapshot of ${target}`);
    process.exit(1);
  }
  fs.cpSync(path.join(store, match), dir, { recursive: true });
} else {
  console.error(`fake amber: unknown command ${cmd}`);
  process.exit(2);
}
