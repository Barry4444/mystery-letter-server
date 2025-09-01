// index.js (SERVER)
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.get('/', (_req, res) => res.send('mystery-letter-server OK'));

const server = http.createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET','POST'], credentials: true },
});

const PORT = process.env.PORT || 10000;

/* ----------------------- State helpers ----------------------- */
const rooms = new Map();

function makeRoom(roomId) {
  return {
    roomId,
    hostId: null,
    players: new Map(),   // id -> { id,name,isHost,isBot,hand:[{key,name,rank}],alive,protected,coins }
    order: [],
    started: false,
    round: 0,
    turn: null,           // socketId van speler aan beurt
    deck: [],
    discard: [],
    settings: { music: false, botsCount: 0, botLevel: 1 },
    logs: [],
    winner: null          // socketId bij spel-winst (3 munten)
  };
}
function log(room, msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  room.logs.unshift(line);
  room.logs = room.logs.slice(0, 50);
}
function roomOf(socket) {
  const ids = [...socket.rooms].filter(r => r !== socket.id);
  if (!ids[0]) return null;
  return rooms.get(ids[0]) || null;
}
function getRoom(socket, payload) {
  // fallback: laat client roomId meesturen
  if (payload?.roomId && rooms.has(payload.roomId)) return rooms.get(payload.roomId);
  return roomOf(socket);
}
function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, isHost: !!p.isHost, isBot: !!p.isBot,
    alive: p.alive !== false, protected: !!p.protected, coins: p.coins || 0
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
    deckCount: room.deck.length
  });
  for (const [id, p] of room.players) {
    if (p.isBot) continue; // bots hebben geen client
    io.to(id).emit('player:hand', { hand: p.hand || [] });
  }
}
function ensureOrder(room) {
  room.order = [...room.players.keys()].filter(id => room.players.get(id).alive !== false);
  if (!room.turn && room.order.length) room.turn = room.order[0];
}
function nextTurn(room) {
  if (!room.order.length) { room.turn = null; return; }
  const idx = room.order.indexOf(room.turn);
  const nextIdx = (idx === -1 ? 0 : (idx + 1) % room.order.length);
  room.turn = room.order[nextIdx];
  // bescherming duurt 1 beurt → reset bescherming op het begin van iemands beurt
  const p = room.players.get(room.turn);
  if (p) p.protected = false;
}
function eliminate(room, playerId, reason = 'uitgeschakeld') {
  const p = room.players.get(playerId);
  if (!p || p.alive === false) return;
  p.alive = false;
  p.hand = [];
  log(room, `${p.name} is ${reason}`);
  // verwijder uit volgorde
  room.order = room.order.filter(id => id !== playerId);
  if (room.turn === playerId) nextTurn(room);
}
function awardAndMaybeFinishGame(room) {
  const living = [...room.players.values()].filter(p => p.alive !== false);
  if (living.length === 1) {
    const winner = living[0];
    winner.coins = (winner.coins || 0) + 1;
    log(room, `${winner.name} wint de ronde en krijgt een muntje (${winner.coins}/3)`);
    room.started = false;
    room.turn = null;
    room.deck = [];
    room.discard = [];
    room.round = room.round; // blijft staan voor log
    broadcastState(room);
    if (winner.coins >= 3) {
      room.winner = winner.id;
      log(room, `${winner.name} wint het spel met 3 munten!`);
      io.to(room.roomId).emit('game:over', { winnerId: winner.id, name: winner.name });
    }
    return true;
  }
  return false;
}

/* ----------------------- Kaarten / Deck ----------------------- */
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
    for (let i = 0; i < def.count; i++) deck.push({ key: def.key, name: def.name, rank: def.rank });
  }
  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function findCardDef(key){ return CARD_DEFS.find(c => c.key === key); }

