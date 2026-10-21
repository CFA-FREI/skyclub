import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_PLAYERS = 8;
const MAX_SOCKETS = Math.max(8, Number(process.env.MAX_SOCKETS) || 512);
const MAX_TABS_PER_USER = 3;
const MAX_CONNECTIONS_PER_IP = 48;
const MAX_ROOMS = 400;
const MAX_ROOMS_PER_GUEST = 10;
const ROOM_CODE_LENGTH = 8;
const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'store.json');
let db = { users: [], sessions: {}, rooms: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // Migration automatique : les anciens comptes deviennent de simples invités.
  // Les empreintes de mots de passe ne sont plus utiles et ne sont pas conservées.
  db = { users: (loaded.users || []).map(({ id, name, createdAt }) => ({ id, name, createdAt })), sessions: loaded.sessions || {}, rooms: loaded.rooms || {} };
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error('Sauvegarde illisible : démarrage interrompu pour ne pas écraser les données :', e.message);
    process.exit(1);
  }
}
let sessionsPruned = false;
for (const [hash, session] of Object.entries(db.sessions)) {
  if (!session || session.expires < Date.now()) { delete db.sessions[hash]; sessionsPruned = true; }
}
const usersById = new Map(db.users.map(user => [user.id, user]));
const roomsByUser = new Map();
function addMembership(id, code) {
  if (!roomsByUser.has(id)) roomsByUser.set(id, new Set());
  roomsByUser.get(id).add(code);
}
function removeMembership(id, code) {
  const rooms = roomsByUser.get(id);
  if (rooms) { rooms.delete(code); if (!rooms.size) roomsByUser.delete(id); }
}
// La rétention limite le stockage et supprime les anciens codes de salon.
const nowAtStart = Date.now();
for (const [code, room] of Object.entries(db.rooms)) {
  const maxAge = room.game ? 14 * 86400000 : 2 * 86400000;
  if (!room?.players?.length || nowAtStart - (room.updatedAt || room.createdAt || 0) > maxAge) { delete db.rooms[code]; sessionsPruned = true; }
}
for (const room of Object.values(db.rooms)) for (const player of room.players) addMembership(player.id, room.code);
// Anciennes identités inactives, sans salon et sans session valide.
const activeUsers = new Set(Object.values(db.sessions).map(s => s.userId));
db.users = db.users.filter(u => activeUsers.has(u.id) || roomsByUser.has(u.id) || nowAtStart - u.createdAt < ONE_MONTH);
usersById.clear();
for (const user of db.users) usersById.set(user.id, user);

