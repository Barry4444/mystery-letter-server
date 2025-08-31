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
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
});

const PORT = process.env.PORT || 10000;

/* ----------------------- State ----------------------- */
const rooms = new Map();

function makeRoom(roomId) {
  return {
    roomId,
    hostId: null,
    players: new Map(), // id -> { ... }
    order: [],
    started: false,
    round: 0,
    turn: null,
    turnSeq: 0,
    deck: [],
    discard: [],
    settings: { music: false, botsCount: 0, botLevel: 1 },
    logs: [],
  };
}
function log(room, msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  room.logs.unshift(line);
  room.logs = room.logs.slice(0, 50);
}

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
const byKey = Object.fromEntries(CARD_DEFS.map(c => [c.key, c]));

function buildDeck() {
  const deck = [];
  for (const def of CARD_DEFS) {
    for (let i = 0; i < def.count; i++) deck.push({ key: def.key, name: def.name, rank: def.rank });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function roomOf(socket) {
  const ids = [...socket.rooms].filter(r => r !== socket.id);
  return rooms.get(ids[0]);
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    isHost: !!p.isHost,
    isBot: !!p.isBot,
    alive: p.alive !== false,
    protected: !!p.protected,
    coins: p.coins || 0,
  }));
}

function anyProtected(room) {
  return [...room.players.values()].some(p => p.protected);
}

function emitAmbiance(room) {
  io.to(room.roomId).emit('sound:ambiance', { on: anyProtected(room) });
}

function broadcastState(room) {
  io.to(room.roomId).emit('room:state', {
    roomId: room.roomId,
    hostId: room.hostId,
    players: publicPlayers(room),
    started: room.started,
    round: room.round,
    turnPlayerId: room.turn,
    deckCount: room.deck.length,
    inRound: room.started,
    logs: room.logs,
  });
  for (const [id, p] of room.players) {
    if (p.isBot) continue;
    io.to(id).emit('player:hand', { hand: p.hand || [] });
  }
}

function ensureOrder(room) {
  room.order = [...room.players.keys()].filter(id => room.players.get(id).alive !== false);
  if (room.order.length && !room.turn) room.turn = room.order[0];
}

function nextTurn(room) {
  if (!room.order.length) return;
  const idx = room.order.indexOf(room.turn);
  room.turn = room.order[(idx + 1) % room.order.length];
  room.turnSeq++;
  // start van iemands beurt: 1-ronde bescherming valt af
  const p = room.players.get(room.turn);
  if (p && p.protected) {
    p.protected = false;
    log(room, `${p.name} verliest bescherming`);
    emitAmbiance(room);
  }
}

function alivePlayers(room) {
  return [...room.players.values()].filter(p => p.alive !== false);
}

function eliminate(room, player, reason = 'verliest') {
  if (!player || player.alive === false) return;
  player.alive = false;
  room.discard.push(...(player.hand || []));
  player.hand = [];
  log(room, `${player.name} ${reason}`);
}

function awardAndMaybeFinishGame(room, winner) {
  winner.coins = (winner.coins || 0) + 1;
  log(room, `${winner.name} wint de ronde (+1 goud → ${winner.coins})`);
  if (winner.coins >= 3) {
    log(room, `🏆 ${winner.name} wint het spel met 3 goudstukken!`);
    // spel stopt, ronde is klaar
    room.started = false;
  }
}

function checkEndRound(room) {
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    const winner = alive[0];
    if (winner) awardAndMaybeFinishGame(room, winner);
    room.started = false;
    room.turn = null;
    broadcastState(room);
    return true;
  }
  return false;
}

function botName(i){ return ['Bot A','Bot B','Bot C','Bot D'][i] || `Bot ${i+1}`; }

/* ----------------------- Verplichte regels na trekken ----------------------- */
// - Heks + Prinses  => Prinses MOET af (=> verlies)
// - Heks + (God|Emir) => Heks MOET af (geen extra effect)
function enforceAfterDraw(room, player) {
  if (!player?.hand || player.hand.length !== 2) return { forced: false, eliminated: false };

  const keys = player.hand.map(c => c.key);
  const has = k => keys.includes(k);

  if (has('heks') && has('prinses')) {
    // Prinses afleggen = verlies
    const idx = player.hand.findIndex(c => c.key === 'prinses');
    if (idx >= 0) {
      const princess = player.hand.splice(idx, 1)[0];
      room.discard.push(princess);
    }
    eliminate(room, player, 'legt de Prinses af en verliest');
    return { forced: true, eliminated: true };
  }

  if (has('heks') && (has('god') || has('emir'))) {
    const idx = player.hand.findIndex(c => c.key === 'heks');
    if (idx >= 0) {
      const witch = player.hand.splice(idx, 1)[0];
      room.discard.push(witch);
      log(room, `${player.name} moest de Heks afleggen (regel)`);
    }
    return { forced: true, eliminated: false };
  }

  return { forced: false, eliminated: false };
}

