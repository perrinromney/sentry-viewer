import { describe, expect, it } from 'vitest';
import {
  candidateFrames,
  IndexedFile,
  normalizeFramePath,
  resolveEventLocations,
  resolveFrame,
} from '../src/code/frameResolver';
import type { SentryEvent } from '../src/sentry/types';

function indexed(...relativePaths: string[]): IndexedFile[] {
  return relativePaths.map((p) => ({ fsPath: `/repo/${p}`, segments: p.toLowerCase().split('/') }));
}

describe('normalizeFramePath', () => {
  it('strips leading ../ sequences (real audit data)', () => {
    expect(normalizeFramePath('../../src/components/shared/ScheduleVarianceModal.vue')).toBe(
      'src/components/shared/ScheduleVarianceModal.vue',
    );
  });

  it('takes the pathname from absolute URLs', () => {
    expect(normalizeFramePath('https://allucent-prod.web.app/src/components/Foo.vue')).toBe('src/components/Foo.vue');
  });

  it('rejects minified asset bundles', () => {
    expect(normalizeFramePath('/assets/ByCu493P.js')).toBeUndefined();
    expect(normalizeFramePath('https://allucent-prod.web.app/assets/ByCu493P.js')).toBeUndefined();
  });

  it('rejects node_modules frames', () => {
    expect(normalizeFramePath('../../node_modules/splitpanes/dist/splitpanes.es.js')).toBeUndefined();
  });

  it('rejects extension-less paths', () => {
    expect(normalizeFramePath('<anonymous>')).toBeUndefined();
  });

  it('strips webpack prefixes and query strings', () => {
    expect(normalizeFramePath('webpack:///./src/app.ts?abc')).toBe('src/app.ts');
    expect(normalizeFramePath('webpack-internal:///src/main.js')).toBe('src/main.js');
  });

  it('applies path mappings by longest prefix', () => {
    expect(normalizeFramePath('src/app.ts', { 'src/': 'packages/web/src/' })).toBe('packages/web/src/app.ts');
  });
});

describe('resolveFrame', () => {
  const frame = { filename: '../../src/components/shared/ScheduleVarianceModal.vue', lineNo: 136, colNo: 10, inApp: true };

  it('matches a monorepo-nested file by trailing segments', () => {
    const index = indexed('allucent/src/components/shared/ScheduleVarianceModal.vue', 'allucent/src/other/File.vue');
    const resolved = resolveFrame(frame, index);
    expect(resolved?.fsPath).toBe('/repo/allucent/src/components/shared/ScheduleVarianceModal.vue');
    expect(resolved?.line).toBe(135); // 0-based
    expect(resolved?.column).toBe(9);
  });

  it('requires at least two matching trailing segments for multi-segment frames', () => {
    const index = indexed('elsewhere/ScheduleVarianceModal.vue');
    expect(resolveFrame(frame, index)).toBeUndefined();
  });

  it('prefers the deepest suffix match, then the shortest path', () => {
    const index = indexed(
      'app/src/components/shared/ScheduleVarianceModal.vue',
      'legacy/old/components/shared/ScheduleVarianceModal.vue',
    );
    expect(resolveFrame(frame, index)?.fsPath).toBe('/repo/app/src/components/shared/ScheduleVarianceModal.vue');
  });

  it('rejects ambiguous bare-filename frames', () => {
    const bare = { filename: 'util.ts', lineNo: 3 };
    const index = indexed('a/util.ts', 'b/util.ts');
    expect(resolveFrame(bare, index)).toBeUndefined();
    expect(resolveFrame(bare, indexed('a/util.ts'))?.fsPath).toBe('/repo/a/util.ts');
  });

  it('is case-insensitive on segments', () => {
    const index = indexed('src/Components/Shared/schedulevariancemodal.vue');
    expect(resolveFrame(frame, index)).toBeDefined();
  });
});

describe('candidateFrames / resolveEventLocations', () => {
  const event: SentryEvent = {
    id: 'e1',
    eventID: 'e1',
    entries: [
      {
        type: 'exception',
        data: {
          values: [
            {
              stacktrace: {
                frames: [
                  { filename: '../../node_modules/lib/outer.js', lineNo: 1, inApp: false },
                  { filename: '../../src/store/session.ts', lineNo: 20, inApp: true },
                  { filename: '../../src/components/Deep.vue', lineNo: 42, inApp: true },
                ],
              },
            },
          ],
        },
      },
    ],
  };

  it('orders innermost first and in-app before library frames', () => {
    const frames = candidateFrames(event);
    expect(frames[0].filename).toContain('Deep.vue');
    expect(frames[frames.length - 1].inApp).toBe(false);
  });

  it('resolves and dedupes locations', () => {
    const index = indexed('src/components/Deep.vue', 'src/store/session.ts');
    const locations = resolveEventLocations(event, index);
    expect(locations).toHaveLength(2);
    expect(locations[0].fsPath).toBe('/repo/src/components/Deep.vue');
    expect(locations[0].line).toBe(41);
  });

  it('returns [] when nothing resolves (minified-only event)', () => {
    const minified: SentryEvent = {
      id: 'e2',
      eventID: 'e2',
      entries: [
        {
          type: 'exception',
          data: { values: [{ stacktrace: { frames: [{ filename: '/assets/ByCu493P.js', lineNo: 228 }] } }] },
        },
      ],
    };
    expect(resolveEventLocations(minified, indexed('src/a.ts'))).toHaveLength(0);
  });
});
