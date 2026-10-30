const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync('index.html','utf8');
const script=fs.readFileSync('app.js','utf8');
function app(overrides={},setup=()=>{}){
  const dom=new JSDOM(html,{url:'https://novaleague.vercel.app/',runScripts:'outside-only'});
  const w=dom.window;
  const addEvent=w.addEventListener.bind(w);w.addEventListener=(type,fn,...args)=>{if(type!=='DOMContentLoaded')addEvent(type,fn,...args)};
  w.setInterval=()=>0;w.setTimeout=()=>0;w.clearTimeout=()=>{};
  w.NOVA_CONFIG={supabaseUrl:'https://aqvyehkrbjttvdirtjzd.supabase.co',publishableKey:'sb_publishable_test'};
  const client={rpc:async(name)=>({data:name==='is_admin'?false:[],error:null}),auth:{onAuthStateChange(){},mfa:{},signOut:async()=>({error:null})},...overrides};
  w.supabase={createClient:()=>client};setup(w);const context=dom.getInternalVMContext();vm.runInContext(script,context);
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

test('Booyah ranking counts Top 1 first, uses Top 2 for ties and includes podiums with zero kills',()=>{
 const a=app();a.run(`
  state.players=[{id:'a',nick:'Alice',gameId:'1234****'},{id:'b',nick:'Bruno',gameId:'1234****',kills:99},{id:'c',nick:'Clara',gameId:'9876****'},{id:'d',nick:'Dani',gameId:'5555****'},{id:'e',nick:'Empty',gameId:'7777****'}].map(p=>({kills:0,earnings:0,matchesCount:5,...p}));
  state.matches=[{id:'1',playerId:'a',pos:1},{id:'2',playerId:'a',pos:1},{id:'3',playerId:'b',pos:1},{id:'4',playerId:'b',pos:2},{id:'5',playerId:'b',pos:2},{id:'6',playerId:'b',pos:2},{id:'7',playerId:'c',pos:1},{id:'8',playerId:'c',pos:1},{id:'9',playerId:'c',pos:2},{id:'10',playerId:'d',pos:2},{id:'11',playerId:'e',pos:3},{id:'1',playerId:'a',pos:1},{id:'12',playerId:'deleted',pos:1}];
  switchRankingType('booyahs');
 `);
 const rows=[...a.w.document.querySelectorAll('#ranking-list-container .ranking-entry')];
 assert.deepEqual(rows.map(row=>row.querySelector('strong').textContent),['Clara','Alice','Bruno','Dani']);
 assert.deepEqual(rows.map(row=>row.querySelector('.ranking-main-value').textContent.trim()),['2 Booyahs','2 Booyahs','1 Booyah','0 Booyahs']);
 assert.deepEqual(rows.map(row=>row.querySelector('.ranking-sub-value').textContent),['1x 🥈','0x 🥈','3x 🥈','1x 🥈']);
 assert.equal(rows[0].querySelector('.ranking-sub-value [aria-label]').getAttribute('aria-label'),'1 segundo lugar');
 assert.ok(parseFloat(rows[0].querySelector('.ranking-sub-value').style.fontSize)<parseFloat(rows[0].querySelector('.ranking-main-value').style.fontSize));
 assert.equal(a.w.document.getElementById('tab-ranking-booyahs').getAttribute('aria-pressed'),'true');
 a.dom.window.close();
});

test('Booyah totals recalculate after editing/deleting a result and do not leak into other ranking categories',()=>{
 const a=app();a.run(`state.players=[{id:'a',nick:'Alice',gameId:'12345',kills:7,earnings:12,matchesCount:1}];state.matches=[{id:'1',playerId:'a',pos:1}];switchRankingType('booyahs')`);
 assert.equal(a.w.document.querySelector('.ranking-main-value').textContent.trim(),'1 Booyah');
 a.run(`state.matches[0].pos=2;renderRankingList()`);assert.equal(a.w.document.querySelector('.ranking-main-value').textContent.trim(),'0 Booyahs');assert.equal(a.w.document.querySelector('.ranking-sub-value').textContent,'1x 🥈');
 a.run(`switchRankingType('kills')`);assert.equal(a.w.document.querySelector('.ranking-main-value').textContent.trim(),'7 Kills');
 a.run(`switchRankingType('earnings')`);assert.equal(a.w.document.querySelector('.ranking-main-value').textContent.trim(),'R$ 12.00');
 a.run(`state.matches=[];switchRankingType('booyahs')`);assert.equal(a.w.document.querySelectorAll('.ranking-entry').length,0);assert.match(a.w.document.getElementById('ranking-list-container').textContent,/Nenhum Top 1 ou Top 2/);
 assert.equal(a.w.document.getElementById('tab-ranking-kills').getAttribute('aria-pressed'),'false');a.dom.window.close();
});

test('Booyah ties use kills and name deterministically, with player IDs rather than masked game IDs',()=>{
 const a=app();a.run(`state.players=[{id:'b',nick:'Bruno',gameId:'1234****',kills:5},{id:'a',nick:'Alice',gameId:'1234****',kills:5},{id:'c',nick:'Clara',gameId:'1234****',kills:6}].map(p=>({earnings:0,matchesCount:1,...p}));state.matches=state.players.map(p=>({id:p.id,playerId:p.id,pos:1}));switchRankingType('booyahs')`);
 const rows=[...a.w.document.querySelectorAll('.ranking-entry')];assert.deepEqual(rows.map(row=>row.querySelector('strong').textContent),['Clara','Alice','Bruno']);assert.ok(rows.every(row=>row.querySelector('.ranking-main-value').textContent.trim()==='1 Booyah'));a.dom.window.close();
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

test('Rejected ID starts a shared 15-second wait; typing another ID cannot bypass or extend it',async()=>{
 let now=100000,calls=0;
 const a=app({rpc:async()=>{calls++;return {data:[{error:'ID inválido'}],error:null}}},w=>{w.Date.now=()=>now});
 a.run(`document.getElementById('player-login-id').value='99999999'`);
 const form=a.w.document.getElementById('form-player-login');const event={target:form,preventDefault(){},stopPropagation(){}};
 await a.w.dispatchAction(event,'submit');
 for(const id of ['form-player-login','form-admin-login']) {const button=a.w.document.querySelector('#'+id+' button[type=submit]');assert.equal(button.disabled,true);assert.match(button.textContent,/15s/);}
 assert.equal(Number(a.w.localStorage.getItem('nova_login_retry_until_v1')),115000);
 a.run(`document.getElementById('player-login-id').value='88888888'`);
 now=114999;await a.run('handlePlayerLogin()');await a.run('handleAdminAuth()');assert.equal(calls,1);assert.equal(Number(a.w.localStorage.getItem('nova_login_retry_until_v1')),115000);
 assert.match(form.querySelector('button').textContent,/1s/);
 now=115000;a.run('renderLoginRetryControls()');assert.equal(form.querySelector('button').disabled,false);assert.equal(form.querySelector('button').textContent,'ENTRAR');
 await a.run('handlePlayerLogin()');assert.equal(calls,2);assert.equal(Number(a.w.localStorage.getItem('nova_login_retry_until_v1')),130000);a.dom.window.close();
});

test('Wrong administrative password blocks new authentication requests for exactly 15 seconds',async()=>{
 let now=100000,calls=0;
 const a=app({auth:{signInWithPassword:async()=>{calls++;return {data:{user:null},error:{code:'invalid_credentials',status:400}}}}},w=>{w.Date.now=()=>now});
 a.run(`document.getElementById('admin-user-input').value='admin@example.test';document.getElementById('admin-pass-input').value='wrong-password'`);
 await a.run('handleAdminAuth()');assert.equal(calls,1);assert.equal(a.w.document.querySelector('#form-admin-login button').disabled,true);
 now=114000;a.run(`document.getElementById('admin-pass-input').value='another-password'`);await a.run('handleAdminAuth()');assert.equal(calls,1);
 now=115000;await a.run('handleAdminAuth()');assert.equal(calls,2);a.dom.window.close();
});

test('Wait survives reload and storage events synchronize the countdown with other tabs',()=>{
 let now=105000;const a=app({},w=>{w.Date.now=()=>now;w.localStorage.setItem('nova_login_retry_until_v1','115000')});
 const button=a.w.document.querySelector('#form-player-login button');assert.equal(button.disabled,true);assert.match(button.textContent,/10s/);
 for(const notice of a.w.document.querySelectorAll('[data-login-wait]')){
  assert.equal(notice.classList.contains('hidden'),false);assert.equal(notice.querySelector('[data-login-seconds]').textContent,'10');assert.equal(notice.querySelector('progress').value,10);
 }
 now=110500;a.run('renderLoginRetryControls()');assert.equal(a.w.document.querySelector('[data-login-seconds]').textContent,'5');assert.equal(a.w.document.querySelector('[data-login-progress]').value,4.5);
 now=105000;a.run('renderLoginRetryControls()');
 a.run(`openModal('modal-player-auth');closeModal('modal-player-auth');openModal('modal-admin-auth')`);assert.match(button.textContent,/10s/);
 now=115000;a.run('renderLoginRetryControls()');assert.equal(button.disabled,false);
 for(const notice of a.w.document.querySelectorAll('[data-login-wait]')) {assert.equal(notice.classList.contains('hidden'),true);assert.equal(notice.querySelector('progress').value,0);}
 a.w.localStorage.setItem('nova_login_retry_until_v1','130000');a.w.dispatchEvent(new a.w.StorageEvent('storage',{key:'nova_login_retry_until_v1',newValue:'130000'}));assert.match(button.textContent,/15s/);assert.equal(button.disabled,true);a.dom.window.close();
});

test('Native form validation starts the wait before submitting an invalid login',()=>{
 const a=app();const input=a.w.document.getElementById('player-login-id');input.value='abc';
 input.dispatchEvent(new a.w.Event('invalid',{cancelable:true}));assert.equal(a.w.document.querySelector('#form-player-login button').disabled,true);assert.equal(a.w.document.querySelector('#form-admin-login button').disabled,true);a.dom.window.close();
});

test('Invalid ID or administrative credential format starts the wait without calling the backend',async()=>{
 for(const action of ['handlePlayerLogin','handleAdminAuth']){
  let calls=0;const a=app({rpc:async()=>{calls++;throw Error('Unexpected request')},auth:{signInWithPassword:async()=>{calls++;throw Error('Unexpected request')}}});
  a.run(`document.getElementById('player-login-id').value='abc';document.getElementById('admin-user-input').value='invalid';document.getElementById('admin-pass-input').value='short'`);
  await a.run(action+'()');assert.equal(calls,0);assert.equal(a.w.document.querySelector('#form-admin-login button').disabled,true);a.dom.window.close();
 }
});

test('Network failures do not count as incorrect credentials',async()=>{
 const player=app({rpc:async()=>({data:null,error:{message:'Network failed'}})});player.run(`document.getElementById('player-login-id').value='99999999'`);await assert.rejects(player.run('handlePlayerLogin()'));assert.equal(player.run('loginRetrySeconds()'),0);player.dom.window.close();
 const admin=app({auth:{signInWithPassword:async()=>({data:null,error:{name:'AuthRetryableFetchError',status:503}})}});admin.run(`document.getElementById('admin-user-input').value='admin@example.test';document.getElementById('admin-pass-input').value='test-password'`);await admin.run('handleAdminAuth()');assert.equal(admin.run('loginRetrySeconds()'),0);admin.dom.window.close();
});
test('Vercel headers prevent framing, sniffing, referrer leakage and mixed content',()=>{
 const config=JSON.parse(fs.readFileSync('vercel.json','utf8'));const headers=Object.fromEntries(config.headers[0].headers.map(h=>[h.key,h.value]));
 assert.equal(headers['X-Frame-Options'],'DENY');assert.equal(headers['X-Content-Type-Options'],'nosniff');assert.equal(headers['Referrer-Policy'],'no-referrer');assert.match(headers['Content-Security-Policy'],/frame-ancestors 'none'/);assert.match(headers['Strict-Transport-Security'],/max-age=31536000/);
});

test('A delayed admin authorization response cannot restore access after logout',async()=>{
 let release,calls=0;
 const a=app({rpc:async name=>name==='is_admin' && ++calls===1 ? new Promise(r=>{release=r}) : {data:name==='is_admin'?false:[],error:null},
  from:()=>({select(){return this},order(){return this},range:async()=>({data:[],error:null})})});
 const reading=a.run('fetchFromDatabase()');const leaving=a.run('adminLogout()');
 release({data:true,error:null});await Promise.all([reading,leaving]);
 assert.equal(a.run('state.isAdminAuthenticated'),false);a.dom.window.close();
});

test('A delayed player message response is discarded after logout',async()=>{
 let release,entered;const waiting=new Promise(r=>{entered=r});
 const a=app({rpc:async name=>{
  if(name==='player_session_login')return {data:[{id:'11111111-1111-4111-8111-111111111111',nick:'QA',gameId:'99999001',status:'normal',kills:0,earnings:0}],error:null};
  if(name==='get_my_messages'){entered();return new Promise(r=>{release=r})}
  return {data:name==='is_admin'?false:[],error:null};
 },from:()=>({select(){return this},order(){return this},range:async()=>({data:[],error:null})})});
 a.run(`playerToken='${'a'.repeat(64)}'`);
 const reading=a.run('fetchFromDatabase()');await waiting;const leaving=a.run('playerLogout()');
 release({data:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',recipientId:'all',text:'PRIVATE_QA_MESSAGE',readBy:[]}],error:null});
 await Promise.all([reading,leaving]);assert.equal(a.run('state.messages.length'),0);assert.equal(a.run('state.currentPlayer'),null);
 assert.doesNotMatch(a.w.document.body.textContent,/PRIVATE_QA_MESSAGE/);a.dom.window.close();
});

test('Logout removes private dashboard values and unfinished admin forms from the DOM',()=>{
 const a=app();a.run(`state.isAdminAuthenticated=true;state.currentPlayer={id:'11111111-1111-4111-8111-111111111111',nick:'PRIVATE_QA_NICK',gameId:'99999001',kills:0,earnings:0};state.players=[state.currentPlayer];renderAll();openAddMatchModal();state.isAdminAuthenticated=false;state.currentPlayer=null;state.players=[];renderAll()`);
 assert.notEqual(a.w.document.getElementById('dash-player-id').innerText,'99999001');
 assert.doesNotMatch(a.w.document.body.textContent,/PRIVATE_QA_NICK/);a.dom.window.close();
});

test('Stored XSS payloads remain text across rankings, messages, matches, coupons and editor options',()=>{
 const payloads=['<img src=x onerror="window.PWNED=1">','</option><svg onload="window.PWNED=1">',
  '\" autofocus onfocus=window.PWNED=1 x=\"',"'><iframe srcdoc='<script>window.PWNED=1</script>'>",
  '<a href="javascript:window.PWNED=1">click</a>','<form id="actions"><input name="handleAdminAuth"></form>',
  '${window.PWNED=1}', '<style>body{display:none}</style>'];
 for(const payload of payloads){
  const a=app();a.w.payload=payload;
  a.run(`
   const qa={id:'11111111-1111-4111-8111-111111111111',nick:window.payload,gameId:'99999001',status:'normal',kills:1,matchesCount:1,earnings:1};
   state.isAdminAuthenticated=true;state.currentPlayer=qa;state.players=[qa];
   state.matches=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',number:window.payload,date:window.payload,playerId:qa.id,playerNick:window.payload,playerGameId:qa.gameId,kills:1,pos:1,total:1}];
   state.messages=[{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',recipientId:'all',text:window.payload,date:window.payload,readBy:[]}];
   state.coupons=[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',code:'SAFE_QA',discount:window.payload,valid:window.payload}];
   renderAll();switchRankingType('booyahs');openAddMatchModal();openEditMatchModal(getGroupedMatches()[0].key);
  `);
  assert.equal(a.w.document.querySelector('[onerror],[onload],[onfocus],iframe,[href^="javascript:"],form#actions,style'),null);
  assert.equal(a.w.document.querySelector('#profile-content').textContent.includes(payload),true);
  assert.equal(a.w.document.querySelector('#ranking-list-container').textContent.includes(payload),true);
  assert.equal(a.w.PWNED,undefined);a.dom.window.close();
 }
});

test('All accepted ID lengths are masked unless explicitly rendering the logged-in player',()=>{
 const a=app();for(const id of ['123','1234','12345','12345678901234567890'])assert.match(a.w.maskGameId(id),/\*/);
 assert.equal(a.w.maskGameId('1234****'),'1234****');a.dom.window.close();
});

test('Player creation sends only nickname and ID; protected balances come from database defaults',async()=>{
 const inserted=[];const a=app({from:()=>({insert:async rows=>{inserted.push(...rows);return {error:null}}})});
 a.run(`fetchFromDatabase=async()=>{};state.isAdminAuthenticated=true;document.getElementById('new-player-nick').value='QA';document.getElementById('new-player-id').value='88888001'`);
 await a.run('handleAddPlayer()');
 a.run(`document.getElementById('bulk-players-input').value='88888002, QA2'`);await a.run('handleBulkPlayersImport()');
 assert.equal(inserted.length,2);for(const row of inserted)assert.deepEqual(Object.keys(row).sort(),['gameId','nick']);a.dom.window.close();
});

test('Admin logout sends the existing session to Auth before removing its local credential',async()=>{
 const {GoTrueClient}=require('@supabase/auth-js');let auth;const requests=[];
 const a=app({auth:{signOut:options=>auth.signOut(options)},from:()=>({select(){return this},order(){return this},range:async()=>({data:[],error:null})})},w=>{
  const exp=Math.floor(Date.now()/1000)+3600;
  const access_token=[{alg:'HS256',typ:'JWT'},{exp,sub:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',role:'authenticated'}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.')+'.synthetic';
  w.sessionStorage.setItem('nova_admin_auth_v2',JSON.stringify({access_token,refresh_token:'synthetic-refresh',expires_at:exp,user:{id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}}));
  auth=new GoTrueClient({url:'https://auth.example.test',storage:w.sessionStorage,storageKey:'nova_admin_auth_v2',persistSession:true,autoRefreshToken:false,detectSessionInUrl:false,
   fetch:async(url,options)=>{requests.push({url,authorized:!!options.headers.Authorization});return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}})}});
 });
 try{
  await auth.initialize();await a.run('adminLogout()');
  assert.ok(requests.some(r=>r.url==='https://auth.example.test/logout?scope=local' && r.authorized));
  assert.equal(a.w.sessionStorage.getItem('nova_admin_auth_v2'),null);
 }finally{await auth.dispose();a.dom.window.close();}
});

test('A failed refresh clears both privileged authorization and private player data',async()=>{
 const a=app({rpc:async()=>({data:true,error:null}),from:()=>({select(){return this},order(){return this},range:async()=>({data:null,error:{message:'Unavailable'}})})});
 a.run(`state.isAdminAuthenticated=true;state.currentPlayer={id:'private'};state.messages=[{text:'PRIVATE_QA'}]`);
 await a.run('fetchFromDatabase()');assert.equal(a.run('state.isAdminAuthenticated'),false);assert.equal(a.run('state.currentPlayer'),null);assert.equal(a.run('state.messages.length'),0);
 assert.equal(a.w.document.getElementById('conn-status-badge').textContent,'SEM CONEXÃO');a.dom.window.close();
});

function financeData(overrides={}) {
 return {participations:'2',registration_fee:'6.00',accumulated_total:'12.00',payout_total:'5.50',advertising_total:'0.00',balance:'6.50',version:0,non_participants:'0',non_participant_revenue:'0.00',entries:[],entries_count:'0',...overrides};
}

test('CSV export escapes separators, quotes and spreadsheet formulas',()=>{
 const a=app();const csv=a.w.makeReportCsv(['Nick','Descrição'],[['=HYPERLINK("bad")','a;b'],['\t=1+1','two\nlines'],[' @SUM(1)','"quoted"']]);
 assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));assert.ok(csv.includes('"a;b"'));assert.ok(csv.includes('"\'\t=1+1"'));assert.ok(csv.includes('"\' @SUM(1)"'));a.dom.window.close();
});

test('Reversal asks for a reason, updates totals and keeps the original visible',async()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';let captured;
 const a=app({rpc:async(name,args)=>{captured={name,args};return {data:financeData({advertising_total:'0.00',version:2,entries:[{id,kind:'advertising',amount:'80.00',created_at:'2026-10-30T00:00:00Z',reversed_at:'2026-10-30T01:00:00Z',reversal_reason:'Duplicado'}],entries_count:'1'}),error:null}}});
 a.w.prompt=()=> 'Duplicado';a.run('state.isAdminAuthenticated=true');await a.w.reverseFinanceEntry(id);
 assert.equal(captured.name,'reverse_finance_entry');assert.equal(captured.args.p_reason,'Duplicado');assert.match(a.w.document.getElementById('finance-entries-list').textContent,/ESTORNADO/);assert.equal(a.w.document.querySelector('[data-click="reverseFinanceEntry"]'),null);a.dom.window.close();
});

