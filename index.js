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
    origin: '*', // zet desnoods je Netlify domein hier voor strakkere CORS
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 10000;

/* ================== State ================== */
const rooms = new Map();            // roomId -> room
const socketToRoom = new Map();     // socketId -> roomId  (voor betrouwbare cleanup)

function makeRoom(roomId) {
  return {
    roomId,
    hostId: null,
    players: new Map(),    // socketId|botId -> player
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
  for (const def of CARD_DEFS) for (let i = 0; i < def.count; i++) deck.push({ key: def.key, name: def.name, rank: def.rank });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, isHost: !!p.isHost, isBot: !!p.isBot,
    alive: p.alive !== false, protected: !!p.protected, coins: p.coins || 0,
  }));
}
function broadcastState(room) {
  io.to(room.roomId).emit('room:state', {
    roomId: room.roomId, hostId: room.hostId, players: publicPlayers(room),
    started: room.started, round: room.round, turn: room.turn,
    settings: room.settings, logs: room.logs,
  });
  for (const [id, p] of room.players) {
    if (p.isBot) continue;
    io.to(id).emit('player:hand', { hand: p.hand || [] });
  }
}
function ensureOrder(room) {
  room.order = [...room.players.keys()].filter(id => room.players.get(id).alive !== false && !room.players.get(id).isBot);
  if (room.order.length && !room.turn) room.turn = room.order[0];
}
function nextTurn(room) {
  if (!room.order.length) return;
  const idx = room.order.indexOf(room.turn);
  room.turn = room.order[(idx + 1) % room.order.length];
}
function botName(i){ return ['Bot A','Bot B','Bot C','Bot D'][i] || `Bot ${i+1}`; }

