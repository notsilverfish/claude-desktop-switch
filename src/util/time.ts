import { CdsError } from '../errors.js';

// "7d", "12h", "2w" or a date.
export function parseSince(value: string): Date {
  const m = /^(\d+)\s*([hdw])$/i.exec(value.trim());
  if (m) {
    const hours = Number(m[1]) * { h: 1, d: 24, w: 168 }[m[2]!.toLowerCase() as 'h' | 'd' | 'w'];
    return new Date(Date.now() - hours * 3600_000);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new CdsError(`Invalid --since value "${value}".`, 'Use e.g. 7d, 24h, 2w or 2026-09-01.');
  return d;
}
