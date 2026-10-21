const root = document.querySelector('#app');
const header = document.querySelector('#header');
const overlay = document.querySelector('#overlay');
const toastEl = document.querySelector('#toast');
const state = {
  user: null, socket: null, room: null, rooms: [], screen: 'home',
  invited: new URLSearchParams(location.search).get('room')?.toUpperCase() || '',
  entering: false, help: false, scores: false, guestBusy: false, connected: false, finale: null
};
const COLORS = ['violet', 'coral', 'teal', 'blue', 'amber', 'rose', 'lime', 'indigo'];
const html = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = (room, id) => room?.players.find(p => p.id === id)?.name || 'Un joueur';
const sum = nums => nums.reduce((a,b) => a+b, 0);
const countVisible = hand => hand?.filter(c => c.face || c.removed).length || 0;
const total = (g,id) => sum(g?.scores?.[id] || []);
const initials = name => (name || '?').split(' ').filter(Boolean).slice(0,2).map(w => w[0]).join('').toUpperCase();
let toastTimeout, reconnectTimeout;
let reconnectAttempts = 0;
let renderScheduled = false;
let lastHeaderHTML = null;
let lastPageHTML = null;
let lastOverlayHTML = null;
let finaleSequence = 0;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const shortWait = ms => new Promise(resolve => setTimeout(resolve, ms));
function resetFinale() {
  finaleSequence++;
  state.finale = null;
}
function startFinale(room) {
  const token = ++finaleSequence;
  state.finale = { roomCode: room.code, round: room.game.round, token };
  scheduleRender();
  // Le premier RAF peint la page. Le second lance les animations après insertion.
  requestAnimationFrame(() => requestAnimationFrame(() => void playFinale(token)));
}
function activeFinale(token) {
  return state.finale?.token === token && state.screen === 'room' &&
    state.room?.code === state.finale.roomCode && state.room?.game?.round === state.finale.round &&
    ['round_end', 'game_over'].includes(state.room?.game?.status);
}
function updateFinaleTitle(title, subtitle) {
  const heading = document.querySelector('[data-finale-title]');
  const detail = document.querySelector('[data-finale-subtitle]');
  if (heading) heading.textContent = title;
  if (detail) detail.textContent = subtitle;
}
function signedNumber(n) { return n > 0 ? `+${n}` : String(n); }
async function playFinale(token) {
  if (!activeFinale(token)) return;
  const room = state.room, g = room.game;
  const step = reducedMotion() ? 0 : 105;
  const pause = async ms => {
    await shortWait(reducedMotion() ? 0 : ms);
    return activeFinale(token);
  };
  if (!await pause(650)) return;
  updateFinaleTitle('Les dernières cartes !', 'Regardez les cartes cachées se révéler…');
  const order = [room.me, ...room.players.filter(p => p.id !== room.me).map(p => p.id)];
  for (const id of order) {
    if (!activeFinale(token)) return;
    const panel = document.querySelector(`[data-final-player="${id}"]`);
    panel?.classList.add('is-spotlit');
    panel?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'instant' : 'smooth' });
    const snapshot = g.result.reveal.find(item => item.id === id);
    if (snapshot) for (let i = 0; i < 12; i++) {
      if (!snapshot.removedBefore[i] && !snapshot.faceBefore[i]) {
        const tile = panel?.querySelector(`[data-final-index="${i}"]`);
        tile?.classList.add('is-flipped', 'is-fresh');
        if (!await pause(step)) return;
      }
    }
    if (!await pause(170)) return;
    panel?.classList.remove('is-spotlit');
  }
  let removedCount = 0;
  for (const player of room.players) {
    const before = g.result.reveal.find(item => item.id === player.id);
    const panel = document.querySelector(`[data-final-player="${player.id}"]`);
    if (!before) continue;
    for (let i = 0; i < 12; i++) {
      if (g.hands[player.id]?.[i]?.removed && !before.removedBefore[i]) {
        panel?.querySelector(`[data-final-index="${i}"]`)?.classList.add('is-removed');
        panel?.classList.add('has-bonus');
        removedCount++;
      }
    }
  }
  updateFinaleTitle(removedCount ? 'Colonnes éliminées ✨' : 'Toutes les cartes sont révélées !',
    removedCount ? 'Les colonnes de trois cartes identiques s’envolent !' : 'Place au calcul des scores.');
  if (!await pause(removedCount ? 800 : 450)) return;
  updateFinaleTitle('On compte les points !', 'Chaque carte rejoint le compteur de son joueur.');
  for (const player of room.players) {
    if (!activeFinale(token)) return;
    const panel = document.querySelector(`[data-final-player="${player.id}"]`);
    const scoreEl = panel?.querySelector('[data-finale-score]');
    const totalEl = panel?.querySelector('[data-finale-total]');
    panel?.classList.add('is-counting');
    let running = 0;
    if (scoreEl) scoreEl.textContent = '0';
    for (let i = 0; i < 12; i++) {
      const card = g.hands[player.id]?.[i];
      if (!card || card.removed) continue;
      running += card.value;
      panel?.querySelector(`[data-final-index="${i}"]`)?.classList.add('is-counted');
      if (scoreEl) { scoreEl.textContent = signedNumber(running); scoreEl.classList.remove('score-pop'); void scoreEl.offsetWidth; scoreEl.classList.add('score-pop'); }
      if (!await pause(82)) return;
    }
    if (g.result.doubledId === player.id) {
      panel?.classList.add('is-doubled');
      if (!await pause(400)) return;
    }
    if (scoreEl) scoreEl.textContent = signedNumber(g.result.scores[player.id]);
    if (totalEl) totalEl.textContent = `${g.result.totals[player.id]} pts au total`;
    panel?.classList.remove('is-counting');
    panel?.classList.add('is-scored');
    if (!await pause(180)) return;
  }
  updateFinaleTitle('Voilà les résultats !', 'Tous les scores sont calculés.');
  if (!await pause(850)) return;
  if (activeFinale(token)) { resetFinale(); scheduleRender(); }
}
// Coalesce plusieurs événements temps réel dans une seule image de rendu.
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

