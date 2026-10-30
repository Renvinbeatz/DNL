const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
test('Initial finance migration: calculations, persistence and permissions before ledger upgrade',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});
 const admin='dddddddd-dddd-4ddd-8ddd-dddddddddddd',session='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 const one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
 const owner=()=>db.exec(`RESET ROLE;SET request.jwt.claims='{"role":"service_role"}';`);
 const authenticated=()=>db.exec(`SET ROLE authenticated;SET request.jwt.claims='{"role":"authenticated","sub":"${admin}","session_id":"${session}","aal":"aal1"}';`);
 const summary=async()=>(await db.query('SELECT public.get_admin_finances() AS data')).rows[0].data;
 const save=async(amount,version)=>(await db.query('SELECT public.save_admin_ad_spend($1,$2) AS data',[amount,version])).rows[0].data;
 try{
  await db.exec(fs.readFileSync('tests/legacy-schema.sql','utf8'));
  for(const name of fs.readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql') && !n.endsWith('_finance_entries.sql') && !n.endsWith('_admin_reports_reversals.sql')).sort())await db.exec(fs.readFileSync('supabase/migrations/'+name,'utf8'));
  await t.test('Anonymous visitors cannot read or modify league finances',async()=>{
   await db.exec(`SET ROLE anon;SET request.jwt.claims='{"role":"anon"}';`);
   for(const query of ['SELECT public.get_admin_finances()', 'SELECT public.save_admin_ad_spend(1,0)', 'SELECT nova_private.get_admin_finances()', 'SELECT * FROM nova_private.finance_settings'])await assert.rejects(db.query(query));
   await owner();
  });
  await t.test('An authenticated non-admin cannot read or save expenses',async()=>{
   await owner();await db.query('INSERT INTO auth.users VALUES($1)',[admin]);await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)',[session,admin]);
   await authenticated();await assert.rejects(summary());await assert.rejects(save('1.00',0));await owner();
   await db.query('INSERT INTO public.admin_users(user_id) VALUES($1)',[admin]);
  });
  await t.test('A fresh league with registered players but zero participations has zero revenue',async()=>{
   await authenticated();assert.deepEqual(await summary(),{participations:'0',registration_fee:'6.00',accumulated_total:'0.00',payout_total:'0.00',advertising_total:'0.00',balance:'0.00',version:0});
  });
  await t.test('Each participation adds six reais; payout matches the existing player aggregate',async()=>{
   const entries=[{playerId:one,kills:1,pos:1,killValue:1,bonus:0},{playerId:two,kills:2,pos:2,killValue:1.25,bonus:2}];
   await db.query(`SELECT public.add_match_with_players('FINANCE','today',$1::jsonb)`,[JSON.stringify(entries)]);
   const result=await summary();assert.equal(result.participations,'2');assert.equal(result.accumulated_total,'12.00');assert.equal(result.payout_total,'5.50');assert.equal(result.balance,'6.50');
   const panel=(await db.query('SELECT sum(earnings)::text AS total FROM public.jogadores')).rows[0].total;assert.equal(Number(result.payout_total),Number(panel));
  });
  await t.test('Banning a player keeps historical revenue and payouts; a registration alone adds no revenue',async()=>{
   await db.query(`UPDATE public.jogadores SET status='banned' WHERE id=$1`,[one]);
   await db.query(`INSERT INTO public.jogadores(nick,"gameId") VALUES('UNPLAYED','77777001')`);
   const result=await summary();assert.equal(result.accumulated_total,'12.00');assert.equal(result.payout_total,'5.50');
  });
  await t.test('Advertising expense persists and replaces the previous total rather than accumulating it',async()=>{
   const first=await save('3.25',0);assert.equal(first.advertising_total,'3.25');assert.equal(first.balance,'3.25');assert.equal(first.version,1);
   await owner();await authenticated();assert.equal((await summary()).advertising_total,'3.25');
   const second=await save('4.00',1);assert.equal(second.advertising_total,'4.00');assert.equal(second.balance,'2.50');assert.equal(second.version,2);
  });
  await t.test('Stale updates are rejected instead of overwriting another admin’s expense',async()=>{
   await assert.rejects(save('99.00',0),e=>e.code==='40001');assert.equal((await summary()).advertising_total,'4.00');
  });
  await t.test('Invalid or non-cent amounts are rejected without changing saved finances',async()=>{
   for(const value of [null,'-0.01','0.001','1000000001','NaN','Infinity',"1; DROP TABLE public.jogadores"] )await assert.rejects(save(value,2));
   await assert.rejects(save('1.00',null));await assert.rejects(save('1.00',-1));
   assert.equal((await summary()).advertising_total,'4.00');assert.equal((await summary()).version,2);
  });
  await t.test('Editing a prize updates payout and negative balance without adding a participation',async()=>{
   const match=(await db.query('SELECT id FROM public.partidas WHERE "playerId"=$1',[one])).rows[0].id;
   await db.query(`SELECT public.edit_match_group('FINANCE','today',$1::jsonb)`,[JSON.stringify([{matchId:match,kills:1,pos:1,total:8}])]);
   const result=await summary();assert.equal(result.accumulated_total,'12.00');assert.equal(result.payout_total,'12.50');assert.equal(result.balance,'-4.50');
  });
  await t.test('Deleting a match removes its revenue and prizes while preserving advertising expense',async()=>{
   await db.query(`SELECT public.delete_match_group('FINANCE','today')`);
   const result=await summary();assert.equal(result.participations,'0');assert.equal(result.accumulated_total,'0.00');assert.equal(result.payout_total,'0.00');assert.equal(result.advertising_total,'4.00');assert.equal(result.balance,'-4.00');
  });
  await t.test('No exposed privileged functions, no direct finance access, and audit metadata records saves',async()=>{
   await assert.rejects(db.query('SELECT * FROM nova_private.finance_settings'));
   await assert.rejects(db.query('UPDATE nova_private.finance_settings SET advertising_total=0'));
   await owner();
   assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosecdef`)).rows[0].n,0);
   assert.equal((await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid='nova_private.finance_settings'::regclass`)).rows[0].relrowsecurity,true);
   const audits=(await db.query(`SELECT actor,entity,operation FROM nova_private.audit_log WHERE entity='finance_settings'`)).rows;
   assert.equal(audits.length,2);assert.ok(audits.every(row=>row.actor===admin && row.operation==='UPDATE'));
  });
  await t.test('A revoked admin session loses both finance read and expense write access',async()=>{
   await owner();await db.query('DELETE FROM auth.sessions WHERE id=$1',[session]);await authenticated();
   await assert.rejects(summary());await assert.rejects(save('0.00',2));
  });
 }finally{await db.close();}
});

test('Gains migration also works before the optional security 08 update',async()=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try{
  await db.exec(fs.readFileSync('tests/legacy-schema.sql','utf8'));
  for(const name of fs.readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql') && !n.endsWith('_08.sql') && !n.endsWith('_finance_entries.sql') && !n.endsWith('_admin_reports_reversals.sql')).sort())await db.exec(fs.readFileSync('supabase/migrations/'+name,'utf8'));
  await db.exec(`INSERT INTO auth.users VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd');INSERT INTO auth.sessions(id,user_id) VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','dddddddd-dddd-4ddd-8ddd-dddddddddddd');INSERT INTO public.admin_users(user_id) VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd');SET ROLE authenticated;SET request.jwt.claims='{"role":"authenticated","sub":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","session_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","aal":"aal1"}';`);
  const result=(await db.query('SELECT public.save_admin_ad_spend(1.25,0) AS data')).rows[0].data;
  assert.equal(result.advertising_total,'1.25');assert.equal(result.balance,'-1.25');
 }finally{await db.close();}
});
