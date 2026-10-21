import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const folder = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skyclub-optimized-'));
const port = 37000 + crypto.randomInt(3000);
const base = `http://127.0.0.1:${port}`;
let server;

async function until(predicate, timeout=5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Attente dépassée');
}
async function startServer() {
  server = spawn(process.execPath, ['server.js'], {cwd: folder, env: {...process.env, HOST:'127.0.0.1',PORT:String(port),DATA_DIR:temp},stdio:'ignore'});
  await until(async () => {try {return (await fetch(base+'/api/me')).ok;}catch{return false;} });
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const old = server;
  const closed = new Promise(resolve => old.once('exit', resolve));
  old.kill('SIGTERM');
  await closed;
  assert.equal(old.exitCode, 0, 'Arrêt propre avec sauvegarde');
  server = null;
}
function rawRequest(target, headers={}, method='GET') {
  return new Promise((resolve,reject)=>{
    const req=http.request(base+target,{headers,method},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.on('error',reject);
    req.end();
  });
}
async function newPlayer(name) {
  const res=await fetch(base+'/api/guest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});
  assert.equal(res.status,201);
  assert.match(res.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  return {cookie:res.headers.get('set-cookie').split(';')[0], user:(await res.json()).user};
}
function connect(player) {
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(base.replace('http','ws')+'/ws',{headers:{Cookie:player.cookie,Origin:base}});
    const client={ws,messages:[]};
    ws.onmessage=event=>client.messages.push(JSON.parse(event.data));
    ws.onopen=()=>resolve(client);
    ws.onerror=reject;
  });
}

test('Compression HTTP, ETag et sauvegarde/reconnexion après redémarrage', async () => {
  let client;
  try {
    await startServer();
    for (const name of ['app.js','style.css','index.html']) {
      const raw = await rawRequest('/'+name);
      const br = await rawRequest('/'+name,{'accept-encoding':'br'});
      const gz = await rawRequest('/'+name,{'accept-encoding':'gzip'});
      assert.equal(raw.status,200);
      assert.equal(br.headers['content-encoding'],'br');
      assert.equal(gz.headers['content-encoding'],'gzip');
      assert.deepEqual(zlib.brotliDecompressSync(br.body),raw.body);
      assert.deepEqual(zlib.gunzipSync(gz.body),raw.body);
      assert.ok(br.body.length < raw.body.length * .65, 'Gain Brotli significatif');
      const unchanged=await rawRequest('/'+name,{'if-none-match':raw.headers.etag});
      assert.equal(unchanged.status,304);
      assert.equal(unchanged.body.length,0);
      const head=await rawRequest('/'+name,{'accept-encoding':'br'},'HEAD');
      assert.equal(head.status,200);
      assert.equal(head.body.length,0);
      assert.equal(Number(head.headers['content-length']),br.body.length);
    }
    // Les illustrations Paper Play sont servies depuis une liste autorisée,
    // avec le même cache HTTP et sans exposition du système de fichiers.
    for (const name of ['art/cloud-mark.svg', 'art/paper-landscape.svg', 'art/sparkle.svg']) {
      const illustration = await rawRequest('/' + name);
      const compressed = await rawRequest('/' + name, {'accept-encoding': 'br'});
      assert.equal(illustration.status, 200);
      assert.equal(illustration.headers['content-type'], 'image/svg+xml');
      assert.equal(compressed.headers['content-encoding'], 'br');
      assert.deepEqual(zlib.brotliDecompressSync(compressed.body), illustration.body);
    }
    assert.equal((await rawRequest('/art/not-allowed.svg')).status,404);
    assert.equal((await rawRequest('/../../server.js')).status,404);
    const headers = (await rawRequest('/')).headers;
    assert.match(headers['content-security-policy'],/frame-ancestors 'none'/);
    assert.equal(headers['x-content-type-options'],'nosniff');
    assert.equal(headers['x-frame-options'],'DENY');
    const guestWithoutName=await fetch(base+'/api/guest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'<script>'})});
    assert.equal(guestWithoutName.status,400,'Les pseudos contenant du HTML sont refusés');


    const player = await newPlayer('Optim Test');
    // Une WebSocket sans Origin ou depuis un site tiers est rejetée.
    const blockedWs = (headers) => new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace('http','ws')+'/ws',{headers});
      ws.onopen=()=>{ws.close();reject(new Error('WebSocket non autorisée acceptée'));};
      ws.onerror=()=>resolve();
      ws.onclose=()=>resolve();
    });
    await blockedWs({Cookie:player.cookie});
    await blockedWs({Cookie:player.cookie,Origin:'https://evil.example'});

    client=await connect(player);
    client.ws.send(JSON.stringify({type:'room:create'}));
    await until(()=>client.messages.some(m=>m.type==='room:state'));
    const code=client.messages.find(m=>m.type==='room:state').room.code;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(client.messages.filter(m=>m.type==='room:state').length,1, 'Pas de doublon de broadcast après création');
    // Arrêt immédiatement après un changement : aucun coup n'est perdu sur SIGTERM.
    await stopServer();
    const saved=JSON.parse(fs.readFileSync(path.join(temp,'store.json'),'utf8'));
    assert.equal(saved.users.length,1);
    assert.equal(saved.rooms[code].players.length,1);
    assert.ok(Object.values(saved.sessions).length===1);
    client.ws.close();

    await startServer();
    const session=await fetch(base+'/api/me',{headers:{cookie:player.cookie}}).then(r=>r.json());
    assert.equal(session.user.id,player.user.id);
    client=await connect(player);
    client.ws.send(JSON.stringify({type:'room:watch',code}));
    await until(()=>client.messages.some(m=>m.type==='room:state'&&m.room.code===code));
    const state=client.messages.find(m=>m.type==='room:state');
    assert.equal(state.room.players.length,1);
    // Le pseudo ne donne aucun accès à la partie : l'identité vient du cookie privé.
    const stranger = await newPlayer('Optim Test');
    assert.notEqual(stranger.user.id, player.user.id, 'Deux invités peuvent choisir le même pseudo globalement');
    const outsider = await connect(stranger);
    outsider.ws.send(JSON.stringify({type:'room:watch',code}));
    await until(()=>outsider.messages.some(m=>m.type==='error'));
    assert.ok(!outsider.messages.some(m=>m.type==='room:state'), 'Pas de divulgation des cartes à un tiers');
    outsider.ws.send(JSON.stringify({type:'room:join',code}));
    await until(()=>outsider.messages.filter(m=>m.type==='error').length===2);
    assert.match(outsider.messages.at(-1).message,/pseudo/i,'Pseudo identique interdit dans un salon');
    outsider.ws.close();

    // Contrôle anti-CSRF : les requêtes cross-origin sont refusées.
    const blocked=await fetch(base+'/api/guest',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:JSON.stringify({name:'Intrus'})});
    assert.equal(blocked.status,403);
    // Pas de réactivation des anciens points d'authentification.
    const oldLogin=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(oldLogin.status,404);
    // Un invité change de pseudo sans perdre son identité ni son salon.
    const renamed=await fetch(base+'/api/guest',{method:'POST',headers:{Cookie:player.cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'Optim Nouveau'})});
    assert.equal(renamed.status,200);
    assert.equal((await renamed.json()).user.id,player.user.id);
    client.ws.send(JSON.stringify({type:'room:watch',code}));
    await until(()=>client.messages.some(m=>m.type==='room:state'&&m.room.players[0].name==='Optim Nouveau'));
  } finally {
    try { client?.ws.close(); } catch {}
    await stopServer();
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
