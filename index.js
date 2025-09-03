// index.js (SERVER) — bots met kaartlogica
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
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 10000;

/* ================== State ================== */
const rooms = new Map();        // roomId -> room
const socketToRoom = new Map(); // socketId -> roomId

function makeRoom(roomId) {
  return {
    roomId,
    hostId: null,
    players: new Map(), // id -> player
    order: [],
    started: false,
    round: 0,
    turn: null,
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

function buildDeck() {
  const deck = [];
  for (const def of CARD_DEFS) {
    for (let i = 0; i < def.count; i++) {
      deck.push({ key: def.key, name: def.name, rank: def.rank });
    }
  }
  // Fisher–Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
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
    players: publicPlayers(room),
    started: room.started,
    round: room.round,
    turn: room.turn,
    settings: room.settings,
    logs: room.logs,
  });
  // handen naar eigen sockets
  for (const [id, p] of room.players) {
    if (p.isBot) continue;
    io.to(id).emit('player:hand', { hand: p.hand || [] });
  }
}

function ensureOrder(room) {
  room.order = [...room.players.keys()].filter(id => room.players.get(id).alive !== false);
  if (room.order.length && !room.turn) {
    const nextId = room.order[0];
    const nextP = room.players.get(nextId);
    if (nextP) nextP.protected = false; // bescherming vervalt bij start van je beurt
    room.turn = nextId;
  }
}

function nextTurn(room) {
  if (!room.order.length) return;
  const idx = room.order.indexOf(room.turn);
  const nextId = room.order[(idx + 1) % room.order.length];
  const nextP = room.players.get(nextId);
  if (nextP) nextP.protected = false; // bescherming vervalt bij begin van je beurt
  room.turn = nextId;
}

function botName(i) {
  return ['Bot A', 'Bot B', 'Bot C', 'Bot D'][i] || `Bot ${i + 1}`;
}

function maybeEndRound(room) {
  const alive = [...room.players.values()].filter(p => p.alive);
  if (alive.length <= 1) {
    if (alive.length === 1) {
      const w = alive[0];
      w.coins = (w.coins || 0) + 1;
      log(room, `${w.name} wint de ronde en krijgt een gouden munt (totaal ${w.coins})`);
      if (w.coins >= 3) {
        log(room, `${w.name} wint het spel met 3 munten!`);
      }
    } else {
      log(room, `Ronde eindigt — geen spelers over`);
    }
    room.started = false;
    room.turn = null;
    room.deck = [];
    room.discard = [];
    broadcastState(room);
    return true;
  }
  return false;
}

