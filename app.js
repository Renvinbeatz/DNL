
    const config = window.NOVA_CONFIG || {};
    const _supabase = window.supabase && /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.supabaseUrl || '') && /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey || '')
      ? window.supabase.createClient(config.supabaseUrl, config.publishableKey, { auth: { storage: sessionStorage, storageKey: 'nova_admin_auth_v2', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }) : null;
    const state = {
      isAdminAuthenticated: false,
      currentPlayer: null,
      players: [],
      matches: [],
      coupons: [],
      messages: [],
      finances: null
    };

    // Token só nesta aba; validade renovável de 7 dias, limitada a 30 dias
    // no banco. Fechar a aba normalmente exige informar o ID novamente.
    const PLAYER_SESSION_KEY = 'nova_league_player_session_v2';
    localStorage.removeItem('nova_league_player_session');
    let playerToken = sessionStorage.getItem(PLAYER_SESSION_KEY) || '';
    let connectionState = 'connecting';
    let fetching = null;
    let sessionEpoch = 0;
    let financeFetching = null;
    let financeReadEpoch = 0;
    let financeLoadState = 'idle';
    let financeDraftDirty = false;
    const actionLocks = new Set();
    const LOGIN_RETRY_KEY = 'nova_login_retry_until_v1';
    const LOGIN_RETRY_MS = 15000;
    const loginActions = new Set(['handlePlayerLogin','handleAdminAuth']);
    let loginRetryUntil = 0;
    let loginRetryTimer = null;
    const safeId = /^[0-9]{3,20}$/;
    const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

    let adminClickCount = 0;
    let adminClickTimer = null;
    let filterDebounceTimer = null;
    let currentMatchPage = 1;
    const MATCHES_PER_PAGE = 10;
    let currentRankingType = 'kills'; // kills, earnings ou booyahs

    function switchRankingType(type) {
      if(!['kills','earnings','booyahs'].includes(type)) return;
      currentRankingType = type;
      renderRankingList();
    }

    // Linguagem visual das medalhas: medalhão circular + estrela central,
    // 3 tiers dentro da própria paleta (sem introduzir azul/roxo/rosa).
    let svgIdCounter = 0;
    function nextSvgId(prefix) { svgIdCounter++; return prefix + svgIdCounter; }

    const TIER_COLORS = {
      ouro:   { from: '#f8d775', to: '#e5b839', glow: 'rgba(248,215,117,0.6)' },
      prata:  { from: '#e8ecf1', to: '#8d99ae', glow: 'rgba(141,153,174,0.4)' },
      bronze: { from: '#c7962c', to: '#8a651c', glow: 'rgba(199,150,44,0.4)' }
    };

    function getRoundMedalSVG(tierKey, size = 26) {
      const t = TIER_COLORS[tierKey];
      if (!t) return null;
      const gradId = nextSvgId('medalGrad');
      return `
        <svg viewBox="0 0 40 40" width="${size}" height="${size}" style="filter: drop-shadow(0 0 5px ${t.glow}); flex-shrink: 0;">
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="${t.from}"/>
              <stop offset="100%" stop-color="${t.to}"/>
            </linearGradient>
          </defs>
          <circle cx="20" cy="20" r="17" fill="url(#${gradId})" stroke="rgba(0,0,0,0.25)" stroke-width="1"/>
          <circle cx="20" cy="20" r="17" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.5" stroke-dasharray="2 3"/>
          <path d="M20 11 L22.5 17 L29 17.5 L24 21.8 L25.5 28 L20 24.5 L14.5 28 L16 21.8 L11 17.5 L17.5 17 Z" fill="#0b0e14" opacity="0.75"/>
        </svg>
      `;
    }

    // Honra: formato de escudo, dourado + vermelho — reconhecimento manual
    function getHonraSVG(size = 20) {
      const gradId = nextSvgId('honraGrad');
      return `
        <svg viewBox="0 0 40 40" width="${size}" height="${size}" style="filter: drop-shadow(0 0 5px rgba(231,76,60,0.5)); flex-shrink: 0;">
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#f8d775"/>
              <stop offset="100%" stop-color="#e74c3c"/>
            </linearGradient>
          </defs>
          <path d="M20 4 L34 9 V19 C34 29 28 35 20 38 C12 35 6 29 6 19 V9 Z" fill="url(#${gradId})" stroke="rgba(0,0,0,0.25)" stroke-width="1"/>
          <path d="M20 4 L34 9 V19 C34 29 28 35 20 38 C12 35 6 29 6 19 V9 Z" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.2"/>
          <path d="M20 12 L23 18 L29 18.5 L24.5 22.5 L26 28 L20 24.7 L14 28 L15.5 22.5 L11 18.5 L17 18 Z" fill="#0b0e14" opacity="0.75"/>
        </svg>
      `;
    }

    // Verificado: selo-estrela com check, dourado + verde — reconhecimento manual
    function getVerificadoSVG(size = 20) {
      const gradId = nextSvgId('verifGrad');
      return `
        <svg viewBox="0 0 40 40" width="${size}" height="${size}" style="filter: drop-shadow(0 0 5px rgba(46,204,113,0.5)); flex-shrink: 0;">
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#f8d775"/>
              <stop offset="100%" stop-color="#2ecc71"/>
            </linearGradient>
          </defs>
          <path d="M20 3 L24 7 L29.5 6 L30 11.5 L34.5 15 L31.5 20 L34.5 25 L30 28.5 L29.5 34 L24 33 L20 37 L16 33 L10.5 34 L10 28.5 L5.5 25 L8.5 20 L5.5 15 L10 11.5 L10.5 6 L16 7 Z" fill="url(#${gradId})" stroke="rgba(0,0,0,0.25)" stroke-width="1"/>
          <path d="M13 20 L18 25 L27 14" fill="none" stroke="#0b0e14" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
        </svg>
      `;
    }

    function getAchievementMedalSVG(key, size) {
      if (key === 'ouro' || key === 'prata' || key === 'bronze') return getRoundMedalSVG(key, size);
      if (key === 'honra') return getHonraSVG(size);
      if (key === 'verificado') return getVerificadoSVG(size);
      return '';
    }

    // Sistema de conquistas: Bronze/Prata/Ouro são automáticas e se
    // SUBSTITUEM (só a mais alta aparece). Honra e Verificado são manuais
    // (só o ADM concede) e aparecem JUNTO com a de progressão.
    const MEDAL_INFO = {
      bronze: {
        name: 'Bronze',
        desc: 'Primeira conquista de progressão na NØVA LEAGUE.',
        req: '50 kills ou R$ 200,00 acumulados.'
      },
      prata: {
        name: 'Prata',
        desc: 'Jogador em ascensão na liga.',
        req: '100 kills ou R$ 500,00 acumulados.'
      },
      ouro: {
        name: 'Ouro',
        desc: 'Elite da NØVA LEAGUE.',
        req: '250 kills ou R$ 1.000,00 acumulados.'
      },
      honra: {
        name: 'Honra',
        desc: 'Reconhecimento por fidelidade e frequência na liga.',
        req: 'Concedida manualmente pela organização — não tem número fixo.'
      },
      verificado: {
        name: 'Verificado',
        desc: 'Reconhecimento oficial de criador de conteúdo ou parceiro da NØVA LEAGUE.',
        req: 'Concedida manualmente pela organização — não tem número fixo.'
      }
    };

    // Qual tier de progressão (bronze/prata/ouro) o jogador já alcançou —
    // retorna só a mais alta, elas se substituem.
    function getProgressionTier(kills, earnings) {
      kills = kills || 0;
      earnings = parseFloat(earnings) || 0;
      if (kills >= 250 || earnings >= 1000) return 'ouro';
      if (kills >= 100 || earnings >= 500) return 'prata';
      if (kills >= 50 || earnings >= 200) return 'bronze';
      return null;
    }

    // Monta a fileira de medalhas de conquista pra exibir ao lado do nick
    // (ex: Bronze - Honra - Verificado)
    function renderAchievementMedals(player) {
      const badges = [];
      const tier = getProgressionTier(player.kills, player.earnings);
      if (tier) badges.push(tier);
      if (player.is_honra) badges.push('honra');
      if (player.is_verificado) badges.push('verificado');

      if (badges.length === 0) return '';

      const iconsHTML = badges.map(key => `
        <span data-click="showMedalInfo" data-arg="${key}" style="cursor: pointer; display: inline-flex;">
          ${getAchievementMedalSVG(key, 18)}
        </span>
      `).join('');

      return `<span style="display: inline-flex; align-items: center; gap: 4px; margin-left: 6px; vertical-align: middle;">${iconsHTML}</span>`;
    }

    function showMedalInfo(key) {
      const info = MEDAL_INFO[key];
      if (!info) return;
      document.getElementById('medal-info-icon').innerHTML = getAchievementMedalSVG(key, 64);
      document.getElementById('medal-info-name').innerText = info.name;
      document.getElementById('medal-info-desc').innerText = info.desc;
      document.getElementById('medal-info-req').innerHTML = `<strong>Requisito:</strong> ${info.req}`;
      openModal('modal-medal-info');
    }

    async function toggleMedalFlag(playerId, field, newValue) {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }
      if (!['is_honra','is_verificado'].includes(field) || typeof newValue!=='boolean' || !uuidPattern.test(playerId)) throw new Error('Dados inválidos.');
      const changed=await checked(_supabase.from('jogadores').update({[field]:newValue}).eq('id',playerId).select('id'));
      if(changed.length!==1) throw new Error('Operação não autorizada.');
      const error=null;
      if (error) { showToast('Erro ao atualizar medalha.', 'danger'); return; }
      const player = state.players.find(p => String(p.id) === String(playerId));
      if (player) player[field] = newValue;
      showToast(newValue ? 'Medalha concedida!' : 'Medalha removida.');
      renderAll();
    }

    function renderRankingList() {
      const rankingContainer = document.getElementById('ranking-list-container');
      const isBooyahs=currentRankingType==='booyahs';
      for(const type of ['kills','earnings','booyahs']){
        const tab=document.getElementById('tab-ranking-'+type);
        tab.classList.toggle('active',currentRankingType===type);
        tab.setAttribute('aria-pressed',String(currentRankingType===type));
      }
      document.getElementById('ranking-description').textContent=isBooyahs
        ? 'Mais Booyahs (Top 1) primeiro. Desempate por Top 2, kills e nome. Participam jogadores com Top 1 ou Top 2 registrado.'
        : currentRankingType==='earnings' ? 'Participam jogadores com ganhos acumulados acima de zero.' : 'Participam jogadores com pelo menos 1 abate registrado.';

      // Public projections use matching player aliases; never group by a masked game ID.
      const podiums=new Map(),seenMatches=new Set();
      if(isBooyahs) for(const match of state.matches){
        const pos=Number(match.pos);
        if(!match.playerId || (pos!==1 && pos!==2) || (match.id && seenMatches.has(match.id))) continue;
        if(match.id) seenMatches.add(match.id);
        const id=String(match.playerId);
        if(!podiums.has(id)) podiums.set(id,{booyahs:0,top2:0});
        podiums.get(id)[pos===1 ? 'booyahs' : 'top2']++;
      }

      const players=isBooyahs ? state.players.map(p=>({...p,...(podiums.get(String(p.id)) || {booyahs:0,top2:0})})) : state.players;
      const eligiblePlayers = players.filter(p =>
        isBooyahs ? p.booyahs>0 || p.top2>0 : currentRankingType === 'earnings' ? parseFloat(p.earnings) > 0 : p.kills > 0
      );

      if (eligiblePlayers.length === 0) {
        rankingContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-trophy"></i><p>${isBooyahs ? 'Nenhum Top 1 ou Top 2 registrado ainda.' : 'Nenhum participante no ranking ainda.'}</p></div>`;
        return;
      }

      const sortedPlayers = [...eligiblePlayers].sort((a, b) =>
        isBooyahs
          ? (b.booyahs-a.booyahs) || (b.top2-a.top2) || (b.kills-a.kills) || String(a.nick).localeCompare(String(b.nick)) || String(a.id).localeCompare(String(b.id))
          : currentRankingType === 'earnings'
          ? (parseFloat(b.earnings) - parseFloat(a.earnings))
          : (b.kills - a.kills) || String(a.nick).localeCompare(String(b.nick))
      );

      rankingContainer.innerHTML = sortedPlayers.map((p, idx) => {
        const mainValue = isBooyahs
          ? `${p.booyahs} ${p.booyahs===1 ? 'Booyah' : 'Booyahs'}`
          : currentRankingType === 'earnings'
          ? `R$ ${parseFloat(p.earnings).toFixed(2)}`
          : `${p.kills} Kills`;
        const subValue = isBooyahs
          ? `<span title="Top 2" aria-label="${p.top2} ${p.top2===1 ? 'segundo lugar' : 'segundos lugares'}">${p.top2}x <span aria-hidden="true">🥈</span></span>`
          : currentRankingType === 'earnings'
          ? `${p.kills} kills`
          : `R$ ${parseFloat(p.earnings).toFixed(2)}`;
        const positionHTML = `<span style="font-family: var(--font-heading); font-size: 15px; color: var(--neon-gold); width: 26px; text-align: center; flex-shrink: 0;">#${idx + 1}</span>`;

        return `
          <div class="card ranking-entry" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 12px;">
            <div style="display: flex; align-items: center; gap: 10px;">
              ${positionHTML}
              <div>
                <strong style="color: #fff; font-size: 13px;">${escapeHTML(p.nick)}</strong>${renderAchievementMedals(p)}
                <div style="font-size: 10px; color: var(--text-muted);">ID: ${escapeHTML(maskGameId(p.gameId))} | Partidas: ${p.matchesCount}</div>
              </div>
            </div>
            <div style="text-align: right;">
              <div class="ranking-main-value" style="font-family: var(--font-sub); font-weight: 700; color: var(--neon-gold); font-size: 16px;">
                ${mainValue}
              </div>
              <div class="ranking-sub-value" style="font-size: 10px; color: var(--text-muted);">${subValue}</div>
            </div>
          </div>
        `;
      }).join('');
    }

    function escapeHTML(str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    // Sem o Supabase configurado, o site avisa isso claramente em vez de
    // fingir que está tudo certo salvando só no localStorage do navegador.
    function updateConnectionBadge() {
      const badge = document.getElementById('conn-status-badge');
      badge.textContent = !_supabase ? 'INDISPONÍVEL' : connectionState === 'online' ? 'ONLINE' : connectionState === 'offline' ? 'SEM CONEXÃO' : 'CONECTANDO...';
      badge.className = 'conn-status ' + (connectionState === 'online' ? 'online' : 'offline');
      document.getElementById('setup-warning-box').classList.toggle('hidden', !!_supabase && connectionState !== 'offline');
    }

    function handleSecretAdminTrigger() {
      adminClickCount++;
      clearTimeout(adminClickTimer);
      if (adminClickCount >= 5) {
        adminClickCount = 0;
        openAdminPanel();
      } else {
        adminClickTimer = setTimeout(() => { adminClickCount = 0; }, 2000);
      }
    }

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        openAdminPanel();
      }
    });

    // Busca os dados COMPARTILHADOS do Supabase — é isso que garante que
    // todo mundo (ADM e jogadores, em qualquer dispositivo) vê os mesmos dados.
    function invalidateSessionReads() {
      sessionEpoch++;
      fetching=null;
      financeFetching=null;financeReadEpoch++;financeLoadState='idle';financeDraftDirty=false;
      Object.assign(state,{isAdminAuthenticated:false,currentPlayer:null,players:[],matches:[],coupons:[],messages:[],finances:null});
    }

    async function fetchFromDatabase() {
      if (fetching) return fetching;
      const epoch=sessionEpoch;
      const token=playerToken;
      const request = (async () => {
        if (!_supabase) { renderAll(); return; }
        connectionState = 'connecting'; updateConnectionBadge();
        try {
          const adminResult = await _supabase.rpc('is_admin');
          if(epoch!==sessionEpoch) return;
          const isAdminAuthenticated = !adminResult.error && adminResult.data === true;
          const oldPlayer = state.currentPlayer;
          let currentPlayer = null;
          if (token) {
            const result = await _supabase.rpc('player_session_login', { p_token: token });
            if(epoch!==sessionEpoch) return;
            if (result.error) throw result.error;
            const row = result.data?.[0];
            if (row && !row.error) currentPlayer = row;
            else if (row?.error === 'Aguarde antes de atualizar.') throw new Error('rate');
            else { playerToken = ''; sessionStorage.removeItem(PLAYER_SESSION_KEY); }
          }
          const [players, matches, coupons, messages] = await Promise.all([
            isAdminAuthenticated ? readTablePages('jogadores', 'created_at') : readRpcPages('get_public_players'),
            isAdminAuthenticated ? readTablePages('partidas', 'created_at') : readRpcPages('get_public_matches', { p_token: currentPlayer ? token : null }),
            readTablePages('cupons', 'created_at'),
            isAdminAuthenticated ? readTablePages('mensagens', 'created_at') : currentPlayer ? checked(_supabase.rpc('get_my_messages', { p_token: token })) : []
          ]);
          if(epoch!==sessionEpoch) return;
          Object.assign(state, { isAdminAuthenticated, currentPlayer, players, matches, coupons, messages });
          connectionState = 'online';
          if (oldPlayer && !currentPlayer) showToast('Seu acesso expirou. Entre novamente.', 'danger');
          renderAll();
          if(isAdminAuthenticated && !document.getElementById('admin-sub-finances').classList.contains('hidden')) await loadAdminFinances(true);
        } catch (error) {
          if(epoch!==sessionEpoch) return;
          connectionState = 'offline';
          // Prevent stale privileged data from surviving an expired admin session.
          Object.assign(state,{isAdminAuthenticated:false,currentPlayer:null,players:[],matches:[],messages:[],coupons:[],finances:null});
          renderAll(); showToast('Não foi possível atualizar os dados. Tente novamente.', 'danger');
        } finally { if(epoch===sessionEpoch) updateConnectionBadge(); }
      })();
      fetching=request;
      try { return await request; } finally { if(fetching===request) fetching = null; }
    }

    function loginRetrySeconds() {
      try {
        const saved=Number(localStorage.getItem(LOGIN_RETRY_KEY));
        if(Number.isFinite(saved) && saved>0) loginRetryUntil=Math.max(loginRetryUntil,saved);
      } catch { /* The current tab still enforces the wait if storage is unavailable. */ }
      return Math.max(0,Math.ceil((loginRetryUntil-Date.now())/1000));
    }

    function renderLoginRetryControls() {
      const seconds=loginRetrySeconds();
      document.querySelectorAll('form[data-submit]').forEach(form=>{
        if(!loginActions.has(form.dataset.submit)) return;
        const button=form.querySelector('button[type="submit"]');
        const notice=form.querySelector('[data-login-wait]');
        button.disabled=seconds>0 || actionLocks.has(form.dataset.submit);
        button.textContent=seconds>0 ? `TENTAR NOVAMENTE EM ${seconds}s` : button.dataset.loginLabel;
        notice.querySelector('[data-login-seconds]').textContent=String(seconds);
        const progress=notice.querySelector('[data-login-progress]');
        progress.value=Math.max(0,Math.min(LOGIN_RETRY_MS,loginRetryUntil-Date.now()))/1000;
        progress.setAttribute('aria-valuetext',`${seconds} ${seconds===1 ? 'segundo restante' : 'segundos restantes'}`);
        notice.classList.toggle('hidden',seconds===0);
      });
      if(seconds>0 && loginRetryTimer===null) loginRetryTimer=setInterval(renderLoginRetryControls,250);
      else if(seconds===0 && loginRetryTimer!==null) {clearInterval(loginRetryTimer);loginRetryTimer=null;}
    }

    function startLoginRetryWait() {
      if(loginRetrySeconds()===0) {
        loginRetryUntil=Date.now()+LOGIN_RETRY_MS;
        try {localStorage.setItem(LOGIN_RETRY_KEY,String(loginRetryUntil));} catch { /* Keep the in-memory deadline. */ }
      }
      renderLoginRetryControls();
    }

    function loginRetryBlocked() {
      const seconds=loginRetrySeconds();
      renderLoginRetryControls();
      if(seconds>0) showToast(`Aguarde ${seconds}s para tentar novamente.`,'danger');
      return seconds>0;
    }

    async function handlePlayerLogin() {
      if(loginRetryBlocked()) return;
      if (!_supabase) throw new Error('offline');
      const id = document.getElementById('player-login-id').value.trim();
      if (!safeId.test(id)) {startLoginRetryWait();showToast('Digite um ID válido, com 3 a 20 números. Tente novamente em 15s.','danger');return;}
      const epoch=sessionEpoch;
      const result = await checked(_supabase.rpc('player_login', { p_game_id: id }));
      if(epoch!==sessionEpoch) return;
      const row = result?.[0];
      if (!row || row.error || !/^[a-f0-9]{64}$/.test(row.session_token || '')) {
        startLoginRetryWait();
        showToast(row?.error?.startsWith('Aguarde') ? 'Aguarde antes de tentar novamente.' : 'Não foi possível acessar. Confira seu ID ou fale com a organização.', 'danger'); return;
      }
      invalidateSessionReads();
      playerToken = row.session_token; sessionStorage.setItem(PLAYER_SESSION_KEY, playerToken);
      state.currentPlayer = row; delete state.currentPlayer.session_token;
      document.getElementById('player-login-id').value = '';
      closeModal('modal-player-auth');
      await fetchFromDatabase(); showToast('Diário acessado.');
    }

    async function playerLogout() {
      const token=playerToken; playerToken=''; sessionStorage.removeItem(PLAYER_SESSION_KEY);
      invalidateSessionReads(); renderAll();
      if (_supabase && token) await checked(_supabase.rpc('player_session_logout', {p_token:token}));
      await fetchFromDatabase(); showToast('Acesso encerrado.');
    }

    async function handleAdminAuth() {
      if(loginRetryBlocked()) return;
      if (!_supabase) throw new Error('offline');
      const email=document.getElementById('admin-user-input').value.trim();
      const password=document.getElementById('admin-pass-input').value;
      if (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length<8 || password.length>1024) {startLoginRetryWait();showToast('Credenciais inválidas. Tente novamente em 15s.','danger');return;}
      invalidateSessionReads();
      const epoch=sessionEpoch;
      const {data,error}=await _supabase.auth.signInWithPassword({email,password});
      document.getElementById('admin-pass-input').value='';
      if(epoch!==sessionEpoch) return;
      if (error || !data?.user) {
        if(!error || (error.name!=='AuthRetryableFetchError' && error.name!=='TypeError' && !(error.status>=500))) startLoginRetryWait();
        showToast('Não foi possível autenticar. Confira as credenciais ou aguarde.', 'danger'); return;
      }
      const membership=await _supabase.from('admin_users').select('role').eq('user_id',data.user.id).maybeSingle();
      if(epoch!==sessionEpoch) return;
      if (membership.error || !membership.data) { if(!membership.error) startLoginRetryWait(); await _supabase.auth.signOut(); showToast('Não foi possível autenticar o administrador.', 'danger'); return; }
      try {
        const allowed=await checked(_supabase.rpc('is_admin'));
        if(epoch!==sessionEpoch) return;
        if(allowed!==true) {startLoginRetryWait();throw new Error('Acesso não autorizado.');}
        if(fetching) await fetching;
        await fetchFromDatabase();
        if(epoch!==sessionEpoch) return;
        if(!state.isAdminAuthenticated || connectionState!=='online') throw new Error('Serviço indisponível.');
        closeModal('modal-admin-auth'); openAdminPanel(); showToast('Administrador autenticado.');
      } catch (error) {
        if(epoch!==sessionEpoch) return;
        invalidateSessionReads();
        renderAll(); await _supabase.auth.signOut({scope:'local'}); throw error;
      }
    }

    async function adminLogout() {
      invalidateSessionReads();
      switchTab('view-home'); renderAll();
      // Auth needs the stored access token to revoke this server session.
      // Removing it first silently turns signOut into local cleanup only.
      if (_supabase) { const {error}=await _supabase.auth.signOut({scope:'local'}); if (error) throw error; }
      else sessionStorage.removeItem('nova_admin_auth_v2');
      await fetchFromDatabase(); showToast('Sessão ADM encerrada.');
    }

    function openAdminPanel() {
      if (!state.isAdminAuthenticated) {
        openModal('modal-admin-auth');
        return;
      }
      switchTab('view-admin');
    }

    function switchTab(tabId) {
      if (tabId === 'view-admin' && !state.isAdminAuthenticated) {
        openModal('modal-admin-auth');
        return;
      }

      const tabs = ['view-home', 'view-ranking', 'view-matches', 'view-coupons', 'view-profile', 'view-admin'];
      tabs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });

      document.getElementById(tabId).classList.remove('hidden');

      document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
      const activeNav = document.getElementById('nav-' + tabId.replace('view-', ''));
      if (activeNav) activeNav.classList.add('active');
    }

    function switchAdminSubtab(sub, element) {
      const sections=['players','matches','coupons','messages','finances'];
      if(!state.isAdminAuthenticated || !sections.includes(sub)) return;
      document.querySelectorAll('.admin-tile').forEach(t => t.classList.remove('active'));
      element.classList.add('active');
      for(const name of sections) document.getElementById('admin-sub-'+name).classList.toggle('hidden',name!==sub);
      if(sub==='finances') return loadAdminFinances();
    }

    function financeCents(value) {
      const match=/^(-?)([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(String(value));
      if(!match) throw new Error('Valor monetário inválido.');
      const cents=BigInt(match[2])*100n+BigInt((match[3] || '').padEnd(2,'0'));
      return match[1] ? -cents : cents;
    }

    function formatFinanceMoney(value) {
      const cents=financeCents(value),absolute=cents<0n ? -cents : cents;
      return `${cents<0n ? '-' : ''}R$\u00a0${new Intl.NumberFormat('pt-BR').format(absolute/100n)},${String(absolute%100n).padStart(2,'0')}`;
    }

    function validateFinanceSummary(data) {
      if(!data || Array.isArray(data) || !Number.isInteger(data.version) || data.version<0 || !/^[0-9]+$/.test(String(data.participations))) throw new Error('Resposta inválida.');
      for(const key of ['registration_fee','accumulated_total','payout_total','advertising_total','balance']) financeCents(data[key]);
      return data;
    }

    function renderAdminFinances() {
      const form=document.getElementById('form-ad-spend');
      const input=document.getElementById('finance-ad-spend-input');
      const status=document.getElementById('finance-status');
      const fields={accumulated_total:'finance-accumulated',payout_total:'finance-payout',advertising_total:'finance-ad-spend',balance:'finance-balance'};
      if(!state.isAdminAuthenticated){state.finances=null;financeLoadState='idle';financeDraftDirty=false;}
      const data=state.isAdminAuthenticated ? state.finances : null;
      for(const [key,id]of Object.entries(fields)) document.getElementById(id).textContent=data ? formatFinanceMoney(data[key]) : '—';
      const balance=document.getElementById('finance-balance');
      balance.classList.toggle('finance-negative',!!data && financeCents(data.balance)<0n);
      balance.classList.toggle('finance-positive',!!data && financeCents(data.balance)>=0n);
      const ready=!!data && financeLoadState==='ready';
      input.disabled=!ready || actionLocks.has('handleSaveAdSpend');
      form.querySelector('button[type="submit"]').disabled=input.disabled;
      if(!data && !state.isAdminAuthenticated){input.value='';delete form.dataset.version;}
      else if(data && !financeDraftDirty){input.value=data.advertising_total;form.dataset.version=String(data.version);}
      status.textContent=!state.isAdminAuthenticated ? 'Entre no painel para consultar os valores.'
        : financeLoadState==='error' ? 'Não foi possível carregar os ganhos. Tente atualizar.'
        : financeLoadState==='loading' ? 'Atualizando os valores…'
        : data ? `${new Intl.NumberFormat('pt-BR').format(BigInt(data.participations))} participações registradas × R$ 6,00. Valores calculados pelo histórico da liga.`
        : 'Abra a aba para consultar os ganhos.';
    }

    async function loadAdminFinances(force=false) {
      if(!state.isAdminAuthenticated || !_supabase) return;
      if(financeFetching && !force) return financeFetching;
      const epoch=sessionEpoch;
      const readEpoch=++financeReadEpoch;
      const request=(async()=>{
        financeLoadState='loading';renderAdminFinances();
        try{
          const data=validateFinanceSummary(await checked(_supabase.rpc('get_admin_finances')));
          if(epoch!==sessionEpoch || readEpoch!==financeReadEpoch || !state.isAdminAuthenticated) return;
          state.finances=data;financeLoadState='ready';
        }catch{
          if(epoch!==sessionEpoch || readEpoch!==financeReadEpoch || !state.isAdminAuthenticated) return;
          state.finances=null;financeLoadState='error';
        }finally{if(epoch===sessionEpoch && readEpoch===financeReadEpoch) renderAdminFinances();}
      })();
      financeFetching=request;
      try{return await request;}finally{if(financeFetching===request) financeFetching=null;}
    }

    async function handleSaveAdSpend() {
      if(!state.isAdminAuthenticated || !state.finances || financeLoadState!=='ready') throw new Error('Acesso inválido.');
      const raw=document.getElementById('finance-ad-spend-input').value;
      const cents=financeCents(raw);
      const version=Number(document.getElementById('form-ad-spend').dataset.version);
      if(cents<0n || cents>100000000000n || !Number.isInteger(version) || version<0) throw new Error('Valor inválido.');
      const epoch=sessionEpoch;
      financeReadEpoch++;financeFetching=null;
      try{
        const data=validateFinanceSummary(await checked(_supabase.rpc('save_admin_ad_spend',{p_advertising_total:raw,p_expected_version:version})));
        if(epoch!==sessionEpoch || !state.isAdminAuthenticated) return;
        financeReadEpoch++;financeFetching=null;financeLoadState='ready';
        state.finances=data;financeDraftDirty=false;renderAdminFinances();
        showToast('Gasto com anúncios salvo. Saldo atualizado.');
      }catch(error){
        if(epoch!==sessionEpoch || !state.isAdminAuthenticated) return;
        if(error?.code==='40001'){
          financeDraftDirty=false;await loadAdminFinances(true);
          showToast('Outro administrador alterou o gasto. Confira o valor atualizado antes de salvar.','danger');return;
        }
        throw error;
      }
    }

    function openModal(id) {
      const modal=document.getElementById(id); if (!modal) return;
      modal._previousFocus=document.activeElement; modal.classList.add('active'); modal.setAttribute('aria-hidden','false');
      modal.querySelector('input,button,[tabindex]')?.focus();
    }

    function closeModal(id) {
      const modal=document.getElementById(id); if (!modal) return;
      modal.classList.remove('active'); modal.setAttribute('aria-hidden','true'); modal._previousFocus?.focus();
    }

    function showToast(msg, type = 'success', durationMs = 4000) {
      const container=document.getElementById('toast-container');
      const toast=document.createElement('div'); toast.className='toast';
      const text=document.createElement('div'); text.className='toast-text'; text.textContent=String(msg);
      const button=document.createElement('button'); button.type='button'; button.className='toast-close'; button.textContent='×'; button.setAttribute('aria-label','Fechar aviso'); button.addEventListener('click',()=>toast.remove());
      toast.append(text,button); container.appendChild(toast); setTimeout(()=>toast.remove(),durationMs);
    }

    async function handleAddPlayer() {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }

      const nick = document.getElementById('new-player-nick').value.trim();
      const gameId = document.getElementById('new-player-id').value.trim();

      if (state.players.some(p => String(p.gameId) === String(gameId))) {
        showToast('Este ID já está registrado no servidor!', 'danger');
        return;
      }

      if (!safeId.test(gameId) || !nick || nick.length>80) throw new Error('Dados inválidos.');
      const newPlayer = {
        nick: nick,
        gameId: gameId
      };

      const { error } = await _supabase.from('jogadores').insert([newPlayer]);
      if (error) { showToast('Erro ao gravar jogador no banco de dados.', 'danger'); return; }

      closeModal('modal-add-player');
      document.getElementById('new-player-nick').value = '';
      document.getElementById('new-player-id').value = '';
      showToast('✓ ID registrado no servidor com sucesso!');
      await fetchFromDatabase();
    }

    async function handleBulkPlayersImport() {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }

      const rawText = document.getElementById('bulk-players-input').value.trim();

      if (!rawText) {
        showToast('Cole a lista de jogadores!', 'danger');
        return;
      }

      if (rawText.length>50000) throw new Error('Lista muito grande.');
      const lines = rawText.split('\n');
      if (lines.filter(l=>l.trim()).length>100) throw new Error('Importe até 100 linhas por vez.');
      const playersToInsert = [];
      let addedCount = 0;
      let skippedCount = 0;

      for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        const parts = line.split(/[,;\t]/);
        if (parts.length >= 2) {
          const gameId = parts[0].trim();
          const nick = parts.slice(1).join(',').trim().replace(/^["']|["']$/g, '');

          if (!safeId.test(gameId) || !nick || nick.length>80) throw new Error('A lista contém dados inválidos.');

          const existsInState = state.players.some(p => String(p.gameId) === String(gameId));
          const existsInBatch = playersToInsert.some(p => String(p.gameId) === String(gameId));

          if (existsInState || existsInBatch) {
            skippedCount++;
            continue;
          }

          playersToInsert.push({
            nick: nick,
            gameId: gameId
          });
          addedCount++;
        }
      }

      if (playersToInsert.length > 0) {
        const { error } = await _supabase.from('jogadores').insert(playersToInsert);
        if (error) {
          showToast('Erro ao cadastrar jogadores no banco de dados.', 'danger');
          return;
        }

        closeModal('modal-bulk-players-import');
        document.getElementById('bulk-players-input').value = '';

        let msg = `✓ ${addedCount} novos jogadores cadastrados!`;
        if (skippedCount > 0) msg += ` (${skippedCount} ignorados por já existirem)`;
        showToast(msg, 'success', 6000);
        await fetchFromDatabase();
      } else {
        showToast(skippedCount > 0 ? 'Todos os IDs informados já estão cadastrados!' : 'Nenhum formato válido encontrado. Use: ID, NICK', 'danger');
      }
    }

    async function updatePlayerStatus(playerId,newStatus) {
      if (!state.isAdminAuthenticated || !uuidPattern.test(playerId) || !['normal','warning1','warning2','banned'].includes(newStatus)) throw new Error('Operação inválida.');
      if (newStatus==='banned' && !confirm('Bloquear o acesso do jogador e preservar seu histórico?')) { renderAdminPlayersTable(); return; }
      const rows=await checked(_supabase.from('jogadores').update({status:newStatus}).eq('id',playerId).select('id'));
      if (rows.length!==1) throw new Error('Operação não autorizada.');
      await fetchFromDatabase(); showToast('Status atualizado.');
    }

    function openAddMatchModal() {
      if (state.players.length === 0) {
        showToast('Cadastre ao menos um jogador antes de criar partidas!', 'danger');
        return;
      }
      document.getElementById('match-players-container').innerHTML = '';

      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      document.getElementById('match-datetime').value = now.toISOString().slice(0, 16);

      addPlayerRowToMatch();
      openModal('modal-add-match');
    }

    function addPlayerRowToMatch() {
      const container = document.getElementById('match-players-container');
      const rowId = 'player-row-' + Date.now() + Math.random().toString(36).substring(2, 5);

      const options = state.players.map(p => `<option value="${p.id}">${escapeHTML(p.nick)} (ID: ${escapeHTML(p.gameId)})</option>`).join('');

      const row = document.createElement('div');
      row.className = 'player-entry-card';
      row.id = rowId;
      row.innerHTML = `
        <button type="button" class="btn-remove-row" data-click="removePlayerRow" data-arg="${rowId}"><i class="fa-solid fa-xmark"></i></button>
        <div class="form-group">
          <label>JOGADOR</label>
          <select class="form-control match-p-id" required>${options}</select>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div class="form-group">
            <label>KILLS</label>
            <input type="number" class="form-control match-p-kills" value="0" min="0" required>
          </div>
          <div class="form-group">
            <label>POSIÇÃO</label>
            <input type="number" class="form-control match-p-pos" value="1" min="1" required>
          </div>
        </div>
        <div class="form-group">
          <label>VALOR/KILL (R$)</label>
          <input type="number" class="form-control match-p-valkill" value="4.00" step="0.50" required>
        </div>
      `;
      container.appendChild(row);
    }

    function removePlayerRow(rowId) {
      const rows = document.querySelectorAll('#match-players-container .player-entry-card');
      if (rows.length <= 1) {
        showToast('A partida deve conter ao menos 1 jogador.', 'danger');
        return;
      }
      document.getElementById(rowId).remove();
    }

    async function handleAddMatch() {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }

      const matchNum = document.getElementById('match-number').value.trim();
      const datetimeInput = document.getElementById('match-datetime').value;
      const top1Bonus = numberValue(document.getElementById('match-top1-bonus').value,0,100000);
      const top2Bonus = numberValue(document.getElementById('match-top2-bonus').value,0,100000);
      const rows = document.querySelectorAll('#match-players-container .player-entry-card');

      if (rows.length === 0) {
        showToast('Adicione pelo menos um jogador!', 'danger');
        return;
      }

      const selectedPlayerIds = [];
      for (const row of rows) {
        const pId = row.querySelector('.match-p-id').value;
        if (selectedPlayerIds.includes(pId)) {
          showToast('Erro: O mesmo jogador foi selecionado mais de uma vez!', 'danger');
          return;
        }
        selectedPlayerIds.push(pId);
      }

      let formattedDate = new Date().toLocaleDateString('pt-BR') + ' ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      if (datetimeInput) {
        const dtObj = new Date(datetimeInput);
        formattedDate = dtObj.toLocaleDateString('pt-BR') + ' às ' + dtObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      }

      if (!matchNum || matchNum.length>80) throw new Error('Nome da partida inválido.');
      const rpcEntries = [];

      for (const row of rows) {
        const playerId = row.querySelector('.match-p-id').value;
        const kills = numberValue(row.querySelector('.match-p-kills').value,0,10000,true);
        const pos = numberValue(row.querySelector('.match-p-pos').value,1,100000,true);
        const killVal = numberValue(row.querySelector('.match-p-valkill').value,0,100000);

        let bonus = 0;
        if (pos === 1) bonus = top1Bonus;
        else if (pos === 2) bonus = top2Bonus;

        const player = state.players.find(p => String(p.id) === String(playerId));
        if (!player) continue;

        rpcEntries.push({ playerId: player.id, kills, pos, killValue: killVal, bonus });
      }

      const { data: matchCount, error: matchError } = await _supabase.rpc('add_match_with_players', {
        p_match_number: matchNum,
        p_match_date: formattedDate,
        p_entries: rpcEntries
      });
      if (matchError || matchCount!==rpcEntries.length || matchCount===0) { showToast('Erro ao salvar a partida.', 'danger'); return; }

      closeModal('modal-add-match');
      showToast(`✓ Partida "${escapeHTML(matchNum)}" registrada!`);
      await fetchFromDatabase();
    }

    async function handleBulkImport() {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }

      const matchNum = document.getElementById('bulk-match-number').value.trim();
      const datetimeInput = document.getElementById('bulk-match-datetime').value;
      const rawText = document.getElementById('bulk-data-input').value.trim();
      const killVal = numberValue(document.getElementById('bulk-kill-val').value,0,100000);
      const top1Val = numberValue(document.getElementById('bulk-top1-val').value,0,100000);
      const top2Val = numberValue(document.getElementById('bulk-top2-val').value,0,100000);

      if (!matchNum || !rawText) {
        showToast('Preencha os campos obrigatórios!', 'danger');
        return;
      }

      let formattedDate = new Date().toLocaleDateString('pt-BR') + ' ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      if (datetimeInput) {
        const dtObj = new Date(datetimeInput);
        formattedDate = dtObj.toLocaleDateString('pt-BR') + ' às ' + dtObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      }

      if (rawText.length>50000) throw new Error('Lista muito grande.');
      const lines = rawText.split('\n');
      if (lines.filter(l=>l.trim()).length>100) throw new Error('Importe até 100 linhas por vez.');
      const rpcEntries = [];

      for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        const parts = line.split(/[,;\t]+/).map(s => s.trim());
        const gameId = parts[0];
        const kills = numberValue(parts[1],0,10000,true);
        const pos = numberValue(parts[2],1,100000,true);
        if (!safeId.test(gameId)) throw new Error('A lista contém um ID inválido.');

        rpcEntries.push({ gameId, kills, pos });
      }

      if (rpcEntries.length === 0) {
        showToast('Nenhuma linha válida encontrada.', 'danger');
        return;
      }

      const { data, error } = await _supabase.rpc('bulk_import_matches', {
        p_match_number: matchNum,
        p_match_date: formattedDate,
        p_kill_value: killVal,
        p_top1_value: top1Val,
        p_top2_value: top2Val,
        p_entries: rpcEntries
      });

      if (error) {
        showToast('Erro ao importar partidas.', 'danger');
        return;
      }

      const result = data && data[0];
      const importedCount = result ? result.imported_count : 0;
      const notFound = result && result.not_found ? result.not_found : [];

      if (importedCount > 0) {
        closeModal('modal-bulk-import');
        document.getElementById('bulk-data-input').value = '';
        let msg = `✓ ${importedCount} resultados importados em uma única operação!`;
        if (notFound.length > 0) msg += ` (${notFound.length} ID(s) não encontrado(s): ${notFound.join(', ')})`;
        showToast(msg, 'success', 6000);
        await fetchFromDatabase();
      } else {
        showToast('Nenhum ID correspondente encontrado.', 'danger');
      }
    }

    // REMOVER PARTIDA PELO ADM
    // Abre o modal de edição já preenchido com os dados atuais da partida
    function openEditMatchModal(groupKey) {
      const groupMatches = state.matches.filter(m => JSON.stringify([m.number,m.date ?? null]) === groupKey);
      if (groupMatches.length === 0) {
        showToast('Partida não encontrada.', 'danger');
        return;
      }

      document.getElementById('edit-match-number').value = groupMatches[0].number;
      document.getElementById('edit-match-date').value = groupMatches[0].date || '';

      const container = document.getElementById('edit-match-players-container');
      container.innerHTML = groupMatches.map(m => `
        <div class="player-entry-card" data-match-id="${m.id}">
          <div style="font-size: 12px; font-weight: 700; color: #fff; margin-bottom: 8px;">
            ${escapeHTML(m.playerNick)} <span style="color: var(--text-muted); font-weight: 400;">// ${escapeHTML(m.playerGameId)}</span>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
            <div class="form-group" style="margin-bottom: 0;">
              <label>KILLS</label>
              <input type="number" class="form-control edit-p-kills" value="${m.kills}" min="0" required>
            </div>
            <div class="form-group" style="margin-bottom: 0;">
              <label>POSIÇÃO</label>
              <input type="number" class="form-control edit-p-pos" value="${m.pos}" min="1" required>
            </div>
            <div class="form-group" style="margin-bottom: 0;">
              <label>TOTAL R$</label>
              <input type="number" class="form-control edit-p-total" value="${parseFloat(m.total).toFixed(2)}" step="0.5" required>
            </div>
          </div>
        </div>
      `).join('');

      openModal('modal-edit-match');
    }

    // Salva as alterações: reverte o valor antigo de cada jogador e aplica
    // o novo, tudo numa função só no banco (evita ficar inconsistente
    // se a conexão cair no meio de várias chamadas separadas).
    async function handleEditMatch() {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }

      const newNumber = document.getElementById('edit-match-number').value.trim();
      const newDate = document.getElementById('edit-match-date').value.trim();
      const rows = document.querySelectorAll('#edit-match-players-container .player-entry-card');

      if (rows.length === 0) {
        showToast('Nada pra salvar.', 'danger');
        return;
      }

      const entries = Array.from(rows).map(row => ({
        matchId: row.dataset.matchId,
        kills: numberValue(row.querySelector('.edit-p-kills').value,0,10000,true),
        pos: numberValue(row.querySelector('.edit-p-pos').value,1,100000,true),
        total: numberValue(row.querySelector('.edit-p-total').value,0,1000000000)
      }));

      const { data: editedCount, error } = await _supabase.rpc('edit_match_group', {
        p_new_number: newNumber,
        p_new_date: newDate,
        p_entries: entries
      });

      if (error || editedCount!==entries.length) {
        showToast('Erro ao salvar as alterações.', 'danger');
        return;
      }

      closeModal('modal-edit-match');
      showToast('✓ Partida atualizada!');
      await fetchFromDatabase();
    }

    async function deleteMatchGroup(groupKey) {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }
      if (!confirm('⚠️ Deseja realmente excluir esta partida? Os pontos e prêmios acumulados pelos jogadores nesta partida serão revertidos.')) return;

      const sample = state.matches.find(m => JSON.stringify([m.number,m.date ?? null]) === groupKey);
      if (!sample) return;

      const { data: deletedCount, error } = await _supabase.rpc('delete_match_group', {
        p_number: sample.number,
        p_date: sample.date ?? null
      });

      if (error || !Number.isInteger(deletedCount) || deletedCount<1) { showToast('Erro ao excluir a partida.', 'danger'); return; }

      showToast('Partida removida com sucesso!', 'danger');
      await fetchFromDatabase();
    }

    async function handleAddCoupon() {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }

      const code = document.getElementById('coupon-code').value.trim();
      const discount = document.getElementById('coupon-discount').value.trim();
      const valid = document.getElementById('coupon-valid').value.trim();

      if(!/^[A-Za-z0-9_-]{1,40}$/.test(code) || !discount || discount.length>160 || valid.length>80) throw new Error('Cupom inválido.');
      const { error } = await _supabase.from('cupons').insert([{ code, discount, valid }]);
      if (error) { showToast('Erro ao criar cupom.', 'danger'); return; }

      closeModal('modal-add-coupon');
      document.getElementById('coupon-code').value = '';
      document.getElementById('coupon-discount').value = '';
      document.getElementById('coupon-valid').value = '';
      showToast('✓ Cupom adicionado!');
      await fetchFromDatabase();
    }

    // REMOVER CUPOM PELO ADM
    async function deleteCoupon(couponId) {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }
      if (!confirm('Deseja realmente remover este cupom?')) return;

      const changed=await checked(_supabase.from('cupons').delete().eq('id',couponId).select('id'));
      if(changed.length!==1) throw new Error('Operação não autorizada.');
      showToast('Cupom removido com sucesso!', 'danger');
      await fetchFromDatabase();
    }

    async function copyCoupon(code,btn) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(code)) throw new Error('Código inválido.');
      await navigator.clipboard.writeText(code); btn.textContent='✓ COPIADO'; showToast('Código copiado.');
      setTimeout(()=>{btn.textContent='COPIAR CÓDIGO';},2000);
    }

    async function handleSendMessage() {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }

      const targetId = document.getElementById('msg-recipient').value;
      const text = document.getElementById('msg-text').value.trim();

      if (!text || text.length>4000 || !(targetId==='all' || uuidPattern.test(targetId))) {
        showToast('Digite a mensagem!', 'danger');
        return;
      }

      const currentDate = new Date().toLocaleDateString('pt-BR') + ' às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

      const { error } = await _supabase.from('mensagens').insert([{
        recipientId: targetId,
        text: text,
        date: currentDate,
        readBy: []
      }]);

      if (error) { showToast('Erro ao enviar comunicado.', 'danger'); return; }

      document.getElementById('msg-text').value = '';
      showToast('📢 Comunicado enviado com sucesso!');
      await fetchFromDatabase();
    }

    async function deleteMessage(msgId) {
      if (!_supabase) { showToast('Banco de dados não configurado ainda.', 'danger'); return; }
      if (!confirm('Deseja excluir este comunicado?')) return;

      const changed=await checked(_supabase.from('mensagens').delete().eq('id',msgId).select('id'));
      if(changed.length!==1) throw new Error('Operação não autorizada.');
      showToast('Comunicado removido.');
      await fetchFromDatabase();
    }

    async function markMessageAsRead(msgId) {
      if (!playerToken || !state.currentPlayer || !uuidPattern.test(msgId)) throw new Error('Acesso inválido.');
      const ok=await checked(_supabase.rpc('mark_message_read',{p_message_id:msgId,p_token:playerToken}));
      if (ok!==true) throw new Error('Não foi possível marcar o aviso.');
      await fetchFromDatabase();
    }

    function toggleMatchGroup(id) {
      const target = document.getElementById(id);
      const icon = document.getElementById('icon-' + id);
      if (target) {
        target.classList.toggle('hidden');
        if (icon) {
          icon.classList.toggle('fa-chevron-down');
          icon.classList.toggle('fa-chevron-up');
        }
      }
    }

    function getGroupedMatches(filterGameId=null) {
      const groups=new Map();
      for(const match of state.matches){
        const key=JSON.stringify([match.number,match.date ?? null]);
        if(!groups.has(key)) groups.set(key,{key,number:match.number,date:match.date || 'Data não informada',players:[]});
        groups.get(key).players.push(match);
      }
      const all=Array.from(groups.values());
      return filterGameId ? all.filter(g=>g.players.some(m=>String(m.playerGameId)===String(filterGameId))) : all;
    }

    function maskGameId(gameId) {
      const str = String(gameId || '');
      if (str.length <= 4) return '*'.repeat(str.length);
      return str.slice(0, 4) + '*'.repeat(str.length - 4);
    }

    function renderMatchGroupHTML(group, groupIndex, isAdmin = false, maskMode = 'none', exactFilterValue = null) {
      const sortedPlayers = [...group.players].sort((a, b) => a.pos - b.pos);

      let myIndex = -1;
      if (state.currentPlayer) {
        myIndex = sortedPlayers.findIndex(p => String(p.playerGameId) === String(state.currentPlayer.gameId));
      }

      const displayId = (gameId) => {
        if (isAdmin) return escapeHTML(gameId);
        const isOwn = state.currentPlayer && String(gameId) === String(state.currentPlayer.gameId);
        const matchesFilter = false;
        return isOwn ? escapeHTML(gameId) : escapeHTML(maskGameId(gameId));
      };

      let meHighlightedHTML = '';
      if (myIndex !== -1) {
        const myRecord = sortedPlayers[myIndex];
        meHighlightedHTML = `
          <div style="margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px dashed var(--neon-gold);">
            <div style="font-size: 11px; color: var(--neon-gold); font-weight: 700; margin-bottom: 4px;">Sua Posição nesta Partida:</div>
            <div class="player-row-item highlight-me">
              <div>
                <span class="player-row-title">#${myRecord.pos} ${escapeHTML(myRecord.playerNick)} // ${displayId(myRecord.playerGameId)}</span>
              </div>
              <div style="text-align: right;">
                <strong style="color: var(--neon-gold);">${myRecord.kills} Kills</strong>
                <div style="font-size: 11px; color: var(--neon-green);">R$ ${parseFloat(myRecord.total).toFixed(2)}</div>
              </div>
            </div>
          </div>
        `;
      }

      const allPlayersListHTML = sortedPlayers.map(p => {
        const isMe = state.currentPlayer && String(p.playerGameId) === String(state.currentPlayer.gameId);
        return `
          <div class="player-row-item ${isMe ? 'highlight-me' : ''}">
            <div>
              <span class="player-row-title">#${p.pos} ${escapeHTML(p.playerNick)} // ${displayId(p.playerGameId)}</span>
            </div>
            <div style="text-align: right;">
              <strong style="color: var(--neon-gold);">${p.kills} Kills</strong>
              <div style="font-size: 11px; color: var(--neon-green);">R$ ${parseFloat(p.total).toFixed(2)}</div>
            </div>
          </div>
        `;
      }).join('');

      const accordionId = 'match-details-' + groupIndex;
      const deleteBtn = isAdmin ? `
        <button class="btn-copy" style="background: rgba(46,204,113,0.2); color: var(--neon-green); padding: 4px 8px; font-size: 10px;" data-click="openEditMatchModal" data-arg="${escapeHTML(group.key)}">
          <i class="fa-solid fa-pen"></i> EDITAR
        </button>
        <button class="btn-copy" style="background: rgba(231,76,60,0.2); color: var(--neon-red); padding: 4px 8px; font-size: 10px;" data-click="deleteMatchGroup" data-arg="${escapeHTML(group.key)}">
          <i class="fa-solid fa-trash"></i> EXCLUIR
        </button>
      ` : '';

      return `
        <div class="match-group-card">
          <div role="button" tabindex="0" class="match-header-btn" data-click="toggleMatchGroup" data-arg="${accordionId}">
            <div>
              <h4 style="font-family: var(--font-sub); font-size: 15px; color: var(--neon-gold);">${escapeHTML(group.number)}</h4>
              <p style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
                <i class="fa-regular fa-clock"></i> ${escapeHTML(group.date)} | <i class="fa-solid fa-users"></i> ${group.players.length} Jogadores
              </p>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              ${deleteBtn}
              <i class="fa-solid fa-chevron-down" id="icon-${accordionId}" style="color: var(--neon-gold);"></i>
            </div>
          </div>

          <div id="${accordionId}" class="match-details-box hidden">
            ${meHighlightedHTML}
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; margin-bottom: 6px;">
              Lista de #${sortedPlayers[0]?.pos || 1} a #${sortedPlayers[sortedPlayers.length - 1]?.pos || sortedPlayers.length}:
            </div>
            ${allPlayersListHTML}
          </div>
        </div>
      `;
    }

    function renderMatchesOnly() {
      const fullMatchesList = document.getElementById('full-matches-list');
      const filterId = document.getElementById('filter-match-id')?.value.trim();
      const allGroups = getGroupedMatches(filterId);

      const totalPages = Math.ceil(allGroups.length / MATCHES_PER_PAGE) || 1;
      if (currentMatchPage > totalPages) currentMatchPage = totalPages;
      if (currentMatchPage < 1) currentMatchPage = 1;

      const startIndex = (currentMatchPage - 1) * MATCHES_PER_PAGE;
      const paginatedGroups = allGroups.slice(startIndex, startIndex + MATCHES_PER_PAGE);

      if (paginatedGroups.length === 0) {
        fullMatchesList.innerHTML = `<div class="empty-state"><i class="fa-solid fa-magnifying-glass"></i><p>${filterId ? 'Nenhum resultado para o ID ' + escapeHTML(filterId) : 'Nenhuma partida registrada.'}</p></div>`;
      } else {
        fullMatchesList.innerHTML = paginatedGroups.map((g, idx) => renderMatchGroupHTML(g, 'full-' + idx, false, 'smart', filterId)).join('');
      }

      document.getElementById('page-indicator').innerText = `Página ${currentMatchPage} de ${totalPages}`;
      document.getElementById('btn-prev-page').disabled = currentMatchPage === 1;
      document.getElementById('btn-next-page').disabled = currentMatchPage === totalPages;
    }

    function changeMatchPage(direction) {
      currentMatchPage += direction;
      renderMatchesOnly();
    }

    // Tabela de jogadores do ADM: busca por nick/ID + ordenada por quem mais
    // jogou primeiro. Função própria pra não precisar rodar o renderAll()
    // inteiro a cada tecla digitada na busca.
    function renderAdminPlayersTable() {
      const playersTable = document.getElementById('admin-players-table-body');
      if (!playersTable) return;

      const playerSearchTerm = (document.getElementById('admin-player-search')?.value || '').trim().toLowerCase();

      const visiblePlayers = (state.isAdminAuthenticated ? state.players : [])
        .filter(p => !playerSearchTerm || String(p.nick || '').toLowerCase().includes(playerSearchTerm) || String(p.gameId).includes(playerSearchTerm))
        .sort((a, b) => (b.matchesCount || 0) - (a.matchesCount || 0));

      if (state.players.length === 0) {
        playersTable.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Nenhum ID liberado no banco.</td></tr>`;
        return;
      }
      if (visiblePlayers.length === 0) {
        playersTable.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Nenhum jogador encontrado para "${escapeHTML(playerSearchTerm)}".</td></tr>`;
        return;
      }

      playersTable.innerHTML = visiblePlayers.map(p => {
        const st = p.status || 'normal';
        const autoTier = getProgressionTier(p.kills, p.earnings);
        const tierIcon = autoTier ? getAchievementMedalSVG(autoTier, 20) : '<span style="font-size:10px; color: var(--text-muted);">—</span>';
        const honraOn = !!p.is_honra;
        const verifOn = !!p.is_verificado;
        return `
          <tr>
            <td>
              <strong>${escapeHTML(p.nick)}</strong>
              <div style="font-size: 10px; color: var(--text-muted);">ID: ${escapeHTML(p.gameId)}</div>
            </td>
            <td>
              <select class="status-select" data-change="updatePlayerStatus" data-arg="${escapeHTML(p.id)}">
                <option value="normal" ${st === 'normal' ? 'selected' : ''}>🟢 Normal</option>
                <option value="warning1" ${st === 'warning1' ? 'selected' : ''}>🟡 1º Aviso</option>
                <option value="warning2" ${st === 'warning2' ? 'selected' : ''}>🟠 2º Aviso</option>
                <option value="banned" ${st === 'banned' ? 'selected' : ''}>🔴 Banido</option>
              </select>
            </td>
            <td>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span title="Tier automático (kills/ganhos)">${tierIcon}</span>
                <button class="btn-icon" style="width: 24px; height: 24px; opacity: ${honraOn ? '1' : '0.35'};" title="Honra (manual)" data-click="toggleMedalFlag" data-arg="${escapeHTML(p.id)}" data-extra="is_honra" data-value="${!honraOn}">${getHonraSVG(16)}</button>
                <button class="btn-icon" style="width: 24px; height: 24px; opacity: ${verifOn ? '1' : '0.35'};" title="Verificado (manual)" data-click="toggleMedalFlag" data-arg="${escapeHTML(p.id)}" data-extra="is_verificado" data-value="${!verifOn}">${getVerificadoSVG(16)}</button>
              </div>
            </td>
            <td style="text-align: center; font-weight: 700; color: #fff;">${p.matchesCount || 0}</td>
            <td><span style="color: var(--neon-green); font-weight: 700;">R$ ${parseFloat(p.earnings).toFixed(2)}</span></td>
          </tr>
        `;
      }).join('');
    }

    function renderAll() {
      updateConnectionBadge();

      const loggedOutView = document.getElementById('player-logged-out-view');
      const loggedInView = document.getElementById('player-logged-in-view');

      if (!state.currentPlayer) {
        loggedOutView.classList.remove('hidden');
        loggedInView.classList.add('hidden');
        for(const id of ['dash-player-nick','dash-player-id','dash-kills','dash-matches','dash-earnings','dash-rank']) document.getElementById(id).innerText='';
        document.getElementById('home-matches-list').replaceChildren();
      } else {
        loggedOutView.classList.add('hidden');
        loggedInView.classList.remove('hidden');

        const p = state.currentPlayer;
        document.getElementById('dash-player-nick').innerText = p.nick;
        document.getElementById('dash-player-id').innerText = p.gameId;
        document.getElementById('dash-kills').innerText = p.kills;
        document.getElementById('dash-matches').innerText = p.matchesCount;
        document.getElementById('dash-earnings').innerText = `R$ ${parseFloat(p.earnings).toFixed(2)}`;

        const sorted = [...state.players].filter(p=>p.kills>0).sort((a,b)=>b.kills-a.kills || String(a.nick).localeCompare(String(b.nick)));
        const rankIndex = sorted.findIndex(item => item.id === (state.isAdminAuthenticated ? p.id : p.rankingId));
        const rankPos = rankIndex !== -1 ? rankIndex + 1 : null;
        document.getElementById('dash-rank').innerText = rankPos ? `#${rankPos}` : '--';

        const myGroups = getGroupedMatches(p.gameId);
        const homeMatchesList = document.getElementById('home-matches-list');

        if (myGroups.length === 0) {
          homeMatchesList.innerHTML = `<div class="empty-state"><i class="fa-solid fa-gamepad"></i><p>Nenhum resultado registrado para seu ID.</p></div>`;
        } else {
          homeMatchesList.innerHTML = myGroups.map((g, idx) => renderMatchGroupHTML(g, 'home-' + idx)).join('');
        }
      }

      renderMatchesOnly();

      // RANKING
      renderRankingList();

      // CUPONS PARA JOGADORES
      const couponsContainer = document.getElementById('coupons-list-container');
      if (state.coupons.length === 0) {
        couponsContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-ticket"></i><p>Nenhum cupom ativo no momento.</p></div>`;
      } else {
        couponsContainer.innerHTML = state.coupons.map(c => `
          <div class="coupon-card">
            <div>
              <div class="coupon-code">${escapeHTML(c.code)}</div>
              <div style="font-size: 12px; font-weight: 700; color: var(--neon-green);">${escapeHTML(c.discount)}</div>
              <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Validade: ${escapeHTML(c.valid)}</div>
            </div>
            <button class="btn-copy" data-click="copyCoupon" data-arg="${escapeHTML(c.code)}">COPIAR CÓDIGO</button>
          </div>
        `).join('');
      }

      // PERFIL E NOTIFICAÇÕES DE AVISOS
      const profileContent = document.getElementById('profile-content');
      let hasNotificationBadge = false;

      if (state.currentPlayer) {
        const pStatus = state.currentPlayer.status || 'normal';
        let statusBadgeHTML = '<span class="badge badge-normal">🟢 NORMAL</span>';
        let warningBoxHTML = '';

        if (pStatus === 'warning1') {
          hasNotificationBadge = true;
          statusBadgeHTML = '<span class="badge badge-warning1">🟡 1º AVISO</span>';
          warningBoxHTML = `
            <div class="alert-card warning1">
              <i class="fa-solid fa-triangle-exclamation" style="font-size: 18px;"></i>
              <div>
                <strong>Aviso Importante (1º Aviso):</strong> Sua conta recebeu uma advertência por descumprimento de regras leves do campeonato.
              </div>
            </div>
          `;
        } else if (pStatus === 'warning2') {
          hasNotificationBadge = true;
          statusBadgeHTML = '<span class="badge badge-warning2">🟠 2º AVISO DE INFRAÇÃO</span>';
          warningBoxHTML = `
            <div class="alert-card warning2">
              <i class="fa-solid fa-radiation" style="font-size: 18px;"></i>
              <div>
                <strong>Aviso Crítico (2º Aviso):</strong> Sua conta possui 2 advertências ativas! Uma nova infração resultará no BANIMENTO PERMANENTE.
              </div>
            </div>
          `;
        }

        const myMessages = state.messages.filter(m =>
          m.recipientId === 'all' || String(m.recipientId) === String(state.currentPlayer.id)
        );

        const unreadCount = myMessages.filter(m => !m.readBy || !m.readBy.includes(state.currentPlayer.id)).length;
        if (unreadCount > 0) hasNotificationBadge = true;

        let messagesListHTML = '';
        if (myMessages.length === 0) {
          messagesListHTML = `<div style="font-size: 11px; color: var(--text-muted); text-align: center; padding: 10px;">Nenhuma mensagem ou aviso recebido.</div>`;
        } else {
          messagesListHTML = myMessages.map(m => {
            const isRead = m.readBy && m.readBy.includes(state.currentPlayer.id);
            const badgeType = m.recipientId === 'all' ? '<span class="badge badge-pending">📢 GERAL</span>' : '<span class="badge badge-paid">📩 DIRETO</span>';
            return `
              <div class="card" style="margin-bottom: 8px; padding: 10px; border-left: 3px solid ${isRead ? 'var(--border-color)' : 'var(--neon-gold)'};">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <div>${badgeType} <span style="font-size: 10px; color: var(--text-muted); margin-left: 6px;">${escapeHTML(m.date)}</span></div>
                  ${!isRead ? `<button class="btn-copy" style="font-size: 9px; padding: 3px 6px;" data-click="markMessageAsRead" data-arg="${escapeHTML(m.id)}">Marcar Lida</button>` : '<span style="font-size: 10px; color: var(--neon-green);">✓ Lida</span>'}
                </div>
                <div style="font-size: 12px; color: #fff; line-height: 1.4;">${escapeHTML(m.text)}</div>
              </div>
            `;
          }).join('');
        }

        profileContent.innerHTML = `
          <div class="card" style="text-align: center;">
            <div style="width: 60px; height: 60px; font-size: 20px; margin: 0 auto 10px auto; border-radius: 50%; background: #1c2432; display: flex; align-items: center; justify-content: center; border: 1px solid var(--neon-gold);">
              <i class="fa-solid fa-user" style="color: var(--neon-gold);"></i>
            </div>
            <h3 style="font-family: var(--font-heading); font-size: 16px;">${escapeHTML(state.currentPlayer.nick)}</h3>
            <p style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">ID Free Fire: ${escapeHTML(state.currentPlayer.gameId)}</p>
            <div style="margin-bottom: 14px;">${statusBadgeHTML}</div>

            ${warningBoxHTML}

            <button class="btn-primary" data-click="openModal" data-arg="modal-support">
              <i class="fa-solid fa-headset"></i> SUPORTE E FAQ
            </button>
          </div>

          <div class="section-header">
            <div class="section-title"><i class="fa-solid fa-bell"></i> SEUS AVISOS E COMUNICADOS</div>
          </div>
          ${messagesListHTML}
        `;
      } else {
        profileContent.innerHTML = `
          <div class="empty-state">
            <i class="fa-solid fa-user-lock"></i>
            <p>Entre com seu ID do Free Fire pra ver seu perfil.</p>
          </div>
        `;
      }

      // BADGE NO BOTTOM NAV
      const navBadge = document.getElementById('nav-profile-badge');
      if (hasNotificationBadge) {
        navBadge.classList.remove('hidden');
      } else {
        navBadge.classList.add('hidden');
      }

      // PAINEL ADM - MÉTRICAS
      renderAdminFinances();
      if(!state.isAdminAuthenticated) {
        if(!document.getElementById('view-admin').classList.contains('hidden')) switchTab('view-home');
        document.querySelectorAll('form[data-submit]').forEach(form=>{
          if(!adminActions.has(form.dataset.submit)) return;
          form.reset();
          const modal=form.closest('.modal-overlay');if(modal?.classList.contains('active')) closeModal(modal.id);
        });
        document.querySelectorAll('#match-players-container, #edit-match-players-container').forEach(el=>el.replaceChildren());
      }
      const allMatchGroups = getGroupedMatches();
      const totalEarnings = state.players.reduce((acc, p) => acc + parseFloat(p.earnings || 0), 0);
      document.getElementById('admin-count-players').innerText = state.players.length;
      document.getElementById('admin-count-matches').innerText = allMatchGroups.length;
      document.getElementById('admin-total-payout').innerText = `R$ ${totalEarnings.toFixed(2)}`;
      document.getElementById('admin-count-coupons').innerText = state.coupons.length;

      renderAdminPlayersTable();

      // CUPONS NO ADM
      const adminCouponsContainer = document.getElementById('admin-coupons-table-body');
      if (adminCouponsContainer) {
        if (state.coupons.length === 0) {
          adminCouponsContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-ticket"></i><p>Nenhum cupom cadastrado.</p></div>`;
        } else {
          adminCouponsContainer.innerHTML = state.coupons.map(c => `
            <div class="coupon-card">
              <div>
                <div class="coupon-code">${escapeHTML(c.code)}</div>
                <div style="font-size: 12px; font-weight: 700; color: var(--neon-green);">${escapeHTML(c.discount)}</div>
                <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Validade: ${escapeHTML(c.valid)}</div>
              </div>
              <button class="btn-copy" style="background: rgba(231,76,60,0.2); color: var(--neon-red);" data-click="deleteCoupon" data-arg="${escapeHTML(c.id)}">
                <i class="fa-solid fa-trash"></i> EXCLUIR
              </button>
            </div>
          `).join('');
        }
      }

      // SELECT DE DESTINATÁRIOS
      const recipientSelect = document.getElementById('msg-recipient');
      if (recipientSelect) {
        recipientSelect.innerHTML = `<option value="all">📢 Todos os Jogadores (Global)</option>` +
          state.players.map(p => `<option value="${p.id}">👤 ${escapeHTML(p.nick)} (ID: ${escapeHTML(p.gameId)})</option>`).join('');
      }

      // HISTÓRICO DE MENSAGENS NO ADM
      const msgHistory = document.getElementById('admin-messages-history');
      if (msgHistory) {
        if (state.messages.length === 0) {
          msgHistory.innerHTML = `<div style="font-size: 11px; color: var(--text-muted);">Nenhuma mensagem enviada.</div>`;
        } else {
          msgHistory.innerHTML = state.messages.map(m => {
            let targetLabel = '📢 Todos os Jogadores';
            if (m.recipientId !== 'all') {
              const targetPlayer = state.players.find(p => String(p.id) === String(m.recipientId));
              targetLabel = targetPlayer ? `👤 ${escapeHTML(targetPlayer.nick)} (ID: ${escapeHTML(targetPlayer.gameId)})` : '👤 Jogador Removido';
            }
            return `
              <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--border-color); padding: 8px; border-radius: 6px; margin-bottom: 6px; font-size: 11px;">
                <div style="display: flex; justify-content: space-between; color: var(--neon-gold); font-weight: 700;">
                  <span>Para: ${targetLabel}</span>
                  <button class="btn-copy" style="background: rgba(231,76,60,0.2); color: var(--neon-red); font-size: 9px; padding: 2px 6px;" data-click="deleteMessage" data-arg="${escapeHTML(m.id)}">Excluir</button>
                </div>
                <div style="color: #fff; margin: 4px 0;">${escapeHTML(m.text)}</div>
                <div style="font-size: 9px; color: var(--text-muted);">${escapeHTML(m.date)}</div>
              </div>
            `;
          }).join('');
        }
      }

      // PARTIDAS ADM (COM BOTÃO DE EXCLUIR)
      const adminMatchesList = document.getElementById('admin-matches-list');
      if (state.matches.length === 0) {
        adminMatchesList.innerHTML = `<div class="empty-state"><i class="fa-solid fa-gamepad"></i><p>Nenhuma partida criada.</p></div>`;
      } else {
        adminMatchesList.innerHTML = allMatchGroups.map((g, idx) => renderMatchGroupHTML(g, 'admin-' + idx, true)).join('');
      }
    }

    async function checked(query) {
      const {data,error}=await query;
      if(error) throw error;
      return data;
    }

    function numberValue(raw,min,max,integer=false) {
      if(raw == null || String(raw).trim()==='') throw new Error('Preencha os valores numéricos.');
      const n=Number(raw);
      if(!Number.isFinite(n) || n<min || n>max || (integer && !Number.isInteger(n))) throw new Error('Valor numérico inválido.');
      return integer ? n : Math.round((n+Number.EPSILON)*100)/100;
    }

    async function readTablePages(table,order) {
      const rows=[];
      for(let offset=0;offset<20000;offset+=200){
        const page=await checked(_supabase.from(table).select('*').order(order,{ascending:false}).order('id',{ascending:true}).range(offset,offset+199));
        rows.push(...page); if(page.length<200) return rows;
      }
      throw new Error('Histórico excede o limite de consulta.');
    }

    async function readRpcPages(name,args={}) {
      const rows=[];
      for(let offset=0;offset<20000;offset+=200){
        const page=await checked(_supabase.rpc(name,{...args,p_offset:offset,p_limit:200}));
        if(!Array.isArray(page)) throw new Error('Resposta inválida.');
        rows.push(...page); if(page.length<200) return rows;
      }
      throw new Error('Histórico excede o limite de consulta.');
    }

    const actions = {
      handleSecretAdminTrigger: ()=>handleSecretAdminTrigger(),
      openModal: (el)=>openModal(el.dataset.arg), closeModal: (el)=>closeModal(el.dataset.arg),
      playerLogout: ()=>playerLogout(), adminLogout: ()=>adminLogout(),
      switchRankingType:(el)=>switchRankingType(el.dataset.arg),
      changeMatchPage:(el)=>changeMatchPage(Number(el.dataset.arg)),
      switchTab:(el)=>switchTab(el.dataset.arg),
      switchAdminSubtab:(el)=>switchAdminSubtab(el.dataset.arg,el),
      openAddMatchModal:()=>openAddMatchModal(), addPlayerRowToMatch:()=>addPlayerRowToMatch(),
      showMedalInfo:(el)=>showMedalInfo(el.dataset.arg), removePlayerRow:(el)=>removePlayerRow(el.dataset.arg),
      openEditMatchModal:(el)=>openEditMatchModal(el.dataset.arg), deleteMatchGroup:(el)=>deleteMatchGroup(el.dataset.arg),
      toggleMatchGroup:(el)=>toggleMatchGroup(el.dataset.arg),
      updatePlayerStatus:(el)=>updatePlayerStatus(el.dataset.arg,el.value),
      toggleMedalFlag:(el)=>toggleMedalFlag(el.dataset.arg,el.dataset.extra,el.dataset.value==='true'),
      copyCoupon:(el)=>copyCoupon(el.dataset.arg,el), markMessageAsRead:(el)=>markMessageAsRead(el.dataset.arg),
      deleteCoupon:(el)=>deleteCoupon(el.dataset.arg), deleteMessage:(el)=>deleteMessage(el.dataset.arg),
      handleSendMessage:()=>handleSendMessage(), handlePlayerLogin:()=>handlePlayerLogin(),
      handleAdminAuth:()=>handleAdminAuth(), handleAddPlayer:()=>handleAddPlayer(),
      handleBulkPlayersImport:()=>handleBulkPlayersImport(), handleAddMatch:()=>handleAddMatch(),
      handleEditMatch:()=>handleEditMatch(), handleBulkImport:()=>handleBulkImport(),
      handleAddCoupon:()=>handleAddCoupon(),
      loadAdminFinances:()=>loadAdminFinances(true),handleSaveAdSpend:()=>handleSaveAdSpend()
    };
    const adminActions=new Set(['switchAdminSubtab','openAddMatchModal','addPlayerRowToMatch','removePlayerRow','openEditMatchModal','deleteMatchGroup','updatePlayerStatus','toggleMedalFlag','deleteCoupon','deleteMessage','handleSendMessage','handleAddPlayer','handleBulkPlayersImport','handleAddMatch','handleEditMatch','handleBulkImport','handleAddCoupon','loadAdminFinances','handleSaveAdSpend']);

    async function dispatchAction(event,type) {
      const el=event.target.closest('[data-'+type+']'); if(!el) return;
      const name=el.dataset[type];
      if(!Object.hasOwn(actions,name)) return;
      event.preventDefault(); event.stopPropagation();
      if(adminActions.has(name) && !state.isAdminAuthenticated) { showToast('Entre no painel administrativo.','danger'); return; }
      if(loginActions.has(name) && loginRetryBlocked()) return;
      if(actionLocks.has(name)) return;
      const controls=el.matches('form') ? [...el.querySelectorAll('button,input,textarea,select')] : [el];
      const previous=controls.map(c=>c.disabled); actionLocks.add(name);
      controls.forEach(c=>{c.disabled=true;}); el.setAttribute('aria-busy','true');
      try { await actions[name](el); }
      catch { showToast('Não foi possível concluir. Verifique os dados, sua conexão e tente novamente.','danger'); }
      finally { actionLocks.delete(name); controls.forEach((c,i)=>{c.disabled=previous[i];}); el.removeAttribute('aria-busy'); renderLoginRetryControls(); }
    }

    let lastInteraction=Date.now();
    document.addEventListener('click',event=>{lastInteraction=Date.now(); void dispatchAction(event,'click');});
    document.addEventListener('submit',event=>{lastInteraction=Date.now(); void dispatchAction(event,'submit');});
    document.addEventListener('change',event=>{lastInteraction=Date.now(); void dispatchAction(event,'change');});
    document.getElementById('finance-ad-spend-input').addEventListener('input',()=>{lastInteraction=Date.now();financeDraftDirty=true;});
    document.addEventListener('invalid',event=>{
      const form=event.target.closest('form');
      if(form && loginActions.has(form.dataset.submit)) startLoginRetryWait();
    },true);
    window.addEventListener('storage',event=>{if(event.key===LOGIN_RETRY_KEY || event.key===null) renderLoginRetryControls();});
    window.addEventListener('pageshow',renderLoginRetryControls);
    document.addEventListener('visibilitychange',renderLoginRetryControls);
    renderLoginRetryControls();
    document.addEventListener('keydown',event=>{
      lastInteraction=Date.now();
      const modal=document.querySelector('.modal-overlay.active');
      if(event.key==='Escape' && modal) closeModal(modal.id);
      if(event.key==='Tab' && modal){
        const controls=[...modal.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(e=>!e.disabled && !e.closest('.hidden'));
        const first=controls[0],last=controls.at(-1);
        if(event.shiftKey && document.activeElement===first) {event.preventDefault(); last?.focus();}
        else if(!event.shiftKey && document.activeElement===last) {event.preventDefault(); first?.focus();}
      }
      if(['Enter',' '].includes(event.key) && event.target.matches('[role="button"][data-click]')) {event.preventDefault(); event.target.click();}
    });

    async function initializeApp() {
      document.querySelectorAll('[data-image-fallback]').forEach(img=>img.addEventListener('error',()=>{img.style.display='none';img.nextElementSibling.style.display='flex';}));
      document.querySelectorAll('.modal-overlay').forEach(modal=>{const title=modal.querySelector('h3');if(title){title.id=title.id || modal.id+'-title';modal.setAttribute('aria-labelledby',title.id);}});
      document.querySelectorAll('input,textarea,select').forEach((input,index)=>{
        const label=input.closest('.form-group')?.querySelector('label');
        if(label){input.id=input.id || 'field-'+index;label.htmlFor=input.id;}
      });
      const support=document.getElementById('support-link');
      if(/^https:\/\/wa\.me\/[0-9]{10,15}(?:\?.*)?$/.test(config.supportUrl || '')){support.href=config.supportUrl;support.classList.remove('hidden');}
      else {const notice=document.createElement('p');notice.textContent='Para suporte, procure a organização pelo canal oficial da liga.';support.after(notice);}
      if(_supabase){
        _supabase.auth.onAuthStateChange(event=>{
          if(event==='SIGNED_OUT'){invalidateSessionReads();switchTab('view-home');renderAll();}
          if(['SIGNED_OUT','TOKEN_REFRESHED'].includes(event)) setTimeout(()=>{void fetchFromDatabase();},0);
        });
      }
      await fetchFromDatabase();
      const filter=document.getElementById('filter-match-id');
      filter.addEventListener('input',()=>{clearTimeout(filterDebounceTimer);filterDebounceTimer=setTimeout(()=>{currentMatchPage=1;renderMatchesOnly();},300);});
      const search=document.getElementById('admin-player-search');let timer;
      search.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(renderAdminPlayersTable,300);});
      setInterval(()=>{
        if(state.isAdminAuthenticated && Date.now()-lastInteraction>15*60*1000) {void adminLogout().catch(()=>{});return;}
        if(!document.hidden) void fetchFromDatabase();
      },60000);
      document.addEventListener('visibilitychange',()=>{if(!document.hidden) void fetchFromDatabase();});
      window.addEventListener('online',()=>{void fetchFromDatabase();});
      window.addEventListener('offline',()=>{connectionState='offline';updateConnectionBadge();});
    }
    window.addEventListener('DOMContentLoaded',()=>{void initializeApp().catch(()=>{connectionState='offline';updateConnectionBadge();showToast('Serviço indisponível. Tente novamente.','danger');});});
