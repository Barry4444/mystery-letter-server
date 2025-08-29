// index.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

/* =====================  Setup  ===================== */

const PORT = process.env.PORT || 10000;

const app = express();

// Pas eventueel je eigen Netlify domein hier aan:
const ALLOWED = new Set([
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'https://mystery-letter-game.netlify.app',
]);

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED.has(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
  credentials: true,
}));

app.get('/', (_req, res) => res.send('Mystery Letter server OK'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      if (!origin || ALLOWED.has(origin)) return cb(null, true);
      return cb(new Error('CORS blocked'), false);
    },
    credentials: true,
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
});

/* =====================  Game data  ===================== */
/**
 * We volgen de Love Letter structuur, met jouw namen:
 * 1  Ziener (x5)         — Guard
 * 2  Wolf (x2)           — Priest
 * 3  Zeemeermin (x2)     — Baron
 * 4  Ridder (x2)         — Handmaid (bescherming t/m je volgende beurt)
 * 5  Emir (x2)           — Prince (doelwit legt hand af, trekt nieuw; Princess = verlies)
 * 6  God (x1)            — King (wissel hand)
 * 7  Heks (x1)           — Countess (moet afleggen als je God/Emir erbij hebt)
 * 8  Prinses (x1)        — Princess (als je moet afleggen => verlies; je mag haar niet “vrijwillig” spelen)
 */

const CARD_COUNTS = {
  Ziener: 5,
  Wolf: 2,
  Zeemeermin: 2,
  Ridder: 2,
  Emir: 2,
  God: 1,
  Heks: 1,
  Prinses: 1,
};

const CARD_VALUE = {
  Ziener: 1,
  Wolf: 2,
  Zeemeermin: 3,
  Ridder: 4,
  Emir: 5,
  God: 6,
  Heks: 7,
  Prinses: 8,
};

const ALL_CARD_NAMES = Object.keys(CARD_COUNTS);

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function buildDeck() {
  const deck = [];
  for (const name of ALL_CARD_NAMES) {
    const count = CARD_COUNTS[name];
    for (let i = 0; i < count; i++) {
      deck.push({ id: uid(), name, value: CARD_VALUE[name] });
    }
  }
  // schudden
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/* =====================  Rooms & state  ===================== */

const rooms = new Map();
/**
 * Room shape:
 * {
 *   id,
 *   players: Map<socketId | botId, Player>,
 *   order: string[],            // speelvolgorde id's (bots incl.)
 *   coins: { [id]: number },
 *   roundNum: number,
 *   turnIdx: number,            // index in order
 *   deck: Card[],
 *   burned: Card|null,          // 1 kaart face-down
 *   discard: Card[],
 *   inRound: boolean,
 *   botsEnabled: boolean,
 *   botLevel: 1|2|3,
 * }
 *
 * Player shape:
 * { id, name, isBot, socket?, hand: Card[], eliminated: boolean, protected: boolean }
 */

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      players: new Map(),
      order: [],
      coins: {},
      roundNum: 0,
      turnIdx: 0,
      deck: [],
      burned: null,
      discard: [],
      inRound: false,
      botsEnabled: false,
      botLevel: 1,
    });
  }
  return rooms.get(roomId);
}

function humanPlayers(room) {
  return room.order.filter(id => !room.players.get(id)?.isBot);
}

function alivePlayers(room) {
  return room.order.filter(id => {
    const p = room.players.get(id);
    return p && !p.eliminated;
  });
}

function nextTurnIdx(room, fromIdx = room.turnIdx) {
  if (!room.order.length) return 0;
  let idx = fromIdx;
  for (let i = 0; i < room.order.length; i++) {
    idx = (idx + 1) % room.order.length;
    const p = room.players.get(room.order[idx]);
    if (p && !p.eliminated) return idx;
  }
  return fromIdx;
}

function drawCard(room) {
  return room.deck.pop() || null;
}

function discardCard(room, card) {
  if (card) room.discard.push(card);
}

function eliminate(room, playerId, reason = 'uitgeschakeld') {
  const p = room.players.get(playerId);
  if (!p || p.eliminated) return;
  // Als Prinses in hand => ook op de discard (voor logging compleet)
  while (p.hand.length) discardCard(room, p.hand.pop());
  p.eliminated = true;
  roomLog(room, `${nameOf(room, playerId)} ligt eruit (${reason}).`);
}

