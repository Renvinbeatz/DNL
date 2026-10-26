import {readFile,writeFile,readdir} from 'node:fs/promises';
const names=(await readdir('supabase/migrations')).filter(n=>/^\d+_(admin_finances|finance_entries)\.sql$/.test(n)).sort();
if(names.length!==2) throw new Error('Expected admin_finances and finance_entries migrations');
const sources=await Promise.all(names.map(n=>readFile('supabase/migrations/'+n,'utf8')));
await writeFile('supabase/enable-admin-finances.sql',
  '-- Generated from finance migrations. Requires existing security migrations 01-07.\n'+
  '-- Apply once as migration owner. Creates private finance data; does not alter historical results.\nBEGIN;\n'+
  sources.join('\n\n')+'\nCOMMIT;\n');
await writeFile('supabase/update-finance-entries.sql',
  '-- Incremental update: requires admin_finances already applied. Apply once as migration owner.\nBEGIN;\n'+sources[1]+'\nCOMMIT;\n');
