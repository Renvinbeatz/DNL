const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
test('PostgreSQL migration and authorization regression suite',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try{
  await db.exec(fs.readFileSync('tests/legacy-schema.sql','utf8'));
  await db.exec('BEGIN');
  for(const name of fs.readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).sort()) await db.exec(fs.readFileSync('supabase/migrations/'+name,'utf8'));
  await db.exec('COMMIT');
  async function asAnon(){await db.exec(`SET ROLE anon; SET request.jwt.claims='{"role":"anon"}';`);}
  async function asOwner(){await db.exec(`RESET ROLE; SET request.jwt.claims='{"role":"service_role"}';`);}
  await t.test('No exposed privileged functions or legacy IDOR overload',async()=>{
   const r=await db.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosecdef`);assert.equal(r.rows[0].n,0);
   const old=await db.query(`SELECT to_regprocedure('public.mark_message_read(uuid,uuid)') AS f`);assert.equal(old.rows[0].f,null);
  });
  await t.test('Anonymous visitors cannot read protected tables',async()=>{
   await asAnon();for(const table of ['mensagens','jogadores','partidas','player_sessions','admin_users','public_jogadores'])await assert.rejects(db.query(`SELECT * FROM public.${table}`));await asOwner();
  });
  let token;
  await t.test('ID login preserves product flow but stores only token hash',async()=>{
   await asAnon();const r=await db.query(`SELECT * FROM public.player_login($1)`,['99999001']);assert.equal(r.rows[0].error,null);token=r.rows[0].session_token;assert.match(token,/^[a-f0-9]{64}$/);assert.match(r.rows[0].rankingId,/^[a-f0-9-]{36}$/);assert.notEqual(r.rows[0].rankingId,r.rows[0].id);await asOwner();
   const stored=await db.query(`SELECT token,expires_at<=absolute_expires_at AS bounded FROM public.player_sessions WHERE player_id='11111111-1111-4111-8111-111111111111'`);assert.notEqual(stored.rows[0].token,token);assert.equal(stored.rows[0].bounded,true);
  });
  await t.test('Invalid token cannot read or acknowledge messages',async()=>{
   await asAnon();const r=await db.query(`SELECT * FROM public.get_my_messages($1)`,['x'.repeat(64)]);assert.equal(r.rows.length,0);
   const read=await db.query(`SELECT public.mark_message_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1) AS ok`,['a'.repeat(64)]);assert.equal(read.rows[0].ok,false);await asOwner();
  });
  await t.test('Valid session reads own and global messages only',async()=>{
   await asAnon();const r=await db.query(`SELECT * FROM public.get_my_messages($1)`,[token]);assert.deepEqual(r.rows.map(r=>r.text).sort(),['General','Only One']);await asOwner();
  });
  await t.test('Valid token cannot acknowledge someone else’s message',async()=>{
   await asAnon();const r=await db.query(`SELECT public.mark_message_read('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$1) AS ok`,[token]);assert.equal(r.rows[0].ok,false);
   const own=await db.query(`SELECT public.mark_message_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1) AS ok`,[token]);assert.equal(own.rows[0].ok,true);await asOwner();
  });
  await t.test('Public projections do not disclose raw player identifiers or warnings',async()=>{
   await asAnon();const r=await db.query(`SELECT public.get_public_players(0,200) AS data`);assert.ok(r.rows[0].data.every(p=>!p.gameId.includes('99999001') && !Object.hasOwn(p,'status')));assert.ok(r.rows[0].data.every(p=>p.id!=='11111111-1111-4111-8111-111111111111'));await asOwner();
  });
  await t.test('Login rejects SQL injection and rate-limits repeated attempts',async()=>{
   await asAnon();const bad=await db.query(`SELECT * FROM public.player_login($1)`,["99999001' OR '1'='1"]);assert.ok(bad.rows[0].error);let last;for(let i=0;i<6;i++)last=await db.query(`SELECT * FROM public.player_login($1)`,['99999002']);assert.match(last.rows[0].error,/Aguarde/);await asOwner();
  });
  await t.test('Unregistered IDs do not allocate rate-limit keys; inactive counters expire',async()=>{
   await db.exec(`INSERT INTO nova_private.rate_limits VALUES('old','old',now()-interval '3 days',1)`);
   await asAnon();await db.query(`SELECT * FROM public.player_login($1)`,['123456789999']);await asOwner();
   const unknown=await db.query(`SELECT count(*)::int AS n FROM nova_private.rate_limits WHERE subject=encode(extensions.digest('123456789999','sha256'),'hex') OR scope='old'`);assert.equal(unknown.rows[0].n,0);
  });
  await t.test('Administrative membership without MFA cannot write',async()=>{
   await db.exec(`INSERT INTO auth.users VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd'); INSERT INTO public.admin_users(user_id) VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd');INSERT INTO auth.sessions(id,user_id) VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','dddddddd-dddd-4ddd-8ddd-dddddddddddd');SET ROLE authenticated;SET request.jwt.claims='{"role":"authenticated","sub":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","session_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","aal":"aal1"}';`);
   const r=await db.query('SELECT public.is_admin() AS ok');assert.equal(r.rows[0].ok,false);await assert.rejects(db.query(`INSERT INTO public.cupons(code,discount) VALUES('QA','Test')`));await asOwner();
  });
  await t.test('MFA admin can write; validation rejects invalid and duplicate results atomically',async()=>{
   await db.exec(`SET ROLE authenticated;SET request.jwt.claims='{"role":"authenticated","sub":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","session_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","aal":"aal2"}';`);
   const r=await db.query('SELECT public.is_admin() AS ok');assert.equal(r.rows[0].ok,true);
   await db.query(`INSERT INTO public.cupons(code,discount) VALUES('QA','Test')`);
   await assert.rejects(db.query(`INSERT INTO public.cupons(code,discount) VALUES($1,'Test')`,["BAD'CODE"]));
   const entries=[{playerId:'11111111-1111-4111-8111-111111111111',kills:2,pos:1,killValue:4,bonus:10}];
   await db.query(`SELECT public.add_match_with_players('QA_MATCH','2026-10-10',$1::jsonb)`,[JSON.stringify(entries)]);
   await assert.rejects(db.query(`SELECT public.add_match_with_players('QA_MATCH','2026-10-10',$1::jsonb)`,[JSON.stringify(entries)]));
   await assert.rejects(db.query(`SELECT public.add_match_with_players('QA_BAD','2026-10-10',$1::jsonb)`,[JSON.stringify([{...entries[0],kills:-1}])]));
   const own=await db.query(`SELECT kills,earnings,"matchesCount" FROM public.jogadores WHERE id='11111111-1111-4111-8111-111111111111'`);assert.deepEqual(own.rows[0],{kills:2,earnings:'18.00',matchesCount:1});await asOwner();
  });
  await t.test('Public matches reveal only own full ID when session is valid',async()=>{
   await asAnon();const a=await db.query(`SELECT public.get_public_matches(NULL,0,200) AS data`);assert.match(a.rows[0].data[0].playerGameId,/\*/);
   const b=await db.query(`SELECT public.get_public_matches($1,0,200) AS data`,[token]);assert.equal(b.rows[0].data[0].playerGameId,'99999001');await asOwner();
  });
  await t.test('Editing and deleting results update totals atomically; null dates stay distinct',async()=>{
   await db.exec(`SET ROLE authenticated;SET request.jwt.claims='{"role":"authenticated","sub":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","session_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","aal":"aal2"}';`);
   const existing=await db.query(`SELECT id FROM public.partidas WHERE number='QA_MATCH'`);
   await db.query(`SELECT public.edit_match_group('QA_EDIT','2026-10-10',$1::jsonb)`,[JSON.stringify([{matchId:existing.rows[0].id,kills:3,pos:2,total:22}])]);
   const updated=await db.query(`SELECT kills,earnings,"matchesCount" FROM public.jogadores WHERE id='11111111-1111-4111-8111-111111111111'`);assert.deepEqual(updated.rows[0],{kills:3,earnings:'22.00',matchesCount:1});
   await db.query(`SELECT public.delete_match_group('QA_EDIT','2026-10-10')`);
   const deleted=await db.query(`SELECT kills,earnings,"matchesCount" FROM public.jogadores WHERE id='11111111-1111-4111-8111-111111111111'`);assert.deepEqual(deleted.rows[0],{kills:0,earnings:'0',matchesCount:0});
   const entries=JSON.stringify([{playerId:'22222222-2222-4222-8222-222222222222',kills:1,pos:1,killValue:2,bonus:0}]);
   for(const date of ['initial','sem_data'])await db.query(`SELECT public.add_match_with_players('QA_NULL',$1,$2::jsonb)`,[date,entries]);
   await asOwner();await db.exec(`UPDATE public.partidas SET date=NULL WHERE number='QA_NULL' AND date='initial'`);
   await db.exec(`SET ROLE authenticated;SET request.jwt.claims='{"role":"authenticated","sub":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","session_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","aal":"aal2"}';`);
   const count=await db.query(`SELECT public.delete_match_group('QA_NULL',NULL) AS n`);assert.equal(count.rows[0].n,1);
   const remaining=await db.query(`SELECT date FROM public.partidas WHERE number='QA_NULL'`);assert.deepEqual(remaining.rows,[{date:'sem_data'}]);await asOwner();
  });
  await t.test('Revoked admin session and banned player lose authorization',async()=>{
   await db.exec(`DELETE FROM auth.sessions WHERE id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';SET ROLE authenticated;SET request.jwt.claims='{"role":"authenticated","sub":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","session_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","aal":"aal2"}';`);const r=await db.query('SELECT public.is_admin() AS ok');assert.equal(r.rows[0].ok,false);await asOwner();
   await db.exec(`UPDATE public.jogadores SET status='banned' WHERE id='11111111-1111-4111-8111-111111111111'`);await asAnon();const s=await db.query(`SELECT * FROM public.player_session_login($1)`,[token]);assert.ok(s.rows[0].error);await asOwner();
  });
  await t.test('Audit metadata records mutations without message contents',async()=>{
   const r=await db.query('SELECT entity,operation FROM nova_private.audit_log');assert.ok(r.rows.length>0);assert.ok(r.rows.every(row=>!Object.hasOwn(row,'text')));
  });
 } finally {await db.close();}
});