test('Audit responses arriving after logout are discarded',async()=>{
 let release;const a=app({rpc:async()=>new Promise(r=>{release=r})});a.run('state.isAdminAuthenticated=true');const pending=a.w.loadAdminAudit(true);a.run('invalidateSessionReads();renderAll()');release({data:[{id:'1',administrator:'PRIVATE_ADMIN',operation:'UPDATE',entity:'partidas',created_at:'2026-10-30'}],error:null});await pending;
 assert.doesNotMatch(a.w.document.getElementById('admin-audit-list').textContent,/PRIVATE_ADMIN/);a.dom.window.close();
});

test('Results export downloads a CSV with the selected period and safe text cells',async()=>{
 let captured,blob,filename;
 const a=app({rpc:async(name,args)=>{captured={name,args};return {data:[{id:'qa',created_at:'2026-10-30',number:'1',date:'30/10',playerNick:'=DANGEROUS()',playerGameId:'99999001',kills:1,pos:1,total:'2.50',registration_revenue:'6.00'}],error:null}}});
 a.w.Blob=Blob;a.w.URL.createObjectURL=b=>{blob=b;return 'blob:qa'};a.w.URL.revokeObjectURL=()=>{};a.w.HTMLAnchorElement.prototype.click=function(){filename=this.download};
 a.run('state.isAdminAuthenticated=true');a.w.document.getElementById('report-kind').value='results';a.w.document.getElementById('report-start').value='2026-10-30';a.w.document.getElementById('report-end').value='2026-10-30';
 await a.w.exportAdminReport();assert.equal(captured.name,'get_admin_report');assert.equal(captured.args.p_start,'2026-10-30');assert.match(filename,/nova-results-.*\.csv/);const csv=await blob.text();assert.ok(csv.includes("'=DANGEROUS()"));assert.ok(csv.includes('2,50'));a.dom.window.close();
});