/* ================== Socket.io ================== */
io.on('connection', (socket) => {
  socket.on('ping:server', (_p, ack) => ack?.({ ok: true, pong: Date.now() }));

  /* ---- join ---- */
  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok:false, error:'roomId and name required' });
    let room = rooms.get(roomId); if (!room){ room = makeRoom(roomId); rooms.set(roomId, room); }
    socket.join(roomId);

    const player = { id: socket.id, name, isHost:false, isBot:false, hand:[], alive:true, protected:false, coins:0 };
    room.players.set(socket.id, player);
    socketToRoom.set(socket.id, roomId);

    ensureOrder(room);
    log(room, `${name} heeft de kamer betreden`);
    broadcastState(room);
    ack?.({ ok:true, roomId, you:{ id: socket.id, name } });
  });

  /* ---- leave (bewuste actie vanuit UI) ---- */
  socket.on('leave', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) { ack?.({ ok:true }); return; }
    const room = rooms.get(roomId);
    if (!room) { socketToRoom.delete(socket.id); ack?.({ ok:true }); return; }

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

    ack?.({ ok:true });
  });

  /* ---- host claim ---- */
  socket.on('host:claim', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id); const room = rooms.get(roomId);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (room.hostId && room.hostId !== socket.id) return ack?.({ ok:false, error:'host already taken' });
    room.hostId = socket.id; const me = room.players.get(socket.id); if (me) me.isHost = true;
    log(room, `${me?.name ?? 'Host'} is host geworden`);
    broadcastState(room); ack?.({ ok:true });
  });

  /* ---- bots ---- */
  socket.on('bots:configure', ({ botsCount=0, botLevel=1 }, ack) => {
    const roomId = socketToRoom.get(socket.id); const room = rooms.get(roomId);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });

    // verwijder oude bots
    for (const [id,p] of [...room.players]) if (p.isBot) room.players.delete(id);

    // voeg bots toe
    for (let i=0;i<Math.max(0,Math.min(3,botsCount));i++){
      const id = `bot-${i+1}-${roomId}`;
      room.players.set(id,{ id, name:botName(i), isBot:true, botLevel:Math.max(1,Math.min(3,botLevel)), hand:[], alive:true, protected:false, coins:0 });
    }
    room.settings.botsCount = Math.max(0,Math.min(3,botsCount));
    room.settings.botLevel = Math.max(1,Math.min(3,botLevel));
    log(room, `Bots geconfigureerd: ${room.settings.botsCount} (lvl ${room.settings.botLevel})`);

    ensureOrder(room); broadcastState(room); ack?.({ ok:true });
  });

  /* ---- muziek ---- */
  socket.on('music:toggle', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id); const room = rooms.get(roomId);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.settings.music = !room.settings.music;
    log(room, `Muziek ${room.settings.music ? 'aan' : 'uit'}`);
    broadcastState(room); ack?.({ ok:true, music: room.settings.music });
  });

  /* ---- nieuw spel / ronde ---- */
  socket.on('game:new', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id); const room = rooms.get(roomId);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.started=false; room.round=0; room.turn=null; room.deck=[]; room.discard=[];
    for (const p of room.players.values()){ p.hand=[]; p.alive=true; p.protected=false; }
    log(room, 'Nieuw spel klaarzetten'); ensureOrder(room); broadcastState(room); ack?.({ ok:true });
  });

  socket.on('game:startRound', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id); const room = rooms.get(roomId);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });

    const living = [...room.players.values()].filter(p => p.alive !== false);
    if (living.filter(p=>!p.isBot).length < 2 && living.length < 2) return ack?.({ ok:false, error:'min 2 spelers' });

    room.round += 1; room.started = true; room.deck = buildDeck(); room.discard = [];
    for (const p of living){ p.hand=[]; p.protected=false; }
    for (const p of living){ const c = room.deck.pop(); if (c) p.hand.push(c); }
    ensureOrder(room); log(room, `Ronde ${room.round} gestart`); broadcastState(room); ack?.({ ok:true });
    maybeBotTurn(room);
  });

  socket.on('game:draw', (_p, ack) => {
    const roomId = socketToRoom.get(socket.id); const room = rooms.get(roomId);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });
    const me = room.players.get(socket.id); if (!me) return ack?.({ ok:false, error:'no player' });
    if (!room.started) return ack?.({ ok:false, error:'round not started' });
    if ((me.hand?.length ?? 0) !== 1) return ack?.({ ok:false, error:'need 1 card to draw' });
    const card = room.deck.pop(); if (!card) return ack?.({ ok:false, error:'deck empty' });
    me.hand.push(card); log(room, `${me.name} trekt een kaart`); broadcastState(room); ack?.({ ok:true, handSize: me.hand.length });
  });

  /* ---- speel kaart (jouw bestaande logica blijft hier) ---- */
 socket.on('game:play', (payload, ack) => {
  const roomId = socketToRoom.get(socket.id); const room = rooms.get(roomId);
  if (!room) return ack?.({ ok:false, error:'no room' });
  const me = room.players.get(socket.id);
  if (!room.started) return ack?.({ ok:false, error:'round not started' });
  if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });
  if (!me || !Array.isArray(me.hand) || me.hand.length !== 2) return ack?.({ ok:false, error:'need 2 cards in hand' });

  const { index, targetId, guess, allowNoTarget } = payload || {};
  if (index !== 0 && index !== 1) return ack?.({ ok:false, error:'invalid index' });

  const card = me.hand[index];
  if (!card) return ack?.({ ok:false, error:'card not in hand' });
  const other = me.hand[1 - index];

  // special: Heks + Prinses => Prinses MOET af en speler verliest
  if (card.key === 'heks' && other?.key === 'prinses') {
    const princessIdx = me.hand.findIndex(c => c.key === 'prinses');
    const princess = me.hand.splice(princessIdx, 1)[0];
    room.discard.push(princess);
    me.alive = false;
    log(room, `${me.name} moest de Prinses afleggen en ligt uit het spel!`);
    const played = me.hand.splice(0,1)[0]; // heks zelf uit de hand
    room.discard.push(played);
    nextTurn(room); broadcastState(room); ack?.({ ok:true });
    maybeBotTurn(room);
    return;
  }

  const needsTarget = ['ziener','wolf','ridder','zeemeermin','god','emir'].includes(card.key);
  const target = targetId ? room.players.get(targetId) : null;

  // Als doelwit vereist is maar er is geen geldig doelwit: toegestaan om zonder effect af te leggen
  if (needsTarget) {
    // Voor 'ridder' mag je iedereen kiezen (ook beschermd, ook jezelf).
    const ridder = card.key === 'ridder';
    const validTarget =
      ridder
        ? (target && target.alive)
        : (target && target.alive && !target.protected && (card.key !== 'god' ? true : target.id !== socket.id));

    if (!validTarget) {
      if (allowNoTarget && card.key !== 'prinses') {
        const played = me.hand.splice(index, 1)[0];
        room.discard.push(played);
        log(room, `${me.name} kon geen geldig doelwit kiezen (${card.name}) — kaart zonder effect`);
        nextTurn(room); broadcastState(room); ack?.({ ok:true, noTarget:true });
        maybeBotTurn(room);
        return;
      }
      return ack?.({ ok:false, error:'target required' });
    }
  }

  // --------- bestaande effect-afhandeling hieronder (ongewijzigd) ----------
  if (card.key === 'ziener') {
    if (!guess || guess < 1 || guess > 8) return ack?.({ ok:false, error:'guess required' });
    const tCard = target.hand?.[0];
    if (tCard && tCard.rank === Number(guess)) {
      target.alive = false;
      log(room, `${me.name} gokte juist (${tCard.name}) — ${target.name} ligt eruit!`);
    } else {
      log(room, `${me.name} gokte fout op ${target.name}`);
    }
  }
  else if (card.key === 'wolf') {
    const tCard = target.hand?.[0];
    io.to(socket.id).emit('secret:peek', { id: target.id, name: target.name, card: tCard || null });
    log(room, `${me.name} loert stiekem naar ${target.name}`);
  }
  else if (card.key === 'ridder') {
    target.protected = true;
    log(room, `${me.name} geeft bescherming aan ${target.name}`);
  }
  else if (card.key === 'zeemeermin') {
    const mine = other; const theirs = target.hand?.[0];
    if (mine && theirs) {
      if (mine.rank > theirs.rank) { target.alive = false; log(room, `${me.name} wint (Zeemeermin) — ${target.name} ligt eruit!`); }
      else if (theirs.rank > mine.rank) { me.alive = false; log(room, `${target.name} wint (Zeemeermin) — ${me.name} ligt eruit!`); }
      else { log(room, `${me.name} en ${target.name} spelen gelijk (Zeemeermin)`); }
    }
  }
  else if (card.key === 'god') {
    if (target.id === socket.id) return ack?.({ ok:false, error:'valid target required' });
    const mine = other; const theirs = target.hand?.[0];
    if (mine && theirs) {
      target.hand = [mine];
      me.hand = [theirs];
      log(room, `${me.name} wisselt kaart met ${target.name}`);
    }
  }
  else if (card.key === 'emir') {
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
    return ack?.({ ok:false, error:'Prinses mag niet vrijwillig gespeeld worden' });
  }

  const played = me.hand.splice(index, 1)[0];
  room.discard.push(played);

  nextTurn(room); broadcastState(room); ack?.({ ok:true });
  maybeBotTurn(room);
});


    // voorbeeld-acties
    if (card.key === 'ziener') {
      if (!target || !target.alive) return ack?.({ ok:false, error:'target required' });
      if (!guess || guess < 1 || guess > 8) return ack?.({ ok:false, error:'guess required' });
      const tCard = target.hand?.[0]; // target heeft 1 kaart (voor draw)
      if (tCard && tCard.rank === Number(guess)) {
        target.alive = false;
        log(room, `${me.name} gokte juist (${tCard.name}) — ${target.name} ligt eruit!`);
      } else {
        log(room, `${me.name} gokte fout op ${target.name}`);
      }
    }
    else if (card.key === 'wolf') {
      if (!target || !target.alive) return ack?.({ ok:false, error:'target required' });
      const tCard = target.hand?.[0];
      io.to(socket.id).emit('secret:peek', { id: target.id, name: target.name, card: tCard || null });
      log(room, `${me.name} loert stiekem naar ${target.name}`);
    }
    else if (card.key === 'ridder') {
      if (!target || !target.alive) return ack?.({ ok:false, error:'target required' });
      target.protected = true;
      log(room, `${me.name} geeft bescherming aan ${target.name}`);
    }
    else if (card.key === 'zeemeermin') {
      if (!target || !target.alive) return ack?.({ ok:false, error:'target required' });
      const mine = other; const theirs = target.hand?.[0];
      if (mine && theirs) {
        if (mine.rank > theirs.rank) { target.alive = false; log(room, `${me.name} wint (Zeemeermin) — ${target.name} ligt eruit!`); }
        else if (theirs.rank > mine.rank) { me.alive = false; log(room, `${target.name} wint (Zeemeermin) — ${me.name} ligt eruit!`); }
        else { log(room, `${me.name} en ${target.name} spelen gelijk (Zeemeermin)`); }
      }
    }
    else if (card.key === 'god') {
      if (!target || !target.alive || target.id === socket.id) return ack?.({ ok:false, error:'valid target required' });
      const mine = other; const theirs = target.hand?.[0];
      if (mine && theirs) {
        target.hand = [mine];
        me.hand = [theirs];
        log(room, `${me.name} wisselt kaart met ${target.name}`);
      }
    }
    else if (card.key === 'emir') {
      if (!target || !target.alive) return ack?.({ ok:false, error:'target required' });
      const drawTarget = target;
      const newCard = room.deck.pop();
      if (newCard) {
        if (!drawTarget.hand) drawTarget.hand = [];
        drawTarget.hand[0] = newCard;
        log(room, `${drawTarget.name} krijgt een nieuwe kaart (Emir)`);
      }
    }
    else if (card.key === 'heks') {
      // Heks solo: geen effect tenzij kombinatie hierboven
      log(room, `${me.name} speelt Heks`);
    }
    else if (card.key === 'prinses') {
      // mag niet vrijwillig — alleen door Heks-regel hierboven
      return ack?.({ ok:false, error:'Prinses mag niet vrijwillig gespeeld worden' });
    }

    // leg gespeelde kaart af
    const played = me.hand.splice(index, 1)[0];
    room.discard.push(played);

    // beurt doorgeven
    nextTurn(room); broadcastState(room); ack?.({ ok:true });
    maybeBotTurn(room);
  });

  /* ---- kick ---- */
  socket.on('admin:kick', ({ playerId }, ack) => {
    const roomId = socketToRoom.get(socket.id); const room = rooms.get(roomId);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    if (!playerId || !room.players.has(playerId)) return ack?.({ ok:false, error:'unknown player' });

    const target = room.players.get(playerId);
    const targetSocket = io.sockets.sockets.get(playerId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      // hard disconnect; cleanup gebeurt in 'disconnecting'
      targetSocket.disconnect(true);
    } else {
      // offline socket — ruim handmatig op
      room.players.delete(playerId);
      log(room, `${target?.name ?? 'Speler'} is gekickt`);
      ensureOrder(room);
      broadcastState(room);
    }
    ack?.({ ok:true });
  });

  /* ---- disconnect cleanup (betrouwbaar via mapping) ---- */
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

/* ================== Bots (dummy) ================== */
function maybeBotTurn(room) {
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot) return;
  setTimeout(() => {
    if ((actor.hand?.length ?? 0) === 1 && room.deck.length) {
      actor.hand.push(room.deck.pop());
      log(room, `${actor.name} trekt een kaart (bot)`);
      const idx = Math.random() < 0.5 ? 0 : 1;
      const played = actor.hand.splice(idx, 1)[0];
      room.discard.push(played);
      log(room, `${actor.name} speelt ${played.name}`);
      nextTurn(room); broadcastState(room); maybeBotTurn(room);
    }
  }, 800);
}

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
