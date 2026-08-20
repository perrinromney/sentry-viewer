import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const contexts = await Promise.all([
  esbuild.context({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
    minify: !watch,
  }),
  esbuild.context({
    entryPoints: ['src/webview/main.ts', 'src/webview/settings.ts', 'src/webview/filters.ts'],
    outdir: 'dist/webview',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: true,
    minify: !watch,
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[esbuild] watching…');
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  console.log('[esbuild] build complete');
}
