// index.js — Mystery Letter server (fixes: dedupe joins, stable host, working kick)
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
  cors: { origin: '*', methods: ['GET','POST'], credentials: true },
});

const PORT = process.env.PORT || 10000;

/* --------------------------- Game model --------------------------- */
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
const NEEDS_TARGET = new Set(['ziener','wolf','zeemeermin','god','emir']);

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
function buildDeck() {
  const deck = [];
  for (const def of CARD_DEFS) for (let i = 0; i < def.count; i++)
    deck.push({ key: def.key, name: def.name, rank: def.rank });
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
  room.order = [...room.players.keys()].filter(id => room.players.get(id)?.alive !== false);
  if (room.order.length && !room.turn) room.turn = room.order[0];
}
function nextTurn(room) {
  if (!room.order.length) { room.turn = null; return; }
  const idx = room.order.indexOf(room.turn);
  const nextId = room.order[(idx + 1) % room.order.length];
  room.turn = nextId;
  const nxt = room.players.get(nextId);
  if (nxt) nxt.protected = false; // bescherming reset aan start eigen beurt
}
function livingPlayers(room) {
  return [...room.players.values()].filter(p => p.alive !== false);
}
function targetsAvailable(room, actorId) {
  return livingPlayers(room).filter(p => p.id !== actorId && !p.protected);
}
function removeFromOrder(room, pid) {
  room.order = room.order.filter(id => id !== pid);
  if (room.turn === pid) nextTurn(room);
}
function endRoundIfNeeded(room) {
  const alive = livingPlayers(room);
  if (alive.length <= 1) {
    const winner = alive[0];
    if (winner) {
      winner.coins = (winner.coins || 0) + 1;
      log(room, `${winner.name} wint de ronde en krijgt een munt (totaal: ${winner.coins})`);
      if (winner.coins >= 3) log(room, `${winner.name} wint het spel met 3 munten!`);
    } else log(room, `Ronde eindigt zonder winnaar`);
    room.started = false;
    room.turn = null;
    broadcastState(room);
    return true;
  }
  return false;
}
function enforceForcedCombos(room, player) {
  if (!player?.hand || player.hand.length < 2) return false;
  const hasHeks = player.hand.some(c => c.key === 'heks');
  const hasPrinses = player.hand.some(c => c.key === 'prinses');
  if (hasHeks && hasPrinses) {
    const idx = player.hand.findIndex(c => c.key === 'prinses');
    const [prin] = player.hand.splice(idx, 1);
    room.discard.push(prin);
    player.alive = false;
    log(room, `${player.name} had Heks + Prinses → Prinses afgelegd en verliest!`);
    removeFromOrder(room, player.id);
    return true;
  }
  return false;
}

/* --------------------------- Acties --------------------------- */
function doZiener(room, actor, target, guess) {
  if (!target) return;
  const tCard = target.hand?.[0];
  if (tCard && tCard.key === guess) {
    target.alive = false;
    room.discard.push(tCard);
    target.hand = [];
    log(room, `${actor.name} raadde juist (${guess}) → ${target.name} ligt eruit`);
    removeFromOrder(room, target.id);
  } else {
    log(room, `${actor.name} raadde fout tegen ${target.name}`);
  }
}
function doWolf(room, actor, target) {
  if (!target) return;
  const tCard = target.hand?.[0] || null;
  io.to(actor.id).emit('private:peek', { targetId: target.id, card: tCard ? tCard.key : null });
  log(room, `${actor.name} kijkt (in stilte) naar de kaart van ${target.name}`);
}
function doRidder(room, actor, target) {
  const who = target || actor;
  who.protected = true;
  log(room, `${actor.name} geeft bescherming aan ${who.name}`);
}
function doZeemeermin(room, actor, target) {
  if (!target) return;
  const aCard = actor.hand?.[0];
  const tCard = target.hand?.[0];
  if (!aCard || !tCard) return;
  const loser = aCard.rank > tCard.rank ? target : actor;
  const winner = loser === actor ? target : actor;
  loser.alive = false;
  if (loser.hand?.length) {
    room.discard.push(loser.hand[0]);
    loser.hand = [];
  }
  log(room, `${winner.name} wint de vergelijking, ${loser.name} ligt eruit`);
  removeFromOrder(room, loser.id);
}
function doGod(room, actor, target) {
  if (!target) return;
  const a = actor.hand?.[0] ?? null;
  const b = target.hand?.[0] ?? null;
  actor.hand = b ? [b] : [];
  target.hand = a ? [a] : [];
  log(room, `${actor.name} wisselt kaart met ${target.name}`);
}
function doEmir(room, actor, target) {
  const who = target || actor;
  if (!room.deck.length || !who.hand?.length) {
    log(room, `${actor.name} speelde Emir maar er was geen vervanging mogelijk`);
    return;
  }
  const old = who.hand[0];
  const fresh = room.deck.pop();
  who.hand = [fresh];
  room.discard.push(old);
  log(room, `${actor.name} geeft ${who === actor ? 'zichzelf' : who.name} een nieuwe kaart (oude afgelegd)`);
}
function playCard(room, player, cardIdx, targetId, guess) {
  if (!player.hand?.length || cardIdx == null || cardIdx < 0 || cardIdx >= player.hand.length)
    return { ok: false, error: 'ongeldige kaart' };

  const card = player.hand.splice(cardIdx, 1)[0];
  room.discard.push(card);
  const target = targetId ? room.players.get(targetId) : null;

  if (card.key === 'prinses') {
    player.alive = false;
    log(room, `${player.name} legt de Prinses af en ligt eruit`);
    removeFromOrder(room, player.id);
  } else if (card.key === 'heks') {
    log(room, `${player.name} legt Heks af`);
  } else if (card.key === 'ziener') {
    if (target && guess) doZiener(room, player, target, guess);
    else log(room, `${player.name} legt Ziener af (geen doelwit/guess)`);
  } else if (card.key === 'wolf') {
    if (target) doWolf(room, player, target);
    else log(room, `${player.name} legt Wolf af (geen doelwit)`);
  } else if (card.key === 'ridder') {
    doRidder(room, player, target);
  } else if (card.key === 'zeemeermin') {
    if (target) doZeemeermin(room, player, target);
    else log(room, `${player.name} legt Zeemeermin af (geen doelwit)`);
  } else if (card.key === 'god') {
    if (target) doGod(room, player, target);
    else log(room, `${player.name} legt God af (geen doelwit)`);
  } else if (card.key === 'emir') {
    doEmir(room, player, target || player);
  }

  if (endRoundIfNeeded(room)) return { ok: true };
  nextTurn(room);
  broadcastState(room);
  maybeBotTurn(room);
  return { ok: true };
}

