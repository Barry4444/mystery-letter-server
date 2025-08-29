// index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

/* ================
   EXPRESS + CORS
   ================ */
const app = express();

const RAW_ORIGINS = process.env.ALLOWED_ORIGINS || '';
const ALLOWED_ORIGINS = RAW_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
const ORIGINS_REGEX = process.env.ALLOWED_ORIGINS_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGINS_REGEX)
  : null;

const allowAll = ALLOWED_ORIGINS.length === 0 && !ORIGINS_REGEX;

const isAllowedOrigin = (origin) => {
  if (!origin) return true;       // server-to-server / curl
  if (allowAll) return true;      // debug fallback
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (ORIGINS_REGEX?.test(origin)) return true;
  console.warn('[CORS BLOCKED]', origin);
  return false;
};

app.use(cors({
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());
app.get('/health', (_req, res) => res.type('text').send('OK'));

/* ================
   HTTP + SOCKET.IO
   ================ */
const httpServer = createServer(app);

const io = new Server(httpServer, {
  path: '/socket.io',
  cors: {
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  },
  pingTimeout: 25_000,
  pingInterval: 25_000,
});

io.engine.on('initial_headers', (_headers, req) => {
  console.log('[SIO handshake] origin:', req.headers.origin, 'url:', req.url);
});
io.engine.on('headers', (_headers, req) => {
  console.log('[SIO upgrade] origin:', req.headers.origin);
});
io.engine.on('connection_error', (err) => {
  console.warn('[SIO connection_error]', err?.code, err?.message);
});

/* =====================
   GAME: DATA & HELPERS
   ===================== */

// Kaarten (geïnspireerd, niet officieel)
const CARD_SET = [
  { id: 'W1', name: 'Watcher', power: 1, text: 'Kies speler en raad kaart (niet W1). Bij juist: die speler valt af.' },
  { id: 'S2', name: 'Seer',    power: 2, text: 'Raad de kaart van een speler. Bij juist: die speler valt af.' },
  { id: 'D3', name: 'Duelist', power: 3, text: 'Vergelijk handen; laagste valt af.' },
  { id: 'A4', name: 'Aegis',   power: 4, text: 'Beschermd tot volgende beurt.' },
  { id: 'C5', name: 'Courier', power: 5, text: 'Kies speler (evt. jezelf): die gooit hand af en trekt 1.' },
  { id: 'X6', name: 'Switch',  power: 6, text: 'Ruil hand met een speler.' },
  { id: 'H7', name: 'Heir',    power: 7, text: 'Moet worden gespeeld als je ook 5 of 6 hebt.' },
  { id: 'O8', name: 'Oracle',  power: 8, text: 'Als je deze aflegt, lig je uit.' }
];
const COUNTS = { W1:5, S2:2, D3:2, A4:2, C5:2, X6:1, H7:1, O8:1 };

const byId = Object.fromEntries(CARD_SET.map(c => [c.id, c]));

/** Maak en schud deck */
function makeDeck() {
  const deck = [];
  for (const c of CARD_SET) {
    const n = COUNTS[c.id] || 0;
    for (let i = 0; i < n; i++) deck.push({ ...c });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function publicPlayerView(p) {
  const { id, name, eliminated, protectedUntil, hand } = p;
  return {
    id,
    name,
    eliminated,
    protected: !!p.protected,
    protectedUntil,
    handCount: Array.isArray(hand) ? hand.length : 0,
  };
}

function serializeRoom(room, forSocketId) {
  return {
    id: room.id,
    createdAt: room.createdAt,
    hostId: room.hostId,
    started: room.started,
    turnIndex: room.turnIndex,
    turn: room.turn,
    deckCount: room.deck.length,
    discard: room.discard.map(c => c.id), // alleen ids publiek
    players: room.players.map(publicPlayerView),
    me: forSocketId
      ? {
          hand: room.players.find(p => p.id === forSocketId)?.hand ?? [],
        }
      : undefined,
  };
}

function findPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function alivePlayers(room) {
  return room.players.filter(p => !p.eliminated);
}

function nextAliveIndex(room, startIndex) {
  const n = room.players.length;
  for (let step = 1; step <= n; step++) {
    const i = (startIndex + step) % n;
    if (!room.players[i].eliminated) return i;
  }
  return -1;
}

function drawOne(room) {
  return room.deck.shift() || null;
}

function playerOtherCard(player, playedId) {
  return player.hand.find(c => c.id !== playedId);
}

function removeFromHand(player, cardId) {
  const idx = player.hand.findIndex(c => c.id === cardId);
  if (idx >= 0) return player.hand.splice(idx, 1)[0];
  return null;
}

function endRound(room, reason = 'deck-empty') {
  const alive = alivePlayers(room);
  let winners = [];
  if (alive.length === 1) {
    winners = alive;
  } else {
    // Deck leeg → hoogste hand-power wint
    let bestPower = -1;
    for (const p of alive) {
      const power = (p.hand[0]?.power || 0);
      if (power > bestPower) {
        bestPower = power;
        winners = [p];
      } else if (power === bestPower) {
        winners.push(p);
      }
    }
  }
  room.started = false;
  room.winners = winners.map(w => ({ id: w.id, name: w.name, power: w.hand[0]?.power || 0 }));
  return room.winners;
}

function startGame(room) {
  room.deck = makeDeck();
  room.discard = [];
  room.turnIndex = 0;
  room.turn = 1;
  room.started = true;
  room.winners = [];
  // reset players
  for (const p of room.players) {
    p.eliminated = false;
    p.protected = false;
    p.protectedUntil = 0;
    p.hand = [];
  }
  // iedereen 1 kaart
  for (const p of room.players) {
    const c = drawOne(room);
    if (c) p.hand.push(c);
  }
  // top Player begint: trek 1 (zodat hij 2 kaarten heeft)
  const cur = room.players[room.turnIndex];
  const c2 = drawOne(room);
  if (c2) cur.hand.push(c2);
}

function advanceTurn(room) {
  // win check vóór turn-advance
  if (alivePlayers(room).length <= 1) {
    endRound(room, 'all-eliminated');
    return;
  }
  if (room.deck.length === 0) {
    endRound(room, 'deck-empty');
    return;
  }
  // volgende speler
  const ni = nextAliveIndex(room, room.turnIndex);
  room.turnIndex = ni;
  room.turn += 1;

  const cur = room.players[room.turnIndex];
  // beschermingsshield (A4) vervalt aan begin van je eigen beurt
  if (cur.protected) cur.protected = false;

  const c = drawOne(room);
  if (c) cur.hand.push(c);
}

function discardTo(room, card, targetDiscard = room.discard) {
  if (card) targetDiscard.push(card);
}

/* =====================
   ROOMS
   ===================== */
const rooms = new Map(); // id -> room
function getOrCreateRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = {
      id,
      createdAt: Date.now(),
      hostId: null,
      players: [],
      deck: [],
      discard: [],
      turnIndex: 0,
      turn: 1,
      started: false,
      winners: [],
    };
    rooms.set(id, room);
  }
  return room;
}

function broadcastRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit('state', serializeRoom(room, p.id));
  }
}

