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
    origin: '*',             // of beperk tot jouw Netlify domein
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 10000;

/* ------------------------------ Game data ------------------------------ */

const CARD_DEFS = [
  { key: 'ziener',     name: 'Ziener',     rank: 1, count: 5 }, // raad kaart van ander; juist = ander verliest
  { key: 'wolf',       name: 'Wolf',       rank: 2, count: 2 }, // kijk stiekem naar kaart van ander
  { key: 'ridder',     name: 'Ridder',     rank: 3, count: 2 }, // protect self of ander (1 beurt)
  { key: 'zeemeermin', name: 'Zeemeermin', rank: 4, count: 2 }, // vergelijk hand; laagste verliest
  { key: 'god',        name: 'God',        rank: 5, count: 1 }, // swap kaart met ander
  { key: 'emir',       name: 'Emir',       rank: 6, count: 1 }, // target (of self) krijgt 1 extra kaart
  { key: 'heks',       name: 'Heks',       rank: 7, count: 2 }, // passief: samen met Prinses => Prinses verplicht afleggen = verlies
  { key: 'prinses',    name: 'Prinses',    rank: 8, count: 1 }, // niet vrijwillig afleggen; afleggen = verlies
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
    players: new Map(), // id -> player
    winnerOfGame: null,
  };
}

function makePlayer(id, name, isBot = false, botLevel = 1) {
  return {
    id, name,
    isHost: false,
    isBot,
    botLevel,
    hand: [],
    alive: true,
    protected: false,
    coins: 0,
  };
}

const rooms = new Map();

/* ------------------------------ Helpers ------------------------------ */

function log(room, msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  room.logs.unshift(line);
  if (room.logs.length > 50) room.logs.length = 50;
}

function roomOf(socket) {
  const ids = [...socket.rooms].filter(r => r !== socket.id);
  return rooms.get(ids[0]);
}

function alivePlayers(room) {
  return [...room.players.values()].filter(p => p.alive);
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    isHost: !!p.isHost,
    isBot: !!p.isBot,
    alive: p.alive,
    protected: p.protected,
    coins: p.coins,
  }));
}

function broadcastState(room) {
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
  // Stuur ieders hand individueel
  for (const [id, p] of room.players) {
    if (p.isBot) continue;
    io.to(id).emit('player:hand', { hand: p.hand });
  }
}

function ensureOrder(room) {
  room.order = [...room.players.keys()].filter(id => room.players.get(id).alive);
  if (room.order.length && !room.turn) room.turn = room.order[0];
}

function nextTurn(room) {
  if (!room.order.length) { room.turn = null; return; }
  const idx = room.order.indexOf(room.turn);
  room.turn = room.order[(idx + 1) % room.order.length];
  // bij start van beurt: bescherming van speler vervalt
  const cur = room.players.get(room.turn);
  if (cur) cur.protected = false;
}

function eliminate(room, player, reason = '') {
  player.alive = false;
  if (player.hand.length) {
    room.discard.push(...player.hand);
    player.hand = [];
  }
  log(room, `${player.name} ligt uit${reason ? ` (${reason})` : ''}`);
  ensureOrder(room);
}

function checkRoundEnd(room) {
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    const winner = alive[0];
    room.started = false;
    room.turn = null;
    if (winner) {
      winner.coins = (winner.coins || 0) + 1;
      log(room, `${winner.name} wint de ronde en krijgt 1 munt (totaal ${winner.coins})`);
      if (winner.coins >= 3) {
        room.winnerOfGame = winner.id;
        log(room, `${winner.name} wint het spel met 3 munten!`);
      }
    } else {
      log(room, `Ronde eindigt zonder winnaar.`);
    }
    broadcastState(room);
    return true;
  }
  return false;
}

function heksPrincessForced(room, player) {
  const keys = player.hand.map(c => c.key);
  if (keys.includes('heks') && keys.includes('prinses')) {
    // Prinsses MOET af (en afleggen = verlies)
    const idx = player.hand.findIndex(c => c.key === 'prinses');
    if (idx >= 0) {
      room.discard.push(player.hand.splice(idx, 1)[0]);
    }
    eliminate(room, player, 'moest de Prinses afleggen (Heks-regel)');
    broadcastState(room);
    return true;
  }
  return false;
}

