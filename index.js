// index.js — Mystery Letter SERVER
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
    origin: '*', // desnoods beperken tot je Netlify domein
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 10000;

/* ========================= Speldata ========================= */

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

const rooms = new Map(); // roomId -> room

function makeRoom(roomId) {
  return {
    roomId,
    hostId: null,
    players: new Map(), // id -> player
    order: [],          // volgorde (ids) van levende spelers
    started: false,
    round: 0,
    turn: null,         // id
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
    // Je UI toont deck niet, maar wil je het wel: deckCount: room.deck.length
  });
  for (const [id, p] of room.players) {
    if (p.isBot) continue;
    io.to(id).emit('player:hand', { hand: p.hand || [] });
  }
}

function roomOf(socket) {
  const ids = [...socket.rooms].filter(r => r !== socket.id);
  return rooms.get(ids[0]);
}

function ensureOrder(room) {
  room.order = [...room.players.values()]
    .filter(p => p.alive !== false)
    .map(p => p.id);
  if (room.order.length && (!room.turn || !room.order.includes(room.turn))) {
    room.turn = room.order[0];
  }
}

function nextTurn(room) {
  if (!room.order.length) { room.turn = null; return; }
  const idx = room.order.indexOf(room.turn);
  room.turn = room.order[(idx + 1) % room.order.length];
  // bescherming van speler die nu aan beurt is vervalt
  const cur = room.players.get(room.turn);
  if (cur && cur.protected) {
    cur.protected = false;
    log(room, `${cur.name} verliest bescherming`);
  }
}

function livingPlayers(room) {
  return [...room.players.values()].filter(p => p.alive !== false);
}

