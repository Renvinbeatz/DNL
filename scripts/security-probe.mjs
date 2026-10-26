// Bounded, read-only checks against the owner's two explicit public origins.
// Never logs response records, credentials, session tokens or message contents.
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const site='https://novaleague.vercel.app';
const api='https://aqvyehkrbjttvdirtjzd.supabase.co';
const config=await readFile('public-config.js','utf8');
const key=config.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
if(!key) throw Error('Missing public client key');
const sourceOnly=process.argv.includes('--source-only');
const report={at:new Date().toISOString(),scope:sourceOnly?[site]:[site,api],baselineRevision:execFileSync('git',['rev-parse','HEAD']).toString().trim(),checks:[]};
const headersToKeep=['content-security-policy','x-frame-options','x-content-type-options','referrer-policy','strict-transport-security','permissions-policy','cache-control','access-control-allow-origin','access-control-allow-credentials','access-control-allow-methods','location'];
async function probe(origin,path,{method='GET',headers={},local,inspect}={}){
  if(![site,api,'http://novaleague.vercel.app'].includes(origin) || !['GET','HEAD','OPTIONS'].includes(method)) throw Error('Outside read-only scope');
  const result={origin,path,method};
  try {
    const res=await fetch(origin+path,{method,headers:{...(origin===api?{apikey:key}:{}),...headers},redirect:'manual',signal:AbortSignal.timeout(15000)});
    result.status=res.status;result.headers=Object.fromEntries(headersToKeep.filter(k=>res.headers.has(k)).map(k=>[k,res.headers.get(k)]));
    const bytes=Buffer.from(await res.arrayBuffer());result.bytes=bytes.length;
    if(local) {
      result.matchesLocal=createHash('sha256').update(bytes).digest('hex')===createHash('sha256').update(await readFile(local)).digest('hex');
      result.matchesCommittedNormalized=bytes.toString().replaceAll('\r\n','\n')===execFileSync('git',['show','HEAD:'+local],{maxBuffer:1024*1024}).toString().replaceAll('\r\n','\n');
    }
    let json;try{json=JSON.parse(bytes.toString())}catch{}
    if(json && !Array.isArray(json) && typeof json.code==='string')result.errorCode=json.code;
    if(inspect)result.observation=inspect(json);
  } catch(e){result.error=e.name;}
  report.checks.push(result);
}
if(!sourceOnly)await probe('http://novaleague.vercel.app','/',{method:'HEAD'});
await probe(site,'/',{local:'index.html'});
for(const file of sourceOnly?['app.js']:['app.js','public-config.js','assets/supabase.js'])await probe(site,'/'+file,{local:file});
if(!sourceOnly){
for(const path of ['/.env','/.env.local','/.git/config','/package.json','/security/apply-security.sql','/tests/legacy-schema.sql','/app.js.map','/supabase/migrations/20261021044448_security_hardening_07.sql','/%2e%2e/.env'])await probe(site,path);
for(const table of ['jogadores','partidas','mensagens','player_sessions','admin_users','public_jogadores','cupons'])await probe(api,`/rest/v1/${table}?select=*&limit=0`);
await probe(api,'/rest/v1/rpc/get_public_players?p_offset=0&p_limit=1',{inspect:j=>Array.isArray(j)?{rows:j.length,fields:Object.keys(j[0]||{}),masked:j.every(x=>x.gameId.includes('*'))}:null});
await probe(api,'/rest/v1/rpc/get_public_matches?p_offset=0&p_limit=1',{inspect:j=>Array.isArray(j)?{rows:j.length,fields:Object.keys(j[0]||{}),masked:j.every(x=>x.playerGameId.includes('*'))}:null});
await probe(api,'/rest/v1/rpc/is_admin');
await probe(api,'/rest/v1/jogadores?select=id&limit=0',{headers:{'Accept-Profile':'nova_private'}});
const unsigned=[{alg:'none',typ:'JWT'},{role:'authenticated',sub:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',exp:Math.floor(Date.now()/1000)+300}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.')+'.';
await probe(api,'/rest/v1/jogadores?select=id&limit=0',{headers:{Authorization:'Bearer '+unsigned}});
await probe(api,'/rest/v1/cupons?select=id&limit=0',{method:'OPTIONS',headers:{Origin:'https://example.invalid','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'apikey,authorization,content-type'}});
await probe(api,'/auth/v1/settings',{inspect:j=>j?{disable_signup:j.disable_signup,mailer_autoconfirm:j.mailer_autoconfirm,anonymous_users_enabled:j.external?.anonymous_users}:null});
await probe(api,'/auth/v1/user');
}
await writeFile(`security/audit-${sourceOnly?'source':'public'}-2026-10-26.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({at:report.at,checks:report.checks.map(({path,status,errorCode,matchesCommittedNormalized,observation,error})=>({path,status,errorCode,matchesCommittedNormalized,observation,error}))},null,2));