/* ----------------------- Actie-afhandeling ----------------------- */
function findTarget(room, id) {
  if (!id) return null;
  const p = room.players.get(id);
  return p && p.alive !== false ? p : null;
}
function otherCard(hand, cardKeyPlayed) {
  return hand.find(c => c.key !== cardKeyPlayed) || null;
}

function applyPlay(room, actorId, cardKey, { targetId = null, guessKey = null } = {}) {
  const actor = room.players.get(actorId);
  if (!actor || actor.alive === false) return { ok: false, error: 'no actor' };
  if (room.turn !== actorId) return { ok: false, error: 'not your turn' };
  if (!room.started) return { ok: false, error: 'round not started' };
  if (!actor.hand || actor.hand.length !== 2) return { ok: false, error: 'need 2 cards to play' };

  const idx = actor.hand.findIndex(c => c.key === cardKey);
  if (idx < 0) return { ok: false, error: 'card not in hand' };
  const played = actor.hand[idx];
  const keep = otherCard(actor.hand, played.key);

  // Prinses spelen = verlies
  if (played.key === 'prinses') {
    actor.hand.splice(idx, 1);
    room.discard.push(played);
    eliminate(room, actor, 'legt de Prinses af en verliest');
    broadcastState(room);
    return { ok: true, eliminated: true, ended: checkEndRound(room) };
  }

  // Heks: gewoon afleggen (tenzij al afgedwongen bij draw)
  if (played.key === 'heks') {
    actor.hand.splice(idx, 1);
    room.discard.push(played);
    log(room, `${actor.name} legt de Heks af`);
    // geen verder effect
  }

  // Ziener
  if (played.key === 'ziener') {
    const t = findTarget(room, targetId);
    if (!t) return { ok: false, error: 'target required' };
    actor.hand.splice(idx, 1);
    room.discard.push(played);
    if (t.protected) {
      log(room, `${actor.name} probeert Ziener op ${t.name}, maar bescherming blokt`);
    } else {
      const correct = (t.hand?.[0]?.key === guessKey);
      log(room, `${actor.name} raadt (${byKey[guessKey]?.name ?? guessKey}) voor ${t.name} → ${correct ? 'JUÍST' : 'fout'}`);
      if (correct) eliminate(room, t, 'werd juist geraden');
    }
  }

  // Wolf (peek)
  if (played.key === 'wolf') {
    const t = findTarget(room, targetId);
    if (!t) return { ok: false, error: 'target required' };
    actor.hand.splice(idx, 1);
    room.discard.push(played);
    if (t.protected) {
      log(room, `${actor.name} probeert Wolf op ${t.name}, maar bescherming blokt`);
    } else {
      io.to(actorId).emit('private:peek', { targetId: t.id, card: t.hand?.[0] || null });
      log(room, `${actor.name} gluurt naar ${t.name} (onzichtbaar voor anderen)`);
    }
  }

  // Ridder (bescherming 1 beurt)
  if (played.key === 'ridder') {
    const target = targetId ? findTarget(room, targetId) : actor;
    actor.hand.splice(idx, 1);
    room.discard.push(played);
    if (target) {
      target.protected = true;
      log(room, `${actor.name} geeft bescherming aan ${target.name}`);
      emitAmbiance(room);
    }
  }

  // Zeemeermin (vergelijk)
  if (played.key === 'zeemeermin') {
    const t = findTarget(room, targetId);
    if (!t) return { ok: false, error: 'target required' };
    actor.hand.splice(idx, 1);
    room.discard.push(played);
    if (t.protected) {
      log(room, `${actor.name} probeert Zeemeermin op ${t.name}, maar bescherming blokt`);
    } else {
      const mine = keep?.rank ?? 0;
      const theirs = t.hand?.[0]?.rank ?? 0;
      log(room, `${actor.name} vergelijkt met ${t.name} → ${mine} vs ${theirs}`);
      if (mine > theirs) eliminate(room, t, 'verliest de vergelijking');
      else if (theirs > mine) eliminate(room, actor, 'verliest de vergelijking');
      else log(room, 'Gelijkspel — niets gebeurt');
    }
  }

  // God (wissel)
  if (played.key === 'god') {
    const t = findTarget(room, targetId);
    if (!t) return { ok: false, error: 'target required' };
    actor.hand.splice(idx, 1); // speel God
    room.discard.push(played);
    if (t.protected) {
      log(room, `${actor.name} probeert God op ${t.name}, maar bescherming blokt`);
    } else {
      // wissel actor.keep met t.hand[0]
      const their = t.hand?.[0] || null;
      if (keep && their) {
        t.hand[0] = keep;
        actor.hand = [their]; // actor houdt nu target-kaart
        log(room, `${actor.name} wisselt kaarten met ${t.name}`);
      } else {
        log(room, `Wissel mislukt (ontbrekende kaarten)`);
      }
    }
  }

  // Emir (nieuwe kaart voor jezelf of target; hou hoogste)
  if (played.key === 'emir') {
    const target = targetId ? findTarget(room, targetId) : actor;
    actor.hand.splice(idx, 1);
    room.discard.push(played);
    if (!target) {
      log(room, `Emir zonder doelwit — geen effect`);
    } else if (room.deck.length === 0) {
      log(room, `Emir: deck is leeg — geen effect`);
    } else {
      const newCard = room.deck.pop();
      if (!target.hand?.length) target.hand = [newCard];
      else {
        const a = target.hand[0], b = newCard;
        // kies hoogste rank om te houden
        const keepHigh = (a.rank >= b.rank) ? a : b;
        const discardLow = (a.rank >= b.rank) ? b : a;
        target.hand = [keepHigh];
        room.discard.push(discardLow);
      }
      log(room, `${actor.name} laat ${target.name} een nieuwe kaart nemen (Emir)`);
    }
  }

  // na effect: check einde ronde
  const ended = checkEndRound(room);
  if (ended) return { ok: true, ended: true };

  // als actor nog leeft en ronde loopt → beurt doorgeven
  if (room.started && room.players.get(actorId)?.alive !== false) {
    nextTurn(room);
  }
  broadcastState(room);
  return { ok: true };
}