/* ----------------------- Bot helpers ----------------------- */
function botName(i){ return ['Bot A','Bot B','Bot C','Bot D'][i] || `Bot ${i+1}`; }
function randomAliveOpponent(room, exceptId) {
  const opts = [...room.players.values()].filter(p => p.alive !== false && p.id !== exceptId);
  if (!opts.length) return null;
  return opts[Math.floor(Math.random() * opts.length)];
}

/* ----------------------- Kaart-effecten ----------------------- */
function applyCardEffect(room, actorId, played, { targetId=null, guess=null } = {}) {
  const actor = room.players.get(actorId);
  if (!actor) return;

  const target = targetId ? room.players.get(targetId) : null;

  switch (played.key) {
    case 'ziener': {
      if (!target || target.alive === false) break;
      const targetHand = target.hand?.[0];
      if (!targetHand) break;
      if (guess && guess === targetHand.key && !target.protected) {
        log(room, `${actor.name} raadt juist dat ${target.name} ${findCardDef(guess).name} heeft — ${target.name} ligt uit!`);
        eliminate(room, target.id, 'uit door Ziener');
      } else {
        log(room, `${actor.name} gokt met Ziener op ${target?.name} (${guess ?? 'geen gok'}) → mis`);
      }
      break;
    }
    case 'wolf': {
      if (!target || target.alive === false) break;
      const card = target.hand?.[0];
      if (!card) break;
      // Alleen actor krijgt de inhoud (client kan privé-popup tonen)
      io.to(actor.id).emit('info:peek', { targetId: target.id, card });
      log(room, `${actor.name} heeft de kaart van ${target.name} bekeken (Wolf)`);
      break;
    }
    case 'ridder': {
      if (target && target.alive !== false) {
        target.protected = true;
        log(room, `${actor.name} geeft bescherming aan ${target.name} (Ridder)`);
      } else {
        actor.protected = true;
        log(room, `${actor.name} krijgt bescherming (Ridder)`);
      }
      break;
    }
    case 'zeemeermin': {
      if (!target || target.alive === false) break;
      const a = actor.hand?.[0];    // na spelen van deze kaart blijft er 1 over
      const b = target.hand?.[0];
      if (!a || !b) break;
      if (a.rank === b.rank) {
        log(room, `${actor.name} en ${target.name} zijn gelijk (Zeemeermin)`);
      } else if (a.rank > b.rank) {
        if (!target.protected) {
          eliminate(room, target.id, 'verliest door Zeemeermin');
          log(room, `${actor.name} wint de vergelijking — ${target.name} ligt uit`);
        } else {
          log(room, `${target.name} was beschermd — niemand ligt uit (Zeemeermin)`);
        }
      } else {
        if (!actor.protected) {
          eliminate(room, actor.id, 'verliest door Zeemeermin');
          log(room, `${target.name} wint de vergelijking — ${actor.name} ligt uit`);
        } else {
          log(room, `${actor.name} is beschermd — niemand ligt uit (Zeemeermin)`);
        }
      }
      break;
    }
    case 'god': {
      if (!target || target.alive === false) break;
      // wissel overgebleven kaart
      const my = actor.hand?.[0];
      const his = target.hand?.[0];
      if (my && his && !target.protected) {
        actor.hand[0] = his;
        target.hand[0] = my;
        log(room, `${actor.name} wisselt kaart met ${target.name} (God)`);
      } else {
        log(room, `${actor.name} probeert te wisselen, maar het lukte niet (bescherming of geen kaart)`);
      }
      break;
    }
    case 'emir': {
      // “Jij of target discardeert zijn hand en trekt 1 nieuwe”
      const who = (target && target.alive !== false) ? target : actor;
      const old = who.hand?.[0];
      if (old) {
        // Prinses afleggen → direct uit
        if (old.key === 'prinses') {
          eliminate(room, who.id, 'moest Prinses afleggen (Emir)');
        } else {
          room.discard.push(who.hand.splice(0,1)[0]);
          const c = room.deck.pop();
          if (c) who.hand.push(c);
          log(room, `${who.name} moet afleggen en trekt een nieuwe kaart (Emir)`);
        }
      }
      break;
    }
    case 'heks': {
      // Heks zelf heeft geen effect — regels worden elders afgedwongen bij draw/choose
      log(room, `${actor.name} legt Heks af`);
      break;
    }
    case 'prinses': {
      // Mag niet gespeeld worden (wordt in validatie voorkomen). Als ze toch in discard komt → verlies.
      eliminate(room, actor.id, 'heeft de Prinses afgelegd');
      log(room, `${actor.name} legt de Prinses af en verliest`);
      break;
    }
    default: break;
  }
}