// Regroupe les mutations rapprochées et écrit hors de la boucle événementielle.
// Une seule écriture atomique à la fois : les snapshots ne peuvent pas se doubler.
const SAVE_DELAY_MS = 35;
let saveTimer = null;
let writing = false;
let dirty = false;
let currentWrite = Promise.resolve();
let writeFailures = 0;
function save() {
  dirty = true;
  if (saveTimer === null && !writing) {
    saveTimer = setTimeout(() => { saveTimer = null; void persist(); }, SAVE_DELAY_MS);
  }
}
async function persist() {
  if (writing || !dirty) return currentWrite;
  writing = true;
  dirty = false;
  const snapshot = JSON.stringify(db);
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  currentWrite = (async () => {
    await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.promises.rename(tmp, DB_FILE);
  })();
  try {
    await currentWrite;
    writeFailures = 0;
  } catch (err) {
    dirty = true;
    writeFailures++;
    console.error('Échec de sauvegarde (nouvelle tentative prévue):', err);
  } finally {
    writing = false;
    if (dirty && saveTimer === null) {
      saveTimer = setTimeout(() => { saveTimer = null; void persist(); }, Math.min(5000, SAVE_DELAY_MS * 2 ** Math.min(writeFailures, 7)));
    }
  }
}
if (sessionsPruned) save();
async function flushSave() {
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  if (writing) await currentWrite.catch(() => {});
  if (dirty) await persist();
  if (dirty) throw new Error('La sauvegarde ne peut pas être terminée.');
}
function randomId(bytes = 16) { return crypto.randomBytes(bytes).toString('hex'); }
function sha(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function slugUsername(str) { return String(str || '').trim().replace(/\s+/g, ' '); }
function validName(name) { return typeof name === 'string' && name.length >= 2 && name.length <= 18 && /^[\p{L}\p{N} _.'-]+$/u.test(name); }
function normalizedName(name) { return name.toLocaleLowerCase('fr'); }
// Les codes à 6 caractères des parties existantes restent utilisables après mise à jour.
function validCode(code) { return typeof code === 'string' && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}(?:[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{2})?$/.test(code); }
function requestIp(req) { return req.socket.remoteAddress || 'unknown'; } // Ne jamais faire confiance au X-Forwarded-For envoyé par le client.
function getSession(req) {
  const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('sid='));
  const token = cookie?.slice(4);
  if (!token || !/^[a-f\d]{64}$/.test(token)) return null;
  const sess = db.sessions[sha(token)];
  if (!sess || sess.expires < Date.now()) return null;
  return usersById.get(sess.userId) || null;
}
function setCookie(res, token, req, clear = false) {
  const secure = req.socket.encrypted || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
  res.setHeader('Set-Cookie', `sid=${clear ? '' : token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 2592000}${secure ? '; Secure' : ''}`);
}
function newSession(user) {
  const token = randomId(32);
  db.sessions[sha(token)] = { userId: user.id, expires: Date.now() + ONE_MONTH };
  save();
  return token;
}
function publicUser(user) { return { id: user.id, name: user.name, createdAt: user.createdAt }; }
function sendJson(res, status, payload) {
  const out = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(out) });
  res.end(out);
}
function originMatches(req, originRequired = false) {
  const origin = req.headers.origin;
  if (!origin) return !originRequired && !req.headers['sec-fetch-site'];
  try {
    const parsed = new URL(origin);
    // N'accepte aucun WebSocket/API cross-origin, même avec un cookie invité valide.
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.headers.host) return false;
    const isHttps = req.socket.encrypted || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
    return parsed.protocol === (isHttps ? 'https:' : 'http:');
  } catch { return false; }
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10000) throw new Error('Requête trop volumineuse.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Données JSON invalides.'); }
}
// Limites indépendantes par action, invité et adresse IP (en mémoire).
const attempts = new Map();
function rateLimit(key, max = 20, windowMs = 15 * 60000) {
  const now = Date.now();
  if (attempts.size > 4096) {
    for (const [k, row] of attempts) if (now >= row.until) attempts.delete(k);
    if (attempts.size > 4096) attempts.delete(attempts.keys().next().value);
  }
  let row = attempts.get(key);
  if (!row || now >= row.until) { row = { count: 0, until: now + windowMs }; attempts.set(key, row); }
  return ++row.count <= max;
}
function guestNameAvailable(room, userId, name) {
  return !room.players.some(p => p.id !== userId && normalizedName(p.name) === normalizedName(name));
}
function userRooms(userId) {
  return [...(roomsByUser.get(userId) || [])].map(code => db.rooms[code]).filter(Boolean)
    .map(r => ({ code: r.code, hostId: r.hostId, players: r.players.map(p => ({ id: p.id, name: p.name })), status: r.game?.status || 'lobby', round: r.game?.round || 0, updatedAt: r.updatedAt }))
    .sort((a,b) => b.updatedAt - a.updatedAt).slice(0, 30);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function createDeck() {
  const deck = [];
  for (let i = 0; i < 5; i++) deck.push(-2);
  for (let i = 0; i < 15; i++) deck.push(0);
  for (let n = -1; n <= 12; n++) if (n !== 0) for (let i = 0; i < 10; i++) deck.push(n);
  return shuffle(deck);
}
function addLog(g, msg) { g.logs.push({ id: randomId(4), text: msg, at: Date.now() }); g.logs = g.logs.slice(-24); }
function handDone(hand) { return hand.every(card => card.removed || card.face); }
function draw(g) {
  if (g.deck.length === 0 && g.discard.length > 1) {
    const top = g.discard.pop();
    g.deck = shuffle(g.discard);
    g.discard = [top];
    addLog(g, 'La défausse a été mélangée pour refaire la pioche.');
  }
  if (g.deck.length === 0) throw new Error('La pioche est momentanément vide.');
  return g.deck.pop();
}
function applyColumns(g, hand, playerName) {
  for (let col = 0; col < 4; col++) {
    const ids = [col, col + 4, col + 8];
    const cards = ids.map(i => hand[i]);
    if (cards.every(c => !c.removed && c.face && c.v === cards[0].v)) {
      const value = cards[0].v;
      ids.forEach(i => { hand[i].removed = true; });
      // Ces 3 cartes vont SUR la pile après la carte échangée.
      g.discard.push(value, value, value);
      addLog(g, `${playerName} élimine une colonne de trois ${value} ! ✨`);
    }
  }
}
function makeRound(room, round) {
  const deck = createDeck();
  const hands = {};
  for (const p of room.players) hands[p.id] = Array.from({ length: 12 }, () => ({ v: deck.pop(), face: false, removed: false }));
  const g = {
    status: 'setup', round, deck, discard: [deck.pop()], hands,
    revealed: Object.fromEntries(room.players.map(p => [p.id, 0])),
    currentId: null, phase: 'setup', drawn: null, drawnSource: null,
    finisherId: null, finalRemaining: [], lastFinisherId: null,
    scores: room.game?.scores || Object.fromEntries(room.players.map(p => [p.id, []])),
    logs: [], result: null
  };
  addLog(g, `Manche ${round} : chacun retourne deux cartes !`);
  return g;
}
function scoreRound(room) {
  const g = room.game;
  // Snapshot non sensible : seuls les indices/états précédents sont transmis,
  // et uniquement APRÈS la fin de la manche. Les valeurs restent secrètes avant.
  const reveal = room.players.map(p => ({
    id: p.id,
    faceBefore: g.hands[p.id].map(c => !!c.face),
    removedBefore: g.hands[p.id].map(c => !!c.removed)
  }));
  const rawScores = {};
  for (const p of room.players) {
    const hand = g.hands[p.id];
    hand.forEach(c => { if (!c.removed) c.face = true; });
    applyColumns(g, hand, p.name);
    rawScores[p.id] = hand.reduce((sum, card) => sum + (card.removed ? 0 : card.v), 0);
  }
  const scores = { ...rawScores };
  const finisher = g.finisherId;
  if (finisher && rawScores[finisher] > 0 && room.players.some(p => p.id !== finisher && rawScores[p.id] <= rawScores[finisher])) {
    scores[finisher] *= 2;
    addLog(g, 'Le joueur qui a terminé n’a pas le plus petit score : points doublés !');
  }
  const totals = {};
  for (const p of room.players) {
    g.scores[p.id] ??= [];
    g.scores[p.id].push(scores[p.id]);
    totals[p.id] = g.scores[p.id].reduce((s,n) => s + n, 0);
  }
  const ended = Object.values(totals).some(n => n >= 100);
  const best = Math.min(...Object.values(totals));
  g.status = ended ? 'game_over' : 'round_end';
  g.phase = g.status;
  g.currentId = null;
  g.drawn = null;
  g.drawnSource = null;
  g.lastFinisherId = finisher;
  g.result = { rawScores, scores, totals, reveal,
    winnerIds: ended ? Object.keys(totals).filter(id => totals[id] === best) : [],
    doubledId: scores[finisher] !== rawScores[finisher] ? finisher : null };
  addLog(g, ended ? 'La partie est terminée ! 🏆' : `Fin de la manche ${g.round} : les scores sont calculés.`);
}
function finishTurn(room, user) {
  const g = room.game;
  g.drawn = null;
  g.drawnSource = null;
  g.phase = 'choose';
  if (!g.finisherId && handDone(g.hands[user.id])) {
    g.finisherId = user.id;
    g.finalRemaining = room.players.filter(p => p.id !== user.id).map(p => p.id);
    addLog(g, `${user.name} a dévoilé toutes ses cartes ! Un dernier tour pour les autres.`);
  } else if (g.finisherId) {
    g.finalRemaining = g.finalRemaining.filter(id => id !== user.id);
  }
  if (g.finisherId && g.finalRemaining.length === 0) { scoreRound(room); return; }
  const idx = room.players.findIndex(p => p.id === user.id);
  for (let step = 1; step <= room.players.length; step++) {
    const next = room.players[(idx + step) % room.players.length];
    if (!g.finisherId || g.finalRemaining.includes(next.id)) { g.currentId = next.id; return; }
  }
}
function perform(room, user, action, index, source) {
  if (!room.players.some(p => p.id === user.id)) throw new Error('Tu ne fais pas partie de ce salon.');
  if (action === 'start') {
    if (room.hostId !== user.id) throw new Error('Seul l’hôte peut démarrer la partie.');
    if (room.game) throw new Error('La partie a déjà commencé.');
    if (room.players.length < 2) throw new Error('Il faut au moins deux joueurs.');
    room.game = makeRound(room, 1);
    return;
  }
  if (action === 'next' || action === 'replay') {
    if (room.hostId !== user.id) throw new Error('Seul l’hôte peut démarrer la prochaine manche.');
    const expected = action === 'next' ? 'round_end' : 'game_over';
    if (room.game?.status !== expected) throw new Error('Action indisponible pour le moment.');
    if (action === 'replay') room.game = null;
    room.game = makeRound(room, action === 'next' ? (room.game?.round || 0) + 1 : 1);
    return;
  }
  const g = room.game;
  if (!g) throw new Error('La partie n’a pas encore commencé.');
  const hand = g.hands[user.id];
  if (action === 'reveal') {
    if (g.status !== 'setup' || g.revealed[user.id] >= 2) throw new Error('Tu as déjà retourné tes deux cartes.');
    if (!Number.isInteger(index) || index < 0 || index > 11 || hand[index].face || hand[index].removed) throw new Error('Choisis une carte cachée.');
    hand[index].face = true;
    g.revealed[user.id]++;
    if (room.players.every(p => g.revealed[p.id] === 2)) {
      const first = room.players.reduce((best, p) => {
        const sum = g.hands[p.id].filter(c => c.face).reduce((s,c) => s + c.v, 0);
        return sum > best.score ? { id:p.id, score:sum } : best;
      }, { id: room.players[0].id, score: -Infinity });
      g.currentId = first.id;
      g.status = 'playing';
      g.phase = 'choose';
      addLog(g, `${room.players.find(p => p.id === first.id).name} commence cette manche !`);
    }
    return;
  }
  if (g.status !== 'playing' || g.currentId !== user.id) throw new Error('Ce n’est pas ton tour.');
  if (action === 'pick') {
    if (g.phase !== 'choose' || !['discard', 'deck'].includes(source)) throw new Error('Choisis la pioche ou la défausse.');
    if (source === 'discard') {
      if (!g.discard.length) throw new Error('La défausse est vide.');
      g.drawn = g.discard.pop();
      g.drawnSource = 'discard';
      g.phase = 'place';
      addLog(g, `${user.name} prend la défausse.`);
    } else {
      g.drawn = draw(g);
      g.drawnSource = 'deck';
      g.phase = 'drawn';
      addLog(g, `${user.name} pioche une carte.`);
    }
    return;
  }
  if (action === 'discard') {
    if (g.phase !== 'drawn' || g.drawnSource !== 'deck') throw new Error('Tu dois d’abord piocher.');
    g.discard.push(g.drawn);
    g.drawn = null;
    g.drawnSource = null;
    g.phase = 'flip';
    addLog(g, `${user.name} défausse sa carte et va en retourner une.`);
    return;
  }
  if (action === 'swap') {
    if (!['drawn', 'place'].includes(g.phase) || g.drawn === null) throw new Error('Aucune carte à échanger.');
    if (!Number.isInteger(index) || index < 0 || index > 11 || hand[index].removed) throw new Error('Cette position est indisponible.');
    const old = hand[index].v;
    hand[index] = { v: g.drawn, face: true, removed: false };
    g.discard.push(old);
    addLog(g, `${user.name} échange une carte de sa grille.`);
    applyColumns(g, hand, user.name);
    finishTurn(room, user);
    return;
  }
  if (action === 'flip') {
    if (g.phase !== 'flip') throw new Error('Tu dois d’abord défausser la carte piochée.');
    if (!Number.isInteger(index) || index < 0 || index > 11 || hand[index].face || hand[index].removed) throw new Error('Choisis une carte cachée.');
    hand[index].face = true;
    addLog(g, `${user.name} retourne une carte de sa grille.`);
    applyColumns(g, hand, user.name);
    finishTurn(room, user);
    return;
  }
  throw new Error('Action inconnue.');
}
function roomForUser(room, userId) {
  const g = room.game;
  const visible = g ? {
    status: g.status, round: g.round, phase: g.phase, currentId: g.currentId,
    revealed: g.revealed, discardTop: g.discard.at(-1) ?? null, deckCount: g.deck.length,
    drawn: g.currentId === userId ? g.drawn : null,
    drawnSource: g.drawnSource, finisherId: g.finisherId, finalRemaining: g.finalRemaining,
    scores: g.scores, result: g.result, logs: g.logs.slice(-12),
    hands: Object.fromEntries(room.players.map(p => [p.id, g.hands[p.id].map(c => ({ value: c.face || g.status === 'round_end' || g.status === 'game_over' ? c.v : null, face: c.face, removed: c.removed }))]))
  } : null;
  return {
    code: room.code, hostId: room.hostId, maxPlayers: MAX_PLAYERS, me: userId,
    players: room.players.map(p => ({ id: p.id, name: p.name, online: !!connectionsByUser.get(p.id)?.size })),
    game: visible
  };
}
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: ROOM_CODE_LENGTH }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (db.rooms[code]);
  return code;
}

