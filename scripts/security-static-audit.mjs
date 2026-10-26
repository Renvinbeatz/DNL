// Offline heuristic secret scan. Reports locations and kinds, never matched values.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const git=(...args)=>execFileSync('git',args,{maxBuffer:32*1024*1024});
const rules=[
 ['Supabase secret key',/sb_secret_[A-Za-z0-9_-]{16,}/g],
 ['Supabase management token',/sbp_[a-zA-Z0-9]{30,}/g],
 ['GitHub access token',/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
 ['AWS access key',/AKIA[0-9A-Z]{16}/g],
 ['Private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
 ['Database URL with password',/postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/g]
];
const result={at:new Date().toISOString(),workingFiles:0,historyBlobs:0,skippedBinaryOrLarge:0,findings:[],limits:'Heuristic patterns; does not prove absence of every secret. No credential values are recorded.'};
function scan(bytes,location){
 if(bytes.length>2*1024*1024 || bytes.includes(0)){result.skippedBinaryOrLarge++;return;}
 const text=bytes.toString('utf8');
 for(const [kind,pattern]of rules){pattern.lastIndex=0;if(pattern.test(text))result.findings.push({location,kind});}
 for(const jwt of text.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)||[]){
  try{if(JSON.parse(Buffer.from(jwt.split('.')[1],'base64url')).role==='service_role')result.findings.push({location,kind:'Privileged service_role JWT'});}catch{}
 }
}
for(const file of git('ls-files','-z').toString().split('\0').filter(Boolean)){scan(await readFile(file),file);result.workingFiles++;}
const objects=git('rev-list','--objects','--all').toString().trim().split('\n').map(line=>line.split(' ')[0]);
const batch=execFileSync('git',['cat-file','--batch'],{input:objects.join('\n')+'\n',maxBuffer:32*1024*1024});
let offset=0;
while(offset<batch.length){
 const end=batch.indexOf(10,offset);if(end<0)break;
 const [hash,type,sizeText]=batch.subarray(offset,end).toString().split(' ');const size=Number(sizeText);
 if(!Number.isFinite(size))break;
 const bytes=batch.subarray(end+1,end+1+size);offset=end+size+2;
 if(type==='blob'){scan(bytes,'git-blob:'+hash);result.historyBlobs++;}
}
const allow=['app.js','assets/supabase.js','index.html','logo.png','manifest.json','public-config.js','styles.css'];
const files=(await readdir('dist',{recursive:true,withFileTypes:true})).filter(x=>x.isFile()).map(x=>path.relative('dist',path.join(x.parentPath,x.name)).replaceAll('\\','/')).sort();
result.distFiles=files;result.distAllowlistOnly=JSON.stringify(files)===JSON.stringify(allow.sort());
await writeFile('security/audit-static-2026-10-26.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