function nameOf(room, id) {
  return room.players.get(id)?.name ?? id;
}

/* =====================  Broadcast (privacy)  ===================== */

function clientStateFor(room, viewerId) {
  const me = room.players.get(viewerId);
  return {
    roomId: room.id,
    meId: viewerId,
    players: room.order.map(id => {
      const p = room.players.get(id);
      return {
        id,
        name: p?.name ?? id,
        coins: room.coins[id] ?? 0,
        eliminated: !!p?.eliminated,
        protected: !!p?.protected,
        cardCount: id === viewerId ? (p?.hand?.length ?? 0) : (p?.eliminated ? 0 : (p?.hand?.length ? 1 : 0)),
      };
    }),
    hand: me?.hand ?? [],
    turnPlayerId: room.order[room.turnIdx] ?? null,
    deckCount: room.deck.length,
    roundNum: room.roundNum,
    inRound: room.inRound,
  };
}

function broadcastState(room) {
  for (const id of room.order) {
    const p = room.players.get(id);
    if (p?.isBot) continue;
    p?.socket?.emit('state', clientStateFor(room, id));
  }
}

function roomLog(room, message) {
  const payload = { message, ts: Date.now() };
  for (const id of room.order) {
    const p = room.players.get(id);
    if (!p?.isBot) p?.socket?.emit('log', payload);
  }
}

function privateLog(room, playerId, message) {
  const p = room.players.get(playerId);
  if (!p?.isBot) p?.socket?.emit('log', { message, ts: Date.now() });
}

/* =====================  Ronde / spel  ===================== */

function resetRound(room) {
  room.inRound = false;
  room.deck = [];
  room.burned = null;
  room.discard = [];
  room.turnIdx = 0;
  for (const id of room.order) {
    const p = room.players.get(id);
    if (!p) continue;
    p.eliminated = false;
    p.protected = false;
    p.hand = [];
  }
}

function ensureBots(room) {
  if (!room.botsEnabled) return;
  // Vul tot 4 spelers
  const need = Math.max(0, 4 - room.order.length);
  for (let i = 0; i < need; i++) {
    const id = `bot-${uid()}`;
    const p = {
      id,
      name: `Bot ${room.order.filter(x => x.startsWith('bot-')).length + 1}`,
      isBot: true,
      hand: [],
      eliminated: false,
      protected: false,
    };
    room.players.set(id, p);
    room.order.push(id);
    room.coins[id] ??= 0;
  }
}

function startRound(room) {
  if (room.inRound) return { ok: false, error: 'Ronde is al bezig' };
  const active = humanPlayers(room).length > 0 ? room.order : [];
  if (active.length < 2) return { ok: false, error: 'Minstens 2 spelers vereist' };

  resetRound(room);
  ensureBots(room);

  room.roundNum += 1;
  room.inRound = true;

  room.deck = buildDeck();
  room.burned = drawCard(room); // face-down (classic rule)

  // deel 1 kaart aan iedereen
  for (const id of room.order) {
    const p = room.players.get(id);
    if (!p) continue;
    p.eliminated = false;
    p.protected = false;
    p.hand = [];
    const c = drawCard(room);
    if (c) p.hand.push(c);
  }

  // wissel startspeler elke ronde
  room.turnIdx = (room.roundNum - 1) % room.order.length;

  roomLog(room, `Ronde ${room.roundNum} gestart.`);
  broadcastState(room);

  // Als startspeler een bot is, laat hem spelen
  maybeBotTurn(room);
  return { ok: true };
}

function endRound(room, winnerId, reason = 'ronde gewonnen') {
  if (!room.inRound) return;
  room.inRound = false;
  roomLog(room, `🏁 ${nameOf(room, winnerId)} wint de ronde (${reason}).`);

  room.coins[winnerId] = (room.coins[winnerId] ?? 0) + 1;

  // Check spel-winst (3 munten)
  if (room.coins[winnerId] >= 3) {
    roomLog(room, `🎉 ${nameOf(room, winnerId)} wint het spel met 3 🪙!`);
    // reset alle munten voor volgende spel
    for (const id of room.order) room.coins[id] = 0;
  }

  broadcastState(room);
}

