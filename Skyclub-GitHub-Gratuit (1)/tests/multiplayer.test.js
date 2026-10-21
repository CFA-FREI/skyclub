import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createDeck } from '../server.js';

const port = 35000 + crypto.randomInt(1000);
const base = `http://127.0.0.1:${port}`;
let server;
const sockets = [];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skyclub-test-'));

async function waitUntil(fn, ms=4000) {
  const start=Date.now();
  while (Date.now()-start < ms) {const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error('Timeout while waiting for condition');
}
async function register(name) {
  const res = await fetch(`${base}/api/guest`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
  const json=await res.json();assert.equal(res.status,201,JSON.stringify(json));
  return {user:json.user,cookie:res.headers.get('set-cookie').split(';')[0]};
}
function connect(player) {
  return new Promise((resolve,reject)=>{
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers:{Cookie:player.cookie, Origin:base}});
    const client={socket,history:[],latest:null,errors:[]};
    socket.addEventListener('message',ev=>{
      const msg=JSON.parse(ev.data);client.history.push(msg);
      if(msg.type==='room:state')client.latest=msg.room;
      if(msg.type==='error')client.errors.push(msg.message);
    });
    socket.addEventListener('open',()=>{sockets.push(socket);resolve(client);});
    socket.addEventListener('error',reject,{once:true});
  });
}
function send(client,data) {client.socket.send(JSON.stringify(data));}
function action(client,code,kind,other={}) {send(client,{type:'game:action',code,action:kind,...other});}
async function updated(client,fn,timeout=4000) {return waitUntil(()=>client.latest&&fn(client.latest)&&client.latest,timeout);}

await test('Le paquet contient bien 150 cartes dans les bonnes proportions',()=>{
  const deck=createDeck();
  assert.equal(deck.length,150);
  for(const n of [-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12])
    assert.equal(deck.filter(x=>x===n).length,n===-2?5:n===0?15:10,`Valeur ${n}`);
});

