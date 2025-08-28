import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// --- Game cards (inspired-by, not official) ---
const CARD_SET = [
  { id: 'W1', name: 'Watcher', power: 1, text: 'Kies een speler en raad een kaart (niet Watcher). Bij juist: die speler valt af.' },
  { id: 'S2', name: 'Seer', power: 2, text: 'Raad de kaart van een speler. Bij juist valt die speler af.' },
  { id: 'D3', name: 'Duelist', power: 3, text: 'Vergelijk handen; laagste valt af.' },
  { id: 'A4', name: 'Aegis', power: 4, text: 'Beschermd tot je volgende beurt.' },
  { id: 'C5', name: 'Courier', power: 5, text: 'Kies een speler (evt. jezelf): die gooit zijn hand af en trekt 1.' },
  { id: 'X6', name: 'Switch', power: 6, text: 'Ruil handen met een speler.' },
  { id: 'H7', name: 'Heir', power: 7, text: 'Moet worden gespeeld als je ook Switch of Courier hebt.' },
  { id: 'O8', name: 'Oracle', power: 8, text: 'Als je deze aflegt, lig je uit het spel.' }
];
const COUNTS = { W1:5, S2:2, D3:2, A4:2, C5:2, X6:1, H7:1, O8:1 };

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
  const { id, name, eliminated, protectedUntil } = p;
  return { id, name, eliminated, protectedUntil };
}

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { players: [], deck: [], burn: [], turn: 0, started: false, log: [] });
  }
  return rooms.get(roomId);
}

function broadcastState(roomId) {
  const room = getRoom(roomId);
  const pub = {
    players: room.players.map(publicPlayerView),
    turn: room.turn,
    started: room.started,
    deckCount: room.deck.length,
    log: room.log.slice(-12)
  };
  io.to(roomId).emit('state', pub);

  // Stuur privé hand naar elke speler
  for (const p of room.players) {
    const target = p.socketId || p.id;
    io.to(target).emit('hand', p.hand || []);
  }
}

function nextPlayer(room) {
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    room.turn = (room.turn + 1) % n;
    const p = room.players[room.turn];
    if (!p.eliminated) break;
  }
}

function drawTo(room, player) {
  if (room.deck.length > 0) player.hand.push(room.deck.pop());
}

io.on('connection', (socket) => {
  // JOIN (reconnect-veilig op basis van naam)
  socket.on('join', ({ roomId, name }) => {
    roomId = (roomId || '').trim().toUpperCase().slice(0, 8);
    name   = (name   || '').trim().slice(0, 20) || 'Speler';
    if (!roomId) return;

    socket.join(roomId);
    const room = getRoom(roomId);

    // Zelfde naam? -> beschouw als reconnect: update socketId
    let player = room.players.find(p => p.name === name && !p.eliminated);
    if (player) {
      player.socketId = socket.id;
      player.id = socket.id;
      room.log.push(`${name} opnieuw verbonden.`);
    } else {
      player = { id: socket.id, socketId: socket.id, name, eliminated: false, hand: [], protectedUntil: 0 };
      room.players.push(player);
      room.log.push(`${name} is toegetreden.`);
    }

    broadcastState(roomId);
    io.to(socket.id).emit('hand', player.hand || []);
  });

  // START
  socket.on('start', ({ roomId }) => {
    roomId = (roomId || '').trim().toUpperCase().slice(0, 8);
    const room = getRoom(roomId);
    room.deck = makeDeck();
    room.burn = [ room.deck.pop() ];
    room.turn = 0;
    room.started = true;
    room.log.push('Ronde gestart.');
    for (const p of room.players) {
      p.eliminated = false;
      p.hand = [];
      drawTo(room, p);
    }
    broadcastState(roomId);
  });

  // DRAW
  socket.on('draw', ({ roomId }) => {
    roomId = (roomId || '').trim().toUpperCase().slice(0, 8);
    const room = getRoom(roomId);
    if (!room.started) return;
    const current = room.players[room.turn];
    if (!current || current.socketId !== socket.id) return;
    if (current.hand.length < 2) {
      drawTo(room, current);
      io.to(roomId).emit('ding');
      // direct privé hand sturen zodat tweede kaart meteen zichtbaar is
      io.to(current.socketId).emit('hand', current.hand || []);
      broadcastState(roomId);
    }
  });

  // PLAY CARD (incl. Seer logica)
  socket.on('playCard', ({ roomId, cardIndex, targetId, guessId }) => {
    roomId = (roomId || '').trim().toUpperCase().slice(0, 8);
    const room = getRoom(roomId);
    if (!room.started) return;

    const player = room.players[room.turn];
    if (!player || player.socketId !== socket.id) return;
    if (typeof cardIndex !== 'number' || cardIndex < 0 || cardIndex >= player.hand.length) return;

    const [card] = player.hand.splice(cardIndex, 1);
    room.log.push(`${player.name} speelt ${card.name} (${card.power}).`);

    // Seer (S2): raad kaart van andere speler; bij juist -> eliminate
    if (card.id === 'S2') {
      const target = room.players.find(p => (p.socketId === targetId || p.id === targetId));
      if (!target || target.eliminated || target.socketId === player.socketId) {
        room.log.push(`Ongeldige target voor Ziener.`);
      } else if (!guessId) {
        room.log.push(`Geen gok doorgegeven voor Ziener.`);
      } else {
        const hit = (target.hand || []).some(c => c.id === guessId);
        if (hit) {
          target.eliminated = true;
          room.log.push(`${player.name} raadt juist (${guessId}) — ${target.name} valt af.`);
        } else {
          room.log.push(`${player.name} raadt fout (${guessId}).`);
        }
      }
    }

    // Oracle (O8): self-eliminate
    if (card.id === 'O8') {
      player.eliminated = true;
      room.log.push(`${player.name} is geëlimineerd door Oracle.`);
    }

    // Einde ronde / beurtwissel
    const active = room.players.filter(p => !p.eliminated).length;
    if (room.deck.length === 0 || active <= 1) {
      room.started = false;
      room.log.push('Ronde afgelopen.');
    } else {
      nextPlayer(room);
    }

    broadcastState(roomId);
  });

  // DISCONNECT
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      const room = getRoom(roomId);
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        const [p] = room.players.splice(idx, 1);
        room.log.push(`${p.name} heeft de kamer verlaten.`);
        broadcastState(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log('MysteryLetter server luistert op http://localhost:' + PORT);
});