test('Admin gains tab loads its four currency totals and hides the other admin sections',async()=>{
 const a=app({rpc:async()=>({data:financeData(),error:null})});a.run('state.isAdminAuthenticated=true');
 await a.run(`switchAdminSubtab('finances',document.querySelector('.admin-tile[data-arg="finances"]'))`);
 assert.equal(a.w.document.getElementById('admin-sub-finances').classList.contains('hidden'),false);
 for(const name of ['players','matches','coupons','messages'])assert.equal(a.w.document.getElementById('admin-sub-'+name).classList.contains('hidden'),true);
 for(const [id,value]of Object.entries({'finance-accumulated':'12,00','finance-payout':'5,50','finance-ad-spend':'0,00','finance-balance':'6,50'}))assert.ok(a.w.document.getElementById(id).textContent.includes(value));
 assert.equal(a.w.document.getElementById('finance-ad-spend-input').disabled,false);
 assert.match(a.w.document.getElementById('finance-status').textContent,/2 participações/);a.dom.window.close();
});

test('Financial amounts retain cents, format large totals exactly and display a negative balance',async()=>{
 const a=app({rpc:async()=>({data:financeData({payout_total:'12.50',advertising_total:'4.00',balance:'-4.50'}),error:null})});
 a.run('state.isAdminAuthenticated=true');await a.run('loadAdminFinances()');
 assert.equal(a.w.document.getElementById('finance-balance').textContent,'-R$\u00a04,50');
 assert.equal(a.w.document.getElementById('finance-balance').classList.contains('finance-negative'),true);
 assert.equal(a.w.formatFinanceMoney('12345678901234567890.05'),'R$\u00a012.345.678.901.234.567.890,05');a.dom.window.close();
});

