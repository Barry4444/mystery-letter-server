// server/index.js
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

// ---------- basic express ----------
const app = express();

const ALLOW_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOW_ORIGINS.includes('*') || ALLOW_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));

app.get('/', (_req, res) => res.type('text/plain').send('mystery-letter-server OK'));

const server = http.createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  cors: { origin: ALLOW_ORIGINS.includes('*') ? true : ALLOW_ORIGINS, credentials: true },
});

const PORT = process.env.PORT || 10000;

// ---------- game state ----------

function now() { return new Date().toLocaleTimeString(); }

function makeRoom(roomId) {
  return {
    roomId,
    hostId: null,
    players: new Map(), // id -> player
    started: false,
    round: 0,
    turn: null, // socket id of current turn
    order: [],
    deck: [],
    discard: [],
    settings: { music: false, botsCount: 0, botLevel: 1 },
    logs: [],
  };
}

function log(room, msg) {
  const line = `[${now()}] ${msg}`;
  room.logs.unshift(line);
  room.logs = room.logs.slice(0, 50);
}

const rooms = new Map();

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
  for (const def of CARD_DEFS) {
    for (let i = 0; i < def.count; i++) {
      deck.push({ key: def.key, name: def.name, rank: def.rank });
    }
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

function broadcastState(room) {
  io.to(room.roomId).emit('room:state', {
    roomId: room.roomId,
    hostId: room.hostId,
    started: room.started,
    round: room.round,
    turn: room.turn,
    players: publicPlayers(room),
    logs: room.logs,
    deckCount: room.deck.length,
  });
  for (const [id, p] of room.players) {
    if (!p.isBot) io.to(id).emit('player:hand', { hand: p.hand || [] });
  }
}

function ensureOrder(room) {
  room.order = [...room.players.keys()].filter(id => room.players.get(id).alive !== false);
  if (room.order.length && !room.turn) room.turn = room.order[0];
}

function nextTurn(room) {
  if (!room.order.length) return;
  const idx = room.order.indexOf(room.turn);
  const next = room.order[(idx + 1) % room.order.length];
  room.turn = next;
  // when your new turn starts, protection expires
  const p = room.players.get(next);
  if (p) p.protected = false;
}

// ---- helpers ----

function cardByKey(key) { return CARD_DEFS.find(c => c.key === key); }

function hasKeys(hand, ...keys) {
  const set = new Set(hand.map(c => c.key));
  return keys.every(k => set.has(k));
}

function eliminate(room, player, reason) {
  player.alive = false;
  room.discard.push(...(player.hand || []));
  player.hand = [];
  log(room, `${player.name} ligt uit (${reason})`);
}

function forcedDiscardCheck(room, player) {
  const hand = player.hand || [];
  if (hand.length < 2) return;

  // Special: Heks + Prinses => Prinses MOET afleggen en je verliest
  if (hasKeys(hand, 'heks', 'prinses')) {
    const idx = hand.findIndex(c => c.key === 'prinses');
    if (idx >= 0) {
      const [dropped] = hand.splice(idx, 1);
      room.discard.push(dropped);
      eliminate(room, player, 'Prinses afgelegd met Heks');
    }
    return;
  }
  // Heks + (God|Emir) => Heks MOET weg
  if (hasKeys(hand, 'heks') && (hasKeys(hand, 'god') || hasKeys(hand, 'emir'))) {
    const idx = hand.findIndex(c => c.key === 'heks');
    if (idx >= 0) {
      const [dropped] = hand.splice(idx, 1);
      room.discard.push(dropped);
      log(room, `${player.name} moest Heks afleggen`);
    }
  }
}

function alivePlayers(room) {
  return [...room.players.values()].filter(p => p.alive !== false);
}

function awardWinner(room) {
  const living = alivePlayers(room);
  if (living.length !== 1) return null;
  const w = living[0];
  w.coins = (w.coins || 0) + 1;
  log(room, `${w.name} wint de ronde en heeft nu ${w.coins} munt(en)`);
  if (w.coins >= 3) {
    log(room, `${w.name} wint het spel met 3 munten!`);
  }
  return w;
}

function resetRound(room) {
  room.started = false;
  room.round += 1;
  room.turn = null;
  room.deck = buildDeck();
  room.discard = [];
  for (const p of room.players.values()) {
    p.alive = true;
    p.protected = false;
    p.hand = [];
  }
  ensureOrder(room);
  // everyone draws 1 card
  for (const p of alivePlayers(room)) {
    const c = room.deck.pop();
    if (c) p.hand.push(c);
  }
  // choose first player deterministically (existing room.turn or first in order)
  room.turn = room.order[0] || null;
  log(room, `Ronde ${room.round} gestart`);
}

// ---- core apply ----

function applyCard(room, actorId, played, payload = {}) {
  const me = room.players.get(actorId);
  if (!me || me.alive === false) return { ok: false, error: 'no player' };

  const others = alivePlayers(room).filter(p => p.id !== me.id);
  const target = payload.targetId ? room.players.get(payload.targetId) : null;
  const remaining = me.hand[0]; // after removing 'played', one card remains

  switch (played.key) {
    case 'ziener': {
      if (!target || !payload.guessKey) return { ok: false, error: 'target and guess required' };
      if (target.protected) return { ok: false, error: 'target protected' };
      const guess = payload.guessKey;
      const actual = target.hand[0]?.key;
      if (actual && guess === actual) {
        eliminate(room, target, 'Ziener gok juist');
      } else {
        log(room, `${me.name} gokt fout (${guess})`);
      }
      break;
    }
    case 'wolf': {
      if (!target) return { ok: false, error: 'target required' };
      if (target.protected) return { ok: false, error: 'target protected' };
      io.to(me.id).emit('secret:peek', { of: target.name, card: target.hand[0] || null });
      log(room, `${me.name} gluurt naar ${target.name}`);
      break;
    }
    case 'ridder': {
      const tgt = (target?.id && target.id !== me.id) ? target : me; // self or chosen
      tgt.protected = true;
      log(room, `${tgt.name} is beschermd tot zijn/haar volgende beurt`);
      break;
    }
    case 'zeemeermin': {
      if (!target) return { ok: false, error: 'target required' };
      if (target.protected) return { ok: false, error: 'target protected' };
      const myCard = remaining;
      const theirCard = target.hand[0];
      if (!myCard || !theirCard) return { ok: false, error: 'compare failed' };
      if (myCard.rank > theirCard.rank) {
        eliminate(room, target, `Zeemeermin (${myCard.name} > ${theirCard.name})`);
      } else if (theirCard.rank > myCard.rank) {
        eliminate(room, me, `Zeemeermin (${theirCard.name} > ${myCard.name})`);
      } else {
        log(room, `Gelijkspel bij Zeemeermin`);
      }
      break;
    }
    case 'god': {
      if (!target) return { ok: false, error: 'target required' };
      if (target.protected) return { ok: false, error: 'target protected' };
      const t = target.hand[0];
      if (!t || !remaining) return { ok: false, error: 'swap failed' };
      target.hand[0] = remaining;
      me.hand[0] = t;
      log(room, `${me.name} wisselt kaart met ${target.name}`);
      forcedDiscardCheck(room, me);
      forcedDiscardCheck(room, target);
      break;
    }
    case 'emir': {
      const tgt = target?.id ? target : me;
      const draw = room.deck.pop();
      if (!draw) { log(room, 'Deck leeg'); break; }
      tgt.hand.push(draw);
      log(room, `${tgt.name} krijgt een extra kaart van Emir`);
      // na trekken: dwing eventuele regels
      forcedDiscardCheck(room, tgt);
      break;
    }
    case 'heks': {
      // effect is alleen de forced regels (al verwerkt door forcedDiscardCheck bij draw/swap)
      log(room, `${me.name} speelt Heks`);
      break;
    }
    case 'prinses': {
      // afleggen = verliezen
      eliminate(room, me, 'Prinses afgelegd');
      break;
    }
  }
  return { ok: true };
}

// ---- socket.io ----

function botName(i) { return ['Bot A','Bot B','Bot C','Bot D'][i] || `Bot ${i+1}`; }

io.on('connection', (socket) => {
  socket.on('ping:server', (_p, ack) => ack?.({ ok: true, pong: Date.now() }));

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok:false, error:'roomId and name required' });
    let room = rooms.get(roomId);
    if (!room) {
      room = makeRoom(roomId);
      rooms.set(roomId, room);
    }
    socket.join(roomId);
    const p = { id: socket.id, name, isHost:false, isBot:false, hand:[], alive:true, protected:false, coins:0 };
    room.players.set(socket.id, p);
    ensureOrder(room);
    log(room, `${name} heeft de kamer betreden`);
    broadcastState(room);
    ack?.({ ok:true, roomId, you: { id: socket.id, name } });
  });

  socket.on('host:claim', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (room.hostId && room.hostId !== socket.id) return ack?.({ ok:false, error:'host already taken' });
    room.hostId = socket.id;
    const me = room.players.get(socket.id); if (me) me.isHost = true;
    log(room, `${me?.name || 'Host'} is host geworden`);
    broadcastState(room);
    ack?.({ ok:true });
  });

  socket.on('kick', ({ targetId }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    if (!targetId || !room.players.has(targetId)) return ack?.({ ok:false, error:'unknown target' });
    const victim = room.players.get(targetId);
    room.players.delete(targetId);
    io.to(targetId).emit('error:toast', { message: 'Je bent verwijderd uit de kamer.' });
    io.sockets.sockets.get(targetId)?.leave(room.roomId);
    log(room, `${victim.name} is gekickt`);
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok:true });
  });

  socket.on('bots:configure', ({ botsCount=0, botLevel=1 }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    // remove existing bots
    for (const [id, p] of [...room.players]) if (p.isBot) room.players.delete(id);
    const n = Math.max(0, Math.min(3, Number(botsCount) || 0));
    for (let i=0; i<n; i++) {
      const id = `bot-${i+1}`;
      room.players.set(id, { id, name: botName(i), isBot:true, botLevel: Math.max(1,Math.min(3,Number(botLevel)||1)), hand:[], alive:true, protected:false, coins:0 });
      io.sockets.sockets.get(id)?.join?.(room.roomId); // (no real socket for bots)
    }
    room.settings.botsCount = n;
    room.settings.botLevel = Math.max(1,Math.min(3,Number(botLevel)||1));
    log(room, `Bots: ${room.settings.botsCount} (lvl ${room.settings.botLevel})`);
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok:true });
  });

  socket.on('music:toggle', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.settings.music = !room.settings.music;
    log(room, `Muziek ${room.settings.music ? 'aan' : 'uit'}`);
    broadcastState(room);
    ack?.({ ok:true, music: room.settings.music });
  });

  socket.on('game:new', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.started = false;
    room.turn = null;
    room.deck = [];
    room.discard = [];
    for (const p of room.players.values()) { p.hand = []; p.alive = true; p.protected = false; }
    ensureOrder(room);
    log(room, 'Nieuw spel klaargezet');
    broadcastState(room);
    ack?.({ ok:true });
  });

  socket.on('game:startRound', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    if (alivePlayers(room).length < 2) return ack?.({ ok:false, error: 'min 2 spelers' });
    room.started = true;
    room.round = room.round || 0; // keep counter; resetRound will ++
    resetRound(room);
    broadcastState(room);
    ack?.({ ok:true });
    maybeBotTurn(room);
  });

  socket.on('game:draw', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (!room.started) return ack?.({ ok:false, error:'round not started' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });
    const me = room.players.get(socket.id); if (!me || me.alive === false) return ack?.({ ok:false, error:'no player' });
    if ((me.hand?.length || 0) !== 1) return ack?.({ ok:false, error:'need exactly 1 card before draw' });
    const c = room.deck.pop();
    if (!c) return ack?.({ ok:false, error:'deck empty' });
    me.hand.push(c);
    log(room, `${me.name} trekt een kaart`);
    forcedDiscardCheck(room, me);
    broadcastState(room);
    ack?.({ ok:true, handSize: me.hand.length, deck: room.deck.length });
  });

  socket.on('game:play', ({ cardIndex, targetId, guessKey }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (!room.started) return ack?.({ ok:false, error:'round not started' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });
    const me = room.players.get(socket.id); if (!me || me.alive === false) return ack?.({ ok:false, error:'no player' });
    if ((me.hand?.length || 0) !== 2) return ack?.({ ok:false, error:'need 2 cards to play' });

    const idx = Number(cardIndex);
    if (!(idx === 0 || idx === 1)) return ack?.({ ok:false, error:'invalid card index' });

    const played = me.hand.splice(idx, 1)[0];
    room.discard.push(played);
    log(room, `${me.name} speelt ${played.name}`);
    const res = applyCard(room, me.id, played, { targetId, guessKey });
    if (!res.ok) {
      // rollback
      const last = room.discard.pop();
      if (last) me.hand.splice(idx, 0, last);
      return ack?.(res);
    }

    // check victory
    const winner = awardWinner(room);
    if (winner) {
      broadcastState(room);
      return ack?.({ ok:true, winner: winner.name });
    }

    // next turn
    nextTurn(room);
    broadcastState(room);
    ack?.({ ok:true });
    maybeBotTurn(room);
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) {
      room.players.delete(socket.id);
      if (room.hostId === socket.id) room.hostId = null;
      log(room, `${p.name} heeft de kamer verlaten`);
      ensureOrder(room);
      if (!room.players.size) rooms.delete(room.roomId);
      else broadcastState(room);
    }
  });
});

