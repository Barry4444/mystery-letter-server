// index.js (SERVER)
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();

// Sta je Netlify-domein toe of gebruik "*"
const CORS_ORIGINS = [
  process.env.ALLOW_ORIGIN,
  'https://mystery-letter-game.netlify.app',
].filter(Boolean);

app.use(cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : '*', credentials: true }));
app.get('/', (_req, res) => res.send('mystery-letter-server OK'));

const server = http.createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  cors: { origin: CORS_ORIGINS.length ? CORS_ORIGINS : '*', methods: ['GET','POST'], credentials: true },
});

const PORT = process.env.PORT || 10000;

// --------- game state ----------
const rooms = new Map();

function makeRoom(roomId) {
  return {
    roomId,
    hostId: null,
    players: new Map(),   // id -> player
    order: [],            // beurtvolgorde (ids)
    started: false,
    round: 0,
    turn: null,           // socket.id van speler aan beurt
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
  // shuffle
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
    players: publicPlayers(room),
    started: room.started,
    round: room.round,
    turn: room.turn,
    deckCount: room.deck.length,
    logs: room.logs,
  });

  // Handen enkel privé naar de betreffende speler
  for (const [id, p] of room.players) {
    if (p.isBot) continue;
    io.to(id).emit('player:hand', { hand: p.hand || [] });
  }
}

function ensureOrder(room) {
  room.order = [...room.players.keys()].filter(
    id => room.players.get(id).alive !== false
  );
  if (room.order.length && !room.turn) room.turn = room.order[0];
}

function nextTurn(room) {
  if (!room.order.length) return;
  const idx = room.order.indexOf(room.turn);
  room.turn = room.order[(idx + 1) % room.order.length];
}

function addBotsIfNeeded(room, minPlayers = 2) {
  const living = [...room.players.values()].filter(p => p.alive !== false);
  if (living.length >= minPlayers) return;
  const id = 'bot-1';
  if (!room.players.has(id)) {
    room.players.set(id, {
      id,
      name: 'Bot A',
      isBot: true,
      botLevel: 1,
      hand: [],
      alive: true,
      protected: false,
      coins: 0,
    });
  }
}

function botName(i) {
  return ['Bot A','Bot B','Bot C','Bot D'][i] || `Bot ${i+1}`;
}

