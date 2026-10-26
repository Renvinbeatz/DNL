const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync('index.html','utf8');
const script=fs.readFileSync('app.js','utf8');
function app(overrides={}){
  const dom=new JSDOM(html,{url:'https://novaleague.vercel.app/',runScripts:'outside-only'});
  const w=dom.window;
  const addEvent=w.addEventListener.bind(w);w.addEventListener=(type,fn,...args)=>{if(type!=='DOMContentLoaded')addEvent(type,fn,...args)};
  w.setInterval=()=>0;w.setTimeout=()=>0;w.clearTimeout=()=>{};
  w.NOVA_CONFIG={supabaseUrl:'https://aqvyehkrbjttvdirtjzd.supabase.co',publishableKey:'sb_publishable_test'};
  const client={rpc:async(name)=>({data:name==='is_admin'?false:[],error:null}),auth:{onAuthStateChange(){},mfa:{},signOut:async()=>({error:null})},...overrides};
  w.supabase={createClient:()=>client};const context=dom.getInternalVMContext();vm.runInContext(script,context);
  return {w,dom,client,run:s=>vm.runInContext(s,context)};
}
test('No executable inline scripts or inline events; restrictive CSP',()=>{
 assert.doesNotMatch(html,/\bon(?:click|error|submit|change)=/i);
 assert.doesNotMatch(html,/<script\s*>/i);
 assert.match(html,/script-src &#39;self&#39;|script-src 'self'/);
 assert.doesNotMatch(html,/user-scalable=no/);
});
test('Toast content is text, including executable markup',()=>{
 const a=app();a.run(`showToast('<img src=x onerror=alert(1)>')`);
 assert.equal(a.w.document.querySelector('#toast-container img'),null);
 assert.equal(a.w.document.querySelector('.toast-text').textContent,'<img src=x onerror=alert(1)>');a.dom.window.close();
});
test('Untrusted coupon values remain inert data attributes',async()=>{
 const a=app();a.run(`state.coupons=[{id:'x',code:"NOVA');alert(1);//",discount:'x',valid:'x'}];renderAll()`);
 const button=a.w.document.querySelector('#coupons-list-container button');
 assert.equal(button.getAttribute('onclick'),null);assert.equal(button.dataset.arg,"NOVA');alert(1);//");
 await assert.rejects(a.run(`copyCoupon("NOVA');alert(1);//", document.querySelector('#coupons-list-container button'))`));
 a.dom.window.close();
});
test('Numeric validation rejects coercion, truncation, negatives and non-finite values',()=>{
 const a=app();for(const v of ['',-1,'2evil','Infinity',1.5])assert.throws(()=>a.run(`numberValue(${JSON.stringify(v)},0,100,true)`));
 assert.equal(a.run('numberValue("0",0,100,true)'),0);assert.equal(a.run('numberValue("2.50",0,100)'),2.5);a.dom.window.close();
});
test('Filtering selects entire groups, with exact IDs and collision-safe keys',()=>{
 const a=app();a.run(`state.matches=[{number:'a_b',date:'c',playerGameId:'12345'},{number:'a_b',date:'c',playerGameId:'98765'},{number:'a',date:'b_c',playerGameId:'55555'}]`);
 assert.equal(a.run('getGroupedMatches().length'),2);assert.equal(a.run('getGroupedMatches("12345")[0].players.length'),2);assert.equal(a.run('getGroupedMatches("123").length'),0);a.dom.window.close();
});
test('Zero-kill player has no rank',()=>{
 const a=app();a.run(`state.currentPlayer={id:'a',nick:'A',gameId:'12345',status:'normal',kills:0,matchesCount:0,earnings:0};state.players=[{...state.currentPlayer,gameId:'1234*'}];renderAll()`);
 assert.equal(a.w.document.getElementById('dash-rank').innerText,'--');a.dom.window.close();
});

test('Own rank remains correct for identical nicknames and masked IDs',()=>{
 const a=app();a.run(`state.currentPlayer={id:'real',rankingId:'second',nick:'Same',gameId:'12349999',status:'normal',kills:2,matchesCount:1,earnings:0};state.players=[{id:'first',nick:'Same',gameId:'1234****',kills:3},{id:'second',nick:'Same',gameId:'1234****',kills:2}];renderAll()`);
 assert.equal(a.w.document.getElementById('dash-rank').innerText,'#2');a.dom.window.close();
});
test('Connection badge never claims online before successful reads',()=>{
 const a=app();a.run('updateConnectionBadge()');assert.equal(a.w.document.getElementById('conn-status-badge').textContent,'CONECTANDO...');a.dom.window.close();
});
test('Rejected writes leave local player state unchanged',async()=>{
 const a=app({from:()=>({update:()=>({eq:()=>({select:async()=>({data:null,error:{message:'denied'}})})})})});
 a.run(`state.isAdminAuthenticated=true;state.players=[{id:'11111111-1111-4111-8111-111111111111',status:'normal'}]`);
 await assert.rejects(a.run(`updatePlayerStatus('11111111-1111-4111-8111-111111111111','warning1')`));assert.equal(a.run('state.players[0].status'),'normal');a.dom.window.close();
});
test('Reading acknowledgements sends token, never supplied player identity',async()=>{
 let captured;const a=app({rpc:async(name,args)=>{captured={name,args};return {data:false,error:null}}});
 a.run(`playerToken='${'a'.repeat(64)}';state.currentPlayer={id:'fake'}`);
 await assert.rejects(a.run(`markMessageAsRead('11111111-1111-4111-8111-111111111111')`));
 assert.equal(captured.name,'mark_message_read');assert.equal(captured.args.p_token,'a'.repeat(64));assert.equal('p_player_id' in captured.args,false);a.dom.window.close();
});
test('Duplicate submits are locked and controls restored after failure',async()=>{
 const a=app();let resolve;let calls=0;a.w._wait=new Promise(r=>{resolve=r});a.w._called=()=>{calls++};
 a.run(`actions.handlePlayerLogin=async()=>{window._called();await window._wait;throw new Error('denied')}`);
 const form=a.w.document.getElementById('form-player-login');const event={target:form,preventDefault(){},stopPropagation(){}};
 const p=a.w.dispatchAction(event,'submit');assert.equal(form.querySelector('button').disabled,true);
 await a.w.dispatchAction(event,'submit');assert.equal(calls,1);resolve();await p;assert.equal(form.querySelector('button').disabled,false);assert.equal(form.hasAttribute('aria-busy'),false);a.dom.window.close();
});
test('Personal dashboard refreshes from the token endpoint and no direct messages read',async()=>{
 const calls=[];const a=app({rpc:async(name,args)=>{calls.push(name);return {error:null,data:name==='is_admin'?false:name==='player_session_login'?[{id:'p',nick:'A',gameId:'12345',status:'normal',kills:9,matchesCount:2,earnings:20}]:[]}},from:table=>({select:()=>({order(){return this},range:async()=>({data:[],error:null})})})});
 a.run(`playerToken='${'a'.repeat(64)}';state.currentPlayer={kills:1}`);await a.run('fetchFromDatabase()');
 assert.equal(a.w.document.getElementById('dash-kills').innerText,9);assert.ok(calls.includes('get_my_messages'));assert.equal(a.w.document.getElementById('conn-status-badge').textContent,'ONLINE');a.dom.window.close();
});
test('Administrator signs in with password and server authorization without a second step',async()=>{
 const a=app({
  auth:{signInWithPassword:async()=>({data:{user:{id:'admin'}},error:null})},
  rpc:async(name)=>({data:name==='is_admin'?true:[],error:null}),
  from(){return {select(){return {
   eq(){return {maybeSingle:async()=>({data:{role:'admin'},error:null})}},
   order(){return this},range:async()=>({data:[],error:null})
  }}}}
 });
 a.run(`document.getElementById('admin-user-input').value='admin@example.test';document.getElementById('admin-pass-input').value='test-password';openModal('modal-admin-auth')`);
 await a.run('handleAdminAuth()');assert.equal(a.run('state.isAdminAuthenticated'),true);assert.equal(a.w.document.querySelector('#view-admin').classList.contains('hidden'),false);assert.equal(a.w.document.querySelector('#modal-admin-mfa'),null);assert.equal(a.w.document.getElementById('admin-pass-input').value,'');a.dom.window.close();
});

test('Password login still rejects a non-admin and a rejected server authorization',async()=>{
 for(const member of [null,{role:'admin'}]){
  let signedOut=false;const a=app({auth:{signInWithPassword:async()=>({data:{user:{id:'user'}},error:null}),signOut:async()=>{signedOut=true;return {error:null}}},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:member,error:null})})})})});
  a.run(`document.getElementById('admin-user-input').value='user@example.test';document.getElementById('admin-pass-input').value='test-password'`);
  if(member) await assert.rejects(a.run('handleAdminAuth()'));else await a.run('handleAdminAuth()');
  assert.equal(signedOut,true);assert.equal(a.run('state.isAdminAuthenticated'),false);a.dom.window.close();
 }
});
test('Vercel headers prevent framing, sniffing, referrer leakage and mixed content',()=>{
 const config=JSON.parse(fs.readFileSync('vercel.json','utf8'));const headers=Object.fromEntries(config.headers[0].headers.map(h=>[h.key,h.value]));
 assert.equal(headers['X-Frame-Options'],'DENY');assert.equal(headers['X-Content-Type-Options'],'nosniff');assert.equal(headers['Referrer-Policy'],'no-referrer');assert.match(headers['Content-Security-Policy'],/frame-ancestors 'none'/);assert.match(headers['Strict-Transport-Security'],/max-age=31536000/);
});
