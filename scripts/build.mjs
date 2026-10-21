import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
const root=resolve('.');
const output=resolve(root,'dist');
if(dirname(output)!==root || basename(output)!=='dist') throw new Error('Invalid output directory');
await build({ entryPoints: ['src/vendor.js'], bundle: true, minify: true, outfile: 'assets/supabase.js', platform: 'browser', target: ['es2022'], legalComments: 'eof' });
await rm(output,{recursive:true,force:true});
await mkdir('dist/assets', { recursive: true });
for (const file of ['index.html', 'app.js', 'styles.css', 'public-config.js', 'logo.png', 'manifest.json', 'assets/supabase.js']) {
  await copyFile(file, 'dist/' + file);
}