test('Saving advertising expense waits for the database, prevents duplicate submits and updates the balance',async()=>{
 let release,calls=0,submitted;
 const a=app({rpc:async(name,args)=>{
  if(name==='add_admin_finance_entry'){calls++;submitted=args;return new Promise(r=>{release=r})}
  return {data:financeData(),error:null};
 }});a.run('state.isAdminAuthenticated=true');await a.run('loadAdminFinances()');
 const input=a.w.document.getElementById('finance-ad-spend-input');input.value='3.25';input.dispatchEvent(new a.w.Event('input'));
 const form=a.w.document.getElementById('form-ad-spend'),event={target:form,preventDefault(){},stopPropagation(){}};
 const saving=a.w.dispatchAction(event,'submit');await a.w.dispatchAction(event,'submit');
 assert.equal(calls,1);assert.equal(input.disabled,true);assert.match(a.w.document.getElementById('finance-ad-spend').textContent,/0,00/);
 release({data:financeData({advertising_total:'3.25',balance:'3.25',version:1}),error:null});await saving;
 assert.equal(submitted.p_amount,'3.25');assert.equal(submitted.p_kind,'advertising');assert.match(submitted.p_request_id,/^[a-f0-9-]{36}$/);assert.equal(input.value,'');
 assert.match(a.w.document.getElementById('finance-ad-spend').textContent,/3,25/);assert.match(a.w.document.getElementById('finance-balance').textContent,/3,25/);
 assert.equal(input.disabled,false);assert.equal(form.querySelector('button').disabled,false);a.dom.window.close();
});

