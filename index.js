// index.js (SERVER) — complete drop-in
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
    origin: '*', // eventueel beperken tot je Netlify domein
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 10000;

// -------------------- state helpers --------------------
const rooms = new Map();

function makeRoom(roomId) {
  return {
    roomId,
    hostId: null,
    players: new Map(),         // id -> {id,name,isHost,isBot,hand:[{key,name,rank}],alive,protected,coins,botLevel}
    order: [],                  // speelvolgorde (levenden)
    started: false,
    round: 0,
    turn: null,                 // socketId van wie aan beurt is
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
const CARD_BY_KEY = Object.fromEntries(CARD_DEFS.map(c => [c.key, c]));

function buildDeck() {
  const deck = [];
  for (const def of CARD_DEFS) {
    for (let i = 0; i < def.count; i++) deck.push({ key: def.key, name: def.name, rank: def.rank });
  }
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}
function roomOf(socket) {
  const id = [...socket.rooms].find(r => r !== socket.id);
  return id ? rooms.get(id) : undefined;
}
function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, isHost: !!p.isHost, isBot: !!p.isBot,
    alive: p.alive !== false, protected: !!p.protected, coins: p.coins || 0,
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
    deckCount: room.deck.length,
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
  if (!room.order.length) return;
  const idx = room.order.indexOf(room.turn);
  room.turn = room.order[(idx + 1) % room.order.length];
  // bescherming duurt tot je volgende beurt -> bij start van je beurt valt bescherming weg
  const now = room.players.get(room.turn);
  if (now) now.protected = false;
}
function alivePlayers(room) {
  return [...room.players.values()].filter(p => p.alive !== false);
}
function eliminate(room, playerId, reason = '') {
  const p = room.players.get(playerId);
  if (!p || p.alive === false) return;
  p.alive = false;
  // hand naar discard
  for (const c of p.hand || []) room.discard.push(c);
  p.hand = [];
  log(room, `${p.name} ligt uit ${reason ? `(${reason})` : ''}`);
  // wie uit ligt verdwijnt uit order
  room.order = room.order.filter(id => id !== playerId);
  if (room.turn === playerId) nextTurn(room);
}
function endRoundIfNeeded(room) {
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    const winner = alive[0];
    if (winner) {
      winner.coins = (winner.coins || 0) + 1;
      log(room, `${winner.name} wint de ronde en krijgt een munt (totaal ${winner.coins})`);
    } else {
      log(room, `Ronde eindigt zonder winnaar`);
    }
    room.started = false;
    room.turn = null;
    broadcastState(room);
    return true;
  }
  return false;
}
function getOtherHandCard(player) {
  return (player.hand?.length === 1) ? player.hand[0] : null;
}
function removeCardFromHandByKey(player, playKey) {
  const idx = player.hand?.findIndex(c => c.key === playKey);
  if (idx == null || idx < 0) return null;
  const [played] = player.hand.splice(idx, 1);
  return played || null;
}
function botName(i){ return ['Bot A','Bot B','Bot C','Bot D'][i] || `Bot ${i+1}`; }
function randomChoice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

