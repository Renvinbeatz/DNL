import {readFile,writeFile,readdir} from 'node:fs/promises';
const names=(await readdir('supabase/migrations')).filter(n=>/^\d+_(admin_finances|finance_entries|admin_reports_reversals)\.sql$/.test(n)).sort();
if(names.length!==3) throw new Error('Expected three finance/admin migrations');
const sources=await Promise.all(names.map(n=>readFile('supabase/migrations/'+n,'utf8')));
await writeFile('supabase/enable-admin-finances.sql',
  '-- Generated from finance migrations. Requires existing security migrations 01-07.\n'+
  '-- Apply once as migration owner. Creates private finance data; does not alter historical results.\nBEGIN;\n'+
  sources.join('\n\n')+'\nCOMMIT;\n');
await writeFile('supabase/update-finance-entries.sql',
  '-- Incremental update: requires admin_finances already applied. Apply once as migration owner.\nBEGIN;\n'+sources[1]+'\n'+sources[2]+'\nCOMMIT;\n');
await writeFile('supabase/update-admin-reports.sql','-- Requires both previous finance migrations. Apply once as owner.\nBEGIN;\n'+sources[2]+'\nCOMMIT;\n');
