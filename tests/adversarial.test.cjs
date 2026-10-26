// Adversarial cases run only in disposable PostgreSQL with synthetic accounts.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
test('Adversarial database isolation, tampering and replay',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});
 const player='11111111-1111-4111-8111-111111111111';
 const admin='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 const session='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 const claims={role:'authenticated',sub:admin,session_id:session,aal:'aal1'};
 const owner=()=>db.exec(`RESET ROLE;SET request.jwt.claims='{"role":"service_role"}';`);
 async function role(name,jwt={role:name}){await db.exec(`SET ROLE ${name}`);await db.query(`SELECT set_config('request.jwt.claims',$1,false)`,[JSON.stringify(jwt)]);}
 async function login(id='99999001'){await role('anon');return (await db.query('SELECT * FROM public.player_login($1)',[id])).rows[0];}
 const entry={playerId:player,kills:2,pos:1,killValue:4,bonus:10};
 try{
  await db.exec(fs.readFileSync('tests/legacy-schema.sql','utf8'));
  for(const name of fs.readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).sort())await db.exec(fs.readFileSync('supabase/migrations/'+name,'utf8'));
  await owner();await db.query('INSERT INTO auth.users VALUES($1)',[admin]);await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)',[session,admin]);
  await t.test('All admin RPCs reject anonymous and authenticated non-admin callers',async()=>{
   for(const name of ['anon','authenticated']){
    await role(name,name==='authenticated'?claims:undefined);
    for(const query of [
     `SELECT public.add_match_with_players('ATTACK','date','[]')`,
     `SELECT * FROM public.bulk_import_matches('ATTACK','date',0,0,0,'[]')`,
     `SELECT public.edit_match_group('ATTACK','date','[]')`,
     `SELECT public.delete_match_group('ATTACK','date')`
    ])await assert.rejects(db.query(query));
   }
   await owner();
  });
  await t.test('User-controlled metadata and a copied session belonging to another user do not grant admin',async()=>{
   await role('authenticated',{...claims,user_metadata:{role:'admin',is_admin:true},app_metadata:{role:'admin'}});
   assert.equal((await db.query('SELECT public.is_admin() AS ok')).rows[0].ok,false);
   await assert.rejects(db.query('INSERT INTO public.admin_users(user_id) VALUES($1)',[admin]));
   await owner();await db.query('INSERT INTO public.admin_users(user_id) VALUES($1)',[admin]);
   await role('authenticated',{...claims,sub:'33333333-3333-4333-8333-333333333333'});
   assert.equal((await db.query('SELECT public.is_admin() AS ok')).rows[0].ok,false);
   await owner();
  });
  await t.test('Internal budget, audit and tokens remain inaccessible even to an admin session',async()=>{
   for(const name of ['anon','authenticated']){
    await role(name,name==='authenticated'?claims:undefined);
    for(const query of [
     `SELECT token FROM public.player_sessions`, `SELECT * FROM nova_private.audit_log`,
     `SELECT nova_private.consume_budget('login_global','endpoint',999999,1)`,
     `UPDATE nova_private.rate_limits SET hits=0`,
     `INSERT INTO public.admin_users(user_id) VALUES('33333333-3333-4333-8333-333333333333')`
    ])await assert.rejects(db.query(query));
   }
   await owner();
  });
  await t.test('Injection strings and malformed IDs never issue player tokens',async()=>{
   for(const id of [null,"' OR 1=1--",'99999001;select pg_sleep(1)',"99999001\n",'９９９９９００１','0'.repeat(21),'1'.repeat(10000)]){
    const result=await login(id);assert.ok(result.error);assert.equal(result.session_token,null);
   }
   await owner();
  });
  let token;
  await t.test('Current limitation: direct ID login ignores the browser 15-second timer',async()=>{
   token=(await login()).session_token;
   const second=await login();assert.ok(token);assert.ok(second.session_token);assert.notEqual(second.session_token,token);
   await owner();
  });
  await t.test('Bearer substitution, projection ID and raw UUID cannot read someone else’s messages',async()=>{
   await role('anon');
   for(const bad of [player,'a'.repeat(64),token.slice(0,63)+(token.endsWith('0')?'1':'0'),"' OR true--",null]){
    assert.equal((await db.query('SELECT * FROM public.get_my_messages($1)',[bad])).rows.length,0);
    assert.equal((await db.query(`SELECT public.mark_message_read('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$1) AS ok`,[bad])).rows[0].ok,false);
   }
   await owner();
  });
  await t.test('Logout revokes replay; both sliding and absolute expiry are enforced',async()=>{
   await role('anon');await db.query('SELECT public.player_session_logout($1)',[token]);
   assert.ok((await db.query('SELECT * FROM public.player_session_login($1)',[token])).rows[0].error);
   for(const column of ['expires_at','absolute_expires_at']){
    const issued=await login();assert.ok(issued.session_token);await owner();
    await db.query(`UPDATE public.player_sessions SET ${column}=now()-interval '1 second' WHERE token=encode(extensions.digest($1,'sha256'),'hex')`,[issued.session_token]);
    await role('anon');assert.equal((await db.query('SELECT * FROM public.get_my_messages($1)',[issued.session_token])).rows.length,0);
   }
   await owner();
  });
  await t.test('Hostile match JSON is rejected atomically without changing balances',async()=>{
   await role('authenticated',claims);
   const bad=[null,{},[],[null],Array(101).fill(entry),[entry,entry],
    ...['-1','1.5','1e100','null','"NaN"','"2 OR 1=1"','true'].map(v=>[{...entry,kills:JSON.parse(v)}]),
    [{...entry,playerId:'-'.repeat(36)}],[{...entry,pos:0}],[{...entry,bonus:-1}],[{...entry,killValue:100001}],
    [entry,{...entry,playerId:'22222222-2222-4222-8222-222222222222',bonus:-1}]];
   for(const payload of bad)await assert.rejects(db.query(`SELECT public.add_match_with_players('INVALID','date',$1::jsonb)`,[JSON.stringify(payload)]));
   assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.partidas WHERE number='INVALID'`)).rows[0].n,0);
   assert.deepEqual((await db.query('SELECT kills,earnings,"matchesCount" FROM public.jogadores WHERE id=$1',[player])).rows[0],{kills:0,earnings:'0',matchesCount:0});
   await owner();
  });
  await t.test('Duplicate replay and a second-entry failure roll back the entire operation',async()=>{
   await role('authenticated',claims);
   await db.query(`SELECT public.add_match_with_players('VALID','date',$1::jsonb)`,[JSON.stringify([entry])]);
   await assert.rejects(db.query(`SELECT public.add_match_with_players('VALID','date',$1::jsonb)`,[JSON.stringify([{...entry,playerId:'22222222-2222-4222-8222-222222222222'},entry])]));
   assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.partidas WHERE number='VALID'`)).rows[0].n,1);
   assert.equal((await db.query('SELECT kills FROM public.jogadores WHERE id=$1',[player])).rows[0].kills,2);
   await owner();
  });
  await t.test('Admin cannot bypass match accounting or mass-assign player balances through table endpoints',async()=>{
   await role('authenticated',claims);
   await assert.rejects(db.query(`UPDATE public.partidas SET kills=999 WHERE number='VALID'`));
   await assert.rejects(db.query(`DELETE FROM public.partidas WHERE number='VALID'`));
   await assert.rejects(db.query(`UPDATE public.jogadores SET earnings=999999 WHERE id=$1`,[player]));
   await assert.rejects(db.query(`INSERT INTO public.jogadores(nick,"gameId",earnings) VALUES('MASS_ASSIGN','88888001',999999)`));
   await db.query(`INSERT INTO public.jogadores(nick,"gameId") VALUES('NEW_QA','88888002')`);
   await db.query(`UPDATE public.jogadores SET status='warning1',is_honra=true WHERE id=$1`,[player]);
   await owner();
  });
  await t.test('Short accepted game IDs are also masked by public projections',async()=>{
   await owner();const short=(await db.query(`INSERT INTO public.jogadores(nick,"gameId") VALUES('SHORT_QA','123') RETURNING id`)).rows[0].id;
   await role('authenticated',claims);await db.query(`SELECT public.add_match_with_players('SHORT','date',$1::jsonb)`,[JSON.stringify([{...entry,playerId:short}])]);
   await role('anon');
   const rows=(await db.query('SELECT public.get_public_players(0,200) AS data')).rows[0].data;
   assert.match(rows.find(x=>x.nick==='SHORT_QA').gameId,/\*/);
   const matches=(await db.query('SELECT public.get_public_matches(NULL,0,200) AS data')).rows[0].data;
   assert.match(matches.find(x=>x.number==='SHORT').playerGameId,/\*/);await owner();
  });
  await t.test('Public pagination clamps negative and oversized limits',async()=>{
   await role('anon');
   for(const [offset,limit] of [[-999,2147483647],[0,-99],[2147483647,200],[null,null]]){
    const rows=(await db.query('SELECT public.get_public_players($1,$2) AS data',[offset,limit])).rows[0].data;
    assert.ok(Array.isArray(rows));assert.ok(rows.length<=200);
   }
   await owner();
  });
  await t.test('Current limitation: exhausting the shared login budget also delays a legitimate ID',async()=>{
   await owner();await db.exec(`INSERT INTO nova_private.rate_limits VALUES('login_global','endpoint',now(),600) ON CONFLICT(scope,subject) DO UPDATE SET hits=600,window_start=now()`);
   const result=await login('99999002');assert.match(result.error,/Aguarde/);await owner();
  });
  await t.test('Current limitation: twenty live ID sessions prevent a new device from signing in',async()=>{
   await owner();await db.exec(`DELETE FROM nova_private.rate_limits;INSERT INTO public.player_sessions(token,player_id,expires_at) SELECT encode(extensions.digest('qa-session-'||g,'sha256'),'hex'),'22222222-2222-4222-8222-222222222222',now()+interval '7 days' FROM generate_series(1,20) g`);
   const result=await login('99999002');assert.match(result.error,/Limite de sessões/);await owner();
  });
  await t.test('Incremental audit migration is repeatable and preserves records and aggregate totals',async()=>{
   await owner();const query=`SELECT id,kills,earnings,"matchesCount" FROM public.jogadores ORDER BY id`;
   const before=(await db.query(query)).rows;
   const name=fs.readdirSync('supabase/migrations').find(n=>n.endsWith('_08.sql'));
   await db.exec(fs.readFileSync('supabase/migrations/'+name,'utf8'));
   assert.deepEqual((await db.query(query)).rows,before);
  });
 } finally {await db.close();}
});
