import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '..');
const read = (relative: string) => readFileSync(join(repoRoot, relative), 'utf8');

const NON_ASCII = /[^\x00-\x7F]/;

describe('linker scripts stay terminal-safe', () => {
  it('install-link.ps1 contains only ASCII', () => {
    // Windows PowerShell 5.1 decodes a BOM-less .ps1 as Windows-1252, so any
    // UTF-8 character (an em dash, say) reaches the console as mojibake.
    const lines = read('scripts/install-link.ps1').split('\n');
    const offenders = lines
      .map((line, i) => ({ line, number: i + 1 }))
      .filter(({ line }) => NON_ASCII.test(line))
      .map(({ line, number }) => `${number}: ${line.trim()}`);
    expect(offenders, 'use ASCII (- instead of an em dash, ... instead of an ellipsis)').toEqual([]);
  });

  it('install-link.sh keeps non-ASCII to its glyph definitions', () => {
    // The box-drawing/status glyphs are deliberate and guarded by use_unicode;
    // everything else must be ASCII so non-UTF-8 terminals render it correctly.
    const offenders = read('scripts/install-link.sh')
      .split('\n')
      .map((line, i) => ({ line, number: i + 1 }))
      .filter(({ line }) => NON_ASCII.test(line) && !/^\s*(BX_|G_)[A-Z_]+=/.test(line))
      .map(({ line, number }) => `${number}: ${line.trim()}`);
    expect(offenders, 'move the glyph into init_style, or use ASCII').toEqual([]);
  });

  it('scripts use LF endings and no byte-order mark', () => {
    for (const file of ['scripts/install-link.sh', 'scripts/install-link.ps1', 'scripts/run-link.mjs']) {
      const raw = read(file);
      expect(raw.includes('\r'), `${file} must not contain CR characters`).toBe(false);
      expect(raw.charCodeAt(0), `${file} must not start with a BOM`).not.toBe(0xfeff);
    }
  });
});