function checkRoundEnd(room) {
  if (!room.inRound) return;
  const alive = alivePlayers(room);
  if (alive.length === 1) {
    endRound(room, alive[0], 'laatste speler over');
    return true;
  }
  if (room.deck.length === 0) {
    // Vergelijk hoogste kaart in hand
    let bestId = null;
    let bestVal = -1;
    for (const id of alive) {
      const p = room.players.get(id);
      const v = p?.hand?.[0]?.value ?? -1;
      if (v > bestVal) {
        bestVal = v;
        bestId = id;
      }
    }
    if (bestId) endRound(room, bestId, 'hoogste kaart bij deck einde');
    return true;
  }
  return false;
}

function beginNextTurn(room) {
  if (!room.inRound) return;
  room.turnIdx = nextTurnIdx(room);
  const turnId = room.order[room.turnIdx];
  const turnP = room.players.get(turnId);
  // Bescherming van Ridder loopt af bij start van je eigen beurt
  if (turnP?.protected) turnP.protected = false;

  broadcastState(room);
  maybeBotTurn(room);
}

/* =====================  Acties  ===================== */

// Heks: verplicht als combinatie met God/Emir
function mustPlayHeks(hand) {
  const hasHeks = hand.some(c => c.name === 'Heks');
  if (!hasHeks) return false;
  const hasGod = hand.some(c => c.name === 'God');
  const hasEmir = hand.some(c => c.name === 'Emir');
  return hasGod || hasEmir;
}

function isProtected(room, targetId) {
  const t = room.players.get(targetId);
  return !t || t.eliminated || t.protected;
}

function handleDraw(room, playerId) {
  if (!room.inRound) return { ok: false, error: 'Geen actieve ronde' };
  const turnId = room.order[room.turnIdx];
  if (turnId !== playerId) return { ok: false, error: 'Niet jouw beurt' };

  const p = room.players.get(playerId);
  if (!p || p.eliminated) return { ok: false, error: 'Speler ongeldig' };
  if (p.hand.length !== 1) return { ok: false, error: 'Je moet precies 1 kaart hebben om te trekken' };

  const c = drawCard(room);
  if (!c) return { ok: false, error: 'Deck leeg' };
  p.hand.push(c);
  broadcastState(room);
  return { ok: true };
}