/* ----------------------- Verplichte afleg-regels ----------------------- */
// Check combinaties en dwing af welke kaart moet worden afgelegd. Returned {forcedKey|null, loseNow:boolean}
function forcedDiscardRule(hand) {
  if (!hand || hand.length !== 2) return { forcedKey: null, loseNow: false };
  const a = hand[0].key, b = hand[1].key;
  const has = k => (a === k || b === k);

  // (A) Als je Heks + (God of Emir) hebt → Heks MOET worden afgelegd (zoals Countess-regel)
  if (has('heks') && (has('god') || has('emir'))) {
    return { forcedKey: 'heks', loseNow: false };
  }
  // (B) Als je Heks + Prinses hebt → Prinses MOET worden afgelegd en je verliest
  if (has('heks') && has('prinses')) {
    return { forcedKey: 'prinses', loseNow: true };
  }
  return { forcedKey: null, loseNow: false };
}

/* ----------------------- Socket events ----------------------- */
io.on('connection', (socket) => {
  socket.on('ping:server', (_p, ack) => ack?.({ ok: true, pong: Date.now() }));

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok:false, error:'roomId and name required' });
    let room = rooms.get(roomId);
    if (!room) { room = makeRoom(roomId); rooms.set(roomId, room); }
    socket.join(roomId);
    room.players.set(socket.id, {
      id: socket.id, name, isHost:false, isBot:false,
      hand:[], alive:true, protected:false, coins: (room.players.get(socket.id)?.coins || 0)
    });
    log(room, `${name} heeft de kamer betreden`);
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok:true, roomId, you:{ id: socket.id, name } });
  });

  socket.on('host:claim', (p, ack) => {
    const room = getRoom(socket, p);
    if (!room) return ack?.({ ok:false, error:'no room' });
    // host vrij of oude host niet meer aanwezig
    if (room.hostId && room.players.has(room.hostId)) {
      if (room.hostId !== socket.id) return ack?.({ ok:false, error:'host already taken' });
    }
    room.hostId = socket.id;
    const me = room.players.get(socket.id); if (me) me.isHost = true;
    log(room, `${me?.name ?? 'Host'} is host geworden`);
    broadcastState(room);
    ack?.({ ok:true });
  });

  socket.on('bots:configure', (p, ack) => {
    const room = getRoom(socket, p);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });

    const botsCount = Math.max(0, Math.min(3, p?.botsCount ?? 0));
    const botLevel  = Math.max(1, Math.min(3, p?.botLevel  ?? 1));

    // verwijder oude bots
    for (const [id, pl] of [...room.players]) if (pl.isBot) room.players.delete(id);
    for (let i=0;i<botsCount;i++) {
      const id = `bot-${i+1}`;
      room.players.set(id, { id, name: botName(i), isBot: true, botLevel, hand:[], alive:true, protected:false, coins:0 });
    }
    room.settings.botsCount = botsCount;
    room.settings.botLevel = botLevel;
    log(room, `Bots geconfigureerd: ${botsCount} (lvl ${botLevel})`);
    ensureOrder(room); broadcastState(room); ack?.({ ok:true });
  });

  socket.on('music:toggle', (p, ack) => {
    const room = getRoom(socket, p);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.settings.music = !room.settings.music;
    log(room, `Muziek ${room.settings.music ? 'aan' : 'uit'}`);
    broadcastState(room); ack?.({ ok:true, music: room.settings.music });
  });

  socket.on('game:new', (p, ack) => {
    const room = getRoom(socket, p);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.started=false; room.turn=null; room.deck=[]; room.discard=[];
    for (const pl of room.players.values()) { pl.hand=[]; pl.alive=true; pl.protected=false; }
    log(room, 'Nieuw spel klaarzetten');
    ensureOrder(room); broadcastState(room); ack?.({ ok:true });
  });

  socket.on('game:startRound', (p, ack) => {
    const room = getRoom(socket, p);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    const living = [...room.players.values()].filter(pl => pl.alive !== false);
    if (living.length < 2) return ack?.({ ok:false, error:'min 2 spelers' });

    room.round += 1; room.started = true; room.deck = buildDeck(); room.discard = [];
    for (const pl of living){ pl.hand=[]; pl.protected=false; }
    // Deel 1 kaart per speler
    for (const pl of living){ const c = room.deck.pop(); if (c) pl.hand.push(c); }
    ensureOrder(room);
    log(room, `Ronde ${room.round} gestart`);
    broadcastState(room);
    ack?.({ ok:true });

    maybeBotTurn(room); // als bot begint
  });

  socket.on('game:draw', (p, ack) => {
    const room = getRoom(socket, p);
    if (!room) return ack?.({ ok:false, error:'no room' });
    const me = room.players.get(socket.id);
    if (!me) return ack?.({ ok:false, error:'no player' });
    if (!room.started) return ack?.({ ok:false, error:'round not started' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });
    if ((me.hand?.length ?? 0) !== 1) return ack?.({ ok:false, error:'need 1 card to draw' });
    const card = room.deck.pop(); if (!card) return ack?.({ ok:false, error:'deck empty' });
    me.hand.push(card);
    log(room, `${me.name} trekt een kaart`);

    // check verplichte afleg
    const rule = forcedDiscardRule(me.hand);
    if (rule.forcedKey) {
      if (rule.loseNow && rule.forcedKey === 'prinses') {
        // meteen verliezen
        log(room, `${me.name} heeft Heks + Prinses → Prinses moet af, verlies!`);
        eliminate(room, me.id, 'verliest (Heks + Prinses)');
        if (!awardAndMaybeFinishGame(room)) { ensureOrder(room); nextTurn(room); }
      } else {
        log(room, `${me.name} moet ${findCardDef(rule.forcedKey).name} afleggen`);
        // forceer meteen spelen zonder effect (Heks) of fout als het Princess was (zou hierboven al afgevangen zijn)
        const idx = me.hand.findIndex(c => c.key === rule.forcedKey);
        if (idx !== -1) {
          const played = me.hand.splice(idx, 1)[0];
          room.discard.push(played);
          if (played.key !== 'heks') applyCardEffect(room, me.id, played, {}); // normaliter heks: geen effect
          // beurt gaat verder: na enforced play, speler houdt 1 kaart over
          nextTurn(room);
        }
      }
    }

    broadcastState(room);
    ack?.({ ok:true, handSize: me.hand.length });

    maybeBotTurn(room);
  });

  socket.on('play:card', (p, ack) => {
    const room = getRoom(socket, p);
    if (!room) return ack?.({ ok:false, error:'no room' });
    const me = room.players.get(socket.id);
    if (!me || !room.started) return ack?.({ ok:false, error:'bad state' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });
    if ((me.hand?.length ?? 0) !== 2) return ack?.({ ok:false, error:'need 2 cards to play' });

    const { cardKey, targetId=null, guess=null } = p || {};
    const rule = forcedDiscardRule(me.hand);
    if (rule.forcedKey && rule.forcedKey !== cardKey) {
      return ack?.({ ok:false, error:`forced to play ${rule.forcedKey}` });
    }
    // Prinses mag niet gekozen worden
    if (cardKey === 'prinses') return ack?.({ ok:false, error:'prinses not playable' });

    const idx = me.hand.findIndex(c => c.key === cardKey);
    if (idx === -1) return ack?.({ ok:false, error:'card not in hand' });

    const played = me.hand.splice(idx, 1)[0];
    room.discard.push(played);
    log(room, `${me.name} speelt ${played.name}`);

    applyCardEffect(room, me.id, played, { targetId, guess });

    // ronde klaar?
    if (!awardAndMaybeFinishGame(room)) {
      // speler houdt 1 kaart over → volgende beurt
      nextTurn(room);
      broadcastState(room);
      ack?.({ ok:true });
      maybeBotTurn(room);
    } else {
      broadcastState(room);
      ack?.({ ok:true, roundEnded:true });
    }
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    room.players.delete(socket.id);
    log(room, `${p.name} heeft de kamer verlaten`);
    if (room.hostId === socket.id) room.hostId = null;
    ensureOrder(room);
    if (!room.players.size) rooms.delete(room.roomId);
    else broadcastState(room);
  });
});