function requireTurn(socket, room) {
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
  socket.on('ping:server', (_p, ack) => ack?.({ ok: true, pong: Date.now() }));

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok:false, error:'roomId and name required' });

    let room = rooms.get(roomId);
    if (!room) {
      room = makeRoom(roomId);
      rooms.set(roomId, room);
    }
    socket.join(roomId);
    const player = makePlayer(socket.id, name);
    room.players.set(socket.id, player);
    ensureOrder(room);
    log(room, `${name} heeft de kamer betreden`);
    broadcastState(room);
    ack?.({ ok:true, roomId, you:{ id: socket.id, name } });
  });

  socket.on('host:claim', (_p, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (room.hostId && room.hostId !== socket.id) return ack?.({ ok:false, error:'host already taken' });
    room.hostId = socket.id;
    const me = room.players.get(socket.id);
    if (me) me.isHost = true;
    log(room, `${me?.name ?? 'Host'} is host geworden`);
    broadcastState(room);
    ack?.({ ok:true });
  });

  socket.on('bots:configure', ({ botsCount=0, botLevel=1 }, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });

    // verwijder oude bots
    for (const [id, p] of [...room.players]) {
      if (p.isBot) room.players.delete(id);
    }
    // voeg nieuwe toe (max 3)
    const n = Math.max(0, Math.min(3, botsCount|0));
    const lvl = Math.max(1, Math.min(3, botLevel|0));
    for (let i=0; i<n; i++) {
      const id = `bot-${i+1}`;
      room.players.set(id, makePlayer(id, botName(i), true, lvl));
    }
    room.settings.botsCount = n;
    room.settings.botLevel = lvl;
    log(room, `Bots geconfigureerd: ${n} (niveau ${lvl})`);
    ensureOrder(room);
    broadcastState(room);
    ack?.({ ok:true });
  });

  socket.on('music:toggle', (_p, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    room.settings.music = !room.settings.music;
    log(room, `Muziek ${room.settings.music ? 'aan' : 'uit'}`);
    broadcastState(room);
    ack?.({ ok:true, music: room.settings.music });
  });

  socket.on('game:new', (_p, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });

    room.started = false;
    room.round = 0;
    room.turn = null;
    room.deck = [];
    room.discard = [];
    room.winnerOfGame = null;
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

  socket.on('game:startRound', (_p, ack) => {
    const room = roomOf(socket);
    if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });

    const living = alivePlayers(room);
    if (living.length < 2) return ack?.({ ok:false, error:'min 2 spelers' });

    room.round += 1;
    room.started = true;
    room.deck = buildDeck();
    room.discard = [];
    room.turn = null;
    for (const p of living) { p.hand = []; p.protected = false; }

    // deel 1 kaart
    for (const p of living) {
      const c = room.deck.pop();
      if (c) p.hand.push(c);
    }
    ensureOrder(room);
    log(room, `Ronde ${room.round} gestart`);
    broadcastState(room);

    // check heks+prinses direct na uitdelen
    for (const p of living) {
      if (!p.alive) continue;
      if (heksPrincessForced(room, p)) {
        if (checkRoundEnd(room)) return ack?.({ ok:true });
      }
    }

    ack?.({ ok:true });

    maybeBotTurn(room);
  });

  socket.on('game:draw', (_p, ack) => {
    const room = roomOf(socket);
    const err = requireTurn(socket, room);
    if (err) return ack?.({ ok:false, error: err });

    const me = room.players.get(socket.id);
    if ((me.hand?.length ?? 0) !== 1) return ack?.({ ok:false, error:'need 1 card to draw' });
    const card = room.deck.pop();
    if (!card) return ack?.({ ok:false, error:'deck empty' });

    me.hand.push(card);
    log(room, `${me.name} trekt een kaart`);
    broadcastState(room);

    // dwing heks+prinses
    if (heksPrincessForced(room, me)) {
      if (checkRoundEnd(room)) return ack?.({ ok:true });
      // als huidige speler eruit is: beurt gaat door
      nextTurn(room);
      broadcastState(room);
      maybeBotTurn(room);
      return ack?.({ ok:true });
    }

    ack?.({ ok:true, handSize: me.hand.length });
  });

  socket.on('game:play', (payload, ack) => {
    const room = roomOf(socket);
    const err = requireTurn(socket, room);
    if (err) return ack?.({ ok:false, error: err });

    const me = room.players.get(socket.id);
    const { index, targetId = null, guessKey = null } = payload || {};

    if (!Array.isArray(me.hand) || me.hand.length < 1) {
      return ack?.({ ok:false, error:'empty hand' });
    }
    if (index !== 0 && index !== 1) {
      return ack?.({ ok:false, error:'invalid index' });
    }
    const played = me.hand[index];
    if (!played) return ack?.({ ok:false, error:'card not in hand' });

    // Princess mag niet vrijwillig
    if (played.key === 'prinses') {
      return ack?.({ ok:false, error:'Prinses mag niet vrijwillig afgelegd worden' });
    }

    // target helpers
    const target = targetId ? room.players.get(targetId) : null;
    const needTarget = (k) => ['ziener','wolf','ridder','zeemeermin','god','emir'].includes(k);
    if (needTarget(played.key)) {
      if (!targetId) return ack?.({ ok:false, error:'target required' });
      if (!target || !target.alive) return ack?.({ ok:false, error:'invalid target' });
      if (target.protected && targetId !== me.id && !['ridder'].includes(played.key)) {
        return ack?.({ ok:false, error:'target is protected' });
      }
    }

    // haal kaart uit hand en leg op aflegstapel
    me.hand.splice(index, 1);
    room.discard.push(played);

    // voer effect uit
    let secret = null; // data die enkel naar speler gaat
    try {
      switch (played.key) {
        case 'ziener': {
          if (!guessKey) return ack?.({ ok:false, error:'guess required' });
          if (!target || !target.hand.length) break;
          const th = target.hand[0];
          if (th.key === guessKey) {
            eliminate(room, target, `Ziener had juist geraden (${th.name})`);
          } else {
            log(room, `${me.name} gokt verkeerd met Ziener`);
          }
          break;
        }
        case 'wolf': {
          if (!target || !target.hand.length) break;
          const th = target.hand[0];
          // geheim naar speler
          secret = { peek: { key: th.key, name: th.name, rank: th.rank } };
          log(room, `${me.name} kijkt in het geheim naar ${target.name} zijn kaart (Wolf)`);
          break;
        }
        case 'ridder': {
          // protect self of target
          const tgt = targetId ? target : me;
          tgt.protected = true;
          log(room, `${me.name} geeft bescherming aan ${tgt.name} (Ridder)`);
          break;
        }
        case 'zeemeermin': {
          if (!target || !target.hand.length || !me.hand.length) break;
          const myRank = me.hand[0].rank;
          const tr = target.hand[0].rank;
          if (myRank === tr) {
            log(room, `${me.name} en ${target.name} hebben gelijk met Zeemeermin`);
          } else if (myRank > tr) {
            eliminate(room, target, 'verliest vergelijking (Zeemeermin)');
          } else {
            eliminate(room, me, 'verliest vergelijking (Zeemeermin)');
          }
          break;
        }
        case 'god': {
          if (!target || !target.hand.length || !me.hand.length) break;
          const myCard = me.hand.splice(0,1)[0] || null;
          const theirCard = target.hand.splice(0,1)[0] || null;
          if (theirCard) me.hand.push(theirCard);
          if (myCard) target.hand.push(myCard);
          log(room, `${me.name} wisselt kaart met ${target.name} (God)`);
          // na wissel forcing checken
          if (heksPrincessForced(room, me)) {}
          if (target.alive && heksPrincessForced(room, target)) {}
          break;
        }
        case 'emir': {
          const tgt = targetId ? target : me;
          if (!room.deck.length) {
            log(room, `${me.name} speelt Emir maar de deck is leeg`);
            break;
          }
          const newC = room.deck.pop();
          tgt.hand.push(newC);
          log(room, `${me.name} geeft een kaart aan ${tgt.name} (Emir)`);
          // heks+prinses check
          if (heksPrincessForced(room, tgt)) {}
          break;
        }
        case 'heks': {
          // op zichzelf geen directe actie
          log(room, `${me.name} gooit Heks af`);
          // als andere kaart Prinses is, was dit niet de forcing; forcing geldt bij combinatie in hand,
          // maar hier is Heks al gespeeld.
          break;
        }
        default:
          break;
      }
    } catch (e) {
      console.error('play error', e);
      return ack?.({ ok:false, error:'play failed' });
    }

    // rond einde check
    if (checkRoundEnd(room)) {
      broadcastState(room);
      return ack?.({ ok:true, secret });
    }

    // door naar volgende beurt
    nextTurn(room);
    broadcastState(room);

    // stuur eventuele geheime info naar alleen deze speler
    if (secret) io.to(socket.id).emit('play:secret', secret);

    ack?.({ ok:true, secret });

    // bots?
    maybeBotTurn(room);
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) {
      room.players.delete(socket.id);
      log(room, `${p.name} heeft de kamer verlaten`);
      if (room.hostId === socket.id) room.hostId = null;
      ensureOrder(room);
      if (!room.players.size) {
        rooms.delete(room.roomId);
      } else {
        // als de vertrekkende speler aan beurt was: volgende
        if (room.turn === socket.id) {
          nextTurn(room);
        }
        broadcastState(room);
      }
    }
  });
});