/* ================== Gedeelde kaartresolver ================== */
function resolvePlay(room, actorId, payload) {
  // return { ok: true/false, error?, noTarget? }
  if (!room.started) return { ok: false, error: 'round not started' };
  if (room.turn !== actorId) return { ok: false, error: 'not your turn' };

  const me = room.players.get(actorId);
  if (!me || !Array.isArray(me.hand)) return { ok: false, error: 'no player' };
  if (me.hand.length !== 2) return { ok: false, error: 'need 2 cards in hand' };

  const { index, targetId, guess, allowNoTarget } = payload || {};
  if (index !== 0 && index !== 1) return { ok: false, error: 'invalid index' };

  const card = me.hand[index];
  if (!card) return { ok: false, error: 'card not in hand' };
  const otherIdx = 1 - index;
  const other = me.hand[otherIdx];

  // Heks + Prinses samen: verplicht Prinses afleggen, speler verliest
  if (card.key === 'heks' && other?.key === 'prinses') {
    const princessIdx = me.hand.findIndex(c => c.key === 'prinses');
    const princess = me.hand.splice(princessIdx, 1)[0];
    room.discard.push(princess);
    me.alive = false;
    log(room, `${me.name} moest de Prinses afleggen en ligt uit het spel!`);
    // heks zelf afleggen
    const played = me.hand.splice(0, 1)[0];
    if (played) room.discard.push(played);

    if (maybeEndRound(room)) return { ok: true };
    nextTurn(room);
    broadcastState(room);
    return { ok: true };
  }

  const needsTarget = ['ziener', 'wolf', 'ridder', 'zeemeermin', 'god', 'emir'].includes(card.key);
  const target = targetId ? room.players.get(targetId) : null;

  if (needsTarget) {
    const isRidder = card.key === 'ridder';
    const validTarget =
      isRidder
        ? (target && target.alive)
        : (target && target.alive && !target.protected && (card.key !== 'god' ? true : target.id !== actorId));

    if (!validTarget) {
      if (allowNoTarget && card.key !== 'prinses') {
        const played = me.hand.splice(index, 1)[0];
        room.discard.push(played);
        log(room, `${me.name} kon geen geldig doelwit kiezen (${card.name}) — kaart zonder effect`);
        nextTurn(room);
        broadcastState(room);
        return { ok: true, noTarget: true };
      }
      return { ok: false, error: 'target required' };
    }
  }

  // --------- effecten ----------
  if (card.key === 'ziener') {
    if (!target || !target.alive) return { ok: false, error: 'target required' };
    if (!guess || guess < 1 || guess > 8) return { ok: false, error: 'guess required' };
    const tCard = target.hand?.[0];
    if (tCard && tCard.rank === Number(guess)) {
      target.alive = false;
      log(room, `${me.name} gokte juist (${tCard.name}) — ${target.name} ligt eruit!`);
      if (maybeEndRound(room)) return { ok: true };
    } else {
      log(room, `${me.name} gokte fout op ${target.name}`);
    }
  }
  else if (card.key === 'wolf') {
    if (!target || !target.alive) return { ok: false, error: 'target required' };
    const tCard = target.hand?.[0];
    io.to(actorId).emit('secret:peek', { id: target.id, name: target.name, card: tCard || null });
    log(room, `${me.name} loert stiekem naar ${target.name}`);
  }
  else if (card.key === 'ridder') {
    if (!target || !target.alive) return { ok: false, error: 'target required' };
    target.protected = true;
    log(room, `${me.name} geeft bescherming aan ${target.name}`);
  }
  else if (card.key === 'zeemeermin') {
    if (!target || !target.alive) return { ok: false, error: 'target required' };
    const mine = other;
    const theirs = target.hand?.[0];
    if (mine && theirs) {
      if (mine.rank > theirs.rank) {
        target.alive = false;
        log(room, `${me.name} wint (Zeemeermin) — ${target.name} ligt eruit!`);
        if (maybeEndRound(room)) return { ok: true };
      } else if (theirs.rank > mine.rank) {
        me.alive = false;
        log(room, `${target.name} wint (Zeemeermin) — ${me.name} ligt eruit!`);
        if (maybeEndRound(room)) return { ok: true };
      } else {
        log(room, `${me.name} en ${target.name} spelen gelijk (Zeemeermin)`);
      }
    }
  }
  else if (card.key === 'god') {
    if (!target || !target.alive || target.id === actorId) return { ok: false, error: 'valid target required' };
    const mine = other;              // mijn NIET-gespeelde kaart
    const theirs = target.hand?.[0]; // target’s kaart
    if (mine && theirs) {
      target.hand[0] = mine;
      me.hand[otherIdx] = theirs;
      log(room, `${me.name} wisselt kaart met ${target.name}`);
    }
  }
  else if (card.key === 'emir') {
    if (!target || !target.alive) return { ok: false, error: 'target required' };
    const newCard = room.deck.pop();
    if (newCard) {
      if (!target.hand) target.hand = [];
      target.hand[0] = newCard;
      log(room, `${target.name} krijgt een nieuwe kaart (Emir)`);
    }
  }
  else if (card.key === 'heks') {
    log(room, `${me.name} speelt Heks`);
  }
  else if (card.key === 'prinses') {
    return { ok: false, error: 'Prinses mag niet vrijwillig gespeeld worden' };
  }

  // gespeelde kaart afleggen
  const played = me.hand.splice(index, 1)[0];
  if (played) room.discard.push(played);

  nextTurn(room);
  broadcastState(room);
  return { ok: true };
}