function endRoundIfNeeded(room) {
  const alive = livingPlayers(room);
  if (alive.length <= 1) {
    const winner = alive[0];
    if (winner) {
      winner.coins = (winner.coins || 0) + 1;
      log(room, `${winner.name} wint de ronde en krijgt een munt (totaal ${winner.coins})`);
      if (winner.coins >= 3) {
        log(room, `🏆 ${winner.name} wint het spel met 3 munten!`);
      }
    } else {
      log(room, `Ronde eindigt zonder winnaar`);
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

function eliminate(room, playerId, reason) {
  const p = room.players.get(playerId);
  if (!p || p.alive === false) return;
  p.alive = false;
  // leg resterende hand af
  if (p.hand?.length) {
    room.discard.push(...p.hand);
    p.hand = [];
  }
  log(room, `${p.name} ligt uit (${reason})`);
  ensureOrder(room);
}

function cardByKey(key) {
  return CARD_DEFS.find(c => c.key === key);
}

/* ========================= Kaartregels ========================= */

function forcePrincessIfWitch(room, player) {
  // Regel: heb je Heks + Prinses tegelijk => je MOET prinses afleggen en verliest
  if (!player?.hand || player.hand.length < 2) return false;
  const hasHeks = player.hand.some(c => c.key === 'heks');
  const hasPrinses = player.hand.some(c => c.key === 'prinses');
  if (hasHeks && hasPrinses) {
    // prinses 'afleggen' = verlies
    room.discard.push(...player.hand);
    player.hand = [];
    eliminate(room, player.id, 'Prinses afgelegd door Heks-regel');
    return true;
  }
  return false;
}

function validatePlay(room, actor, cardIndex, targetId, guess) {
  if (!room.started) return 'Ronde niet gestart';
  if (room.turn !== actor.id) return 'Niet jouw beurt';
  if ((actor.hand?.length ?? 0) !== 2) return 'Je moet 2 kaarten hebben om te spelen';
  if (cardIndex !== 0 && cardIndex !== 1) return 'Ongeldige kaartindex';

  const card = actor.hand[cardIndex];

  // Heks‐regel: bij Heks + (God|Emir) moet je Heks spelen
  const other = actor.hand[1 - cardIndex];
  const mustPlayHeks = actor.hand.some(c => c.key === 'heks') &&
    actor.hand.some(c => c.key === 'god' || c.key === 'emir');
  if (mustPlayHeks && card.key !== 'heks') {
    return 'Je moet Heks spelen (regel: Heks + (God/Emir))';
  }

  // Prinses mag NOOIT vrijwillig gespeeld worden
  if (card.key === 'prinses') {
    return 'Prinses mag je niet bewust afleggen (alleen als je gedwongen wordt)';
  }

  const needsTarget = ['ziener', 'wolf', 'ridder', 'zeemeermin', 'god', 'emir'].includes(card.key);
  if (needsTarget) {
    if (!targetId) return 'Kies een doelwit';
    const target = room.players.get(targetId);
    if (!target || target.alive === false) return 'Ongeldig doelwit';
    // Bescherming: doelwit mag niet beschermd zijn, behalve bij Ridder (mag juist geven)
    if (card.key !== 'ridder' && target.protected) return 'Doelwit is beschermd';
    // God mag niet zichzelf targeten (wisselen met jezelf heeft geen zin)
    if (card.key === 'god' && targetId === actor.id) return 'Kies iemand anders voor wisselen';
  }

  if (card.key === 'ziener') {
    if (guess == null || isNaN(Number(guess))) return 'Kies een gok (1-8)';
  }

  return null;
}

function applyPlay(room, actor, cardIndex, targetId, guess) {
  const played = actor.hand.splice(cardIndex, 1)[0]; // verwijder gespeelde kaart
  room.discard.push(played);

  const target = targetId ? room.players.get(targetId) : null;

  switch (played.key) {
    case 'ziener': {
      const ok = target && target.hand?.[0] && Number(guess) === target.hand[0].rank;
      log(room, `${actor.name} raadt dat ${target?.name} kaart ${guess} heeft — ${ok ? 'JUIST' : 'fout'}`);
      if (ok) {
        eliminate(room, target.id, 'Ziener juist geraden');
      }
      break;
    }
    case 'wolf': {
      // alleen actor krijgt geheime reveal
      if (target && target.hand?.[0]) {
        io.to(actor.id).emit('secret:peek', {
          playerId: target.id,
          name: target.name,
          card: target.hand[0],
        });
        log(room, `${actor.name} gluurt naar de kaart van ${target.name}`);
      }
      break;
    }
    case 'ridder': {
      // bescherming aan jezelf of iemand anders (1 beurt)
      const t = targetId ? target : actor;
      if (t) {
        t.protected = true;
        log(room, `${actor.name} geeft bescherming aan ${t.name}`);
      }
      break;
    }
    case 'zeemeermin': {
      if (target && target.hand?.[0] && actor.hand?.[0]) {
        const aCard = actor.hand[0];
        const bCard = target.hand[0];
        if (aCard.rank > bCard.rank) {
          eliminate(room, target.id, `Zeemeermin — lager dan ${aCard.name}`);
        } else if (bCard.rank > aCard.rank) {
          eliminate(room, actor.id, `Zeemeermin — lager dan ${bCard.name}`);
        } else {
          log(room, `${actor.name} en ${target.name} hebben gelijk — niemand eruit`);
        }
      }
      break;
    }
    case 'god': {
      // wissel resterende kaart met target
      if (target && target.hand?.[0] && actor.hand?.[0]) {
        const tmp = actor.hand[0];
        actor.hand[0] = target.hand[0];
        target.hand[0] = tmp;
        log(room, `${actor.name} wisselt kaart met ${target.name}`);
      }
      break;
    }
    case 'emir': {
      // target (of actor) legt z'n kaart af en pakt nieuwe
      const t = target || actor;
      if (t && t.hand?.[0]) {
        const dumped = t.hand.splice(0, 1)[0];
        room.discard.push(dumped);
        log(room, `${t.name} legt ${dumped.name} af en krijgt een nieuwe kaart`);
        if (dumped.key === 'prinses') {
          // gedwongen prinses afleggen = direct eruit
          eliminate(room, t.id, 'Prinses gedwongen afgelegd (Emir)');
        } else if (t.alive !== false) {
          const nc = room.deck.pop();
          if (nc) t.hand.push(nc);
        }
      }
      break;
    }
    case 'heks': {
      // zelf geen effect — de dwangregel wordt in validatePlay en bij trekken afgedwongen
      log(room, `${actor.name} speelt Heks`);
      break;
    }
    default:
      log(room, `${actor.name} speelt ${played.name}`);
  }
}

/* ========================= Bots ========================= */

function botName(i) { return ['Bot A', 'Bot B', 'Bot C', 'Bot D'][i] || `Bot ${i + 1}`; }

function pickBotTarget(room, actor) {
  const candidates = livingPlayers(room).filter(p => p.id !== actor.id && !p.protected);
  return candidates[0] || null;
}

function botStep(room) {
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot || actor.alive === false) return;

  // trek indien nodig
  if ((actor.hand?.length ?? 0) === 1 && room.deck.length) {
    actor.hand.push(room.deck.pop());
    log(room, `${actor.name} trekt een kaart (bot)`);
    // Heks + Prinses check direct na trekken
    if (forcePrincessIfWitch(room, actor)) {
      if (endRoundIfNeeded(room)) { broadcastState(room); return; }
      ensureOrder(room);
      nextTurn(room);
      broadcastState(room);
      return botStep(room);
    }
  }

  if ((actor.hand?.length ?? 0) < 2) { // geen speelbare situatie
    nextTurn(room); broadcastState(room); return botStep(room);
  }

  // simpele AI: speel kaart met de "laagste rank" tenzij Heks-regel afdwingt
  let idx = actor.hand.findIndex(c => c.key === 'heks' && actor.hand.some(x => x.key === 'god' || x.key === 'emir'));
  if (idx === -1) {
    idx = actor.hand[0].rank <= actor.hand[1].rank ? 0 : 1;
  }

  const card = actor.hand[idx];
  let target = null;
  let guess = null;

  if (['ziener', 'wolf', 'zeemeermin', 'god'].includes(card.key)) {
    target = pickBotTarget(room, actor);
  } else if (card.key === 'ridder') {
    // 50% zelf beschermen
    if (Math.random() < 0.5) target = actor; else target = pickBotTarget(room, actor) || actor;
  } else if (card.key === 'emir') {
    // 40% op zichzelf
    target = Math.random() < 0.4 ? actor : (pickBotTarget(room, actor) || actor);
  }

  if (card.key === 'ziener') {
    // gok een rank tussen 1..8 (exclusief 1 maakt ’t te sterk; maar jouw regels laten alles toe)
    guess = Math.ceil(Math.random() * 8);
  }

  const err = validatePlay(room, actor, idx, target?.id, guess);
  if (err) {
    // fallback: probeer de andere kaart, anders beurt doorgeven
    const alt = idx === 0 ? 1 : 0;
    const err2 = validatePlay(room, actor, alt, target?.id, guess);
    if (err2) { nextTurn(room); broadcastState(room); return botStep(room); }
    applyPlay(room, actor, alt, target?.id, guess);
  } else {
    applyPlay(room, actor, idx, target?.id, guess);
  }

  if (endRoundIfNeeded(room)) { broadcastState(room); return; }

  ensureOrder(room);
  nextTurn(room);
  broadcastState(room);
  setTimeout(() => botStep(room), 600);
}

/* ========================= Socket.io events ========================= */

io.on('connection', (socket) => {
  socket.on('ping:server', (_p, ack) => ack?.({ ok: true, pong: Date.now() }));

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok: false, error: 'roomId and name required' });
    let room = rooms.get(roomId);
    if (!room) { room = makeRoom(roomId); rooms.set(roomId, room); }
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

    log(room, `${name} heeft de kamer betreden`);
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok: true, roomId, you: { id: socket.id, name } });
  });

  socket.on('host:claim', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok: false, error: 'no room' });
    if (room.hostId && room.hostId !== socket.id) return ack?.({ ok: false, error: 'host already taken' });
    room.hostId = socket.id;
    const me = room.players.get(socket.id); if (me) me.isHost = true;
    log(room, `${me?.name ?? 'Host'} is host geworden`);
    broadcastState(room);
    ack?.({ ok: true });
  });

  socket.on('bots:configure', ({ botsCount = 0, botLevel = 1 }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok: false, error: 'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: 'only host' });
    // verwijder bestaande bots
    for (const [id, p] of [...room.players]) if (p.isBot) room.players.delete(id);
    const n = Math.max(0, Math.min(3, botsCount));
    for (let i = 0; i < n; i++) {
      const id = `bot-${i + 1}-${room.roomId}`;
      room.players.set(id, {
        id,
        name: botName(i),
        isBot: true,
        botLevel: Math.max(1, Math.min(3, botLevel)),
        hand: [],
        alive: true,
        protected: false,
        coins: 0,
      });
    }
    room.settings.botsCount = n;
    room.settings.botLevel = Math.max(1, Math.min(3, botLevel));
    log(room, `Bots geconfigureerd: ${n} (lvl ${room.settings.botLevel})`);
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok: true });
  });

  socket.on('music:toggle', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok: false, error: 'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: 'only host' });
    room.settings.music = !room.settings.music;
    log(room, `Muziek ${room.settings.music ? 'aan' : 'uit'}`);
    broadcastState(room);
    ack?.({ ok: true, music: room.settings.music });
  });

  socket.on('game:new', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok: false, error: 'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: 'only host' });

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
    ack?.({ ok: true });
  });

  socket.on('game:startRound', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok: false, error: 'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: 'only host' });

    const live = livingPlayers(room);
    if (live.length < 2) return ack?.({ ok: false, error: 'min 2 spelers' });

    room.round += 1;
    room.started = true;
    room.deck = buildDeck();
    room.discard = [];

    // reset hands & status en geef iedereen 1 kaart
    for (const p of live) { p.hand = []; p.protected = false; }
    for (const p of live) { const c = room.deck.pop(); if (c) p.hand.push(c); }

    ensureOrder(room);
    log(room, `Ronde ${room.round} gestart`);
    broadcastState(room);
    ack?.({ ok: true });

    // bots mogelijk aan zet
    setTimeout(() => botStep(room), 600);
  });

  socket.on('game:draw', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok: false, error: 'no room' });
    if (room.turn !== socket.id) return ack?.({ ok: false, error: 'not your turn' });
    const me = room.players.get(socket.id); if (!me) return ack?.({ ok: false, error: 'no player' });
    if (!room.started) return ack?.({ ok: false, error: 'round not started' });
    if ((me.hand?.length ?? 0) !== 1) return ack?.({ ok: false, error: 'need 1 card to draw' });

    const card = room.deck.pop(); if (!card) return ack?.({ ok: false, error: 'deck empty' });
    me.hand.push(card);
    log(room, `${me.name} trekt een kaart`);

    // Heks + Prinses direct afhandelen
    if (forcePrincessIfWitch(room, me)) {
      if (!endRoundIfNeeded(room)) {
        ensureOrder(room);
        nextTurn(room);
      }
      broadcastState(room);
      return ack?.({ ok: true, forcedOut: true });
    }

    broadcastState(room);
    ack?.({ ok: true });
  });

  socket.on('game:play', ({ index, targetId, guess }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok: false, error: 'no room' });
    const me = room.players.get(socket.id); if (!me) return ack?.({ ok: false, error: 'no player' });

    const err = validatePlay(room, me, Number(index), targetId, guess);
    if (err) return ack?.({ ok: false, error: err });

    applyPlay(room, me, Number(index), targetId, guess);

    if (!endRoundIfNeeded(room)) {
      ensureOrder(room);
      nextTurn(room);
    }
    broadcastState(room);
    setTimeout(() => botStep(room), 600);
    ack?.({ ok: true });
  });

  // ---- Kick door host ----
  socket.on('admin:kick', ({ playerId }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok: false, error: 'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: 'only host' });

    const p = room.players.get(playerId);
    if (!p) return ack?.({ ok: false, error: 'player not found' });

    room.players.delete(playerId);
    log(room, `${p.name} is gekickt door de host`);
    if (room.turn === playerId) {
      ensureOrder(room);
      nextTurn(room);
    } else {
      ensureOrder(room);
    }
    broadcastState(room);

    try {
      io.to(playerId).emit('kicked', { roomId: room.roomId });
      const sock = io.sockets.sockets.get(playerId);
      if (sock) sock.leave(room.roomId);
    } catch {}

    ack?.({ ok: true });
  });

  // ---- disconnect ----
  socket.on('disconnect', () => {
    const room = roomOf(socket); if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    room.players.delete(socket.id);
    log(room, `${p.name} heeft de kamer verlaten`);

    if (room.hostId === socket.id) room.hostId = null;
    ensureOrder(room);

    if (!room.players.size) {
      rooms.delete(room.roomId);
    } else {
      if (room.turn === socket.id) nextTurn(room);
      broadcastState(room);
    }
  });
});

/* ========================= Start server ========================= */
server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