function avatar(player, i, extra='') {
  return `<span class="avatar avatar-${COLORS[i % COLORS.length]} ${extra}" title="${html(player.name)}">${html(initials(player.name))}</span>`;
}
function cardKind(value) {
  if (value <= -1) return 'cold';
  if (value === 0) return 'mint';
  if (value <= 4) return 'green';
  if (value <= 8) return 'warm';
  return 'hot';
}
function cardFace(value, cls='') {
  return `<span class="playing-card face ${cardKind(value)} ${cls}" aria-label="Carte ${value}"><span class="card-corner">${value}</span><span class="card-number">${value}</span><svg class="card-art" viewBox="0 0 160 210" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><circle class="land-sun" cx="122" cy="104" r="17"/><path class="land-mountain-back" d="M0 158 40 118 65 145 106 102 160 153V210H0Z"/><path class="land-mountain-front" d="M0 184 44 153 77 171 118 135 160 170V210H0Z"/><path class="land-ground" d="M0 187c27-20 45-6 79-14 33-8 52-15 81 1v36H0Z"/><path class="land-trunk" d="M26 183v-32m108 39v-34"/><path class="land-tree" d="m26 134-14 22h28l-14-22Zm0 11-14 22h28l-14-22Zm108-3-12 20h24l-12-20Zm0 12-13 21h26l-13-21Z"/><path class="land-river" d="M64 183c17 4 30 1 44-5 18-8 28-5 52-3v35H51c0-9 2-20 13-27Z"/></svg></span>`;
}
function cardBack(cls='') {
  return `<span class="playing-card back ${cls}" aria-label="Carte face cachée"><span class="back-frame"><img class="back-cloud" src="/art/cloud-mark.svg" alt="" draggable="false"/><span class="back-name">Skyclub</span><span class="back-star">✦</span></span></span>`;
}
function cardRemoved() { return `<span class="playing-card removed" aria-label="Colonne éliminée"><span>✦</span></span>`; }
function cardSlot(card, i, opts={}) {
  const interactive = opts.interactive || false;
  const selected = opts.selected || false;
  const inner = card.removed ? cardRemoved() : card.face ? cardFace(card.value) : cardBack();
  const className = `card-slot ${interactive && !card.removed ? 'actionable' : ''} ${selected ? 'hint-card' : ''}`;
  if (opts.own) return `<button type="button" class="${className}" data-action="cell" data-index="${i}" ${interactive && !card.removed ? '' : 'disabled'} aria-label="Carte ${i+1}, ${card.removed ? 'éliminée' : card.face ? card.value : 'cachée'}">${inner}</button>`;
  return `<span class="${className}">${inner}</span>`;
}
function avatarGroup(players) {
  return `<div class="avatar-group">${players.slice(0,8).map((p,i)=>avatar(p,i)).join('')}</div>`;
}
function icon(n) {
  const shapes = {
    arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
    chevron:'<path d="m9 18 6-6-6-6"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    crown:'<path d="m2 8 5 5 5-8 5 8 5-5-2 11H4z"/>',
    leave:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9"/>',
    info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>',
    refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9A7 7 0 0 1 18 7l2 5M4 12l2 5a7 7 0 0 0 12.5-2"/>',
    lock:'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    play:'<path d="m8 5 11 7-11 7z"/>',
    trophy:'<path d="M8 21h8m-4-4v4M7 4h10v7a5 5 0 0 1-10 0V4ZM7 6H4v3a4 4 0 0 0 4 4m9-7h3v3a4 4 0 0 1-4 4"/>',
    back:'<path d="M19 12H5m6 6-6-6 6-6"/>',
    x:'<path d="M18 6 6 18M6 6l12 12"/>',
    spark:'<path d="m12 3 1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"/>',
    wifi:'<path d="M2 8a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0m-11 4a5 5 0 0 1 8 0m-4 4h.01"/>'
  };
  return `<svg class="icon" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[n] || ''}</svg>`;
}
function notify(msg, isError=false) {
  clearTimeout(toastTimeout);
  toastEl.innerHTML = `<span>${isError ? '⚠' : '✦'}</span> ${html(msg)}`;
  toastEl.className = `toast show ${isError ? 'toast-error' : ''}`;
  toastTimeout = setTimeout(()=>toastEl.classList.remove('show'),4200);
}
function setURL(code='') {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room',code);
  else url.searchParams.delete('room');
  history.replaceState(null,'',url.pathname+url.search);
}
function dispatch(message) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
  else notify('Connexion en cours, réessaie dans un instant.', true);
}
function enterRoom(code, type='room:join') {
  if (!code) return;
  state.entering = true;
  dispatch({type, code});
}
function showHome() {
  resetFinale(); state.screen = 'home'; state.room = null; state.entering=false; setURL('');
  dispatch({type:'lobby:list'}); render();
}
function connect() {
  if (!state.user) return;
  if (state.socket?.readyState === WebSocket.CONNECTING || state.socket?.readyState === WebSocket.OPEN) return;
  clearTimeout(reconnectTimeout);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${proto}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener('open', () => {
    reconnectAttempts = 0;
    state.connected = true;
    if (state.invited) { const code = state.invited; state.invited=''; enterRoom(code,'room:join'); }
    else if (state.screen === 'room' && state.room) enterRoom(state.room.code,'room:watch');
    else dispatch({type:'lobby:list'});
    renderHeader();
  });
  socket.addEventListener('message', event => {
    let msg; try { msg=JSON.parse(event.data); } catch { return; }
    if (msg.type === 'room:state') {
      if (state.entering || state.screen === 'room') {
        const previous = state.room;
        const isEnding = previous?.code === msg.room.code && previous.game?.status === 'playing' &&
          ['round_end', 'game_over'].includes(msg.room.game?.status) && Array.isArray(msg.room.game?.result?.reveal);
        if (state.finale && (msg.room.code !== state.finale.roomCode ||
            msg.room.game?.round !== state.finale.round ||
            !['round_end', 'game_over'].includes(msg.room.game?.status))) resetFinale();
        state.room = msg.room; state.screen = 'room'; state.entering = false; setURL(msg.room.code);
        if (isEnding && !reducedMotion()) startFinale(msg.room);
        else scheduleRender();
      }
    } else if (msg.type === 'lobby:rooms') {
      state.rooms = msg.rooms; if (state.screen === 'home') scheduleRender();
    } else if (msg.type === 'room:left') { showHome(); }
    else if (msg.type === 'error') { state.entering = false; notify(msg.message, true); }
  });
  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    state.connected = false; renderHeader();
    if (state.user) {
      const delay = Math.min(15000, 850 * Math.pow(1.6, reconnectAttempts++)) + Math.random() * 250;
      reconnectTimeout = setTimeout(connect, delay);
    }
  });
  socket.addEventListener('error', () => {});
}
async function api(url, body) {
  const response = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Une erreur est survenue.');
  return data;
}
function renderHeader() {
  const markup = `<div class="header-inner">
      <button class="brand" type="button" data-action="home" aria-label="Skyclub, accueil"><span class="brand-icon"><img src="/art/cloud-mark.svg" alt="" /></span><span class="brand-name">Skyclub<span class="brand-spark">✦</span></span></button>
      <nav class="nav-links" aria-label="Navigation"><span class="nav-caption">LE JEU DE CARTES ENTRE AMIS · PAPER PLAY</span><button class="nav-help" data-action="help">${icon('info')} <span>Comment jouer ?</span></button></nav>
      <div class="header-right">${state.user ? `<span class="connection ${state.connected ? 'on' : 'off'}"><span></span>${state.connected ? 'En ligne' : 'Reconnexion…'}</span><button class="profile" data-action="change-name" title="Changer de pseudo" aria-label="Changer de pseudo">${avatar(state.user,0)}<span>${html(state.user.name)}</span>${icon('refresh')}</button>` : `<span class="header-badge">GRATUIT · 2–8 JOUEURS</span>`}</div>
    </div>`;
  if (markup !== lastHeaderHTML) { header.innerHTML = markup; lastHeaderHTML = markup; }
}
function renderGuest() {
  return `<div class="landing"><section class="hero">
      <div class="eyebrow"><span class="eyebrow-dot"></span> UN PETIT JEU, DE GRANDS MOMENTS</div>
      <h1>Des cartes, des amis,<br><em>et de belles histoires.</em></h1>
      <p class="hero-copy">Une table, quelques cartes et tes personnes préférées. Retrouve le plaisir des jeux de société, même à distance.</p>
      <div class="hero-features"><span>${icon('users')} Jusqu’à <strong>8 joueurs</strong></span><span>${icon('lock')} Salons privés</span><span>${icon('spark')} 100 % en ligne</span></div>
      <div class="hero-scene" aria-hidden="true"><img src="/art/paper-landscape.svg" class="hero-landscape" alt="" draggable="false" /><span class="scene-asterisk">✳</span><div class="scene-card scene-back">${cardBack()}</div><div class="scene-card scene-green">${cardFace(2)}</div><div class="scene-card scene-yellow">${cardFace(7)}</div><div class="scene-card scene-pink">${cardFace(-2)}</div><span class="scene-spark scene-spark-a">✦</span><span class="scene-spark scene-spark-b">✳</span><span class="scene-spark scene-spark-c">✦</span><span class="scene-label">DU PAPIER AU PIXEL ✦</span></div>
    </section>
    <section class="auth-side"><div class="auth-card">
      <div class="auth-top"><span class="mini-tag">ACCÈS IMMÉDIAT ✨</span><h2>On joue ensemble ?</h2><p>Choisis ton pseudo : aucun compte, aucun mot de passe. Crée un salon ou rejoins tes amis avec leur code.</p></div>
      <form id="guest-form" class="auth-form"><label for="guest-name">Ton pseudo</label><input id="guest-name" name="name" placeholder="Ex. SuperJoueur42" autocomplete="nickname" minlength="2" maxlength="18" required autofocus />
      <button class="btn primary auth-submit" type="submit" ${state.guestBusy ? 'disabled' : ''}>${state.invited ? 'Rejoindre le salon' : 'Commencer à jouer'} ${icon('arrow')}</button>
      <div class="auth-detail"><span>🔒</span> Ton navigateur conserve ta place grâce à un cookie privé. Ne partage que le code du salon.</div></form>
      ${state.invited ? `<div class="invite-note">✉️ Une invitation pour le salon <strong>${html(state.invited)}</strong> t’attend !</div>` : ''}
      </div><div class="auth-proof">${avatarGroup([{name:'Lea'},{name:'Max'},{name:'Theo'},{name:'Mia'}])}<span>Une table, des amis, une bonne soirée.</span></div>
    </section></div>`;
}
function roomsList() {
  if (!state.rooms.length) return `<div class="empty-rooms"><div class="empty-doodle">${icon('spark')}</div><strong>Aucune partie en cours</strong><span>Ta prochaine soirée jeux n’attend que toi !</span></div>`;
  return `<div class="rooms-list">${state.rooms.map(room => `<button class="room-line" data-action="watch" data-code="${room.code}"><span class="room-letter">${room.code.slice(0,1)}</span><span class="room-meta"><b>Salon ${html(room.code)}</b><small>${room.status==='lobby'?'En attente':room.status==='game_over'?'Partie terminée':`Manche ${room.round} en cours`}</small></span><span class="room-count">${icon('users')} ${room.players.length}/8</span>${icon('chevron')}</button>`).join('')}</div>`;
}
function renderHome() {
  const first = state.user?.name?.split(' ')[0] || 'toi';
  return `<div class="home-wrap"><div class="home-welcome"><div><span class="eyebrow"><span class="eyebrow-dot"></span> TON ESPACE DE JEU</span><h1>Bonjour, ${html(first)} <span class="wave">✦</span></h1><p>Prêt·e à faire tomber les points ? Invite ta bande et que le meilleur gagne !</p></div><span class="welcome-decor">✦</span></div>
    <div class="home-layout"><section class="home-primary"><div class="welcome-panel"><span class="panel-glow panel-glow-one"></span><span class="panel-glow panel-glow-two"></span><div class="welcome-text"><span class="light-tag">LE BON MOMENT, C’EST MAINTENANT</span><h2>Une partie entre amis ?<br><em>La table est prête.</em></h2><p>Crée ta salle, partage le code et installez-vous : la soirée peut commencer.</p><button class="btn lime big" data-action="create">${icon('plus')} Créer un salon ${icon('arrow')}</button></div><div class="home-card-stack" aria-hidden="true"><div class="home-floating-card c1">${cardBack()}</div><div class="home-floating-card c2">${cardFace(12)}</div><div class="home-floating-card c3">${cardFace(-2)}</div><span class="home-floating-star">✳</span></div></div>
      <div class="home-bottom"><article class="info-tile"><div class="info-icon lilac">${icon('users')}</div><div><h3>Jusqu’à 8 joueurs</h3><p>Plus on est de fous, plus les retournements sont mémorables.</p></div></article><article class="info-tile"><div class="info-icon peach">${icon('trophy')}</div><div><h3>Les vraies règles</h3><p>Le paquet classique, les colonnes, les scores. Tout y est.</p></div></article></div>
    </section><aside class="home-aside"><div class="white-panel join-panel"><div class="panel-heading"><div class="panel-icon">✉</div><div><h3>Tu as un code ?</h3><p>Rejoins tes amis en deux clics.</p></div></div><form id="join-form" class="join-form"><label for="room-code">CODE DU SALON</label><input type="text" name="code" id="room-code" placeholder="EX. ABCD2345" minlength="6" maxlength="8" autocomplete="off" required /><button class="btn primary" type="submit">Rejoindre ${icon('arrow')}</button></form></div>
      <div class="white-panel recent-panel"><div class="panel-title"><h3>Mes salons <span class="soft-count">${state.rooms.length}</span></h3><button class="text-link" data-action="reload">Actualiser ${icon('refresh')}</button></div>${roomsList()}</div>
      </aside></div></div>`;
}
function statusText(room) {
  const g = room.game, mine = g.currentId === room.me;
  if (!g) return {title:'La table est presque prête !', subtitle:'Partage le code avec tes amis, puis lance la partie.', label:'SALON EN ATTENTE',cls:'waiting'};
  if (g.status==='setup') {
    const count = g.revealed[room.me] || 0;
    return {title:count===2?'Tes cartes sont prêtes !':'Choisis tes deux premières cartes', subtitle:count===2?'On attend que les autres retournent leurs cartes.':`Retourne ${2-count} carte${2-count>1?'s':''} de ta grille pour commencer.`, label:`PRÉPARATION · ${room.players.filter(p=>g.revealed[p.id]===2).length}/${room.players.length} PRÊTS`,cls:'setup'};
  }
  if (g.status==='round_end') return {title:'La manche est terminée !',subtitle:'Découvre les scores, puis repartez pour un tour.',label:'FIN DE MANCHE',cls:'end'};
  if (g.status==='game_over') return {title:'Quelle partie ! 🏆',subtitle:'Les scores sont tombés. Découvrez le grand gagnant !',label:'PARTIE TERMINÉE',cls:'end'};
  if (!mine) return {title:`C’est au tour de ${nameOf(room,g.currentId)}`,subtitle:g.finisherId?'Dernier tour de table avant le décompte.':'Observe les cartes et prépare ton prochain coup.',label:g.finisherId?'DERNIER TOUR':'EN ATTENTE',cls:'waiting'};
  const cases = {
    choose:['À toi de jouer !','Choisis une carte de la pioche ou récupère la défausse.'],
    drawn:['Une nouvelle carte !','Échange-la avec une carte de ta grille, ou défausse-la.'],
    place:['À toi de choisir.','Remplace n’importe quelle carte encore présente dans ta grille.'],
    flip:['Encore une carte à révéler.','Clique sur une carte cachée de ta grille pour finir ton tour.']
  };
  return {title:cases[g.phase]?.[0] || 'À ton tour !',subtitle:cases[g.phase]?.[1] || '',label:g.finisherId?'DERNIER TOUR':'C’EST TON TOUR',cls:'active'};
}
function renderRoster(room) {
  const g=room.game;
  return `<div class="player-roster">${room.players.map((p,i)=>`<div class="roster-person ${g?.currentId===p.id?'current':''} ${p.id===room.me?'roster-me':''}">
    <div class="roster-avatar-wrap">${avatar(p,i)}<span class="presence-dot ${p.online?'online':''}" title="${p.online?'Connecté':'Hors ligne'}"></span></div><div class="roster-label"><strong>${html(p.name)}${p.id===room.me?' <span class="you-mark">(toi)</span>':''}</strong><small>${!g?(p.id===room.hostId?'Hôte':'Invité'):g.status==='setup'?`${g.revealed[p.id]}/2 cartes`:g.currentId===p.id?'Joue maintenant':`${total(g,p.id)} pts au total`}</small></div>${g?.status==='setup'&&g.revealed[p.id]===2?`<span class="ready-check">${icon('check')}</span>`:''}
    </div>`).join('')}${room.players.length<8&&!g?`<div class="roster-empty">${icon('plus')} ${8-room.players.length} place${8-room.players.length>1?'s':''} libre${8-room.players.length>1?'s':''}</div>`:''}</div>`;
}
function renderLobby(room) {
  const meHost = room.hostId===room.me;
  const hostOnline = room.players.find(p=>p.id===room.hostId)?.online;
  const invite = `${location.origin}/?room=${room.code}`;
  return `<div class="room-page"><div class="room-breadcrumb"><button class="crumb" data-action="home">${icon('back')} Mes salons</button><span>/</span><strong>Salon ${room.code}</strong></div>
    <div class="room-top"><div><span class="eyebrow"><span class="eyebrow-dot"></span> TABLE PRIVÉE</span><h1>La table <em>t’attend !</em></h1><p>Encore quelques amis, et la partie peut commencer.</p></div><div class="room-label"><span class="small-muted">CODE DU SALON</span><div>${room.code}<button data-action="copy-code" aria-label="Copier le code">${icon('copy')}</button></div></div></div>
    <div class="lobby-grid"><div class="white-panel lobby-panel"><div class="panel-title"><h2>Autour de la table <span class="soft-count">${room.players.length}/8</span></h2><span class="lobby-live"><span></span> Salon ouvert</span></div>
      <div class="seats-grid">${Array.from({length:8},(_,i)=>{const p=room.players[i];return p?`<div class="seat filled">${avatar(p,i)}<strong>${html(p.name)}</strong><small>${p.id===room.hostId?'👑 Hôte':p.id===room.me?'C’est toi !':'À la table'}</small></div>`:`<div class="seat empty"><span class="seat-plus">${icon('plus')}</span><strong>Place libre</strong><small>En attente d’un ami</small></div>`}).join('')}</div>
      <div class="lobby-actions"><div class="lobby-tip">${icon('info')} ${room.players.length<2?'Il faut au moins 2 joueurs pour commencer.':'Vous êtes assez nombreux pour jouer !'}</div>${meHost?`<button class="btn primary big" data-action="start" ${room.players.length<2?'disabled':''}>Lancer la partie ${icon('arrow')}</button>`:hostOnline?`<span class="waiting-host">${icon('refresh')} L’hôte va lancer la partie…</span>`:`<button class="btn secondary" data-action="claim-host">Devenir l’hôte ${icon('arrow')}</button>`}</div></div>
      <aside class="lobby-aside"><div class="invite-panel"><span class="invite-emoji">💌</span><h3>Une place pour chacun !</h3><p>Envoie ce lien à ta bande, ils pourront rejoindre directement la table.</p><div class="invite-link">${html(invite)}<button data-action="copy-link" aria-label="Copier le lien">${icon('copy')}</button></div><button class="btn lime full" data-action="copy-link">${icon('copy')} Copier le lien d’invitation</button></div>
      <div class="lobby-rules"><span class="rule-graphic">${cardFace(0)}${cardFace(-1)}</span><strong>Une partie, ça se joue comment ?</strong><p>12 cartes par joueur, fais le plus petit score et élimine tes colonnes.</p><button class="text-link" data-action="help">Voir les règles ${icon('arrow')}</button></div>
      <button class="quiet-link" data-action="leave">Quitter le salon</button></aside></div></div>`;
}
function renderSmallHand(room,player,i) {
  const g=room.game, hand=g.hands[player.id] || [];
  const active = g.currentId===player.id;
  return `<div class="opponent ${active?'playing':''}"><div class="opponent-title">${avatar(player,i)}<span><strong>${html(player.name)}</strong><small>${g.status==='setup'?`${g.revealed[player.id]}/2 retournées`:`${countVisible(hand)}/12 visibles`}</small></span>${active?`<span class="turn-pip" title="À son tour"></span>`:''}</div><div class="mini-grid">${hand.map(c=>`<span class="mini-card ${c.removed?'mini-removed':!c.face?'mini-back':`mini-${cardKind(c.value)}`}">${c.removed?'':c.face?c.value:'✳'}</span>`).join('')}</div></div>`;
}
function renderCenter(room) {
  const g=room.game, hand=g.hands[room.me], myTurn=g.currentId===room.me;
  let interType = null;
  if (g.status==='setup'&&g.revealed[room.me]<2) interType='hidden';
  if (g.status==='playing'&&myTurn) {
    if (['drawn','place'].includes(g.phase)) interType='any';
    if (g.phase==='flip') interType='hidden';
  }
  const status = statusText(room);
  const meIndex=room.players.findIndex(p=>p.id===room.me);
  return `<div class="turn-banner ${status.cls}"><div class="turn-symbol">${status.cls==='active'?'✦':status.cls==='setup'?'✳':status.cls==='end'?'🏆':'⌛'}</div><div><span class="banner-eyebrow">${html(status.label)}</span><strong>${html(status.title)}</strong><p>${html(status.subtitle)}</p></div>${status.cls==='active'?'<div class="pulse-rings" aria-hidden="true"></div>':''}</div>
    <section class="my-board"><div class="my-board-header"><div class="my-identity">${avatar(room.players[meIndex],meIndex)}<div><span>MA GRILLE DE JEU</span><h2>${html(room.players[meIndex].name)} <span>(toi)</span></h2></div></div><div class="my-board-metadata"><div><small>CARTES VISIBLES</small><strong>${countVisible(hand)}<span>/12</span></strong></div><div><small>SCORE TOTAL</small><strong>${total(g,room.me)} <span>pts</span></strong></div></div></div>
    <div class="board-surface"><div class="board-dot bdot-a"></div><div class="board-dot bdot-b"></div><div class="my-grid">${hand.map((c,i)=>cardSlot(c,i,{own:true,interactive:!!interType&&(interType==='any'||!c.face)&&!c.removed,selected:!!interType&&(interType==='any'||!c.face)&&!c.removed})).join('')}</div><span class="board-note">4 COLONNES · 3 LIGNES</span></div>
    <div class="board-bottom"><div class="tip-item"><span>✦</span><p><strong>Astuce :</strong> 3 cartes identiques dans une colonne = 3 cartes éliminées !</p></div>${g.finisherId?`<span class="last-round-chip">${icon('info')} Dernier tour !</span>`:''}</div></section>`;
}
function renderDeck(room) {
  const g=room.game; const turn=g.status==='playing'&&g.currentId===room.me;
  const canPick=turn&&g.phase==='choose';
  const hasDrawn=turn&&['drawn','place'].includes(g.phase);
  return `<div class="deck-box"><div class="panel-title"><h3>Au centre de la table</h3><span class="pill light">MANCHE ${g.round}</span></div><div class="deck-piles"><div class="pile-wrap"><span class="pile-label">PIOCHE</span><button class="pile-button" data-action="pick-deck" ${canPick?'':'disabled'} aria-label="Piocher une carte cachée">${cardBack('deck-top')}<span class="pile-shadow"></span></button><span class="pile-foot">${g.deckCount} cartes</span></div><div class="pile-arrow">↔</div><div class="pile-wrap"><span class="pile-label">DÉFAUSSE</span><button class="pile-button" data-action="pick-discard" ${canPick?'':'disabled'} aria-label="Prendre la carte de la défausse">${g.discardTop!==null?cardFace(g.discardTop,'deck-top'):cardRemoved()}<span class="pile-shadow"></span></button><span class="pile-foot">Face visible</span></div></div>
    ${hasDrawn?`<div class="drawn-box"><span class="drawn-label">TA CARTE PIOCHÉE</span><div class="drawn-row">${cardFace(g.drawn,'drawn-card')}<div><strong>${g.drawnSource==='deck'?'Garder ou défausser ?':'À placer dans ta grille'}</strong><p>${g.drawnSource==='deck'?'Clique sur une carte de ta grille pour l’échanger, ou refuse cette carte.':'Choisis une carte de ta grille à remplacer.'}</p>${g.phase==='drawn'?`<button class="btn discard-btn" data-action="discard">Défausser ${icon('arrow')}</button>`:''}</div></div></div>`:''}
    ${g.status==='setup'?`<div class="deck-instructions">${icon('info')} Retourne deux cartes pour révéler ton départ.</div>`:''}
    ${canPick?`<p class="deck-instructions">${icon('spark')} Choisis une pile pour commencer ton tour.</p>`:''}
    ${turn&&g.phase==='flip'?`<p class="deck-instructions active-instruction">${icon('spark')} Retourne une carte cachée de ta grille pour finir ton tour.</p>`:''}
    </div>`;
}
function renderScorePanel(room) {
  const g=room.game;
  const ranked=[...room.players].sort((a,b)=>total(g,a.id)-total(g,b.id));
  return `<div class="score-box"><div class="panel-title"><h3>Classement</h3><button class="text-link" data-action="scores">Détails ${icon('chevron')}</button></div><div class="score-rows">${ranked.map((p,i)=>`<div class="score-row"><span class="rank ${i===0?'leader':''}">${String(i+1).padStart(2,'0')}</span>${avatar(p,room.players.indexOf(p))}<strong>${html(p.name)}${p.id===room.me?' <small>(toi)</small>':''}</strong><span class="score-points">${total(g,p.id)} <small>pts</small></span></div>`).join('')}</div><div class="score-foot">${icon('trophy')} Le plus petit score gagne à 100 points !</div></div>`;
}
function renderActivity(room) {
  return `<div class="activity-box"><div class="panel-title"><h3>La vie de la table</h3><span class="live-indicator"><span></span> EN DIRECT</span></div><div class="activity-list">${room.game.logs.slice(-5).reverse().map(item=>`<div class="activity-line"><span class="activity-dot"></span><span>${html(item.text)}</span></div>`).join('')}</div></div>`;
}
function renderFinale(room) {
  const g = room.game;
  const reveal = new Map(g.result.reveal.map(p => [p.id, p]));
  return `<div class="finale-page" role="region" aria-label="Révélation des cartes et décompte de la manche">
    <div class="finale-heading"><span class="finale-eyebrow">✦ MANCHE ${g.round} · LE GRAND FINAL ✦</span>
      <h1 data-finale-title>Dernier tour !</h1><p data-finale-subtitle>Un peu de suspense avant les scores…</p>
      <button class="btn finale-skip" data-action="skip-finale">Passer l’animation ${icon('arrow')}</button></div>
    <div class="finale-players">${room.players.map((player, i) => {
      const snapshot = reveal.get(player.id);
      return `<section class="finale-player ${player.id === room.me ? 'finale-you' : ''}" data-final-player="${html(player.id)}">
        <div class="finale-player-top">${avatar(player,i)}<div><strong>${html(player.name)}</strong><small>${player.id === room.me ? 'Tes cartes' : g.finisherId === player.id ? 'A terminé en premier' : 'Son plateau'}</small></div>
          <div class="finale-score-wrap"><output data-finale-score aria-label="Points de la manche">—</output><small data-finale-total>Décompte à venir</small></div></div>
        <div class="finale-hand">${g.hands[player.id].map((card, index) => {
          const wasRemoved = !!snapshot?.removedBefore[index];
          const wasHidden = !snapshot?.faceBefore[index] && !wasRemoved;
          return `<span class="finale-tile ${wasRemoved ? 'is-removed' : wasHidden ? '' : 'is-flipped'}" data-final-index="${index}">
            <span class="finale-tile-inner"><span class="finale-tile-back">${cardBack()}</span><span class="finale-tile-front">${cardFace(card.value)}</span></span><span class="finale-tile-gone" aria-hidden="true">✦</span></span>`;
        }).join('')}</div><span class="finale-doubled-note">Points doublés ×2</span></section>`;
    }).join('')}</div>
    <div class="finale-foot"><span>✷ Les scores sont validés par le serveur.</span><span>Paper Play + Spark</span></div>
  </div>`;
}
function renderGame(room) {
  const g=room.game;
  if (g.status==='round_end'||g.status==='game_over') return renderResults(room);
  const opponents=room.players.filter(p=>p.id!==room.me);
  return `<div class="room-page game-page"><div class="game-top"><div class="game-nav"><button class="crumb" data-action="home">${icon('back')} Mes salons</button><span class="game-nav-divider">/</span><span>Salon <strong>${room.code}</strong></span><button class="code-chip" data-action="copy-link">${icon('copy')} Inviter</button></div><div class="game-top-right"><span class="live-indicator"><span></span> PARTIE EN DIRECT</span><button class="round-chip" data-action="scores">${icon('trophy')} Scores</button><button class="help-chip" data-action="help">${icon('info')}</button></div></div>
    ${opponents.length?`<div class="opponents-scroll"><div class="opponents-grid">${opponents.map((p,i)=>renderSmallHand(room,p,room.players.indexOf(p))).join('')}</div></div>`:''}
    <div class="game-main"><div class="game-center">${renderCenter(room)}</div><aside class="game-sidebar">${renderDeck(room)}${renderScorePanel(room)}${renderActivity(room)}</aside></div>
    </div>`;
}
function renderResults(room) {
  const g=room.game, result=g.result;
  const ended=g.status==='game_over';
  const ranked=[...room.players].sort((a,b)=>result.totals[a.id]-result.totals[b.id]);
  const names=result.winnerIds.map(id=>nameOf(room,id));
  return `<div class="room-page results-page"><button class="crumb" data-action="home">${icon('back')} Mes salons</button><div class="result-heading"><div class="result-trophy">${ended?'🏆':'✳'}</div><span class="eyebrow"><span class="eyebrow-dot"></span> ${ended?'PARTIE TERMINÉE':`MANCHE ${g.round} TERMINÉE`}</span><h1>${ended?'Et le grand gagnant est…':'Les cartes ont parlé !'}</h1><p>${ended?`Bravo à <strong>${html(names.join(' et '))}</strong> ! Une belle partie entre amis.`:'C’est le moment de regarder qui s’en est le mieux sorti.'}</p></div>
    <div class="result-layout"><section class="white-panel results-table"><div class="panel-title"><h2>${ended?'Le classement final':'Les scores de cette manche'}</h2><span class="pill light">${room.players.length} JOUEURS</span></div><div class="result-table-header"><span>JOUEUR</span><span>MANCHE</span><span>TOTAL</span></div>${ranked.map((p,i)=>`<div class="result-line ${i===0?'result-first':''}"><div class="result-person"><span class="result-rank">${i===0?'🏆':String(i+1).padStart(2,'0')}</span>${avatar(p,room.players.indexOf(p))}<span><b>${html(p.name)}</b><small>${p.id===room.me?'C’est toi !':result.doubledId===p.id?'Score doublé ×2':g.finisherId===p.id?'A terminé la manche':''}</small></span></div><strong class="result-single">${result.scores[p.id] > 0 ? '+' : ''}${result.scores[p.id]}</strong><strong class="result-total">${result.totals[p.id]} <small>pts</small></strong></div>`).join('')}</section>
    <aside class="result-aside"><div class="next-card"><span class="next-decoration">✳</span><span class="mini-tag">${ended?'C’EST FINI… OU PAS !':'ON REMET ÇA ?'}</span><h3>${ended?'Une revanche ?':'Encore une manche !'}</h3><p>${ended?'Réinitialise les scores pour repartir de zéro.':'On garde les scores, on mélange et on recommence.'}</p>${room.hostId===room.me?`<button class="btn lime full" data-action="${ended?'replay':'next'}">${ended?'Nouvelle partie':'Manche suivante'} ${icon('arrow')}</button>`:room.players.find(p=>p.id===room.hostId)?.online?`<div class="waiting-host">${icon('refresh')} L’hôte prépare la suite…</div>`:`<button class="btn lime full" data-action="claim-host">Reprendre la table ${icon('arrow')}</button>`}</div><button class="btn secondary full" data-action="scores">Voir l’historique des points ${icon('arrow')}</button><button class="quiet-link" data-action="home">Revenir à mes salons</button></aside></div></div>`;
}
function renderScoresModal() {
  const r=state.room,g=r?.game;
  if (!g) return '';
  const length=Math.max(...r.players.map(p=>g.scores[p.id]?.length||0),0);
  return `<div class="modal-backdrop" data-action="dismiss"><div class="modal-card scores-modal" role="dialog" aria-modal="true" aria-label="Historique des scores"><div class="modal-top"><div><span class="mini-tag">TABLEAU DES SCORES</span><h2>Le carnet de points</h2></div><button class="icon-button" data-action="close-modal" aria-label="Fermer">${icon('x')}</button></div><div class="score-history-scroll"><table class="history-table"><thead><tr><th>Joueur</th>${Array.from({length},(_,i)=>`<th>M${i+1}</th>`).join('')}<th>Total</th></tr></thead><tbody>${r.players.map((p,i)=>`<tr><td>${avatar(p,i)} ${html(p.name)}</td>${(g.scores[p.id]||[]).map(x=>`<td>${x>0?'+':''}${x}</td>`).join('')}<td class="strong">${total(g,p.id)}</td></tr>`).join('')}</tbody></table></div><p class="modal-footnote">Le joueur avec le plus petit total remporte la partie dès qu’un joueur atteint 100 points.</p></div></div>`;
}
function renderHelpModal() {
  return `<div class="modal-backdrop" data-action="dismiss"><div class="modal-card help-modal" role="dialog" aria-modal="true" aria-label="Règles du jeu"><div class="modal-top"><div><span class="mini-tag">PETIT RAPPEL</span><h2>Comment on joue ?</h2></div><button class="icon-button" data-action="close-modal" aria-label="Fermer">${icon('x')}</button></div>
    <div class="rules-intro">🎯 <strong>Le but ?</strong> Avoir le moins de points possible. Quand un joueur atteint 100 points, celui qui a le plus petit total gagne !</div>
    <div class="rules-sections"><div class="rule-line"><span>01</span><div><h3>Prépare ta grille</h3><p>Chacun reçoit 12 cartes face cachée, réparties en 4 colonnes de 3. Retourne 2 cartes pour commencer. Celui qui a la somme visible la plus élevée joue en premier.</p></div></div><div class="rule-line"><span>02</span><div><h3>Pioche ou prends la défausse</h3><p>À ton tour, prends la carte visible de la défausse et échange-la obligatoirement avec l’une des tiennes, ou pioche une carte cachée : garde-la pour l’échanger, ou défausse-la et retourne l’une de tes cartes cachées.</p></div></div><div class="rule-line"><span>03</span><div><h3>Élimine les colonnes</h3><p>Si les 3 cartes d’une même colonne sont visibles et identiques, elles sont retirées de ta grille et ne rapportent aucun point.</p></div></div><div class="rule-line"><span>04</span><div><h3>Termine la manche</h3><p>Quand quelqu’un a dévoilé toute sa grille, les autres ont un dernier tour. S’il n’a pas le score strictement le plus bas, ses points positifs sont doublés !</p></div></div></div>
    <div class="deck-count"><strong>🃏 Le paquet classique · 150 cartes</strong><div class="deck-stats"><span>5 cartes <b>−2</b></span><span>10 cartes <b>−1</b></span><span>15 cartes <b>0</b></span><span>10 de chaque <b>1 à 12</b></span></div></div>
    <button class="btn primary full" data-action="close-modal">Compris, on joue ! ${icon('arrow')}</button></div></div>`;
}
function render() {
  renderHeader();
  const page = !state.user ? renderGuest() : state.screen === 'room' && state.room
    ? (state.finale && state.room.game?.result?.reveal ? renderFinale(state.room)
      : state.room.game ? renderGame(state.room) : renderLobby(state.room)) : renderHome();
  if (page !== lastPageHTML) { root.innerHTML = page; lastPageHTML = page; }
  const modal = state.help ? renderHelpModal() : state.scores && state.room?.game ? renderScoresModal() : '';
  if (modal !== lastOverlayHTML) { overlay.innerHTML = modal; lastOverlayHTML = modal; }
  document.body.classList.toggle('modal-open', state.help || state.scores);
}
async function copy(text) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const ta=document.createElement('textarea'); ta.value=text; document.body.append(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    notify('Copié ! Tu peux le partager à tes amis.');
  } catch { notify(`À partager : ${text}`); }
}
function cardClicked(index) {
  const r=state.room,g=r?.game;if (!g) return;
  if (g.status==='setup' && g.revealed[r.me]<2) dispatch({type:'game:action',code:r.code,action:'reveal',index});
  else if (g.status==='playing'&&g.currentId===r.me) {
    if (g.phase==='flip') dispatch({type:'game:action',code:r.code,action:'flip',index});
    else if (g.phase==='place'||g.phase==='drawn') dispatch({type:'game:action',code:r.code,action:'swap',index});
  }
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button)return;
  const action=button.dataset.action;
  if (action==='dismiss'&&event.target!==button)return;
  if (action==='help'){state.help=true;state.scores=false;render();return;}
  if (action==='scores'){state.scores=true;state.help=false;render();return;}
  if (action==='dismiss'||action==='close-modal'){state.help=false;state.scores=false;render();return;}
  if (action==='skip-finale'){resetFinale();scheduleRender();return;}
  if (action==='home'){if(state.user)showHome();return;}
  if (action==='change-name') {
    const name=prompt('Choisis ton nouveau pseudo (2 à 18 caractères) :',state.user?.name||'');
    if(name===null)return;
    try { const data=await api('/api/guest',{name}); state.user=data.user; scheduleRender(); notify(`Ton pseudo est maintenant ${data.user.name}.`); }
    catch(e){notify(e.message,true);}
    return;
  }
  if (action==='create'){state.entering=true;dispatch({type:'room:create'});return;}
  if (action==='claim-host'){dispatch({type:'room:claim-host',code:state.room?.code});return;}
  if (action==='watch'){enterRoom(button.dataset.code,'room:watch');return;}
  if (action==='reload'){dispatch({type:'lobby:list'});notify('Salons actualisés.');return;}
  if (action==='copy-code'){copy(state.room?.code||'');return;}
  if (action==='copy-link'){copy(`${location.origin}/?room=${state.room?.code}`);return;}
  if (action==='leave'){
    if (state.room) dispatch({type:'room:leave',code:state.room.code}); return;
  }
  if (action==='start'||action==='next'||action==='replay'){dispatch({type:'game:action',code:state.room?.code,action});return;}
  if (action==='cell'){cardClicked(Number(button.dataset.index));return;}
  if (action==='pick-deck'||action==='pick-discard'){dispatch({type:'game:action',code:state.room?.code,action:'pick',source:action==='pick-deck'?'deck':'discard'});return;}
  if (action==='discard'){dispatch({type:'game:action',code:state.room?.code,action:'discard'});return;}
});
document.addEventListener('submit',async event=>{
  if(event.target.id==='guest-form'){
    event.preventDefault();
    if(state.guestBusy)return;
    const form=new FormData(event.target);
    state.guestBusy=true;
    const submit=event.target.querySelector('button[type=submit]');submit.disabled=true;
    try{
      const data=await api('/api/guest',{name:form.get('name')});
      state.user=data.user;state.screen='home';connect();render();notify(`Bienvenue ${state.user.name} ! 🎉`);
    }catch(e){notify(e.message,true);submit.disabled=false;}
    finally{state.guestBusy=false;}
  }
  if(event.target.id==='join-form'){
    event.preventDefault();
    const code=String(new FormData(event.target).get('code')||'').trim().toUpperCase();
    if(!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}(?:[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{2})?$/.test(code)){notify('Code invalide : 8 caractères (6 pour les anciens salons).',true);return;}
    enterRoom(code);
  }
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(state.help||state.scores)){state.help=false;state.scores=false;render();}});
window.addEventListener('popstate',()=>{if(state.user)showHome();});
window.addEventListener('online', () => {
  if (state.user && state.socket?.readyState !== WebSocket.OPEN && state.socket?.readyState !== WebSocket.CONNECTING) connect();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRender();
});
(async()=>{
  try{const res=await fetch('/api/me'); const data=await res.json();state.user=data.user;}
  catch{notify('Impossible de joindre le serveur.',true);}
  if(state.user){connect();if(state.invited)state.entering=true;}
  render();
})();
