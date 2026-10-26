import {readFile,writeFile,readdir} from 'node:fs/promises';
const names=(await readdir('supabase/migrations')).filter(n=>/^\d+_security_hardening_\d+\.sql$/.test(n)).sort();
if(names.length!==7 || names.some((n,i)=>!n.endsWith('_'+String(i+1).padStart(2,'0')+'.sql'))) throw new Error('Expected security migrations 01 through 07');
const sections=await Promise.all(names.map(async n=>`-- ${n}\n${await readFile('supabase/migrations/'+n,'utf8')}`));
await writeFile('security/apply-security.sql','-- Generated from supabase/migrations; run as migration owner after backup.\nBEGIN;\n'+sections.join('\n\n')+'\nCOMMIT;\n');
await writeFile('security/remove-admin-mfa.sql','-- Incremental update: use only after security migrations 01 through 06.\nBEGIN;\n'+await readFile('supabase/migrations/'+names.at(-1),'utf8')+'\nCOMMIT;\n');
