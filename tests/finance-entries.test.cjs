const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
test('Finance ledger: additive expenses, paid non-participants and preserved history',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});
 const admin='dddddddd-dddd-4ddd-8ddd-dddddddddddd',session='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 const owner=()=>db.exec(`RESET ROLE;SET request.jwt.claims='{"role":"service_role"}';`);
 const authenticated=()=>db.exec(`SET ROLE authenticated;SET request.jwt.claims='{"role":"authenticated","sub":"${admin}","session_id":"${session}","aal":"aal1"}';`);
 const summary=async()=>(await db.query('SELECT public.get_admin_finances() AS data')).rows[0].data;
 const add=async(kind,amount=null,quantity=null,id=randomUUID(),note='')=>(await db.query('SELECT public.add_admin_finance_entry($1,$2,$3,$4,$5) AS data',[id,kind,amount,quantity,note])).rows[0].data;
 try{
  await db.exec(fs.readFileSync('tests/legacy-schema.sql','utf8'));
  const names=fs.readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).sort();
  for(const name of names.filter(n=>!n.endsWith('_finance_entries.sql') && !n.endsWith('_admin_reports_reversals.sql')))await db.exec(fs.readFileSync('supabase/migrations/'+name,'utf8'));
  await db.exec(`INSERT INTO auth.users VALUES('${admin}');INSERT INTO auth.sessions(id,user_id) VALUES('${session}','${admin}');INSERT INTO public.admin_users(user_id) VALUES('${admin}');`);
  await authenticated();await db.query('SELECT public.save_admin_ad_spend(80,0)');await owner();
  await db.exec(fs.readFileSync('supabase/migrations/'+names.find(n=>n.endsWith('_finance_entries.sql')),'utf8'));await authenticated();
  await owner();await db.exec(fs.readFileSync('supabase/migrations/'+names.find(n=>n.endsWith('_admin_reports_reversals.sql')),'utf8'));await authenticated();
  await t.test('Upgrade preserves the old expense as a historical opening entry',async()=>{
   const result=await summary();assert.equal(result.advertising_total,'80.00');assert.equal(result.entries_count,'1');assert.match(result.entries[0].note,/anterior/);
  });
  const expenseId=randomUUID();
  await t.test('An additional 120 adds to 80 and persists a total of 200',async()=>{
   const result=await add('advertising','120.00',null,expenseId,'Campanha');assert.equal(result.advertising_total,'200.00');assert.equal(result.entries_count,'2');
   await owner();await authenticated();assert.equal((await summary()).advertising_total,'200.00');
  });
  await t.test('Retrying the same request is idempotent, while reusing its ID with different data is rejected',async()=>{
   const result=await add('advertising','120.00',null,expenseId,'Campanha');assert.equal(result.advertising_total,'200.00');assert.equal(result.entries_count,'2');
   await assert.rejects(add('advertising','125.00',null,expenseId,'Campanha'));assert.equal((await summary()).advertising_total,'200.00');
  });
  await t.test('Non-participant batches add together and contribute six reais each',async()=>{
   await add('non_participant',null,3);const result=await add('non_participant',null,2);
   assert.equal(result.non_participants,'5');assert.equal(result.non_participant_revenue,'30.00');assert.equal(result.accumulated_total,'30.00');assert.equal(result.balance,'-170.00');
  });
  await t.test('Non-participants never create players, results, prizes or ranking records',async()=>{
   assert.equal((await db.query('SELECT count(*)::int AS n FROM public.jogadores')).rows[0].n,2);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM public.partidas')).rows[0].n,0);
   assert.equal((await summary()).payout_total,'0.00');assert.equal((await summary()).participations,'0');
  });
  await t.test('Automatic played participations and manually added paid absences combine without changing prize logic',async()=>{
   await db.query(`SELECT public.add_match_with_players('LEDGER','today',$1::jsonb)`,[JSON.stringify([{playerId:'11111111-1111-4111-8111-111111111111',kills:1,pos:3,killValue:1,bonus:0}])]);
   const result=await summary();assert.equal(result.accumulated_total,'36.00');assert.equal(result.payout_total,'1.00');assert.equal(result.balance,'-165.00');
   await db.query(`SELECT public.delete_match_group('LEDGER','today')`);assert.equal((await summary()).accumulated_total,'30.00');assert.equal((await summary()).non_participants,'5');
  });
  await t.test('Invalid entries do not change totals or append records',async()=>{
   const before=await summary();
   for(const amount of [null,'0','-1','0.001','1000000001','NaN','Infinity'])await assert.rejects(add('advertising',amount));
   for(const count of [null,0,-1,1000001])await assert.rejects(add('non_participant',null,count));
   await assert.rejects(add('non_participant','6',1));await assert.rejects(add('advertising','1',1));await assert.rejects(add('unknown','1'));await assert.rejects(add('advertising','1',null,randomUUID(),'x'.repeat(161)));
   const after=await summary();assert.equal(after.entries_count,before.entries_count);assert.equal(after.advertising_total,before.advertising_total);assert.equal(after.non_participants,before.non_participants);
  });
  await t.test('The old overwrite endpoint and direct table writes are blocked',async()=>{
   await assert.rejects(db.query('SELECT public.save_admin_ad_spend(0,1)'));await assert.rejects(db.query('SELECT * FROM nova_private.finance_entries'));
   await assert.rejects(db.query(`INSERT INTO nova_private.finance_entries(id,kind,amount) VALUES(gen_random_uuid(),'advertising',1)`));
  });
  await t.test('No public privileged function is exposed, and each successful submission has audit metadata',async()=>{
   await owner();assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosecdef`)).rows[0].n,0);
   const rows=(await db.query(`SELECT actor,operation FROM nova_private.audit_log WHERE entity='finance_entries'`)).rows;assert.equal(rows.length,3);assert.ok(rows.every(r=>r.actor===admin && r.operation==='INSERT'));
  });
  await t.test('Anonymous and authenticated non-admin callers cannot access financial entries',async()=>{
   await db.exec(`SET ROLE anon;SET request.jwt.claims='{"role":"anon"}';`);await assert.rejects(summary());await assert.rejects(add('non_participant',null,1));
   await owner();await db.exec(`SET ROLE authenticated;SET request.jwt.claims='{"role":"authenticated","sub":"33333333-3333-4333-8333-333333333333","session_id":"${session}"}';`);await assert.rejects(summary());await assert.rejects(add('advertising','1'));
  });
  await t.test('Only the latest fifty entries are rendered, but totals include all saved entries',async()=>{
   await owner();await db.exec(`INSERT INTO nova_private.finance_entries(id,kind,quantity) SELECT gen_random_uuid(),'non_participant',1 FROM generate_series(1,51)`);await authenticated();
   const result=await summary();assert.equal(result.entries.length,50);assert.equal(result.entries_count,'55');assert.equal(result.non_participants,'56');assert.equal(result.accumulated_total,'336.00');
  });
  await t.test('Session revocation blocks new entries and reads',async()=>{
   await owner();await db.query('DELETE FROM auth.sessions WHERE id=$1',[session]);await authenticated();await assert.rejects(summary());await assert.rejects(add('advertising','1'));
  });
 }finally{await db.close();}
});