test('Failed financial reads show no fabricated zeroes and do not revoke the administrator session',async()=>{
 const a=app({rpc:async()=>({data:null,error:{code:'PGRST202'}})});a.run('state.isAdminAuthenticated=true');await a.run('loadAdminFinances()');
 assert.equal(a.run('state.isAdminAuthenticated'),true);assert.equal(a.run('state.finances'),null);
 for(const id of ['finance-accumulated','finance-payout','finance-ad-spend','finance-balance'])assert.equal(a.w.document.getElementById(id).textContent,'—');
 assert.equal(a.w.document.getElementById('finance-ad-spend-input').disabled,true);assert.match(a.w.document.getElementById('finance-status').textContent,/Não foi possível/);a.dom.window.close();
});

test('Refreshing the active gains tab updates automatic totals without discarding an unsaved expense',async()=>{
 let data=financeData();const a=app({rpc:async name=>({data:name==='is_admin'?true:name==='get_admin_finances'?data:[],error:null}),from:()=>({select(){return this},order(){return this},range:async()=>({data:[],error:null})})});
 a.run('state.isAdminAuthenticated=true');await a.run(`switchAdminSubtab('finances',document.querySelector('.admin-tile[data-arg="finances"]'))`);
 const input=a.w.document.getElementById('finance-ad-spend-input');input.value='1.25';input.dispatchEvent(new a.w.Event('input'));
 data=financeData({participations:'3',accumulated_total:'18.00',balance:'12.50'});
 await a.run('fetchFromDatabase()');assert.match(a.w.document.getElementById('finance-accumulated').textContent,/18,00/);assert.equal(input.value,'1.25');a.dom.window.close();
});