function playCard(room, playerId, cardId, targetId, extra = {}) {
  if (!room.inRound) return { ok: false, error: 'Geen actieve ronde' };
  const turnId = room.order[room.turnIdx];
  if (turnId !== playerId) return { ok: false, error: 'Niet jouw beurt' };

  const p = room.players.get(playerId);
  if (!p || p.eliminated) return { ok: false, error: 'Speler ongeldig' };
  if (p.hand.length !== 2) return { ok: false, error: 'Je moet 2 kaarten hebben om te spelen' };

  const cardIdx = p.hand.findIndex(c => c.id === cardId);
  if (cardIdx === -1) return { ok: false, error: 'Kaart niet in hand' };

  // Heks-regel afdwingen
  if (mustPlayHeks(p.hand) && p.hand[cardIdx].name !== 'Heks') {
    return { ok: false, error: 'Heks moet gespeeld worden (je hebt God/Emir in je hand)' };
  }

  const card = p.hand.splice(cardIdx, 1)[0];  // kaart in spel
  discardCard(room, card);

  const other = p.hand[0] || null;            // resterende kaart

  // Prinses mag je NIET vrijwillig afleggen
  if (card.name === 'Prinses') {
    // Alleen legaal als “verplicht” — maar wij laten de client dit niet kiezen.
    eliminate(room, playerId, 'Prinses afgelegd');
    broadcastState(room);
    if (!checkRoundEnd(room)) beginNextTurn(room);
    return { ok: true };
  }

  /* ---- effect van de kaart ---- */

  switch (card.name) {
    case 'Ziener': {
      // Kies doelwit (moet ongedeerd en niet protected)
      if (!targetId) targetId = firstAvailableTarget(room, playerId);
      if (!targetId) break; // niemand te raken
      if (isProtected(room, targetId)) {
        roomLog(room, `${nameOf(room, playerId)} speelde Ziener, maar ${nameOf(room, targetId)} is beschermd.`);
        break;
      }
      // Raad willekeurig als geen 'guess' meegegeven
      const guess = extra.guess && ALL_CARD_NAMES.includes(extra.guess)
        ? extra.guess
        : randomGuess(); // niet 'Ziener'
      const t = room.players.get(targetId);
      const tCard = t?.hand?.[0];
      roomLog(room, `${nameOf(room, playerId)} gebruikt Ziener op ${nameOf(room, targetId)} en raadt ${guess}.`);
      if (tCard && tCard.name === guess) {
        eliminate(room, targetId, `geraden (${guess})`);
      }
      break;
    }

    case 'Wolf': {
      if (!targetId) targetId = firstAvailableTarget(room, playerId);
      if (!targetId) break;
      if (isProtected(room, targetId)) {
        roomLog(room, `${nameOf(room, playerId)} speelde Wolf, maar ${nameOf(room, targetId)} is beschermd.`);
        break;
      }
      const t = room.players.get(targetId);
      const tCard = t?.hand?.[0];
      roomLog(room, `${nameOf(room, playerId)} gluurt naar de hand van ${nameOf(room, targetId)} (Wolf).`);
      if (tCard) privateLog(room, playerId, `👀 Kaart van ${nameOf(room, targetId)}: ${tCard.name} (${tCard.value})`);
      break;
    }

    case 'Ridder': {
      // Bescherming 1 ronde — voor jezelf of een ander
      const target = targetId && targetId !== playerId ? targetId : playerId;
      const t = room.players.get(target);
      if (t && !t.eliminated) {
        t.protected = true;
        if (target === playerId) roomLog(room, `${nameOf(room, playerId)} beschermt zichzelf (Ridder).`);
        else roomLog(room, `${nameOf(room, playerId)} beschermt ${nameOf(room, target)} (Ridder).`);
      }
      break;
    }

    case 'Zeemeermin': {
      if (!targetId) targetId = firstAvailableTarget(room, playerId);
      if (!targetId) break;
      if (isProtected(room, targetId)) {
        roomLog(room, `${nameOf(room, playerId)} speelde Zeemeermin, maar ${nameOf(room, targetId)} is beschermd.`);
        break;
      }
      const meVal = other?.value ?? -1;
      const t = room.players.get(targetId);
      const tVal = t?.hand?.[0]?.value ?? -1;
      roomLog(room, `${nameOf(room, playerId)} vergelijkt kaarten met ${nameOf(room, targetId)} (Zeemeermin).`);
      if (meVal > tVal) {
        eliminate(room, targetId, 'verliezer bij vergelijking');
      } else if (tVal > meVal) {
        eliminate(room, playerId, 'verliezer bij vergelijking');
      } else {
        roomLog(room, `Gelijkspel bij Zeemeermin — niemand valt af.`);
      }
      break;
    }

    case 'God': {
      if (!targetId) targetId = firstAvailableTarget(room, playerId);
      if (!targetId) break;
      if (isProtected(room, targetId)) {
        roomLog(room, `${nameOf(room, playerId)} speelde God, maar ${nameOf(room, targetId)} is beschermd.`);
        break;
      }
      const t = room.players.get(targetId);
      if (t?.hand?.length === 1 && other) {
        const tmp = t.hand[0];
        t.hand[0] = other;
        p.hand[0] = tmp;
        roomLog(room, `${nameOf(room, playerId)} wisselt kaarten met ${nameOf(room, targetId)} (God).`);
      }
      break;
    }

    case 'Emir': {
      // Zelf of iemand anders legt hand af en trekt nieuw
      const target = targetId || playerId;
      const t = room.players.get(target);
      if (!t || t.eliminated) break;
      if (isProtected(room, target) && target !== playerId) {
        roomLog(room, `${nameOf(room, playerId)} speelde Emir op ${nameOf(room, target)}, maar die is beschermd.`);
        break;
      }
      const old = t.hand.pop();
      if (old) discardCard(room, old);
      roomLog(room, `${nameOf(room, playerId)} laat ${target === playerId ? 'zichzelf' : nameOf(room, target)} een nieuwe kaart nemen (Emir).`);
      if (old?.name === 'Prinses') {
        eliminate(room, target, 'Prinses afgelegd (Emir)');
      } else if (!t.eliminated) {
        const nc = drawCard(room);
        if (nc) t.hand.push(nc);
      }
      break;
    }

    case 'Heks': {
      // Geen effect; dwang is al afgedwongen
      roomLog(room, `${nameOf(room, playerId)} legt Heks af.`);
      break;
    }

    default:
      break;
  }

  // check ronde-einde of volgende beurt
  broadcastState(room);
  if (!checkRoundEnd(room)) beginNextTurn(room);
  return { ok: true };
}