/* ----------------------- Bots ----------------------- */
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickTargetId(room, selfId) {
  const options = alivePlayers(room).filter(p => p.id !== selfId && !p.protected);
  return options.length ? randomFrom(options).id : null;
}
function botChoosePlay(hand) {
  // simpele heuristiek: voorkeursvolgorde
  const prio = ['ziener','god','zeemeermin','ridder','emir','wolf','heks','prinses'];
  const sorted = hand.slice().sort((a,b)=>prio.indexOf(a.key)-prio.indexOf(b.key));
  return sorted[0]?.key;
}

function drawFor(room, playerId) {
  const p = room.players.get(playerId);
  if (!p || p.alive === false || !room.started) return;
  if (p.hand.length !== 1) return;
  if (!room.deck.length) return;

  const drawn = room.deck.pop();
  p.hand.push(drawn);
  io.to(playerId).emit('sound:draw');
  log(room, `${p.name} trekt een kaart`);
  const enforced = enforceAfterDraw(room, p);
  if (enforced.eliminated) {
    broadcastState(room);
    checkEndRound(room);
  } else {
    broadcastState(room);
  }
}

function maybeBotTurn(room) {
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot || !room.started) return;

  setTimeout(() => {
    // 1) trekken indien nodig
    if ((actor.hand?.length ?? 0) === 1 && room.deck.length) {
      drawFor(room, actor.id);
      const me = room.players.get(actor.id);
      if (!me || me.alive === false) { return; } // heks+prinses auto-lose?
      if ((me.hand?.length ?? 0) !== 2) return; // bv. heks auto-afgelegd
    }

    // 2) kaart kiezen + doel
    const toPlay = botChoosePlay(actor.hand);
    const tId = pickTargetId(room, actor.id);
    const guess = randomFrom(CARD_DEFS).key;

    const res = applyPlay(room, actor.id, toPlay, { targetId: tId, guessKey: guess });
    if (res?.ok && room.started) {
      // Volgende beurt kan ook bot zijn
      maybeBotTurn(room);
    }
  }, 700);
}