/* ================== Socket.io ================== */
io.on('connection', (socket) => {
  socket.on('ping:server', (_p, ack) => ack?.({ ok: true, pong: Date.now() }));

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok: false, error: 'roomId and name required' });
    let room = rooms.get(roomId);
    if (!room) { room = makeRoom(roomId); rooms.set(roomId, room); }

    socket.join(roomId);
    room.players.set(socket.id, {
      id: socket.id, name, isHost: false, isBot: false,
      hand: [], alive: true, protected: false, coins: 0,
    });
    socketToRoom.set(socket.id, roomId);

    ensureOrder(room);
    log(room, `${name} heeft de kamer betreden`);
    broadcastState(room);
    ack?.({ ok: true, roomId, you: { id: socket.id, name } });
  });

  socket.on('leave', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) { ack?.({ ok: true }); return; }
    const room = rooms.get(roomId);
    if (!room) { socketToRoom.delete(socket.id); ack?.({ ok: true }); return; }

    const p = room.players.get(socket.id);
    if (p) {
      room.players.delete(socket.id);
      log(room, `${p.name} heeft de kamer verlaten`);
      if (room.hostId === socket.id) room.hostId = null;
    }
    socket.leave(roomId);
    socketToRoom.delete(socket.id);

    ensureOrder(room);
    if (!room.players.size) rooms.delete(roomId);
    else broadcastState(room);
    ack?.({ ok: true });
  });

  socket.on('host:claim', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, error: 'no room' });
    if (room.hostId && room.hostId !== socket.id) return ack?.({ ok: false, error: 'host already taken' });

    room.hostId = socket.id;
    const me = room.players.get(socket.id);
    if (me) me.isHost = true;
    log(room, `${me?.name ?? 'Host'} is host geworden`);
    broadcastState(room);
    ack?.({ ok: true });
  });

  socket.on('bots:configure', ({ botsCount = 0, botLevel = 1 }, ack) => {
    const roomId = socketToRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, error: 'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: 'only host' });

    for (const [id, p] of [...room.players]) if (p.isBot) room.players.delete(id);
    for (let i = 0; i < Math.max(0, Math.min(3, botsCount)); i++) {
      const id = `bot-${i + 1}-${roomId}`;
      room.players.set(id, {
        id, name: botName(i), isBot: true, botLevel: Math.max(1, Math.min(3, botLevel)),
        hand: [], alive: true, protected: false, coins: 0,
      });
    }
    room.settings.botsCount = Math.max(0, Math.min(3, botsCount));
    room.settings.botLevel = Math.max(1, Math.min(3, botLevel));
    log(room, `Bots geconfigureerd: ${room.settings.botsCount} (lvl ${room.settings.botLevel})`);
    ensureOrder(room); broadcastState(room); ack?.({ ok: true });
  });

  socket.on('music:toggle', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, error: 'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: 'only host' });
    room.settings.music = !room.settings.music;
    log(room, `Muziek ${room.settings.music ? 'aan' : 'uit'}`);
    broadcastState(room); ack?.({ ok: true, music: room.settings.music });
  });

  socket.on('game:new', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, error: 'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: 'only host' });

    room.started = false;
    room.round = 0;
    room.turn = null;
    room.deck = [];
    room.discard = [];
    for (const p of room.players.values()) { p.hand = []; p.alive = true; p.protected = false; }
    log(room, 'Nieuw spel klaarzetten');
    ensureOrder(room); broadcastState(room); ack?.({ ok: true });
  });

  socket.on('game:startRound', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, error: 'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: 'only host' });

    const living = [...room.players.values()].filter(p => p.alive !== false);
    if (living.length < 2) return ack?.({ ok: false, error: 'min 2 spelers' });

    room.round += 1; room.started = true; room.deck = buildDeck(); room.discard = [];
    for (const p of living) { p.hand = []; p.protected = false; }
    for (const p of living) { const c = room.deck.pop(); if (c) p.hand.push(c); }
    room.turn = null; ensureOrder(room);
    log(room, `Ronde ${room.round} gestart`);
    broadcastState(room); ack?.({ ok: true });
    maybeBotTurn(room);
  });

  socket.on('game:draw', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, error: 'no room' });
    if (!room.started) return ack?.({ ok: false, error: 'round not started' });
    if (room.turn !== socket.id) return ack?.({ ok: false, error: 'not your turn' });

    const me = room.players.get(socket.id);
    if (!me) return ack?.({ ok: false, error: 'no player' });
    if ((me.hand?.length ?? 0) !== 1) return ack?.({ ok: false, error: 'need 1 card to draw' });

    const card = room.deck.pop();
    if (!card) return ack?.({ ok: false, error: 'deck empty' });

    me.hand.push(card);
    log(room, `${me.name} trekt een kaart`);
    broadcastState(room); ack?.({ ok: true, handSize: me.hand.length });
  });

  socket.on('game:play', (payload, ack) => {
    const roomId = socketToRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, error: 'no room' });
    const res = resolvePlay(room, socket.id, payload);
    ack?.(res);
    if (res.ok) maybeBotTurn(room);
  });

  socket.on('admin:kick', ({ playerId }, ack) => {
    const roomId = socketToRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, error: 'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: 'only host' });
    if (!playerId || !room.players.has(playerId)) return ack?.({ ok: false, error: 'unknown player' });

    const target = room.players.get(playerId);
    const targetSocket = io.sockets.sockets.get(playerId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      targetSocket.disconnect(true);
    } else {
      room.players.delete(playerId);
      log(room, `${target?.name ?? 'Speler'} is gekickt`);
      ensureOrder(room); broadcastState(room);
    }
    ack?.({ ok: true });
  });

  socket.on('disconnecting', () => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) { socketToRoom.delete(socket.id); return; }

    const p = room.players.get(socket.id);
    if (p) {
      room.players.delete(socket.id);
      log(room, `${p.name} heeft de verbinding verbroken`);
      if (room.hostId === socket.id) room.hostId = null;
    }
    socketToRoom.delete(socket.id);

    ensureOrder(room);
    if (!room.players.size) rooms.delete(roomId);
    else broadcastState(room);
  });
});