function firstAvailableTarget(room, exceptId) {
  for (const id of room.order) {
    if (id === exceptId) continue;
    const p = room.players.get(id);
    if (p && !p.eliminated) return id;
  }
  return null;
}

function randomGuess() {
  // Ziener mag niet Ziener raden (klassieke regel). Kies uit 2..8
  const options = ALL_CARD_NAMES.filter(n => n !== 'Ziener');
  return options[Math.floor(Math.random() * options.length)];
}

/* =====================  Bots  ===================== */

function maybeBotTurn(room) {
  if (!room.inRound) return;
  const id = room.order[room.turnIdx];
  const p = room.players.get(id);
  if (!p?.isBot || p.eliminated) return;

  // Simuleer denken
  setTimeout(() => runBotTurn(room, id), 700 + Math.random() * 900);
}

function runBotTurn(room, botId) {
  if (!room.inRound) return;
  const id = room.order[room.turnIdx];
  if (id !== botId) return; // niet meer aan zet

  const p = room.players.get(botId);
  if (!p || p.eliminated) return;

  // Trek indien 1 kaart
  if (p.hand.length === 1) {
    handleDraw(room, botId);
  }
  if (p.hand.length !== 2) return;

  const level = room.botLevel || 1;
  const chooseTarget = () => firstAvailableTarget(room, botId);

  // Heks-regel: verplicht
  const heks = p.hand.find(c => c.name === 'Heks');
  const mustHeks = mustPlayHeks(p.hand);

  let play, target, extra;

  if (mustHeks && heks) {
    play = heks;
  } else if (level === 1) {
    // random kaart
    play = p.hand[Math.floor(Math.random() * p.hand.length)];
  } else if (level === 2) {
    // simpele voorkeuren
    play =
      p.hand.find(c => c.name === 'Ridder') ||
      p.hand.find(c => c.name === 'Ziener') ||
      p.hand.find(c => c.name === 'Zeemeermin') ||
      p.hand.find(c => c.name === 'Wolf') ||
      p.hand.find(c => c.name === 'Emir') ||
      p.hand.find(c => c.name === 'God') ||
      p.hand[0];
  } else {
    // level 3 (iets slimmer)
    // Als ik Ridder heb en onbeschermd, bescherm mezelf.
    if (p.hand.some(c => c.name === 'Ridder') && !p.protected) {
      play = p.hand.find(c => c.name === 'Ridder');
      target = botId;
    } else if (p.hand.some(c => c.name === 'Ziener')) {
      play = p.hand.find(c => c.name === 'Ziener');
      target = chooseTarget();
      extra = { guess: 'Prinses' }; // “slimme” gok
    } else if (p.hand.some(c => c.name === 'Zeemeermin')) {
      play = p.hand.find(c => c.name === 'Zeemeermin');
      target = chooseTarget();
    } else if (p.hand.some(c => c.name === 'Wolf')) {
      play = p.hand.find(c => c.name === 'Wolf');
      target = chooseTarget();
    } else if (p.hand.some(c => c.name === 'God')) {
      play = p.hand.find(c => c.name === 'God');
      target = chooseTarget();
    } else if (p.hand.some(c => c.name === 'Emir')) {
      play = p.hand.find(c => c.name === 'Emir');
      // 50% zelf, 50% ander
      target = Math.random() < 0.5 ? botId : chooseTarget();
    } else {
      play = p.hand[0];
    }
  }

  playCard(room, botId, play.id, target, extra);
}

