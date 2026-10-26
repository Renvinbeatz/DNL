import {readFile,writeFile,readdir} from 'node:fs/promises';
const names=(await readdir('supabase/migrations')).filter(n=>/^\d+_admin_finances\.sql$/.test(n));
if(names.length!==1) throw new Error('Expected one admin_finances migration');
await writeFile('supabase/enable-admin-finances.sql',
  '-- Generated from '+names[0]+'. Requires existing security migrations 01-07.\n'+
  '-- Apply once as migration owner. Creates private finance data; does not alter historical results.\nBEGIN;\n'+
  await readFile('supabase/migrations/'+names[0],'utf8')+'\nCOMMIT;\n');
