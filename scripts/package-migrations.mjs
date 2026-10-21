import {readFile,writeFile,readdir} from 'node:fs/promises';
const names=(await readdir('supabase/migrations')).filter(n=>/^\d+_security_hardening_\d+\.sql$/.test(n)).sort();
if(names.length!==6) throw new Error('Expected all six security migrations');
const sections=await Promise.all(names.map(async n=>`-- ${n}\n${await readFile('supabase/migrations/'+n,'utf8')}`));
await writeFile('security/apply-security.sql','-- Generated from supabase/migrations; run as migration owner after backup.\nBEGIN;\n'+sections.join('\n\n')+'\nCOMMIT;\n');
