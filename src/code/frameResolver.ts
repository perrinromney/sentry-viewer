import type { Frame, SentryEvent } from '../sentry/types';

/** A workspace file prepared for suffix matching (segments lowercased). */
export interface IndexedFile {
  fsPath: string;
  /** Path relative to its workspace folder, split on '/'. */
  segments: string[];
}

export interface ResolvedLocation {
  fsPath: string;
  /** 0-based. */
  line: number;
  column: number;
  score: number;
  frame: Frame;
}

/**
 * Normalize a Sentry stack-frame path into repo-relative segments, or return
 * undefined for frames that can never match source (minified bundles,
 * node_modules, extension-less paths).
 */
export function normalizeFramePath(raw: string | null | undefined, pathMappings: Record<string, string> = {}): string | undefined {
  if (!raw) return undefined;
  let p = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return undefined;
    }
  }
  p = p.replace(/[?#].*$/, '');
  p = p.replace(/^webpack-internal:\/{3}/, '').replace(/^webpack:\/{2}/, '');
  p = p.replace(/^~\//, '');
  while (p.startsWith('./') || p.startsWith('../') || p.startsWith('/')) {
    if (p.startsWith('./')) p = p.slice(2);
    else if (p.startsWith('../')) p = p.slice(3);
    else p = p.slice(1);
  }
  if (!p) return undefined;

  for (const [prefix, replacement] of Object.entries(pathMappings).sort((a, b) => b[0].length - a[0].length)) {
    const cleanPrefix = prefix.replace(/^\.?\//, '');
    if (p.startsWith(cleanPrefix)) {
      p = replacement.replace(/^\.?\//, '').replace(/\/$/, '') + '/' + p.slice(cleanPrefix.length).replace(/^\//, '');
      break;
    }
  }

  if (p.includes('node_modules/')) return undefined;
  if (/^assets\/[\w.-]+\.js$/.test(p)) return undefined; // minified bundle, no sourcemap
  const last = p.split('/').pop() ?? '';
  if (!last.includes('.')) return undefined;
  return p;
}

/** Extract exception frames from an event, innermost first, in-app before library frames. */
export function candidateFrames(event: SentryEvent): Frame[] {
  const frames: Frame[] = [];
  for (const entry of event.entries ?? []) {
    if (entry.type !== 'exception') continue;
    const values = (entry.data as { values?: { stacktrace?: { frames?: Frame[] } | null }[] }).values ?? [];
    for (const value of values) {
      // Sentry orders frames outermost→innermost; we want innermost first.
      frames.push(...[...(value.stacktrace?.frames ?? [])].reverse());
    }
  }
  const inApp = frames.filter((f) => f.inApp);
  const rest = frames.filter((f) => !f.inApp);
  return [...inApp, ...rest];
}

function suffixScore(frameSegments: string[], fileSegments: string[]): number {
  let score = 0;
  let fi = frameSegments.length - 1;
  let si = fileSegments.length - 1;
  while (fi >= 0 && si >= 0 && frameSegments[fi] === fileSegments[si]) {
    score++;
    fi--;
    si--;
  }
  return score;
}

/**
 * Resolve one frame against the workspace index. Requires at least 2 trailing
 * segments to match, unless the frame path is a bare filename (score 1 accepted,
 * but only when the match is unambiguous).
 */
export function resolveFrame(
  frame: Frame,
  index: IndexedFile[],
  pathMappings: Record<string, string> = {},
): ResolvedLocation | undefined {
  const normalized = normalizeFramePath(frame.filename ?? frame.absPath, pathMappings);
  if (!normalized) return undefined;
  const frameSegments = normalized.toLowerCase().split('/');
  const minScore = frameSegments.length === 1 ? 1 : 2;

  let best: { file: IndexedFile; score: number }[] = [];
  let bestScore = 0;
  for (const file of index) {
    if (file.segments[file.segments.length - 1] !== frameSegments[frameSegments.length - 1]) continue;
    const score = suffixScore(frameSegments, file.segments);
    if (score > bestScore) {
      bestScore = score;
      best = [{ file, score }];
    } else if (score === bestScore && score > 0) {
      best.push({ file, score });
    }
  }
  if (bestScore < minScore || best.length === 0) return undefined;
  if (frameSegments.length === 1 && best.length > 1) return undefined; // bare filename, ambiguous

  best.sort((a, b) => a.file.segments.length - b.file.segments.length || a.file.fsPath.localeCompare(b.file.fsPath));
  const chosen = best[0];
  return {
    fsPath: chosen.file.fsPath,
    line: Math.max(0, (frame.lineNo ?? 1) - 1),
    column: Math.max(0, (frame.colNo ?? 1) - 1),
    score: chosen.score,
    frame,
  };
}

/** Resolve the best locations for an event, deduplicated by file+line, best score first. */
export function resolveEventLocations(
  event: SentryEvent,
  index: IndexedFile[],
  pathMappings: Record<string, string> = {},
  limit = 3,
): ResolvedLocation[] {
  const seen = new Set<string>();
  const results: ResolvedLocation[] = [];
  for (const frame of candidateFrames(event)) {
    const resolved = resolveFrame(frame, index, pathMappings);
    if (!resolved) continue;
    const key = `${resolved.fsPath}:${resolved.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(resolved);
    if (results.length >= limit) break;
  }
  return results;
}