/* =====================  Socket events  ===================== */

io.on('connection', (socket) => {
  socket.on('ping:server', (_data, ack) => {
    ack?.({ ok: true, pong: Date.now() });
  });

  socket.on('join', ({ roomId, name }, ack) => {
    roomId = String(roomId || '').trim();
    name = String(name || '').trim();
    if (!roomId || !name) return ack?.({ ok: false, error: 'roomId en name vereist' });

    const room = getOrCreateRoom(roomId);

    if (room.inRound) {
      return ack?.({ ok: false, error: 'Ronde is bezig — even wachten tot volgende ronde' });
    }

    // als socket al ergens in zit, schoon eerst op
    for (const r of rooms.values()) {
      if (r.players.has(socket.id)) {
        r.players.delete(socket.id);
        r.order = r.order.filter(x => x !== socket.id);
      }
    }

    room.players.set(socket.id, {
      id: socket.id,
      name,
      socket,
      isBot: false,
      hand: [],
      eliminated: false,
      protected: false,
    });
    if (!room.order.includes(socket.id)) room.order.push(socket.id);
    room.coins[socket.id] ??= 0;

    socket.join(roomId);

    const state = clientStateFor(room, socket.id);
    ack?.({ ok: true, state });
    socket.emit('joined', { state });

    roomLog(room, `${name} is de kamer binnengekomen.`);
    broadcastState(room);
  });

  socket.on('game:new', ({ botsEnabled = false, botLevel = 1 } = {}, ack) => {
    // vind room waar deze socket in zit
    const room = [...rooms.values()].find(r => r.players.has(socket.id));
    if (!room) return ack?.({ ok: false, error: 'Niet in een kamer' });

    if (room.inRound) return ack?.({ ok: false, error: 'Ronde is bezig' });

    room.botsEnabled = !!botsEnabled;
    room.botLevel = [1, 2, 3].includes(botLevel) ? botLevel : 1;

    // verwijder bestaande bots, we bouwen opnieuw
    for (const id of [...room.order]) {
      const p = room.players.get(id);
      if (p?.isBot) {
        room.players.delete(id);
        room.order = room.order.filter(x => x !== id);
        delete room.coins[id];
      }
    }

    ensureBots(room);
    roomLog(room, `Nieuw spel gestart. Bots: ${room.botsEnabled ? 'aan' : 'uit'} (niveau ${room.botLevel}).`);
    broadcastState(room);
    ack?.({ ok: true });
  });

  socket.on('start:round', (_data, ack) => {
    const room = [...rooms.values()].find(r => r.players.has(socket.id));
    if (!room) return ack?.({ ok: false, error: 'Niet in een kamer' });
    const out = startRound(room);
    ack?.(out);
  });

  socket.on('draw', (_data, ack) => {
    const room = [...rooms.values()].find(r => r.players.has(socket.id));
    if (!room) return ack?.({ ok: false, error: 'Niet in een kamer' });
    const out = handleDraw(room, socket.id);
    ack?.(out);
  });

  socket.on('play', ({ cardId, targetId, extra } = {}, ack) => {
    const room = [...rooms.values()].find(r => r.players.has(socket.id));
    if (!room) return ack?.({ ok: false, error: 'Niet in een kamer' });
    const out = playCard(room, socket.id, cardId, targetId, extra);
    ack?.(out);
  });

  socket.on('disconnect', () => {
    // als speler weggaat buiten een ronde: haal hem uit room
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) {
        const wasInRound = room.inRound;
        const name = nameOf(room, socket.id);
        room.players.delete(socket.id);
        room.order = room.order.filter(x => x !== socket.id);
        roomLog(room, `${name} heeft de kamer verlaten.`);
        if (wasInRound) {
          // als we in een ronde zaten, kan dit een ronde-einde triggeren
          broadcastState(room);
          if (!checkRoundEnd(room)) {
            // als current turn speler vertrok, schuif door
            const current = room.order[room.turnIdx];
            if (!current || room.players.get(current)?.eliminated) {
              beginNextTurn(room);
            }
          }
        } else {
          broadcastState(room);
        }
      }
    }
  });
});

/* =====================  Start  ===================== */

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
