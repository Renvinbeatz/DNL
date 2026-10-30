const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
test('Admin reversals, reports and audit access',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});const admin='dddddddd-dddd-4ddd-8ddd-dddddddddddd',session='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 const owner=()=>db.exec(`RESET ROLE;SET request.jwt.claims='{"role":"service_role"}';`);
 const login=()=>db.exec(`SET ROLE authenticated;SET request.jwt.claims='{"role":"authenticated","sub":"${admin}","session_id":"${session}","aal":"aal1"}';`);
 const summary=async()=>(await db.query('SELECT public.get_admin_finances() AS x')).rows[0].x;
 const ad=randomUUID(),absent=randomUUID();
 try{
 await db.exec(fs.readFileSync('tests/legacy-schema.sql','utf8'));
 for(const name of fs.readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).sort())await db.exec(fs.readFileSync('supabase/migrations/'+name,'utf8'));
 await db.exec(`INSERT INTO auth.users VALUES('${admin}');INSERT INTO auth.sessions(id,user_id) VALUES('${session}','${admin}');INSERT INTO public.admin_users(user_id) VALUES('${admin}');`);await login();
 await db.query(`SELECT public.add_admin_finance_entry($1,'advertising',80,NULL,'Campanha')`,[ad]);
 await db.query(`SELECT public.add_admin_finance_entry($1,'non_participant',NULL,3,'Diário')`,[absent]);
 await t.test('Reversing advertising removes only its expense, preserving the original entry',async()=>{
  await db.query('SELECT public.reverse_finance_entry($1,$2)',[ad,'Lançamento incorreto']);const x=await summary();assert.equal(x.advertising_total,'0.00');assert.equal(x.balance,'18.00');assert.equal(x.entries_count,'2');assert.ok(x.entries.find(e=>e.id===ad).reversed_at);
 });
 await t.test('Reversing absences removes six reais per registration, without touching rankings',async()=>{
  await db.query('SELECT public.reverse_finance_entry($1,$2)',[absent,'Quantidade incorreta']);const x=await summary();assert.equal(x.non_participants,'0');assert.equal(x.accumulated_total,'0.00');assert.equal(x.balance,'0.00');assert.equal((await db.query('SELECT count(*)::int AS n FROM public.jogadores')).rows[0].n,2);
 });
 await t.test('Repeated reversal does not change the reason or create a second audit event',async()=>{
  await db.query('SELECT public.reverse_finance_entry($1,$2)',[ad,'Nova tentativa']);await owner();const r=await db.query(`SELECT count(*)::int AS n FROM nova_private.audit_log WHERE operation='REVERSE'`);assert.equal(r.rows[0].n,2);await login();assert.equal((await summary()).entries.find(e=>e.id===ad).reversal_reason,'Lançamento incorreto');
  await assert.rejects(db.query('SELECT public.reverse_finance_entry($1,$2)',[randomUUID(),'Não existe']));await assert.rejects(db.query('SELECT public.reverse_finance_entry($1,$2)',[ad,'x']));
 });
 await t.test('Financial export includes reversed entries and their original amounts',async()=>{
  const rows=(await db.query(`SELECT public.get_admin_report('finance') AS x`)).rows[0].x;assert.equal(rows.length,2);assert.equal(rows.find(e=>e.id===ad).amount,'80.00');assert.ok(rows.every(e=>e.reversed_at));assert.ok(rows.every(e=>e.effective_expense==='0' && e.effective_revenue==='0'));
  await assert.rejects(db.query(`SELECT public.get_admin_report('finance','2026-10-31','2026-10-30')`));await assert.rejects(db.query(`SELECT public.get_admin_report('other')`));
 });
 await t.test('Date filters include whole Brazilian calendar days',async()=>{
  await owner();for(const time of ['2026-10-30T02:59:59Z','2026-10-30T03:00:00Z','2026-10-31T02:59:59Z','2026-10-31T03:00:00Z'])await db.query(`INSERT INTO nova_private.finance_entries(id,kind,amount,note,created_at) VALUES($1,'advertising',1,'boundary',$2)`,[randomUUID(),time]);
  await login();const rows=(await db.query(`SELECT public.get_admin_report('finance','2026-10-30','2026-10-30') AS x`)).rows[0].x.filter(e=>e.note==='boundary');assert.equal(rows.length,2);
 });
 await t.test('Audit captures the administrator, record label and modified field names',async()=>{
  await db.query(`UPDATE public.jogadores SET status='warning1' WHERE "gameId"='99999001'`);
  const rows=(await db.query('SELECT public.get_admin_audit() AS x')).rows[0].x;const row=rows.find(r=>r.entity==='jogadores' && r.operation==='UPDATE');assert.equal(row.administrator,admin);assert.ok(row.details.fields.includes('status'));assert.ok(row.details.label);
 });
 await t.test('Audit cursor orders numeric IDs correctly and does not repeat rows',async()=>{
  await owner();await db.exec(`INSERT INTO nova_private.audit_log(entity,operation) SELECT 'qa','UPDATE' FROM generate_series(1,65)`);await login();
  const first=(await db.query('SELECT public.get_admin_audit(NULL,50) AS x')).rows[0].x;const next=(await db.query('SELECT public.get_admin_audit($1,50) AS x',[first.at(-1).id])).rows[0].x;
  assert.equal(first.length,50);assert.ok(BigInt(first[0].id)>BigInt(first.at(-1).id));assert.ok(next.every(r=>!first.some(f=>f.id===r.id)));
 });
 await t.test('Visitor and non-admin sessions cannot reverse, export or read audit history',async()=>{
  for(const claims of ['{"role":"anon"}','{"role":"authenticated","sub":"33333333-3333-4333-8333-333333333333"}']){
   await owner();await db.exec(`SET ROLE ${JSON.parse(claims).role};`);await db.query(`SELECT set_config('request.jwt.claims',$1,false)`,[claims]);
   for(const sql of ['SELECT public.get_admin_audit()',"SELECT public.get_admin_report('finance')",`SELECT public.reverse_finance_entry('${ad}','Tentativa')`])await assert.rejects(db.query(sql));
  }
 });
 }finally{await db.close();}
});