/* --------------------------- Socket.io --------------------------- */
function botName(i){ return ['Bot A','Bot B','Bot C','Bot D'][i] || `Bot ${i+1}`; }

io.on('connection', (socket) => {
  socket.on('ping:server', (_p, ack) => ack?.({ ok: true, pong: Date.now() }));

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok:false, error:'roomId and name required' });

    let room = rooms.get(roomId);
    if (!room) { room = makeRoom(roomId); rooms.set(roomId, room); }

    socket.join(roomId);

    // ---- DEDUPE: verwijder oude entries (zelfde socket.id of zelfde naam, geen bot)
    room.players.delete(socket.id);
    for (const [id, p] of [...room.players]) {
      if (!p.isBot && p.name === name) room.players.delete(id);
    }

    // voeg (nieuwe) speler toe
    const player = { id: socket.id, name, isHost:false, isBot:false, hand:[], alive:true, protected:false, coins:0 };
    room.players.set(socket.id, player);

    log(room, `${name} heeft de kamer betreden`);
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok:true, roomId, you:{ id: socket.id, name } });
  });

  socket.on('host:claim', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });

    // als er al een host is (en het is niet jij): weigeren
    if (room.hostId && room.hostId !== socket.id)
      return ack?.({ ok:false, error:'host already taken' });

    // markeer (zorg dat player bestaat; bij extreme timing)
    if (!room.players.has(socket.id)) {
      room.players.set(socket.id, { id: socket.id, name: 'Host', isHost:true, isBot:false, hand:[], alive:true, protected:false, coins:0 });
    } else {
      room.players.get(socket.id).isHost = true;
    }
    room.hostId = socket.id;

    ensureOrder(room);
    log(room, `${room.players.get(socket.id)?.name ?? 'Host'} is host geworden`);
    broadcastState(room);
    ack?.({ ok:true });
  });

  socket.on('admin:kick', ({ targetId }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    if (!targetId || !room.players.has(targetId)) return ack?.({ ok:false, error:'unknown player' });
    if (targetId === room.hostId) return ack?.({ ok:false, error:'cannot kick host' });

    const kicked = room.players.get(targetId);
    room.players.delete(targetId);
    removeFromOrder(room, targetId);
    log(room, `${kicked.name} werd gekickt door de host`);
    broadcastState(room);
    io.to(targetId).emit('kicked', { roomId: room.roomId });
    try { io.sockets.sockets.get(targetId)?.leave(room.roomId); } catch {}
    ack?.({ ok:true });
  });

  socket.on('bots:configure', ({ botsCount=0, botLevel=1 }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });

    for (const [id,p] of [...room.players]) if (p.isBot) room.players.delete(id);

    const n = Math.max(0, Math.min(3, botsCount));
    for (let i=0;i<n;i++){
      const id = `bot-${i+1}-${room.roomId}`;
      room.players.set(id, {
        id, name: botName(i), isBot:true, botLevel: Math.max(1,Math.min(3,botLevel)),
        hand:[], alive:true, protected:false, coins:0
      });
    }
    room.settings.botsCount = n;
    room.settings.botLevel  = Math.max(1, Math.min(3, botLevel));
    log(room, `Bots geconfigureerd: ${n} (lvl ${room.settings.botLevel})`);
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

    room.started=false; room.round=0; room.turn=null; room.deck=[]; room.discard=[];
    for (const p of room.players.values()) { p.hand=[]; p.alive=true; p.protected=false; }
    log(room, 'Nieuw spel klaarzetten');
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok:true });
  });

  socket.on('game:startRound', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });

    const living = livingPlayers(room);
    if (living.length < 2) return ack?.({ ok:false, error:'min 2 spelers' });

    room.round += 1;
    room.started = true;
    room.deck = buildDeck();
    room.discard = [];
    for (const p of living) { p.hand=[]; p.protected=false; }
    for (const p of living) { const c = room.deck.pop(); if (c) p.hand.push(c); }
    ensureOrder(room);
    const turnP = room.players.get(room.turn);
    if (turnP) turnP.protected = false;

    log(room, `Ronde ${room.round} gestart`);
    broadcastState(room);
    ack?.({ ok:true });
    maybeBotTurn(room);
  });

  socket.on('game:draw', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (!room.started) return ack?.({ ok:false, error:'round not started' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });

    const me = room.players.get(socket.id);
    if (!me) return ack?.({ ok:false, error:'no player' });
    if ((me.hand?.length ?? 0) !== 1) return ack?.({ ok:false, error:'need 1 card to draw' });
    if (!room.deck.length) return ack?.({ ok:false, error:'deck empty' });

    const card = room.deck.pop();
    me.hand.push(card);
    log(room, `${me.name} trekt een kaart`);

    const knocked = enforceForcedCombos(room, me);
    broadcastState(room);

    if (knocked) {
      if (endRoundIfNeeded(room)) return ack?.({ ok:true });
      nextTurn(room); broadcastState(room); maybeBotTurn(room);
      return ack?.({ ok:true });
    }
    ack?.({ ok:true, handSize: me.hand.length });
  });

  socket.on('game:play', ({ cardIdx, targetId, guess }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (!room.started) return ack?.({ ok:false, error:'round not started' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });

    const me = room.players.get(socket.id);
    if (!me) return ack?.({ ok:false, error:'no player' });

    // target-check: alleen echt verplicht als er DOELWITTEN beschikbaar zijn
    const needsTarget = (() => {
      if (cardIdx == null || !me.hand || !me.hand[cardIdx]) return false;
      return NEEDS_TARGET.has(me.hand[cardIdx].key);
    })();
    if (needsTarget) {
      const avail = targetsAvailable(room, me.id);
      if (avail.length > 0 && !targetId) return ack?.({ ok:false, error:'target required' });
      if (targetId) {
        const t = room.players.get(targetId);
        if (!t || t.alive === false || t.protected) return ack?.({ ok:false, error:'invalid target' });
      }
    }

    const res = playCard(room, me, cardIdx, targetId || null, guess);
    ack?.(res);
  });

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