test('Retrying an expense after a lost response reuses the submission ID and preserves the draft',async()=>{
 let calls=0;const captured=[];
 const a=app({rpc:async(name,args)=>{
  if(name==='add_admin_finance_entry'){captured.push(args);if(++calls===1)return {data:null,error:{message:'Lost response'}};return {data:financeData({advertising_total:'7.25',balance:'-0.75',version:1}),error:null};}
  return {data:financeData(),error:null};
 }});a.run('state.isAdminAuthenticated=true');await a.run('loadAdminFinances()');
 const input=a.w.document.getElementById('finance-ad-spend-input');input.value='7.25';input.dispatchEvent(new a.w.Event('input'));
 await assert.rejects(a.run('handleSaveAdSpend()'));assert.equal(input.value,'7.25');await a.run('handleSaveAdSpend()');
 assert.equal(captured[0].p_request_id,captured[1].p_request_id);assert.equal(input.value,'');assert.match(a.w.document.getElementById('finance-ad-spend').textContent,/7,25/);a.dom.window.close();
});

test('Invalid advertising amounts never reach the API',async()=>{
 let saves=0;const a=app({rpc:async name=>{if(name==='add_admin_finance_entry')saves++;return {data:financeData(),error:null}}});
 a.run('state.isAdminAuthenticated=true');await a.run('loadAdminFinances()');
 for(const value of ['', '0', '-1', '0.001', '1000000001']){
  a.w.document.getElementById('finance-ad-spend-input').value=value;await assert.rejects(a.run('handleSaveAdSpend()'));
 }
 assert.equal(saves,0);a.dom.window.close();
});