await test('Salons anonymes, 8 joueurs, confidentialité, manches et reconnexion',async()=>{
  server=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:temp},stdio:['ignore','pipe','pipe']});
  let stderr='';server.stderr.on('data',chunk=>stderr+=chunk);
  try {
    await waitUntil(async()=>{try {return (await fetch(`${base}/api/me`)).ok;}catch{return false;}},5000);
    const players=[];
    for(let i=0;i<9;i++) players.push(await register(`Joueur Test ${i+1}`));
    const clients=[];
    for(let i=0;i<9;i++) clients.push(await connect(players[i]));
    send(clients[0],{type:'room:create'});
    const created=await updated(clients[0],room=>room.players.length===1);
    const code=created.code;
    assert.match(code,/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    for(let i=1;i<8;i++) {
      send(clients[i],{type:'room:join',code});
      await updated(clients[0],room=>room.players.length===i+1);
    }
    send(clients[8],{type:'room:join',code});
    await waitUntil(()=>clients[8].errors.length>0);
    assert.match(clients[8].errors[0],/complet/);
    action(clients[1],code,'start');
    await waitUntil(()=>clients[1].errors.some(e=>e.includes('hôte')));
    action(clients[0],code,'start');
    await updated(clients[0],room=>room.game?.status==='setup');
    for(let i=0;i<8;i++) {
      assert.equal(clients[0].latest.game.hands[players[i].user.id].filter(c=>c.value!==null).length,0);
    }
    for(let i=0;i<8;i++) {
      action(clients[i],code,'reveal',{index:0});
      await updated(clients[i],room=>room.game?.revealed[players[i].user.id]===1);
      action(clients[i],code,'reveal',{index:1});
      await updated(clients[i],room=>room.game?.revealed[players[i].user.id]===2);
    }
    await updated(clients[0],room=>room.game?.status==='playing');
    const playing=clients[0].latest;
    const firstId=playing.game.currentId;
    const firstIndex=players.findIndex(p=>p.user.id===firstId);
    action(clients[firstIndex],code,'pick',{source:'deck'});
    await updated(clients[firstIndex],room=>room.game.phase==='drawn');
    await updated(clients[(firstIndex+1)%8],room=>room.game.phase==='drawn');
    assert.equal(typeof clients[firstIndex].latest.game.drawn,'number');
    assert.equal(clients[(firstIndex+1)%8].latest.game.drawn,null,'Secret de la pioche masqué aux adversaires');
    action(clients[firstIndex],code,'discard');
    await updated(clients[firstIndex],room=>room.game.phase==='flip');
    action(clients[firstIndex],code,'flip',{index:2});
    await updated(clients[firstIndex],room=>room.game.currentId!==firstId);

    let moves=0;
    while(clients[0].latest.game.status==='playing' && moves<200){
      const current=clients[0].latest.game.currentId;
      const idx=players.findIndex(p=>p.user.id===current);
      const currClient=clients[idx];
      const before = clients[0].latest;
      const hiddenIdx = before.game.hands[current].findIndex(c=>!c.face&&!c.removed);
      // Il peut rester très peu de cartes cachées : on remplace toujours une carte présente.
      if (hiddenIdx>=0) {
        action(currClient,code,'pick',{source:'deck'});
        await updated(currClient,r=>r.game.phase==='drawn'&&r.game.currentId===current);
        action(currClient,code,'discard');
        await updated(currClient,r=>r.game.phase==='flip'&&r.game.currentId===current);
        action(currClient,code,'flip',{index:hiddenIdx});
      } else {
        action(currClient,code,'pick',{source:'discard'});
        await updated(currClient,r=>r.game.phase==='place'&&r.game.currentId===current);
        const validIdx=before.game.hands[current].findIndex(c=>!c.removed);
        action(currClient,code,'swap',{index:validIdx});
      }
      await waitUntil(()=>clients[0].latest.game.status!=='playing'||clients[0].latest.game.currentId!==current);
      moves++;
    }
    assert.ok(moves<200,'La manche doit prendre fin');
    assert.ok(['round_end','game_over'].includes(clients[0].latest.game.status));
    assert.equal(clients[0].latest.game.round,1);
    const finale = clients[0].latest.game.result.reveal;
    assert.equal(finale.length,8,'Snapshot de révélation disponible uniquement après la manche');
    for(const snap of finale) {
      assert.equal(snap.faceBefore.length,12);
      assert.equal(snap.removedBefore.length,12);
      assert.ok(snap.faceBefore.every(value=>typeof value==='boolean'));
      assert.ok(snap.removedBefore.every(value=>typeof value==='boolean'));
      assert.ok(!Object.hasOwn(snap,'values'),'Aucune valeur secrète dans les métadonnées d’animation');
    }
    for(const p of players.slice(0,8)) {
      assert.equal(clients[0].latest.game.scores[p.user.id].length,1);
      assert.ok(clients[0].latest.game.hands[p.user.id].every(c=>c.face||c.removed));
    }
    const finalStatus=clients[0].latest.game.status;
    action(clients[0],code,finalStatus==='round_end'?'next':'replay');
    await updated(clients[0],room=>room.game?.status==='setup'&&room.game.round===(finalStatus==='round_end'?2:1));
    assert.equal(clients[0].latest.game.scores[players[0].user.id].length,finalStatus==='round_end'?1:0,'Historique cohérent selon manche suivante ou revanche');

    // Un joueur retrouve sa table après fermeture de l'onglet.
    clients[1].socket.close();
    await waitUntil(()=>clients[0].latest.players.find(p=>p.id===players[1].user.id)?.online===false);
    const restored=await connect(players[1]);
    send(restored,{type:'room:watch',code});
    await updated(restored,room=>room.code===code&&room.game.status==='setup');
    assert.equal(restored.latest.players.length,8);
    // Lorsqu'un hôte se déconnecte, un autre membre peut récupérer la table.
    clients[0].socket.close();
    await updated(restored,room=>room.players.find(p=>p.id===players[0].user.id)?.online===false);
    send(restored,{type:'room:claim-host',code});
    await updated(restored,room=>room.hostId===players[1].user.id);
    assert.equal(restored.latest.players.length,8);
  } finally {
    for (const ws of sockets) try {ws.close();}catch{}
    // L'arrêt attend maintenant la dernière écriture asynchrone : ne supprime
    // jamais le dossier de test tant que le processus serveur travaille encore.
    if (server && server.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      await exited;
    }
    if(stderr) console.log('stderr:',stderr);
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