/* ================== BOT-LOGICA ================== */

// kleine hulpjes
function aliveTargets(room, excludeId, { allowProtected = false, allowSelf = false } = {}) {
  return [...room.players.values()].filter(p => {
    if (!p.alive) return false;
    if (!allowSelf && p.id === excludeId) return false;
    if (!allowProtected && p.protected) return false;
    return true;
  });
}
function highestRankCard(cards) {
  return cards?.slice().sort((a,b)=>b.rank-a.rank)[0] || null;
}
function lowestRankCard(cards) {
  return cards?.slice().sort((a,b)=>a.rank-b.rank)[0] || null;
}

function pickBotAction(room, actor) {
  // actor.hand heeft 2 kaarten (gegarandeerd door maybeBotTurn)
  const [c0, c1] = actor.hand;
  const hi = c0.rank >= c1.rank ? 0 : 1;
  const lo = hi === 0 ? 1 : 0;

  // Forced rule: Heks + Prinses -> speel Heks
  if ((c0.key === 'heks' && c1.key === 'prinses') || (c1.key === 'heks' && c0.key === 'prinses')) {
    const idx = c0.key === 'heks' ? 0 : 1;
    return { index: idx, targetId: null, guess: null, allowNoTarget: true };
  }

  // vermijd vrijwillig Prinses
  const avoidPrincessIdx = (c0.key === 'prinses') ? 1 : (c1.key === 'prinses') ? 0 : null;

  // targets per kaarttype
  const targetsOpen   = aliveTargets(room, actor.id, { allowProtected: false, allowSelf: false });
  const targetsAny    = aliveTargets(room, actor.id, { allowProtected: true,  allowSelf: true  });
  const targetsNoSelf = aliveTargets(room, actor.id, { allowProtected: false, allowSelf: false });

  // heuristieken per kaart:
  // RIDDER: geef (meestal) jezelf bescherming, anders teamgenoot/random
  if (c0.key === 'ridder' || c1.key === 'ridder') {
    const idx = (c0.key === 'ridder') ? 0 : 1;
    const meTarget = actor; // jezelf
    const someone = targetsAny[0] || actor;
    return { index: idx, targetId: meTarget?.id ?? someone?.id ?? actor.id, guess: null, allowNoTarget: false };
  }

  // GOD: als andere kaart laag is, wissel met willekeurige tegenstander
  if (c0.key === 'god' || c1.key === 'god') {
    const idx = (c0.key === 'god') ? 0 : 1;
    const other = actor.hand[idx === 0 ? 1 : 0];
    const wantSwap = other.rank <= 3; // lage kaart wegdoen
    const tgt = wantSwap ? targetsOpen[0] : targetsOpen[0];
    if (tgt) return { index: idx, targetId: tgt.id, guess: null, allowNoTarget: false };
    return { index: idx, targetId: null, guess: null, allowNoTarget: true };
  }

  // EMIR: geef nieuwe kaart aan jezelf als je andere kaart laag is, anders random tegenstander
  if (c0.key === 'emir' || c1.key === 'emir') {
    const idx = (c0.key === 'emir') ? 0 : 1;
    const other = actor.hand[idx === 0 ? 1 : 0];
    const selfBetter = other.rank <= 3;
    const tgt = selfBetter ? actor : targetsOpen[0];
    return { index: idx, targetId: (tgt?.id ?? null), guess: null, allowNoTarget: !!tgt ? false : true };
  }

  // ZEEMEERMIN: alleen spelen als jouw andere kaart hoog is (>=5) om risico te verkleinen
  if (c0.key === 'zeemeermin' || c1.key === 'zeemeermin') {
    const idx = (c0.key === 'zeemeermin') ? 0 : 1;
    const other = actor.hand[idx === 0 ? 1 : 0];
    if (other.rank >= 5) {
      const tgt = targetsOpen[0];
      if (tgt) return { index: idx, targetId: tgt.id, guess: null, allowNoTarget: false };
    }
    // anders liever iets anders spelen — wacht nog met Zeemeermin
  }

  // ZIENER: gok op hoge rangen (8,6,5) als “beste gok”
  if (c0.key === 'ziener' || c1.key === 'ziener') {
    const idx = (c0.key === 'ziener') ? 0 : 1;
    const tgt = targetsOpen[0];
    const guessPool = [8, 6, 5, 4, 7, 3, 2, 1];
    const guess = guessPool[Math.floor(Math.random() * guessPool.length)];
    if (tgt) return { index: idx, targetId: tgt.id, guess, allowNoTarget: false };
    return { index: idx, targetId: null, guess: null, allowNoTarget: true };
  }

  // WOLF: gluur bij eerste beste doelwit
  if (c0.key === 'wolf' || c1.key === 'wolf') {
    const idx = (c0.key === 'wolf') ? 0 : 1;
    const tgt = targetsOpen[0];
    if (tgt) return { index: idx, targetId: tgt.id, guess: null, allowNoTarget: false };
    return { index: idx, targetId: null, guess: null, allowNoTarget: true };
  }

  // HEKS: neutraal — speel Heks als je verder niets nuttigs ziet
  if (c0.key === 'heks' || c1.key === 'heks') {
    const idx = (c0.key === 'heks') ? 0 : 1;
    // vermijd om Heks te spelen als de andere kaart Prinses is (zou forced rule moeten triggeren als Heks gekozen wordt)
    if (actor.hand[idx === 0 ? 1 : 0].key === 'prinses') {
      return { index: idx, targetId: null, guess: null, allowNoTarget: true };
    }
    return { index: idx, targetId: null, guess: null, allowNoTarget: true };
  }

  // Anders: speel de laagste kaart (behoud hoge kaart), vermijd Prinses
  if (avoidPrincessIdx !== null) {
    return { index: avoidPrincessIdx, targetId: null, guess: null, allowNoTarget: true };
  }
  const lowestIdx = (lowestRankCard(actor.hand) === actor.hand[0]) ? 0 : 1;
  return { index: lowestIdx, targetId: null, guess: null, allowNoTarget: true };
}