// -------------------- socket.io --------------------
io.on('connection', (socket) => {
  socket.on('ping:server', (_p, ack) => ack?.({ ok: true, pong: Date.now() }));

  socket.on('join', ({ roomId, name }, ack) => {
    if (!roomId || !name) return ack?.({ ok:false, error:'roomId and name required' });
    let room = rooms.get(roomId); if (!room){ room = makeRoom(roomId); rooms.set(roomId, room); }
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
    room.hostId = socket.id; const me = room.players.get(socket.id); if (me) me.isHost = true;
    log(room, `${me?.name ?? 'Host'} is host geworden`);
    broadcastState(room); ack?.({ ok:true });
  });

  socket.on('bots:configure', ({ botsCount=0, botLevel=1 }, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    // reset bots
    for (const [id,p] of [...room.players]) if (p.isBot) room.players.delete(id);
    // add bots
    for (let i=0;i<Math.max(0,Math.min(3,botsCount));i++){
      const id = `bot-${i+1}`;
      room.players.set(id,{
        id, name:botName(i), isBot:true, botLevel:Math.max(1,Math.min(3,botLevel)),
        hand:[], alive:true, protected:false, coins:0
      });
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
    room.started=false; room.round=0; room.turn=null; room.deck=[]; room.discard=[];
    for (const p of room.players.values()){ p.hand=[]; p.alive=true; p.protected=false; }
    log(room, 'Nieuw spel klaarzetten'); ensureOrder(room); broadcastState(room); ack?.({ ok:true });
  });

  socket.on('game:startRound', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (socket.id !== room.hostId) return ack?.({ ok:false, error:'only host' });
    const living = alivePlayers(room);
    if (living.length < 2) return ack?.({ ok:false, error:'min 2 spelers' });
    room.round += 1; room.started = true; room.deck = buildDeck(); room.discard = [];
    for (const p of living){ p.hand=[]; p.protected=false; p.alive=true; }
    // iedereen 1 kaart
    for (const p of living){ const c = room.deck.pop(); if (c) p.hand.push(c); }
    ensureOrder(room);
    log(room, `Ronde ${room.round} gestart`);
    broadcastState(room);
    ack?.({ ok:true });
    maybeBotTurn(room);
  });

  socket.on('game:draw', (_p, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });
    const me = room.players.get(socket.id); if (!me) return ack?.({ ok:false, error:'no player' });
    if (!room.started) return ack?.({ ok:false, error:'round not started' });
    if ((me.hand?.length ?? 0) !== 1) return ack?.({ ok:false, error:'need 1 card to draw' });
    const card = room.deck.pop(); if (!card) return ack?.({ ok:false, error:'deck empty' });
    me.hand.push(card);
    log(room, `${me.name} trekt een kaart`);
    broadcastState(room); ack?.({ ok:true, handSize: me.hand.length });
  });

  // ---------- NIEUW: kaart spelen + effect ----------
  socket.on('game:play', (payload, ack) => {
    const room = roomOf(socket); if (!room) return ack?.({ ok:false, error:'no room' });
    if (room.turn !== socket.id) return ack?.({ ok:false, error:'not your turn' });
    const me = room.players.get(socket.id); if (!me || me.alive === false) return ack?.({ ok:false, error:'no player' });
    if (!room.started) return ack?.({ ok:false, error:'round not started' });
    if ((me.hand?.length ?? 0) !== 2) return ack?.({ ok:false, error:'need 2 cards to play' });

    const { playKey, targetId, guessKey } = payload || {};
    if (!playKey) return ack?.({ ok:false, error:'playKey required' });
    if (playKey === 'prinses') return ack?.({ ok:false, error:'Prinses kan niet vrijwillig gespeeld worden' });

    const played = removeCardFromHandByKey(me, playKey);
    if (!played) return ack?.({ ok:false, error:'card not in hand' });
    room.discard.push(played);
    log(room, `${me.name} speelt ${played.name}`);

    const target = targetId ? room.players.get(targetId) : null;

    // kleine helper
    const isProtected = (p) => p?.protected === true;
    const myOther = getOtherHandCard(me); // na het spelen is dit jouw enige kaart

    // voer effect uit
    switch (played.key) {
      case 'ziener': {
        if (!target || !guessKey) { log(room, `Actie faalt: target of gok ontbreekt`); break; }
        if (!target.alive) { log(room, `Doelwit is al uit`); break; }
        if (isProtected(target)) { log(room, `${target.name} is beschermd`); break; }
        const their = getOtherHandCard(target);
        if (their && their.key === guessKey) {
          log(room, `Gok juist! ${target.name} verliest.`);
          eliminate(room, target.id, 'door Ziener');
        } else {
          log(room, `Gok fout (geraden: ${CARD_BY_KEY[guessKey]?.name ?? guessKey})`);
        }
        break;
      }
      case 'wolf': {
        if (!target) { log(room, `Actie faalt: target ontbreekt`); break; }
        if (!target.alive) { log(room, `Doelwit is al uit`); break; }
        if (isProtected(target)) { log(room, `${target.name} is beschermd`); break; }
        const their = getOtherHandCard(target);
        if (their) io.to(socket.id).emit('private:peek', { targetId: target.id, targetName: target.name, card: their });
        log(room, `${me.name} gluurt naar de kaart van ${target.name}`);
        break;
      }
      case 'ridder': {
        if (target && target.id !== me.id) {
          target.protected = true;
          log(room, `${target.name} krijgt bescherming`);
        } else {
          me.protected = true;
          log(room, `${me.name} is beschermd tot zijn/haar volgende beurt`);
        }
        break;
      }
      case 'zeemeermin': {
        if (!target) { log(room, `Actie faalt: target ontbreekt`); break; }
        if (!target.alive) { log(room, `Doelwit is al uit`); break; }
        if (isProtected(target)) { log(room, `${target.name} is beschermd`); break; }
        const their = getOtherHandCard(target);
        if (!their || !myOther) { log(room, `Vergelijking mislukt (ontbrekende kaart)`); break; }
        if (myOther.rank > their.rank) {
          eliminate(room, target.id, 'door Zeemeermin (lager)');
        } else if (myOther.rank < their.rank) {
          eliminate(room, me.id, 'door Zeemeermin (lager)');
        } else {
          log(room, `Gelijk spel bij Zeemeermin (niemand verliest)`);
        }
        break;
      }
      case 'god': {
        if (!target) { log(room, `Actie faalt: target ontbreekt`); break; }
        if (!target.alive) { log(room, `Doelwit is al uit`); break; }
        if (isProtected(target)) { log(room, `${target.name} is beschermd`); break; }
        const their = getOtherHandCard(target);
        if (!their || !myOther) { log(room, `Wissel mislukt (ontbrekende kaart)`); break; }
        target.hand = [myOther];
        me.hand = [their];
        log(room, `${me.name} wisselt kaart met ${target.name}`);
        break;
      }
      case 'emir': {
        const t = target || me; // self als geen target opgegeven
        if (!t.alive) { log(room, `Doelwit is al uit`); break; }
        if (t.id !== me.id && isProtected(t)) { log(room, `${t.name} is beschermd`); break; }
        const cur = getOtherHandCard(t);
        if (cur) room.discard.push(cur);
        t.hand = [];
        log(room, `${t.name} legt zijn kaart af (Emir)`);
        if (cur && cur.key === 'prinses') {
          eliminate(room, t.id, 'Prinses afgelegd (Emir)');
          break;
        }
        const draw = room.deck.pop();
        if (draw) {
          t.hand.push(draw);
          if (t.id === me.id) log(room, `${me.name} trekt een nieuwe kaart`);
          else log(room, `${t.name} trekt een nieuwe kaart`);
        } else {
          log(room, `Deck leeg — geen nieuwe kaart`);
        }
        break;
      }
      case 'heks': {
        // Countess-analogon: geen effect, behalve dat je hem soms móét afleggen
        // (als je Heks + God/Emir had, is dit nu gebeurd, dus OK)
        break;
      }
      default: {
        // onbereikbare case, Prinses is al geweigerd
        break;
      }
    }

    // Einde ronde?
    if (endRoundIfNeeded(room)) {
      broadcastState(room);
      return ack?.({ ok:true, roundEnded:true });
    }

    // Volgende beurt
    nextTurn(room);
    broadcastState(room);
    ack?.({ ok:true });
    maybeBotTurn(room);
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

// -------------------- simpele bot --------------------
function maybeBotTurn(room) {
  const actor = room.players.get(room.turn);
  if (!actor || !actor.isBot || actor.alive === false || !room.started) return;

  setTimeout(() => {
    // trek indien nodig
    if ((actor.hand?.length ?? 0) === 1 && room.deck.length) {
      actor.hand.push(room.deck.pop());
      log(room, `${actor.name} trekt een kaart (bot)`);
    }
    if ((actor.hand?.length ?? 0) !== 2) {
      nextTurn(room); broadcastState(room); return maybeBotTurn(room);
    }

    // verplichte heks?
    const has = k => actor.hand.some(c => c.key === k);
    let playKey = null, targetId = null, guessKey = null;

    if (has('heks') && (has('god') || has('emir'))) {
      playKey = 'heks';
    } else {
      // kies random kaart
      playKey = randomChoice(actor.hand).key;
    }

    const others = alivePlayers(room).filter(p => p.id !== actor.id && !p.protected);
    const anyTarget = others.length ? randomChoice(others) : null;

    switch (playKey) {
      case 'ziener':
        targetId = anyTarget?.id || null;
        // gok iets dat niet 'prinses' is (random)
        guessKey = randomChoice(CARD_DEFS.filter(c => c.key !== 'prinses')).key;
        break;
      case 'wolf':
      case 'zeemeermin':
      case 'god':
        targetId = anyTarget?.id || null;
        break;
      case 'emir':
        // 50/50 zelf of ander
        targetId = Math.random() < 0.5 ? actor.id : (anyTarget?.id || actor.id);
        break;
      case 'ridder':
        // vaak zichzelf beschermen
        targetId = Math.random() < 0.7 ? actor.id : (anyTarget?.id || actor.id);
        break;
      case 'heks':
        break;
    }

    // voer uit via dezelfde event-handler interface
    io.to(actor.id).emit('bot:debug', { playKey, targetId, guessKey });
    // simuleer alsof bot het event stuurde:
    const fakeSocket = { id: actor.id, rooms: new Set([room.roomId, actor.id]) };
    // kleine helper om dezelfde code te hergebruiken:
    io.emit('noop'); // no-op om event loop niet te blokkeren
    // Copy van handler:
    const played = removeCardFromHandByKey(actor, playKey);
    if (played) {
      room.discard.push(played);
      log(room, `${actor.name} speelt ${played.name}`);
      const target = targetId ? room.players.get(targetId) : null;
      const isProtected = (p) => p?.protected === true;
      const myOther = getOtherHandCard(actor);

      switch (played.key) {
        case 'ziener': {
          if (target && !isProtected(target) && target.alive !== false && guessKey) {
            const their = getOtherHandCard(target);
            if (their && their.key === guessKey) eliminate(room, target.id, 'door Ziener (bot)');
          }
          break;
        }
        case 'wolf': {
          // private peek => alleen voor bot zelf; niets te broadcasten
          break;
        }
        case 'ridder': {
          const t = room.players.get(targetId || actor.id);
          if (t) t.protected = true;
          break;
        }
        case 'zeemeermin': {
          const t = target;
          if (t && !isProtected(t) && t.alive !== false) {
            const their = getOtherHandCard(t);
            if (their && myOther) {
              if (myOther.rank > their.rank) eliminate(room, t.id, 'door Zeemeermin (bot)');
              else if (myOther.rank < their.rank) eliminate(room, actor.id, 'door Zeemeermin (bot)');
            }
          }
          break;
        }
        case 'god': {
          const t = target;
          if (t && !isProtected(t) && t.alive !== false && myOther) {
            const their = getOtherHandCard(t);
            if (their) { t.hand = [myOther]; actor.hand = [their]; }
          }
          break;
        }
        case 'emir': {
          const t = room.players.get(targetId || actor.id);
          if (t && t.alive !== false && (t.id === actor.id || !isProtected(t))) {
            const cur = getOtherHandCard(t);
            if (cur) room.discard.push(cur);
            t.hand = [];
            if (cur && cur.key === 'prinses') eliminate(room, t.id, 'Prinses afgelegd (Emir, bot)');
            else {
              const draw = room.deck.pop();
              if (draw) t.hand.push(draw);
            }
          }
          break;
        }
        case 'heks': { break; }
      }

      if (!endRoundIfNeeded(room)) {
        nextTurn(room);
        broadcastState(room);
        maybeBotTurn(room);
      } else {
        broadcastState(room);
      }
    }
  }, 900);
}

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
