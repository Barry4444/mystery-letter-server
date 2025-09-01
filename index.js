// index.js (SERVER)
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.use(cors());
app.get('/', (_req, res) => res.send('mystery-letter-server OK'));

const server = http.createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  cors: {
    origin: '*', // of beperk tot jouw Netlify domein
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 10000;

/* ------------------------------ Game data ------------------------------ */

const CARD_DEFS = [
  { key: 'ziener',     name: 'Ziener',     rank: 1, count: 5 },
  { key: 'wolf',       name: 'Wolf',       rank: 2, count: 2 },
  { key: 'ridder',     name: 'Ridder',     rank: 3, count: 2 },
  { key: 'zeemeermin', name: 'Zeemeermin', rank: 4, count: 2 },
  { key: 'god',        name: 'God',        rank: 5, count: 1 },
  { key: 'emir',       name: 'Emir',       rank: 6, count: 1 },
  { key: 'heks',       name: 'Heks',       rank: 7, count: 2 },
  { key: 'prinses',    name: 'Prinses',    rank: 8, count: 1 },
];

function buildDeck() {
  const deck = [];
  for (const def of CARD_DEFS) for (let i=0;i<def.count;i++) deck.push({ key:def.key, name:def.name, rank:def.rank });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}

function makeRoom(roomId) {
  return {
    roomId,
    hostId: null,
    started: false,
    round: 0,
    deck: [],
    discard: [],
    order: [],
    turn: null,
    logs: [],
    settings: { music: false, botsCount: 0, botLevel: 1 },
    players: new Map(),
    winnerOfGame: null,
  };
}
function makePlayer(id, name, isBot=false, botLevel=1){
  return { id, name, isHost:false, isBot, botLevel, hand:[], alive:true, protected:false, coins:0 };
}
const rooms = new Map();

/* ------------------------------ Helpers ------------------------------ */

function log(room, msg){
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  room.logs.unshift(line);
  if (room.logs.length > 50) room.logs.length = 50;
}
function roomOf(socket){
  const ids = [...socket.rooms].filter(r => r !== socket.id);
  return rooms.get(ids[0]);
}
function alivePlayers(room){ return [...room.players.values()].filter(p => p.alive); }
function publicPlayers(room){
  return [...room.players.values()].map(p => ({
    id:p.id, name:p.name, isHost:!!p.isHost, isBot:!!p.isBot,
    alive:p.alive, protected:p.protected, coins:p.coins
  }));
}
function broadcastState(room){
  io.to(room.roomId).emit('room:state', {
    roomId: room.roomId,
    roundNum: room.round,
    inRound: room.started,
    turnPlayerId: room.turn,
    deckCount: room.deck.length,
    players: publicPlayers(room),
    logs: room.logs,
    settings: room.settings,
    winnerOfGame: room.winnerOfGame,
  });
  for (const [id, p] of room.players) {
    if (p.isBot) continue;
    io.to(id).emit('player:hand', { hand: p.hand });
  }
}
function ensureOrder(room){
  room.order = [...room.players.keys()].filter(id => room.players.get(id).alive);
  if (room.order.length && !room.turn) room.turn = room.order[0];
}
function nextTurn(room){
  if (!room.order.length) { room.turn = null; return; }
  const idx = room.order.indexOf(room.turn);
  room.turn = room.order[(idx + 1) % room.order.length];
  const cur = room.players.get(room.turn);
  if (cur) cur.protected = false;
}
function eliminate(room, player, reason=''){
  player.alive = false;
  if (player.hand.length) { room.discard.push(...player.hand); player.hand = []; }
  log(room, `${player.name} ligt uit${reason ? ` (${reason})` : ''}`);
  ensureOrder(room);
}
function checkRoundEnd(room){
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    const winner = alive[0];
    room.started = false; room.turn = null;
    if (winner) {
      winner.coins = (winner.coins||0) + 1;
      log(room, `${winner.name} wint de ronde en krijgt 1 munt (totaal ${winner.coins})`);
      if (winner.coins >= 3) { room.winnerOfGame = winner.id; log(room, `${winner.name} wint het spel met 3 munten!`); }
    } else log(room, `Ronde eindigt zonder winnaar.`);
    broadcastState(room);
    return true;
  }
  return false;
}
function heksPrincessForced(room, player){
  const keys = player.hand.map(c=>c.key);
  if (keys.includes('heks') && keys.includes('prinses')) {
    const idx = player.hand.findIndex(c=>c.key==='prinses');
    if (idx >= 0) room.discard.push(player.hand.splice(idx,1)[0]);
    eliminate(room, player, 'moest de Prinses afleggen (Heks-regel)');
    broadcastState(room);
    return true;
  }
  return false;
}
function requireTurn(socket, room){
  if (!room) return 'no room';
  if (room.turn !== socket.id) return 'not your turn';
  const me = room.players.get(socket.id);
  if (!me || !me.alive) return 'no player';
  if (!room.started) return 'round not started';
  return null;
}
function botName(i){ return ['Bot A','Bot B','Bot C','Bot D'][i] || `Bot ${i+1}`; }

