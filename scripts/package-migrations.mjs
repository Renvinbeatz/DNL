import {readFile,writeFile,readdir} from 'node:fs/promises';
const names=(await readdir('supabase/migrations')).filter(n=>/^\d+_security_hardening_\d+\.sql$/.test(n)).sort();
if(names.length!==8 || names.some((n,i)=>!n.endsWith('_'+String(i+1).padStart(2,'0')+'.sql'))) throw new Error('Expected security migrations 01 through 08');
const sections=await Promise.all(names.map(async n=>`-- ${n}\n${await readFile('supabase/migrations/'+n,'utf8')}`));
await writeFile('security/apply-security.sql','-- Generated from supabase/migrations; run as migration owner after backup.\nBEGIN;\n'+sections.join('\n\n')+'\nCOMMIT;\n');
await writeFile('security/remove-admin-mfa.sql','-- Incremental update: use only after security migrations 01 through 06.\nBEGIN;\n'+await readFile('supabase/migrations/'+names.find(n=>n.endsWith('_07.sql')),'utf8')+'\nCOMMIT;\n');
await writeFile('security/audit-fixes-2026-10-26.sql','-- Incremental audit fixes: use only after security migrations 01 through 07.\n-- Publish the updated frontend first; it is compatible with both database versions.\nBEGIN;\n'+await readFile('supabase/migrations/'+names.find(n=>n.endsWith('_08.sql')),'utf8')+'\nCOMMIT;\n');