function maybeBotTurn(room) {
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot || actor.alive === false) return;
  setTimeout(() => {
    // draw if needed
    if ((actor.hand?.length || 0) === 1 && room.deck.length) {
      actor.hand.push(room.deck.pop());
      log(room, `${actor.name} trekt een kaart (bot)`);
      forcedDiscardCheck(room, actor);
    }
    if ((actor.hand?.length || 0) < 2) {
      nextTurn(room);
      broadcastState(room);
      return maybeBotTurn(room);
    }
    // choose a card to play (simple rule: avoid Princess if possible)
    let idx = actor.hand.findIndex(c => c.key !== 'prinses');
    if (idx < 0) idx = 0;
    const played = actor.hand.splice(idx, 1)[0];
    room.discard.push(played);
    log(room, `${actor.name} speelt ${played.name} (bot)`);

    // choose a target if needed (first alive non-protected human or bot)
    const candidates = alivePlayers(room).filter(p => p.id !== actor.id && !p.protected);
    const target = candidates[0] || null;
    const guessPool = CARD_DEFS.map(c => c.key).filter(k => k !== 'prinses');
    const guessKey = guessPool[Math.floor(Math.random()*guessPool.length)];

    const res = applyCard(room, actor.id, played, { targetId: target?.id, guessKey });
    if (!res.ok) log(room, `Bot actie mislukt: ${res.error}`);

    const winner = awardWinner(room);
    if (winner) return broadcastState(room);

    nextTurn(room);
    broadcastState(room);
    maybeBotTurn(room);
  }, 1000);
}

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