function maybeBotTurn(room) {
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot) return;

  setTimeout(() => {
    // 1) trek tot 2 kaarten
    if ((actor.hand?.length ?? 0) === 1 && room.deck.length) {
      actor.hand.push(room.deck.pop());
      log(room, `${actor.name} trekt een kaart (bot)`);
    }

    // als nog steeds <2, geef beurt door om vastlopers te vermijden
    if ((actor.hand?.length ?? 0) < 2) {
      nextTurn(room);
      broadcastState(room);
      return maybeBotTurn(room);
    }

    // 2) kies actie
    const choice = pickBotAction(room, actor);

    // 3) probeer te spelen; als target vereist en faalt -> eenmalig met allowNoTarget herproberen
    let res = resolvePlay(room, actor.id, choice);
    if (!res.ok && res.error === 'target required') {
      const retry = { ...choice, allowNoTarget: true, targetId: null, guess: null };
      res = resolvePlay(room, actor.id, retry);
    }
    if (!res.ok && res.error === 'Prinses mag niet vrijwillig gespeeld worden') {
      // speel de andere kaart (meestal laagste)
      const altIdx = choice.index === 0 ? 1 : 0;
      const alt = { index: altIdx, targetId: null, guess: null, allowNoTarget: true };
      res = resolvePlay(room, actor.id, alt);
    }

    // 4) volgende bot evt
    if (res.ok) return maybeBotTurn(room);

    // fallback: als echt niets lukt, beurt door
    nextTurn(room);
    broadcastState(room);
    maybeBotTurn(room);
  }, 800);
}

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