// --------- socket handlers ----------
io.on('connection', (socket) => {
  // debug ping
  socket.on('ping:server', (_p, ack) => ack?.({ ok: true, pong: Date.now() }));

  // JOIN — eerste speler automatisch host
  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok:false, error:'roomId and name required' });

    let room = rooms.get(roomId);
    if (!room) {
      room = makeRoom(roomId);
      rooms.set(roomId, room);
    }

    socket.join(roomId);
    room.players.set(socket.id, {
      id: socket.id,
      name,
      isHost: false,
      isBot: false,
      hand: [],
      alive: true,
      protected: false,
      coins: 0,
    });

    if (!room.hostId) {
      room.hostId = socket.id;
      room.players.get(socket.id).isHost = true;
      log(room, `${name} is automatisch host geworden`);
    } else {
      log(room, `${name} heeft de kamer betreden`);
    }

    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok:true, roomId, you:{ id: socket.id, name } });
  });

  // Optioneel handmatig claimen
  socket.on('host:claim', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (room.hostId && room.hostId !== socket.id) return ack?.({ ok:false, error:'host already taken' });
    room.hostId = socket.id;
    const me = room.players.get(socket.id);
    if (me) me.isHost = true;
    log(room, `${me?.name ?? 'Host'} is host geworden`);
    broadcastState(room);
    ack?.({ ok:true });
  });

  // Bots configureren (host only)
  socket.on('bots:configure', ({ botsCount=0, botLevel=1 }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    for (const [id,p] of [...room.players]) if (p.isBot) room.players.delete(id);
    const n = Math.max(0, Math.min(3, botsCount));
    for (let i=0;i<n;i++){
      const id = `bot-${i+1}`;
      room.players.set(id, {
        id, name: botName(i), isBot: true,
        botLevel: Math.max(1, Math.min(3, botLevel)),
        hand: [], alive: true, protected: false, coins: 0
      });
    }
    room.settings.botsCount = n;
    room.settings.botLevel = Math.max(1, Math.min(3, botLevel));
    log(room, `Bots geconfigureerd: ${room.settings.botsCount} (lvl ${room.settings.botLevel})`);
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok:true });
  });

  // Muziek toggle (host only)
  socket.on('music:toggle', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.settings.music = !room.settings.music;
    log(room, `Muziek ${room.settings.music ? 'aan' : 'uit'}`);
    broadcastState(room);
    ack?.({ ok:true, music: room.settings.music });
  });

  // Nieuw spel (reset) (host only)
  socket.on('game:new', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });

    room.started = false;
    room.round = 0;
    room.turn = null;
    room.deck = [];
    room.discard = [];
    for (const p of room.players.values()) {
      p.hand = [];
      p.alive = true;
      p.protected = false;
    }
    log(room, 'Nieuw spel klaarzetten');
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok:true });
  });

  // Ronde starten (host only) — voegt bot toe indien te weinig spelers
  socket.on('game:startRound', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });

    addBotsIfNeeded(room, 2);

    const living = [...room.players.values()].filter(p => p.alive !== false);
    if (living.length < 2) return ack?.({ ok:false, error:'min 2 spelers (bot auto-aanvulling mislukt?)' });

    room.round += 1;
    room.started = true;
    room.deck = buildDeck();
    room.discard = [];

    for (const p of living) { p.hand = []; p.protected = false; }
    for (const p of living) {
      const c = room.deck.pop();
      if (c) p.hand.push(c);
    }

    ensureOrder(room);
    if (!room.turn && room.order.length) room.turn = room.order[0];

    log(room, `Ronde ${room.round} gestart`);
    broadcastState(room);
    ack?.({ ok:true });
    maybeBotTurn(room);
  });

  // Kaart trekken — alleen speler aan beurt, en alleen als je precies 1 kaart hebt
  socket.on('game:draw', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (!room.started) return ack?.({ ok:false, error:'round not started' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });

    const me = room.players.get(socket.id);
    if (!me) return ack?.({ ok:false, error:'no player' });
    if ((me.hand?.length ?? 0) !== 1) return ack?.({ ok:false, error:'need 1 card to draw' });

    const card = room.deck.pop();
    if (!card) return ack?.({ ok:false, error:'deck empty' });

    me.hand.push(card);
    log(room, `${me.name} trekt een kaart`);
    broadcastState(room);
    ack?.({ ok:true, handSize: me.hand.length });
  });

  // Kick speler (host only)
  socket.on('player:kick', ({ playerId }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    if (!playerId || !room.players.has(playerId)) return ack?.({ ok:false, error:'player not found' });

    const kicked = room.players.get(playerId);
    room.players.delete(playerId);
    log(room, `${kicked.name} is gekickt`);
    if (room.turn === playerId) {
      ensureOrder(room);
      nextTurn(room);
    } else {
      ensureOrder(room);
    }
    broadcastState(room);
    ack?.({ ok:true });
  });

  // Debug state
  socket.on('room:debug', (_p, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    ack?.({
      ok:true,
      roomId: room.roomId,
      started: room.started,
      round: room.round,
      turn: room.turn,
      deck: room.deck.length,
      order: room.order,
      players: [...room.players.values()].map(p => ({
        id: p.id, name: p.name, isBot: p.isBot, alive: p.alive, hand: (p.hand||[]).length
      })),
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const room = roomOf(socket); if (!room) return;
    const p = room.players.get(socket.id);
    if (p) {
      room.players.delete(socket.id);
      log(room, `${p.name} heeft de kamer verlaten`);
      if (room.hostId === socket.id) room.hostId = null;
      ensureOrder(room);
      if (!room.players.size) {
        rooms.delete(room.roomId);
      } else {
        broadcastState(room);
      }
    }
  });
});

// Eenvoudige bot: trekt en speelt random
function maybeBotTurn(room) {
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot) return;

  setTimeout(() => {
    // kaart trekken indien nodig
    if ((actor.hand?.length ?? 0) === 1 && room.deck.length) {
      actor.hand.push(room.deck.pop());
      log(room, `${actor.name} trekt een kaart (bot)`);
    }
    // speel willekeurige kaart
    if ((actor.hand?.length ?? 0) >= 1) {
      const idx = Math.random() < 0.5 ? 0 : 1;
      const played = actor.hand.splice(idx, 1)[0];
      room.discard.push(played);
      log(room, `${actor.name} speelt ${played.name}`);
    }
    nextTurn(room);
    broadcastState(room);
    // recursive: laat de bot door blijven spelen wanneer aan de beurt
    maybeBotTurn(room);
  }, 800);
}

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