/* =====================
   SOCKET HANDLERS
   ===================== */
io.on('connection', (socket) => {
  console.log('[connect]', socket.id, 'origin:', socket.request.headers.origin);

  socket.on('join', ({ roomId, name }) => {
    try {
      if (!roomId || !name) return socket.emit('error-msg', 'roomId en naam vereist.');
      const room = getOrCreateRoom(roomId);
      if (room.started) return socket.emit('error-msg', 'Spel is al gestart.');

      if (!room.hostId) room.hostId = socket.id;
      const exists = room.players.find(p => p.id === socket.id);
      if (!exists) {
        room.players.push({
          id: socket.id,
          name: String(name).slice(0, 32),
          hand: [],
          eliminated: false,
          protected: false,
          protectedUntil: 0,
          joinedAt: Date.now(),
        });
      } else {
        exists.name = String(name).slice(0, 32);
      }
      socket.join(roomId);
      broadcastRoom(room);
    } catch (e) {
      console.error('join error', e);
      socket.emit('error-msg', 'Join fout.');
    }
  });

  socket.on('rename', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const me = findPlayer(room, socket.id);
    if (!me) return;
    me.name = String(name || '').slice(0, 32);
    broadcastRoom(room);
  });

  socket.on('start', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error-msg', 'Room bestaat niet.');
    if (room.hostId !== socket.id) return socket.emit('error-msg', 'Alleen host mag starten.');
    if (room.players.length < 2) return socket.emit('error-msg', 'Minstens 2 spelers nodig.');
    startGame(room);
    broadcastRoom(room);
  });

  socket.on('chat', ({ roomId, msg }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const me = findPlayer(room, socket.id);
    if (!me) return;
    io.to(roomId).emit('chat', { from: me.name, msg: String(msg || '').slice(0, 500), ts: Date.now() });
  });

  socket.on('play', ({ roomId, cardId, targetId, guessId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.started) return socket.emit('error-msg', 'Geen actief spel.');
    if (room.winners?.length) return; // ronde is net afgelopen

    const meIdx = room.players.findIndex(p => p.id === socket.id);
    if (meIdx < 0) return socket.emit('error-msg', 'Niet in room.');
    if (meIdx !== room.turnIndex) return socket.emit('error-msg', 'Niet jouw beurt.');
    const me = room.players[meIdx];
    if (me.eliminated) return socket.emit('error-msg', 'Je ligt eruit.');

    // H7-regel afdwingen
    const hasH7 = me.hand.some(c => c.id === 'H7');
    const hasC5 = me.hand.some(c => c.id === 'C5');
    const hasX6 = me.hand.some(c => c.id === 'X6');
    if (hasH7 && (hasC5 || hasX6) && cardId !== 'H7') {
      return socket.emit('error-msg', 'Je MOET H7 spelen als je 5 of 6 ook hebt.');
    }

    // kaart uit hand halen
    const played = removeFromHand(me, cardId);
    if (!played) return socket.emit('error-msg', 'Kaart niet in hand.');

    const putToDiscard = () => discardTo(room, played);

    // Zielwit (indien meegegeven)
    const target = targetId ? room.players.find(p => p.id === targetId) : null;
    const targetProtected = target?.protected;

    // EFFECTEN
    try {
      switch (played.id) {
        case 'W1': {
          // Watcher: target + guess verplicht, mag geen W1 raden
          if (!target || target.eliminated) throw new Error('Ongeldige target.');
          if (targetProtected) break; // geen effect
          if (!guessId || guessId === 'W1') throw new Error('Ongeldige gok.');
          const hit = target.hand.some(c => c.id === guessId);
          if (hit) {
            target.eliminated = true;
            // target gooit hand weg
            while (target.hand.length) discardTo(room, target.hand.pop());
          }
          break;
        }
        case 'S2': {
          // Seer: zelfde simplified rule als W1 (raad exact)
          if (!target || target.eliminated) throw new Error('Ongeldige target.');
          if (targetProtected) break;
          if (!guessId) throw new Error('Gok vereist.');
          const hit = target.hand.some(c => c.id === guessId);
          if (hit) {
            target.eliminated = true;
            while (target.hand.length) discardTo(room, target.hand.pop());
          }
          break;
        }
        case 'D3': {
          if (!target || target.eliminated) throw new Error('Ongeldige target.');
          if (targetProtected) break;
          const myCard = playerOtherCard(me, 'D3');
          const theirCard = target.hand[0];
          if (!myCard || !theirCard) break;
          if (myCard.power > theirCard.power) {
            target.eliminated = true;
            discardTo(room, target.hand.pop());
          } else if (theirCard.power > myCard.power) {
            me.eliminated = true;
            discardTo(room, myCard);
            me.hand = []; // leeg, me ligt eruit
          } // gelijk → niets
          break;
        }
        case 'A4': {
          // bescherming tot eigen volgende beurt
          me.protected = true;
          break;
        }
        case 'C5': {
          if (!target || target.eliminated) throw new Error('Ongeldige target.');
          if (targetProtected) break;
          const tossed = target.hand.pop();
          if (tossed) {
            discardTo(room, tossed);
            if (tossed.id === 'O8') {
              target.eliminated = true;
            } else {
              const newC = drawOne(room);
              if (newC) target.hand.push(newC);
            }
          }
          break;
        }
        case 'X6': {
          if (!target || target.eliminated) throw new Error('Ongeldige target.');
          if (targetProtected) break;
          const myCard = playerOtherCard(me, 'X6');
          const theirCard = target.hand[0];
          if (myCard && theirCard) {
            // swap
            target.hand[0] = myCard;
            me.hand = me.hand.filter(c => c.id === 'X6'); // enkel de gespeelde kaart is nu nog in hand (dadelijk weg)
            me.hand.push(theirCard);
          }
          break;
        }
        case 'H7': {
          // geen direct effect
          break;
        }
        case 'O8': {
          // speler ligt eruit als hij O8 aflegt
          me.eliminated = true;
          me.hand = []; // leeg
          break;
        }
        default: {
          // onbekend: niets
          break;
        }
      }
    } catch (err) {
      // rollback: kaart terug in hand bij fout
      me.hand.push(played);
      return socket.emit('error-msg', err.message || 'Ongeldige actie.');
    }

    // gespeelde kaart naar discard
    putToDiscard();

    // na effect: check wincondities / beurtoverdracht
    if (!room.started) {
      // ronde was net beëindigd
      broadcastRoom(room);
      return;
    }

    if (alivePlayers(room).length <= 1) {
      endRound(room, 'all-eliminated');
      broadcastRoom(room);
      return;
    }

    if (room.deck.length === 0) {
      endRound(room, 'deck-empty');
      broadcastRoom(room);
      return;
    }

    // Als de speler zichzelf elimineerde via O8, zorg dat hij niet meer meedoet.
    // Dan beurt doorgeven.
    advanceTurn(room);
    broadcastRoom(room);
  });

  socket.on('state:pull', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    socket.emit('state', serializeRoom(room, socket.id));
  });

  socket.on('leave', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.hostId === socket.id) room.hostId = room.players[0]?.id || null;
    socket.leave(roomId);
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    // Als speler in een room zat: markeer als weg
    for (const room of rooms.values()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx >= 0) {
        // In pre-game: gewoon verwijderen
        if (!room.started) {
          room.players.splice(idx, 1);
          if (room.hostId === socket.id) room.hostId = room.players[0]?.id || null;
        } else {
          // In-game: elimineren
          const p = room.players[idx];
          p.eliminated = true;
          p.hand = [];
          if (room.turnIndex === idx) {
            advanceTurn(room);
          } else if (idx < room.turnIndex) {
            // turnoordeel verschuift mee
            room.turnIndex = Math.max(0, room.turnIndex - 1);
          }
        }
        broadcastRoom(room);
      }
    }
    console.log('[disconnect]', socket.id);
  });
});

/* ================
   START SERVER
   ================ */
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log('Server luistert op poort', PORT);
  console.log('Allowed origins:', ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '(none, fallback allow-all ON)');
  if (ORIGINS_REGEX) console.log('Allowed regex:', ORIGINS_REGEX);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM ontvangen – sluit HTTP en Socket.IO…');
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
});