/* ------------------------------ Socket handlers ------------------------------ */

io.on('connection', (socket) => {
  socket.on('ping:server', (_p, ack) => ack?.({ ok:true, pong: Date.now() }));

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok:false, error:'roomId and name required' });
    let room = rooms.get(roomId);
    if (!room) { room = makeRoom(roomId); rooms.set(roomId, room); }
    socket.join(roomId);
    room.players.set(socket.id, makePlayer(socket.id, name));
    ensureOrder(room);
    log(room, `${name} heeft de kamer betreden`);
    broadcastState(room);
    ack?.({ ok:true, roomId, you:{ id: socket.id, name } });
  });

  socket.on('room:leave', (_p, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:true });
    const me = room.players.get(socket.id);
    if (me) {
      room.players.delete(socket.id);
      log(room, `${me.name} verliet de kamer`);
      if (room.hostId === socket.id) room.hostId = null;
      if (room.turn === socket.id) nextTurn(room);
      ensureOrder(room);
      socket.leave(room.roomId);
      if (!room.players.size) rooms.delete(room.roomId);
      else broadcastState(room);
    }
    ack?.({ ok:true });
  });

  socket.on('host:claim', (_p, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (room.hostId && room.hostId !== socket.id) return ack?.({ ok:false, error:'host already taken' });
    room.hostId = socket.id;
    const me = room.players.get(socket.id); if (me) me.isHost = true;
    log(room, `${me?.name ?? 'Host'} is host geworden`);
    broadcastState(room);
    ack?.({ ok:true });
  });

  socket.on('host:kick', ({ targetId }, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    if (!targetId) return ack?.({ ok:false, error:'no target' });

    const target = room.players.get(targetId);
    if (!target) return ack?.({ ok:false, error:'invalid target' });

    room.players.delete(targetId);
    log(room, `${target.name} is gekickt door de host`);

    if (room.hostId === targetId) room.hostId = null;
    if (room.turn === targetId) nextTurn(room);
    ensureOrder(room);

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.leave(room.roomId);
      io.to(targetId).emit('kicked', { roomId: room.roomId, by: socket.id });
    }

    if (!room.players.size) rooms.delete(room.roomId);
    else broadcastState(room);

    ack?.({ ok:true });
  });

  socket.on('bots:configure', ({ botsCount=0, botLevel=1 }, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    for (const [id,p] of [...room.players]) if (p.isBot) room.players.delete(id);
    const n = Math.max(0, Math.min(3, botsCount|0));
    const lvl = Math.max(1, Math.min(3, botLevel|0));
    for (let i=0;i<n;i++) room.players.set(`bot-${i+1}`, makePlayer(`bot-${i+1}`, botName(i), true, lvl));
    room.settings.botsCount = n; room.settings.botLevel = lvl;
    log(room, `Bots geconfigureerd: ${n} (niveau ${lvl})`);
    ensureOrder(room); broadcastState(room); ack?.({ ok:true });
  });

  socket.on('music:toggle', (_p, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.settings.music = !room.settings.music;
    log(room, `Muziek ${room.settings.music ? 'aan' : 'uit'}`);
    broadcastState(room); ack?.({ ok:true, music: room.settings.music });
  });

  socket.on('game:new', (_p, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.started=false; room.round=0; room.turn=null; room.deck=[]; room.discard=[]; room.winnerOfGame=null;
    for (const p of room.players.values()){ p.hand=[]; p.alive=true; p.protected=false; }
    log(room, 'Nieuw spel klaarzetten'); ensureOrder(room); broadcastState(room); ack?.({ ok:true });
  });

  socket.on('game:startRound', (_p, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    const living = alivePlayers(room);
    if (living.length < 2) return ack?.({ ok:false, error:'min 2 spelers' });

    room.round += 1; room.started = true; room.deck = buildDeck(); room.discard = []; room.turn = null;
    for (const p of living){ p.hand=[]; p.protected=false; }
    for (const p of living){ const c = room.deck.pop(); if (c) p.hand.push(c); }
    ensureOrder(room); log(room, `Ronde ${room.round} gestart`); broadcastState(room);
    for (const p of living){ if (p.alive && heksPrincessForced(room, p)) { if (checkRoundEnd(room)) return ack?.({ ok:true }); } }
    ack?.({ ok:true });
    maybeBotTurn(room);
  });

  socket.on('game:draw', (_p, ack) => {
    const room = roomOf(socket);
    const err = requireTurn(socket, room); if (err) return ack?.({ ok:false, error: err });
    const me = room.players.get(socket.id);
    if ((me.hand?.length ?? 0) !== 1) return ack?.({ ok:false, error:'need 1 card to draw' });
    const card = room.deck.pop(); if (!card) return ack?.({ ok:false, error:'deck empty' });
    me.hand.push(card); log(room, `${me.name} trekt een kaart`); broadcastState(room);
    if (heksPrincessForced(room, me)) {
      if (checkRoundEnd(room)) return ack?.({ ok:true });
      nextTurn(room); broadcastState(room); maybeBotTurn(room); return ack?.({ ok:true });
    }
    ack?.({ ok:true, handSize: me.hand.length });
  });

  socket.on('game:play', (payload, ack) => {
    const room = roomOf(socket);
    const err = requireTurn(socket, room); if (err) return ack?.({ ok:false, error: err });

    const me = room.players.get(socket.id);
    const { index, targetId = null, guessKey = null } = payload || {};
    if (!Array.isArray(me.hand) || me.hand.length < 1) return ack?.({ ok:false, error:'empty hand' });
    if (index !== 0 && index !== 1) return ack?.({ ok:false, error:'invalid index' });
    const played = me.hand[index]; if (!played) return ack?.({ ok:false, error:'card not in hand' });
    if (played.key === 'prinses') return ack?.({ ok:false, error:'Prinses mag niet vrijwillig afgelegd worden' });

    const target = targetId ? room.players.get(targetId) : null;
    const needTarget = (k)=>['ziener','wolf','ridder','zeemeermin','god','emir'].includes(k);
    if (needTarget(played.key)) {
      if (!targetId) return ack?.({ ok:false, error:'target required' });
      if (!target || !target.alive) return ack?.({ ok:false, error:'invalid target' });
      if (target.protected && targetId !== me.id && !['ridder'].includes(played.key)) {
        return ack?.({ ok:false, error:'target is protected' });
      }
    }

    me.hand.splice(index,1);
    room.discard.push(played);

    let secret = null;
    try {
      switch (played.key) {
        case 'ziener': {
          if (!guessKey) return ack?.({ ok:false, error:'guess required' });
          if (!target || !target.hand.length) break;
          const th = target.hand[0];
          if (th.key === guessKey) eliminate(room, target, `Ziener had juist geraden (${th.name})`);
          else log(room, `${me.name} gokt verkeerd met Ziener`);
          break;
        }
        case 'wolf': {
          if (!target || !target.hand.length) break;
          const th = target.hand[0];
          secret = { peek: { key: th.key, name: th.name, rank: th.rank } };
          log(room, `${me.name} kijkt in het geheim naar ${target.name} (Wolf)`);
          break;
        }
        case 'ridder': {
          const tgt = targetId ? target : me;
          tgt.protected = true;
          log(room, `${me.name} geeft bescherming aan ${tgt.name} (Ridder)`);
          break;
        }
        case 'zeemeermin': {
          if (!target || !target.hand.length || !me.hand.length) break;
          const myRank = me.hand[0].rank;
          const tr = target.hand[0].rank;
          if (myRank === tr) log(room, `${me.name} en ${target.name} hebben gelijk (Zeemeermin)`);
          else if (myRank > tr) eliminate(room, target, 'verliest vergelijking (Zeemeermin)');
          else eliminate(room, me, 'verliest vergelijking (Zeemeermin)');
          break;
        }
        case 'god': {
          if (!target || !target.hand.length || !me.hand.length) break;
          const myCard = me.hand.splice(0,1)[0] || null;
          const theirCard = target.hand.splice(0,1)[0] || null;
          if (theirCard) me.hand.push(theirCard);
          if (myCard) target.hand.push(myCard);
          log(room, `${me.name} wisselt kaart met ${target.name} (God)`);
          heksPrincessForced(room, me);
          if (target.alive) heksPrincessForced(room, target);
          break;
        }
        case 'emir': {
          const tgt = targetId ? target : me;
          if (!room.deck.length) { log(room, `${me.name} speelt Emir maar de deck is leeg`); break; }
          const newC = room.deck.pop(); tgt.hand.push(newC);
          log(room, `${me.name} geeft een kaart aan ${tgt.name} (Emir)`);
          heksPrincessForced(room, tgt);
          break;
        }
        case 'heks': {
          log(room, `${me.name} gooit Heks af`);
          break;
        }
        default: break;
      }
    } catch {
      return ack?.({ ok:false, error:'play failed' });
    }

    if (checkRoundEnd(room)) { broadcastState(room); return ack?.({ ok:true, secret }); }

    nextTurn(room);
    broadcastState(room);
    if (secret) io.to(socket.id).emit('play:secret', secret);
    ack?.({ ok:true, secret });
    maybeBotTurn(room);
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket); if (!room) return;
    const p = room.players.get(socket.id);
    if (p) {
      room.players.delete(socket.id);
      log(room, `${p.name} heeft de kamer verlaten`);
      if (room.hostId === socket.id) room.hostId = null;
      if (room.turn === socket.id) nextTurn(room);
      ensureOrder(room);
      if (!room.players.size) rooms.delete(room.roomId);
      else broadcastState(room);
    }
  });
});

