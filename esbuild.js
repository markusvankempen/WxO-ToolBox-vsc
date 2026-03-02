const esbuild = require('esbuild');
const path = require('path');

esbuild.build({
  entryPoints: [path.join(__dirname, 'src/extension.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'dist/extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
}).catch(() => process.exit(1));