/* ----------------------- Bot-automaat ----------------------- */
function maybeBotTurn(room) {
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot || !room.started) return;

  // Simpele AI
  setTimeout(() => {
    // Bot trekt indien nodig
    if ((actor.hand?.length ?? 0) === 1 && room.deck.length) {
      actor.hand.push(room.deck.pop());
      log(room, `${actor.name} trekt een kaart (bot)`);
      const rule = forcedDiscardRule(actor.hand);
      if (rule.forcedKey === 'prinses') {
        log(room, `${actor.name} heeft Heks + Prinses → prinses af → verlies!`);
        eliminate(room, actor.id, 'verliest (Heks + Prinses)');
        if (!awardAndMaybeFinishGame(room)) { ensureOrder(room); nextTurn(room); }
        broadcastState(room);
        maybeBotTurn(room);
        return;
      }
      if (rule.forcedKey === 'heks') {
        const idx = actor.hand.findIndex(c => c.key === 'heks');
        if (idx !== -1) {
          const played = actor.hand.splice(idx, 1)[0];
          room.discard.push(played);
          log(room, `${actor.name} moet Heks afleggen (bot)`);
        }
      }
    }

    // Kies kaart
    if ((actor.hand?.length ?? 0) < 1) { nextTurn(room); broadcastState(room); return; }
    if ((actor.hand?.length ?? 0) === 1) { nextTurn(room); broadcastState(room); maybeBotTurn(room); return; }

    // voorkeursvolgorde om te spelen
    const prefer = ['ziener','zeemeermin','ridder','god','emir','wolf','heks']; // prinses nooit
    let toPlay = actor.hand.find(c => prefer.includes(c.key)) || actor.hand[0];
    if (toPlay.key === 'prinses') toPlay = actor.hand.find(c => c.key !== 'prinses') || actor.hand[0];

    // target & guess
    const tgt = randomAliveOpponent(room, actor.id);
    const payload = {};
    if (['ziener','wolf','zeemeermin','god','emir','ridder'].includes(toPlay.key)) {
      if (toPlay.key !== 'ridder') payload.targetId = tgt?.id ?? null;
      else if (Math.random() < 0.5 && tgt) payload.targetId = tgt.id; // ridder soms op ander
    }
    if (toPlay.key === 'ziener') {
      const guessPool = ['ziener','wolf','ridder','zeemeermin','god','emir','heks','prinses'];
      payload.guess = guessPool[Math.floor(Math.random()*guessPool.length)];
    }

    // speel
    const idx = actor.hand.findIndex(c => c.key === toPlay.key);
    const played = actor.hand.splice(idx,1)[0];
    room.discard.push(played);
    log(room, `${actor.name} speelt ${played.name} (bot)`);

    applyCardEffect(room, actor.id, played, payload);

    if (!awardAndMaybeFinishGame(room)) {
      nextTurn(room);
      broadcastState(room);
      maybeBotTurn(room);
    } else {
      broadcastState(room);
    }
  }, 700);
}

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