test('Financial reads completing after logout cannot restore private totals or inputs',async()=>{
 let release;const a=app({rpc:async name=>name==='get_admin_finances'?new Promise(r=>{release=r}):{data:name==='is_admin'?false:[],error:null},from:()=>({select(){return this},order(){return this},range:async()=>({data:[],error:null})})});
 a.run('state.isAdminAuthenticated=true');const reading=a.run('loadAdminFinances()');const leaving=a.run('adminLogout()');
 release({data:financeData(),error:null});await Promise.all([reading,leaving]);
 assert.equal(a.run('state.finances'),null);assert.equal(a.w.document.getElementById('finance-balance').textContent,'—');assert.equal(a.w.document.getElementById('finance-ad-spend-input').value,'');a.dom.window.close();
});

test('The gains action is blocked for visitors even if they enable the form through the DOM',async()=>{
 let calls=0;const a=app({rpc:async()=>{calls++;return {data:financeData(),error:null}}});
 const form=a.w.document.getElementById('form-ad-spend');form.querySelectorAll('input,button').forEach(el=>{el.disabled=false});
 await a.w.dispatchAction({target:form,preventDefault(){},stopPropagation(){}},'submit');assert.equal(calls,0);a.dom.window.close();
});

test('A financial read started during a save cannot overwrite the successful saved expense',async()=>{
 let releaseSave,releaseRead,calls=0;
 const a=app({rpc:async name=>{
  if(name==='add_admin_finance_entry')return new Promise(r=>{releaseSave=r});
  if(++calls===1)return {data:financeData(),error:null};
  return new Promise(r=>{releaseRead=r});
 }});a.run('state.isAdminAuthenticated=true');await a.run('loadAdminFinances()');
 a.w.document.getElementById('finance-ad-spend-input').value='3.25';
 const saving=a.run('handleSaveAdSpend()');const reading=a.run('loadAdminFinances(true)');
 releaseSave({data:financeData({advertising_total:'3.25',balance:'3.25',version:1}),error:null});await saving;
 releaseRead({data:financeData(),error:null});await reading;
 assert.equal(a.run('state.finances.advertising_total'),'3.25');assert.match(a.w.document.getElementById('finance-balance').textContent,/3,25/);assert.equal(a.w.document.getElementById('finance-ad-spend-input').disabled,false);a.dom.window.close();
});