/* ------------------------------ Bot AI ------------------------------ */
function randomAliveOpponent(room, selfId) {
  const opp = alivePlayers(room).filter(p => p.id !== selfId && !p.protected);
  if (!opp.length) return null;
  return opp[Math.floor(Math.random() * opp.length)];
}

function maybeBotTurn(room) {
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot || !room.started) return;

  const delay = 700 + Math.random() * 600;
  setTimeout(() => {
    // als hand == 1 -> trekken
    if ((actor.hand?.length ?? 0) === 1 && room.deck.length) {
      actor.hand.push(room.deck.pop());
      log(room, `${actor.name} trekt een kaart (bot)`);
      if (heksPrincessForced(room, actor)) {
        if (checkRoundEnd(room)) { broadcastState(room); return; }
        nextTurn(room); broadcastState(room); maybeBotTurn(room);
        return;
      }
    }

    // kies kaart & target
    let idx = 0;
    if (actor.hand.length >= 2) idx = Math.round(Math.random()); // random 0/1
    const card = actor.hand[idx];
    const needsTarget = ['ziener','wolf','ridder','zeemeermin','god','emir'].includes(card.key);
    let target = needsTarget ? randomAliveOpponent(room, actor.id) : null;
    if (needsTarget && !target) {
      // geen geldige target -> probeer self bij ridder/emir
      if (card.key === 'ridder' || card.key === 'emir') {
        target = actor;
      } else {
        // kan niet spelen -> sla beurt over (veiligheid)
        nextTurn(room); broadcastState(room); maybeBotTurn(room);
        return;
      }
    }

    // haal kaart uit hand en leg op discard
    actor.hand.splice(idx,1);
    room.discard.push(card);

    switch (card.key) {
      case 'ziener': {
        const guessPool = CARD_DEFS.map(c => c.key);
        const guessKey = guessPool[Math.floor(Math.random()*guessPool.length)];
        if (target && target.hand.length) {
          const th = target.hand[0];
          if (th.key === guessKey) {
            eliminate(room, target, `Ziener (bot) raadde juist`);
          } else {
            log(room, `${actor.name} gokt verkeerd (Ziener)`);
          }
        }
        break;
      }
      case 'wolf': {
        if (target && target.hand.length) {
          log(room, `${actor.name} kijkt stiekem naar ${target.name} (Wolf)`);
        }
        break;
      }
      case 'ridder': {
        const tgt = target || actor;
        tgt.protected = true;
        log(room, `${actor.name} beschermt ${tgt.name} (Ridder)`);
        break;
      }
      case 'zeemeermin': {
        if (target && target.hand.length && actor.hand.length) {
          const myRank = actor.hand[0].rank;
          const tr = target.hand[0].rank;
          if (myRank === tr) {
            log(room, `${actor.name} en ${target.name} gelijk (Zeemeermin)`);
          } else if (myRank > tr) {
            eliminate(room, target, 'verliest vergelijking (Zeemeermin)');
          } else {
            eliminate(room, actor, 'verliest vergelijking (Zeemeermin)');
          }
        }
        break;
      }
      case 'god': {
        if (target && target.hand.length && actor.hand.length) {
          const myCard = actor.hand.splice(0,1)[0] || null;
          const theirCard = target.hand.splice(0,1)[0] || null;
          if (theirCard) actor.hand.push(theirCard);
          if (myCard) target.hand.push(myCard);
          log(room, `${actor.name} wisselt kaart met ${target.name} (God)`);
          heksPrincessForced(room, actor);
          if (target.alive) heksPrincessForced(room, target);
        }
        break;
      }
      case 'emir': {
        const tgt = target || actor;
        if (room.deck.length) {
          const newC = room.deck.pop();
          tgt.hand.push(newC);
          log(room, `${actor.name} geeft een kaart aan ${tgt.name} (Emir)`);
          heksPrincessForced(room, tgt);
        }
        break;
      }
      case 'heks': {
        log(room, `${actor.name} gooit Heks af`);
        break;
      }
      default:
        break;
    }

    if (checkRoundEnd(room)) { broadcastState(room); return; }
    nextTurn(room);
    broadcastState(room);
    maybeBotTurn(room);
  }, delay);
}

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