const sockets = new Set();
const connectionsByUser = new Map();
const connectionsByRoom = new Map();
const connectionsByIp = new Map();
function addSocket(ws) {
  sockets.add(ws);
  if (!connectionsByUser.has(ws.user.id)) connectionsByUser.set(ws.user.id, new Set());
  connectionsByUser.get(ws.user.id).add(ws);
  connectionsByIp.set(ws.ip, (connectionsByIp.get(ws.ip) || 0) + 1);
}
function watchSocket(ws, code) {
  if (ws.roomCode === code) return;
  if (ws.roomCode) {
    const old = connectionsByRoom.get(ws.roomCode);
    old?.delete(ws);
    if (old?.size === 0) connectionsByRoom.delete(ws.roomCode);
  }
  ws.roomCode = code;
  if (code) {
    if (!connectionsByRoom.has(code)) connectionsByRoom.set(code, new Set());
    connectionsByRoom.get(code).add(ws);
  }
}
function sendRaw(ws, text) {
  if (!ws.alive) return;
  // Un client très lent ne peut pas faire grossir la mémoire du serveur sans limite.
  if (!ws.socket.writable || ws.socket.writableLength > 512 * 1024) { ws.socket.destroy(); return; }
  const b = Buffer.from(text, 'utf8');
  let header;
  if (b.length < 126) { header = Buffer.from([0x81, b.length]); }
  else if (b.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(b.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(b.length), 2); }
  try { ws.socket.write(Buffer.concat([header, b])); } catch { ws.socket.destroy(); }
}
function send(ws, obj) { sendRaw(ws, JSON.stringify(obj)); }
function sendOpcode(ws, code, buf = Buffer.alloc(0)) {
  if (!ws.alive) return;
  if (buf.length > 125 || ws.socket.writableLength > 512 * 1024) { ws.socket.destroy(); return; }
  const header = Buffer.from([0x80 | code, buf.length]);
  try { ws.socket.write(Buffer.concat([header, buf])); } catch { ws.socket.destroy(); }
}
function emitRoom(room) {
  const watchers = connectionsByRoom.get(room.code);
  if (!watchers) return;
  const cachedByUser = new Map();
  for (const ws of watchers) {
    if (!ws.alive || !room.players.some(p => p.id === ws.user.id)) continue;
    let message = cachedByUser.get(ws.user.id);
    if (!message) {
      message = JSON.stringify({ type: 'room:state', room: roomForUser(room, ws.user.id) });
      cachedByUser.set(ws.user.id, message);
    }
    sendRaw(ws, message);
  }
}
function emitRoomList(userId) {
  const clients = connectionsByUser.get(userId);
  if (!clients?.size) return;
  const message = JSON.stringify({ type: 'lobby:rooms', rooms: userRooms(userId) });
  for (const ws of clients) sendRaw(ws, message);
}
function watch(ws, code) {
  const room = db.rooms[code];
  if (!room || !room.players.some(p => p.id === ws.user.id)) throw new Error('Salon introuvable, ou tu n’en fais pas partie.');
  watchSocket(ws, code);
  emitRoom(room);
}
function handleMessage(ws, msg) {
  try {
    const session = db.sessions[ws.sessionHash];
    if (!session || session.expires < Date.now()) { ws.socket.destroy(); return; }
    const now = Date.now();
    if (now - ws.rateStarted >= 1000) { ws.rateStarted = now; ws.rateCount = 0; }
    if (++ws.rateCount > 35) { ws.socket.destroy(); return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') throw new Error('Message invalide.');
    if (msg.type === 'lobby:list') { emitRoomList(ws.user.id); return; }
    if (msg.type === 'room:create') {
      if (!rateLimit(`create:guest:${ws.user.id}`, 10, 3600000) || !rateLimit(`create:ip:${ws.ip}`, 40, 3600000)) throw new Error('Trop de créations de salons. Réessaie plus tard.');
      if (Object.keys(db.rooms).length >= MAX_ROOMS) throw new Error('Le serveur a atteint sa limite de salons.');
      if ((roomsByUser.get(ws.user.id)?.size || 0) >= MAX_ROOMS_PER_GUEST) throw new Error('Tu as déjà trop de salons. Quitte un ancien salon.');
      const code = newCode();
      const room = { code, hostId: ws.user.id, players: [{ id: ws.user.id, name: ws.user.name }], createdAt: Date.now(), updatedAt: Date.now(), game: null };
      db.rooms[code] = room; addMembership(ws.user.id, code); save(); watch(ws, code); emitRoomList(ws.user.id); return;
    }
    if (msg.type === 'room:join') {
      if (!rateLimit(`join:guest:${ws.user.id}`, 35, 15 * 60000) || !rateLimit(`join:ip:${ws.ip}`, 150, 15 * 60000)) throw new Error('Trop de tentatives. Réessaie dans quelques minutes.');
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      if (!validCode(code)) throw new Error('Le code du salon est invalide (6 ou 8 caractères).');
      const room = db.rooms[code];
      if (!room) throw new Error('Ce salon n’existe pas. Vérifie le code.');
      if (!room.players.some(p => p.id === ws.user.id)) {
        if (room.game) throw new Error('Cette partie a déjà commencé.');
        if (room.players.length >= MAX_PLAYERS) throw new Error('Ce salon est complet (8 joueurs).');
        if (!guestNameAvailable(room, ws.user.id, ws.user.name)) throw new Error('Ce pseudo est déjà utilisé dans ce salon. Choisis-en un autre.');
        if ((roomsByUser.get(ws.user.id)?.size || 0) >= MAX_ROOMS_PER_GUEST) throw new Error('Tu as déjà trop de salons.');
        room.players.push({ id: ws.user.id, name: ws.user.name });
        addMembership(ws.user.id, code);
        room.updatedAt = Date.now(); save();
      }
      watch(ws, code);
      for (const p of room.players) emitRoomList(p.id);
      return;
    }
    if (msg.type === 'room:watch') { watch(ws, String(msg.code || '').toUpperCase()); return; }
    if (msg.type === 'room:claim-host') {
      const room = db.rooms[String(msg.code || '').toUpperCase()];
      if (!room || !room.players.some(p => p.id === ws.user.id)) throw new Error('Salon introuvable.');
      if (connectionsByUser.get(room.hostId)?.size) throw new Error('L’hôte est toujours connecté.');
      room.hostId = ws.user.id;
      room.updatedAt = Date.now();
      if (room.game) addLog(room.game, `${ws.user.name} reprend l’organisation de la table.`);
      save(); emitRoom(room);
      for (const p of room.players) emitRoomList(p.id);
      return;
    }
    if (msg.type === 'room:leave') {
      const room = db.rooms[String(msg.code || '').toUpperCase()];
      if (!room || !room.players.some(p => p.id === ws.user.id)) throw new Error('Salon introuvable.');
      if (room.game) { watchSocket(ws, null); send(ws, { type: 'room:left' }); return; }
      room.players = room.players.filter(p => p.id !== ws.user.id);
      removeMembership(ws.user.id, room.code);
      for (const s of connectionsByUser.get(ws.user.id) || []) if (s.roomCode === room.code) { watchSocket(s, null); send(s, { type: 'room:left' }); }
      if (room.players.length === 0) delete db.rooms[room.code];
      else if (room.hostId === ws.user.id) room.hostId = room.players[0].id;
      save();
      if (db.rooms[room.code]) emitRoom(room);
      emitRoomList(ws.user.id);
      for (const p of room.players) emitRoomList(p.id);
      return;
    }
    if (msg.type === 'game:action') {
      const room = db.rooms[String(msg.code || '').toUpperCase()];
      if (!room) throw new Error('Salon introuvable.');
      perform(room, ws.user, msg.action, msg.index, msg.source);
      room.updatedAt = Date.now(); save(); emitRoom(room);
      if (['start', 'next', 'replay'].includes(msg.action) || ['game_over', 'round_end'].includes(room.game?.status)) for (const p of room.players) emitRoomList(p.id);
      return;
    }
    throw new Error('Action inconnue.');
  } catch (e) { send(ws, { type: 'error', message: e.message }); }
}
function dropSocket(ws) {
  if (!ws.alive) return;
  ws.alive = false;
  sockets.delete(ws);
  const ipCount = (connectionsByIp.get(ws.ip) || 1) - 1;
  if (ipCount <= 0) connectionsByIp.delete(ws.ip); else connectionsByIp.set(ws.ip, ipCount);
  const clients = connectionsByUser.get(ws.user.id);
  clients?.delete(ws);
  if (clients?.size === 0) connectionsByUser.delete(ws.user.id);
  const room = ws.roomCode ? db.rooms[ws.roomCode] : null;
  watchSocket(ws, null);
  if (room) emitRoom(room);
}
function processWsBuffer(ws, incoming) {
  ws.buffer = Buffer.concat([ws.buffer, incoming]);
  if (ws.buffer.length > 128000) { ws.socket.destroy(); return; }
  while (ws.buffer.length >= 2) {
    const b0 = ws.buffer[0], b1 = ws.buffer[1];
    const opcode = b0 & 15;
    if (!(b0 & 0x80) || (b0 & 0x70) || !(b1 & 0x80)) { ws.socket.destroy(); return; }
    let len = b1 & 127, offset = 2;
    if (len === 126) { if (ws.buffer.length < 4) return; len = ws.buffer.readUInt16BE(2); offset = 4; }
    if (len === 127) {
      if (ws.buffer.length < 10) return;
      const length = ws.buffer.readBigUInt64BE(2);
      if (length > 4096n) { ws.socket.destroy(); return; }
      len = Number(length); offset = 10;
    }
    if (len > 4096 || ((opcode & 8) && len > 125)) { ws.socket.destroy(); return; }
    if (ws.buffer.length < offset + 4 + len) return;
    const mask = ws.buffer.subarray(offset, offset + 4); offset += 4;
    const data = Buffer.from(ws.buffer.subarray(offset, offset + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    ws.buffer = ws.buffer.subarray(offset + len);
    if (opcode === 8) { ws.socket.end(); return; }
    if (opcode === 9) { sendOpcode(ws, 10, data); continue; }
    if (opcode === 10) { ws.lastPong = Date.now(); continue; }
    if (opcode !== 1) { ws.socket.destroy(); return; }
    try { handleMessage(ws, JSON.parse(data.toString('utf8'))); }
    catch { send(ws, { type: 'error', message: 'Message invalide.' }); }
  }
}

const MIMES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
// Prélecture + Brotli/Gzip au démarrage : aucune lecture disque ni compression
// dans le chemin critique des requêtes. ETag => réponses HTTP 304 très légères.
const assets = new Map();
for (const name of ['index.html', 'app.js', 'style.css', 'favicon.svg', 'art/cloud-mark.svg', 'art/paper-landscape.svg', 'art/sparkle.svg']) {
  const source = fs.readFileSync(path.join(PUBLIC, name));
  assets.set('/' + name, {
    type: MIMES[path.extname(name)],
    etag: `W/"${crypto.createHash('sha256').update(source).digest('hex').slice(0,20)}"`,
    raw: source,
    br: zlib.brotliCompressSync(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }),
    gzip: zlib.gzipSync(source, { level: 6 })
  });
}
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.socket.encrypted || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/api/me') { const user = getSession(req); sendJson(res, 200, { user: user ? publicUser(user) : null }); return; }
    if (req.method !== 'POST' || !originMatches(req) || !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      sendJson(res, 403, { error: 'Accès refusé.' }); return;
    }
    try {
      const body = await readBody(req);
      if (pathname === '/api/guest') {
        if (!rateLimit(`guest:ip:${requestIp(req)}`, 70, 15 * 60000)) { sendJson(res, 429, { error: 'Trop de tentatives. Réessaie plus tard.' }); return; }
        const name = slugUsername(body.name);
        if (!validName(name)) throw new Error('Pseudo : 2 à 18 caractères (lettres, chiffres, espaces, tirets).');
        let user = getSession(req);
        if (!user) {
          if (db.users.length >= 10000) throw new Error('Le serveur est momentanément complet.');
          user = { id: randomId(16), name, createdAt: Date.now() };
          db.users.push(user); usersById.set(user.id, user);
          setCookie(res, newSession(user), req);
          sendJson(res, 201, { user: publicUser(user) }); return;
        }
        // Le changement de pseudo ne change pas l'identité ni les cartes du joueur.
        for (const code of roomsByUser.get(user.id) || []) {
          const room = db.rooms[code];
          if (room && !guestNameAvailable(room, user.id, name)) throw new Error('Ce pseudo est déjà utilisé dans un de tes salons.');
        }
        user.name = name;
        for (const code of roomsByUser.get(user.id) || []) {
          const room = db.rooms[code];
          if (!room) continue;
          const player = room.players.find(p => p.id === user.id);
          if (player) player.name = name;
          room.updatedAt = Date.now();
          emitRoom(room);
          for (const p of room.players) emitRoomList(p.id);
        }
        save(); sendJson(res, 200, { user: publicUser(user) }); return;
      }
      sendJson(res, 404, { error: 'Page introuvable.' });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const asset = assets.get(pathname === '/' ? '/index.html' : pathname);
  if (!asset) { res.writeHead(404); res.end('Introuvable'); return; }
  res.setHeader('Content-Type', asset.type);
  res.setHeader('Cache-Control', 'public, no-cache, must-revalidate');
  res.setHeader('ETag', asset.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.headers['if-none-match']?.split(',').map(x => x.trim()).includes(asset.etag)) {
    res.writeHead(304); res.end(); return;
  }
  const accepted = String(req.headers['accept-encoding'] || '').split(',').map(part => {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    const quality = params.find(param => param.trim().startsWith('q='));
    return [type.trim(), quality ? Number(quality.trim().slice(2)) : 1];
  });
  const supports = type => accepted.some(([name, q]) => name === type && q > 0 && q <= 1);
  const format = supports('br') ? 'br' : supports('gzip') ? 'gzip' : 'raw';
  const payload = asset[format];
  if (format !== 'raw') res.setHeader('Content-Encoding', format);
  res.setHeader('Content-Length', payload.length);
  res.writeHead(200);
  res.end(req.method === 'HEAD' ? undefined : payload);
});
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const user = getSession(req);
  const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('sid='))?.slice(4);
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !user || !originMatches(req, true) || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
  }
  const ip = requestIp(req);
  if (sockets.size >= MAX_SOCKETS || (connectionsByUser.get(user.id)?.size || 0) >= MAX_TABS_PER_USER || (connectionsByIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP || !rateLimit(`ws:ip:${ip}`, 160, 60000)) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const ws = { socket, user, ip, sessionHash: sha(token), alive: true, buffer: Buffer.alloc(0), roomCode: null, lastPong: Date.now(), rateStarted: Date.now(), rateCount: 0 };
  addSocket(ws);
  socket.on('data', chunk => processWsBuffer(ws, chunk));
  socket.on('close', () => dropSocket(ws));
  socket.on('error', () => dropSocket(ws));
  if (head.length) processWsBuffer(ws, head);
  send(ws, { type: 'connected', user: publicUser(user) });
  emitRoomList(user.id);
  for (const code of roomsByUser.get(user.id) || []) if (db.rooms[code]) emitRoom(db.rooms[code]);
});
server.maxHeadersCount = 64;
server.headersTimeout = 15000;
server.requestTimeout = 15000;
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const ws of sockets) {
    if (now - ws.lastPong > 90000) ws.socket.destroy();
    else sendOpcode(ws, 9);
  }
}, 30000);
heartbeat.unref();
const sessionCleanup = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [hash, session] of Object.entries(db.sessions)) {
    if (!session || session.expires < now) { delete db.sessions[hash]; changed = true; }
  }
  for (const [code, room] of Object.entries(db.rooms)) {
    const maxAge = room.game ? 14 * 86400000 : 2 * 86400000;
    if (now - room.updatedAt < maxAge || connectionsByRoom.get(code)?.size) continue;
    delete db.rooms[code]; changed = true;
    for (const player of room.players) { removeMembership(player.id, code); emitRoomList(player.id); }
  }
  const activeUsers = new Set(Object.values(db.sessions).map(s => s.userId));
  const before = db.users.length;
  db.users = db.users.filter(u => activeUsers.has(u.id) || roomsByUser.has(u.id) || now - u.createdAt < ONE_MONTH);
  if (before !== db.users.length) {
    usersById.clear(); for (const u of db.users) usersById.set(u.id, u);
    changed = true;
  }
  if (changed) save();
}, 60 * 60 * 1000);
sessionCleanup.unref();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(sessionCleanup);
  server.close();
  for (const ws of sockets) ws.socket.destroy();
  try { await flushSave(); process.exit(0); }
  catch (err) { console.error('Sauvegarde impossible à l’arrêt :', err); process.exit(1); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => console.log(`🎴 Skyclub est lancé sur http://localhost:${PORT}`));
}