/* --------------------------- Bots --------------------------- */
function maybeBotTurn(room) {
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot || !room.started) return;

  setTimeout(() => {
    if ((actor.hand?.length ?? 0) === 1 && room.deck.length) {
      actor.hand.push(room.deck.pop());
      log(room, `${actor.name} trekt een kaart (bot)`);
      const knocked = enforceForcedCombos(room, actor);
      broadcastState(room);
      if (knocked) {
        if (endRoundIfNeeded(room)) return;
        nextTurn(room); broadcastState(room);
        return maybeBotTurn(room);
      }
    }
    if (!actor.hand?.length) { nextTurn(room); broadcastState(room); return maybeBotTurn(room); }

    let idx = 0;
    if (actor.hand.length === 2) {
      const [a,b] = actor.hand;
      idx = (a.rank <= b.rank) ? 0 : 1;
      if (actor.hand[idx].key === 'prinses') idx = 1 - idx;
    }
    const card = actor.hand[idx];

    let targetId = null;
    if (NEEDS_TARGET.has(card.key)) {
      const avail = targetsAvailable(room, actor.id);
      if (avail.length > 0) {
        const pick = avail[Math.floor(Math.random()*avail.length)];
        targetId = pick.id;
      }
    }
    let guess = null;
    if (card.key === 'ziener') {
      const pool = CARD_DEFS.map(c => c.key);
      guess = pool[Math.floor(Math.random()*pool.length)];
    }
    playCard(room, actor, idx, targetId, guess);
  }, 700);
}

/* ---------------------------------------------------------------- */
server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