/* ----------------------- Socket handlers ----------------------- */
io.on('connection', (socket) => {
  socket.on('ping:server', (_p, ack) => ack?.({ ok: true, pong: Date.now() }));

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok:false, error:'roomId and name required' });
    let room = rooms.get(roomId);
    if (!room){ room = makeRoom(roomId); rooms.set(roomId, room); }
    socket.join(roomId);
    room.players.set(socket.id, { id: socket.id, name, isHost:false, isBot:false, hand:[], alive:true, protected:false, coins:0 });
    log(room, `${name} heeft de kamer betreden`);
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok:true, roomId, you:{ id: socket.id, name } });
  });

  socket.on('host:claim', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (room.hostId && room.hostId !== socket.id) return ack?.({ ok:false, error:'host already taken' });
    room.hostId = socket.id;
    const me = room.players.get(socket.id);
    if (me) me.isHost = true;
    log(room, `${me?.name ?? 'Host'} is host geworden`);
    broadcastState(room); ack?.({ ok:true });
  });

  socket.on('bots:configure', ({ botsCount=0, botLevel=1 }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    // verwijder bestaande bots
    for (const [id,p] of [...room.players]) if (p.isBot) room.players.delete(id);
    // voeg nieuwe toe
    for (let i=0;i<Math.max(0,Math.min(3,botsCount));i++){
      const id = `bot-${i+1}`;
      room.players.set(id,{ id, name:botName(i), isBot:true, botLevel:Math.max(1,Math.min(3,botLevel)), hand:[], alive:true, protected:false, coins:0 });
    }
    room.settings.botsCount = Math.max(0,Math.min(3,botsCount));
    room.settings.botLevel = Math.max(1,Math.min(3,botLevel));
    log(room, `Bots geconfigureerd: ${room.settings.botsCount} (lvl ${room.settings.botLevel})`);
    ensureOrder(room); broadcastState(room); ack?.({ ok:true });
  });

  socket.on('music:toggle', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.settings.music = !room.settings.music;
    log(room, `Muziek ${room.settings.music ? 'aan' : 'uit'}`);
    broadcastState(room); ack?.({ ok:true, music: room.settings.music });
  });

  socket.on('game:new', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.started=false; room.round=0; room.turn=null; room.turnSeq=0; room.deck=[]; room.discard=[];
    for (const p of room.players.values()){ p.hand=[]; p.alive=true; p.protected=false; }
    emitAmbiance(room);
    log(room, 'Nieuw spel klaarzetten'); ensureOrder(room); broadcastState(room); ack?.({ ok:true });
  });

  socket.on('game:startRound', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    const living = alivePlayers(room);
    if (living.length < 2) return ack?.({ ok:false, error:'min 2 spelers' });
    room.round += 1; room.started = true; room.deck = buildDeck(); room.discard = []; room.turnSeq=0;
    for (const p of living){ p.hand=[]; p.protected=false; }
    for (const p of living){ const c = room.deck.pop(); if (c) p.hand.push(c); }
    ensureOrder(room);
    // start van eerste speler: bescherming valt af (voor het geval)
    const tp = room.players.get(room.turn);
    if (tp?.protected) { tp.protected = false; emitAmbiance(room); }
    log(room, `Ronde ${room.round} gestart`);
    broadcastState(room); ack?.({ ok:true });
    maybeBotTurn(room);
  });

  socket.on('game:draw', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });
    const me = room.players.get(socket.id); if (!me) return ack?.({ ok:false, error:'no player' });
    if (!room.started) return ack?.({ ok:false, error:'round not started' });
    if ((me.hand?.length ?? 0) !== 1) return ack?.({ ok:false, error:'need 1 card to draw' });
    if (!room.deck.length) return ack?.({ ok:false, error:'deck empty' });

    const card = room.deck.pop();
    me.hand.push(card);
    io.to(socket.id).emit('sound:draw');
    log(room, `${me.name} trekt een kaart`);
    const enforced = enforceAfterDraw(room, me);
    broadcastState(room);
    if (enforced.eliminated) {
      checkEndRound(room);
    }
    ack?.({ ok:true, handSize: me.hand.length });
  });

  // beide event-namen ondersteunen
  const playHandler = (payload, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    const { cardKey, targetId=null, guessKey=null } = payload || {};
    const res = applyPlay(room, socket.id, cardKey, { targetId, guessKey });
    ack?.(res);
    if (room.started) maybeBotTurn(room);
  };
  socket.on('game:play', playHandler);
  socket.on('game:playCard', playHandler);

  socket.on('disconnect', () => {
    const room = roomOf(socket); if (!room) return;
    const p = room.players.get(socket.id);
    if (p) {
      room.players.delete(socket.id);
      log(room, `${p.name} heeft de kamer verlaten`);
      if (room.hostId === socket.id) room.hostId = null;
      ensureOrder(room);
      if (!room.players.size) rooms.delete(room.roomId);
      else broadcastState(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