test('Paid non-participant batches use their own form and never change ranking state',async()=>{
 let captured;const a=app({rpc:async(name,args)=>{
  if(name==='add_admin_finance_entry'){captured=args;return {data:financeData({non_participants:'5',non_participant_revenue:'30.00',accumulated_total:'42.00',balance:'36.50',version:1}),error:null};}
  return {data:financeData(),error:null};
 }});a.run(`state.isAdminAuthenticated=true;state.players=[{id:'player',nick:'QA'}];state.matches=[]`);await a.run('loadAdminFinances()');
 a.w.document.getElementById('finance-non-participants-input').value='5';await a.run('handleAddNonParticipants()');
 assert.equal(captured.p_kind,'non_participant');assert.equal(captured.p_quantity,5);assert.equal(captured.p_amount,null);
 assert.equal(a.w.document.getElementById('finance-non-participants').textContent,'5');assert.match(a.w.document.getElementById('finance-accumulated').textContent,/42,00/);
 assert.equal(a.run('state.players.length'),1);assert.equal(a.run('state.matches.length'),0);assert.equal(a.w.document.getElementById('finance-non-participants-input').value,'');a.dom.window.close();
});

test('Invalid absent counts never reach the API, and ledger notes render as text',async()=>{
 let writes=0;const a=app({rpc:async(name)=>{if(name==='add_admin_finance_entry')writes++;return {data:financeData({entries:[{id:'x',kind:'advertising',amount:'80.00',quantity:null,note:'<img src=x onerror=alert(1)>',created_at:'2026-10-26T00:00:00Z'}],entries_count:'1'}),error:null}}});
 a.run('state.isAdminAuthenticated=true');await a.run('loadAdminFinances()');
 for(const value of ['', '0', '-1', '1.5', '1000001']){a.w.document.getElementById('finance-non-participants-input').value=value;await assert.rejects(a.run('handleAddNonParticipants()'));}
 assert.equal(writes,0);assert.equal(a.w.document.querySelector('#finance-entries-list img'),null);assert.match(a.w.document.getElementById('finance-entries-list').textContent,/<img/);a.dom.window.close();
});