/* ------------------------------ Bot AI ------------------------------ */
function randomAliveOpponent(room, selfId){
  const opp = alivePlayers(room).filter(p => p.id !== selfId && !p.protected);
  if (!opp.length) return null;
  return opp[Math.floor(Math.random()*opp.length)];
}
function maybeBotTurn(room){
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot || !room.started) return;
  const delay = 700 + Math.random()*600;
  setTimeout(() => {
    if ((actor.hand?.length ?? 0) === 1 && room.deck.length) {
      actor.hand.push(room.deck.pop());
      log(room, `${actor.name} trekt een kaart (bot)`);
      if (heksPrincessForced(room, actor)) {
        if (checkRoundEnd(room)) { broadcastState(room); return; }
        nextTurn(room); broadcastState(room); maybeBotTurn(room);
        return;
      }
    }
    let idx = 0; if (actor.hand.length >= 2) idx = Math.round(Math.random());
    const card = actor.hand[idx];
    const needsTarget = ['ziener','wolf','ridder','zeemeermin','god','emir'].includes(card.key);
    let target = needsTarget ? randomAliveOpponent(room, actor.id) : null;
    if (needsTarget && !target) { if (card.key==='ridder' || card.key==='emir') target = actor; else { nextTurn(room); broadcastState(room); maybeBotTurn(room); return; } }
    actor.hand.splice(idx,1); room.discard.push(card);
    switch (card.key) {
      case 'ziener': {
        const pool = CARD_DEFS.map(c=>c.key);
        const guessKey = pool[Math.floor(Math.random()*pool.length)];
        if (target && target.hand.length) {
          const th = target.hand[0];
          if (th.key === guessKey) eliminate(room, target, `Ziener (bot) raadde juist`);
          else log(room, `${actor.name} gokt verkeerd (Ziener)`);
        }
        break;
      }
      case 'wolf': {
        if (target && target.hand.length) log(room, `${actor.name} kijkt stiekem naar ${target.name} (Wolf)`);
        break;
      }
      case 'ridder': {
        (target||actor).protected = true; log(room, `${actor.name} beschermt ${(target||actor).name} (Ridder)`); break;
      }
      case 'zeemeermin': {
        if (target && target.hand.length && actor.hand.length) {
          const myRank = actor.hand[0].rank, tr = target.hand[0].rank;
          if (myRank === tr) log(room, `${actor.name} en ${target.name} gelijk (Zeemeermin)`);
          else if (myRank > tr) eliminate(room, target, 'verliest vergelijking (Zeemeermin)');
          else eliminate(room, actor, 'verliest vergelijking (Zeemeermin)');
        }
        break;
      }
      case 'god': {
        if (target && target.hand.length && actor.hand.length) {
          const my = actor.hand.splice(0,1)[0]||null;
          const th = target.hand.splice(0,1)[0]||null;
          if (th) actor.hand.push(th);
          if (my) target.hand.push(my);
          log(room, `${actor.name} wisselt kaart met ${target.name} (God)`);
          heksPrincessForced(room, actor); if (target.alive) heksPrincessForced(room, target);
        }
        break;
      }
      case 'emir': {
        const tgt = target || actor;
        if (room.deck.length) { tgt.hand.push(room.deck.pop()); log(room, `${actor.name} geeft een kaart aan ${tgt.name} (Emir)`); heksPrincessForced(room, tgt); }
        break;
      }
      case 'heks': log(room, `${actor.name} gooit Heks af`); break;
      default: break;
    }
    if (checkRoundEnd(room)) { broadcastState(room); return; }
    nextTurn(room); broadcastState(room); maybeBotTurn(room);
  }, delay);
}

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
