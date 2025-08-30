import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// CORS: Render ↔ Netlify
const allowed = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowed.length === 0) return cb(null, true);
    const ok = allowed.some(a => origin === a);
    cb(ok ? null : new Error("CORS blocked"), ok);
  }
}));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowed.length === 0) return cb(null, true);
      const ok = allowed.some(a => origin === a);
      cb(ok ? null : new Error("CORS blocked"), ok);
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  path: "/socket.io",
  transports: ["websocket"]
});

/* -------------------- Game data & helpers -------------------- */

const RANK = {
  "Ziener": 1,
  "Wolf": 2,
  "Ridder": 3,
  "Zeemeermin": 4,
  "God": 5,
  "Emir": 6,
  "Heks": 7,
  "Prinses": 8
};

const ORDER = Object.keys(RANK);
const START_COINS_TO_WIN = 3;

function buildDeck() {
  const add = (name, n, arr) => { for (let i=0;i<n;i++) arr.push(name); };
  const deck = [];
  add("Ziener", 5, deck);
  add("Wolf", 2, deck);
  add("Ridder", 2, deck);
  add("Zeemeermin", 2, deck);
  add("God", 1, deck);
  add("Emir", 1, deck);
  add("Heks", 2, deck);
  add("Prinses", 1, deck);
  return shuffle(deck);
}
function shuffle(a) {
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

const rooms = new Map();
// room = { hostId, musicOn, players(Map), deck, discard, roundActive, turnOrder, turnIdx, log, id }

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostId: null,
      musicOn: false,
      players: new Map(),
      deck: [],
      discard: [],
      roundActive: false,
      turnOrder: [],
      turnIdx: 0,
      log: [],
      id: roomId
    });
  }
  return rooms.get(roomId);
}

function addLog(room, msg) {
  room.log.unshift({ t: Date.now(), msg });
  if (room.log.length > 50) room.log.pop();
}

function alivePlayers(room) {
  return room.turnOrder.filter(id => {
    const p = room.players.get(id);
    return p && !p.eliminated;
  });
}

function summarizeFor(room, meId) {
  const players = room.turnOrder.map(id => {
    const p = room.players.get(id);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      cards: p.hand.length,
      eliminated: !!p.eliminated,
      protected: !!p.protected,
      coins: p.coins ?? 0
    };
  }).filter(Boolean);

  return {
    hostId: room.hostId,
    deckCount: room.deck.length,
    discardCount: room.discard.length,
    turn: room.roundActive ? room.turnOrder[room.turnIdx] : null,
    players,
    roundActive: room.roundActive,
    log: room.log.slice(0, 50),
    meId
  };
}

function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [id, p] of room.players.entries()) {
    io.to(id).emit("room:update", summarizeFor(room, id));
    io.to(id).emit("me:hand", p.hand.slice());
  }
}

function eliminate(room, playerId, cause = "") {
  const p = room.players.get(playerId);
  if (!p || p.eliminated) return;
  p.eliminated = true;
  room.discard.push(...p.hand);
  p.hand = [];
  addLog(room, `❌ ${p.name} ligt uit. ${cause}`);
}

function drawCard(room, playerId) {
  if (room.deck.length === 0) return null;
  const c = room.deck.pop();
  const p = room.players.get(playerId);
  p.hand.push(c);
  return c;
}

function mustPlayHeks(hand) {
  return hand.includes("Heks") && (hand.includes("God") || hand.includes("Emir"));
}

/* ---------- AUTO DRAW: trek 2e kaart bij start beurt ---------- */
function maybeAutoDraw(room) {
  if (!room.roundActive) return;
  const curId = room.turnOrder[room.turnIdx];
  const cur = room.players.get(curId);
  if (!cur || cur.eliminated) return;

  // als deck leeg is: niets trekken (showdown kan later triggeren)
  if (room.deck.length === 0) return;

  // alleen als speler <2 kaarten heeft
  if (cur.hand.length < 2) {
    const c = drawCard(room, curId);
    if (c) addLog(room, `${cur.name} trekt automatisch een kaart.`);
    broadcastState(room.id);
  }
}

function endRound(room, winnerId, reason) {
  room.roundActive = false;
  if (winnerId) {
    const w = room.players.get(winnerId);
    if (w) {
      w.coins = (w.coins || 0) + 1;
      addLog(room, `🏆 ${w.name} wint de ronde (${reason}) en krijgt 1 munt (nu ${w.coins}).`);
      if (w.coins >= START_COINS_TO_WIN) {
        addLog(room, `🎉 ${w.name} wint het spel met ${w.coins} munt(en)!`);
      }
    }
  } else {
    addLog(room, `Ronde eindigt zonder duidelijke winnaar (${reason}).`);
  }
  broadcastState(room.id);
}

function endRoundByShowdown(room, reason = "deck leeg (showdown)") {
  const aliveIds = alivePlayers(room);
  if (aliveIds.length === 0) {
    addLog(room, `Ronde eindigt zonder winnaar (${reason}).`);
    room.roundActive = false;
    broadcastState(room.id);
    return;
  }
  let best = null;
  let bestRank = -1;
  for (const id of aliveIds) {
    const p = room.players.get(id);
    const card = p.hand[0];
    const r = RANK[card] || 0;
    if (r > bestRank) { bestRank = r; best = id; }
  }
  endRound(room, best, reason);
}

function nextTurn(room) {
  if (!room.roundActive) return;
  let tries = 0;
  const n = room.turnOrder.length;
  do {
    room.turnIdx = (room.turnIdx + 1) % n;
    tries++;
    if (tries > n + 5) break;
  } while (room.players.get(room.turnOrder[room.turnIdx])?.eliminated);

  // bescherming vervalt aan het BEGIN van je eigen beurt
  const curId = room.turnOrder[room.turnIdx];
  const cur = room.players.get(curId);
  if (cur) cur.protected = false;

  // check of er nog 1 speler leeft
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    endRound(room, alive[0] || null, "alleen speler over");
    return;
  }

  // auto draw voor nieuwe actieve speler
  maybeAutoDraw(room);
}

/* -------------------- Ronde setup -------------------- */

function startRound(room) {
  room.deck = buildDeck();
  room.discard = [];
  room.roundActive = true;
  addLog(room, "— Nieuwe ronde gestart —");

  const order = [];
  for (const [id, p] of room.players.entries()) {
    p.eliminated = false;
    p.protected = false;
    p.hand = [];
    order.push(id);
  }
  room.turnOrder = shuffle(order);
  room.turnIdx = 0;

  // deel 1 kaart aan iedereen
  for (const id of room.turnOrder) {
    if (room.players.get(id)?.eliminated) continue;
    drawCard(room, id);
  }

  // bescherming van startspeler is uit bij begin
  const cur = room.players.get(room.turnOrder[room.turnIdx]);
  if (cur) cur.protected = false;

  // actieve speler trekt automatisch 2e kaart
  maybeAutoDraw(room);

  broadcastState(room.id);
}

/* -------------------- Socket events -------------------- */

io.on("connection", (socket) => {
  socket.on("ping:server", (_d, ack) => ack && ack({ ok: true, at: Date.now() }));

  socket.on("join", (data, ack) => {
    try {
      const { roomId, name } = data || {};
      if (!roomId || !name) return ack && ack("roomId and name required");
      const room = ensureRoom(roomId);
      room.id = roomId;

      room.players.set(socket.id, {
        id: socket.id,
        name: String(name).slice(0, 20),
        hand: [],
        eliminated: false,
        protected: false,
        coins: (room.players.get(socket.id)?.coins || 0)
      });
      socket.join(roomId);

      if (!room.hostId) room.hostId = socket.id;

      addLog(room, `👋 ${name} joined.`);
      ack && ack({ ok: true, isHost: room.hostId === socket.id, state: summarizeFor(room, socket.id) });
      broadcastState(roomId);
    } catch (e) {
      ack && ack(String(e?.message || e));
    }
  });

  socket.on("music:toggle", (d, ack) => {
    const { roomId, on } = d || {};
    const room = rooms.get(roomId);
    if (!room) return ack && ack("room not found");
    room.musicOn = !!on;
    io.to(room.id).emit("music:state", room.musicOn);
    ack && ack({ ok: true });
  });

  socket.on("room:new", (d, ack) => {
    const { roomId } = d || {};
    const room = rooms.get(roomId);
    if (!room) return ack && ack("room not found");
    if (room.hostId !== socket.id) return ack && ack("only host");
    for (const p of room.players.values()) p.coins = 0;
    startRound(room);
    ack && ack({ ok: true });
  });

  socket.on("room:start", (d, ack) => {
    const { roomId } = d || {};
    const room = rooms.get(roomId);
    if (!room) return ack && ack("room not found");
    if (room.hostId !== socket.id) return ack && ack("only host");
    startRound(room);
    ack && ack({ ok: true });
  });

  socket.on("turn:draw", (d, ack) => {
    const { roomId } = d || {};
    const room = rooms.get(roomId);
    if (!room) return ack && ack("room not found");
    if (!room.roundActive) return ack && ack("round not active");
    const curId = room.turnOrder[room.turnIdx];
    if (socket.id !== curId) return ack && ack("not your turn");
    const p = room.players.get(curId);
    if (!p || p.eliminated) return ack && ack("invalid player");
    if (p.hand.length >= 2) return ack && ack("already have 2 cards");
    if (room.deck.length === 0) {
      endRoundByShowdown(room, "deck leeg vóór trekken");
      return ack && ack("showdown");
    }
    const c = drawCard(room, curId);
    addLog(room, `${p.name} trekt een kaart.`);
    broadcastState(room.id);
    ack && ack({ ok: true, card: c });
  });

  socket.on("card:play", (d, ack) => {
    const { roomId, card, targetId, guess } = d || {};
    const room = rooms.get(roomId);
    if (!room) return ack && ack("room not found");
    if (!room.roundActive) return ack && ack("round not active");

    const curId = room.turnOrder[room.turnIdx];
    if (socket.id !== curId) return ack && ack("not your turn");
    const me = room.players.get(curId);
    if (!me || me.eliminated) return ack && ack("invalid player");
    if (!ORDER.includes(card)) return ack && ack("unknown card");
    if (!me.hand.includes(card)) return ack && ack("you don't hold that card");

    if (me.hand.length >= 2 && mustPlayHeks(me.hand) && card !== "Heks") {
      return ack && ack("Je MOET Heks spelen als je Heks + (God of Emir) hebt.");
    }

    me.hand.splice(me.hand.indexOf(card), 1);
    room.discard.push(card);

    const needAliveTarget = (id) => {
      const t = room.players.get(id);
      if (!t) return "target not found";
      if (t.eliminated) return "target eliminated";
      if (t.protected) return "target protected";
      return null;
    };
    const eliminateIfPrincess = (player, cause) => {
      if (player.hand.includes("Prinses")) {
        player.hand.splice(player.hand.indexOf("Prinses"), 1);
        eliminate(room, player.id, cause || "Prinses afgelegd");
        return true;
      }
      return false;
    };

    let actionMsg = "";

    try {
      switch (card) {
        case "Ziener": {
          if (!targetId || !guess) throw new Error("Ziener vereist targetId en guess");
          const err = needAliveTarget(targetId);
          if (err) throw new Error(err);
          const t = room.players.get(targetId);
          const thand = t.hand[0];
          const correct = (thand === guess);
          actionMsg = `${me.name} raadt dat ${t.name} ${guess} heeft — ${correct ? "JUIST" : "fout"}.`;
          if (correct) eliminate(room, t.id, "geraden door Ziener");
          break;
        }
        case "Wolf": {
          if (!targetId) throw new Error("Wolf vereist targetId");
          const err = needAliveTarget(targetId);
          if (err) throw new Error(err);
          const t = room.players.get(targetId);
          io.to(me.id).emit("private:peek", { target: { id: t.id, name: t.name }, hand: t.hand.slice() });
          actionMsg = `${me.name} kijkt in de hand van ${t.name}.`;
          break;
        }
        case "Ridder": {
          let tgt = me;
          if (targetId && targetId !== me.id) {
            const err = needAliveTarget(targetId);
            if (err) throw new Error(err);
            tgt = room.players.get(targetId);
          }
          tgt.protected = true;
          actionMsg = `${me.name} geeft bescherming aan ${tgt === me ? "zichzelf" : tgt.name} (1 beurt).`;
          io.to(room.id).emit("music:state", true);
          break;
        }
        case "Zeemeermin": {
          if (!targetId) throw new Error("Zeemeermin vereist targetId");
          const err = needAliveTarget(targetId);
          if (err) throw new Error(err);
          const t = room.players.get(targetId);
          if (me.hand.length === 0) throw new Error("Je hebt geen andere kaart om te vergelijken.");
          if (t.hand.length === 0) throw new Error("Tegenstander heeft geen kaart?");
          const my = RANK[me.hand[0]] || 0;
          const ot = RANK[t.hand[0]] || 0;
          if (my === ot) {
            actionMsg = `${me.name} vergelijkt met ${t.name} — gelijkspel, niemand ligt uit.`;
          } else if (my > ot) {
            eliminate(room, t.id, "verloor vergelijking met Zeemeermin");
            actionMsg = `${me.name} wint de vergelijking; ${t.name} ligt uit.`;
          } else {
            eliminate(room, me.id, "verloor vergelijking met Zeemeermin");
            actionMsg = `${t.name} wint de vergelijking; ${me.name} ligt uit.`;
          }
          break;
        }
        case "God": {
          if (!targetId) throw new Error("God vereist targetId");
          const err = needAliveTarget(targetId);
          if (err) throw new Error(err);
          const t = room.players.get(targetId);
          const tmp = me.hand.slice();
          me.hand = t.hand.slice();
          t.hand = tmp;
          room.players.set(me.id, me);
          room.players.set(t.id, t);
          actionMsg = `${me.name} wisselt kaarten met ${t.name}.`;
          break;
        }
        case "Emir": {
          const tgtId = targetId || me.id;
          const err = needAliveTarget(tgtId);
          if (err) throw new Error(err);
          const t = room.players.get(tgtId);
          if (t.hand.length) {
            const dump = t.hand.pop();
            room.discard.push(dump);
          }
          const lost = eliminateIfPrincess(t, "door Emir gedwongen te leggen");
          if (!lost) {
            if (room.deck.length === 0) {
              actionMsg = `${me.name} laat ${t.name} afleggen; deck leeg — geen nieuwe kaart.`;
            } else {
              drawCard(room, t.id);
              actionMsg = `${me.name} laat ${t.name} afleggen en nieuwe kaart trekken.`;
            }
          } else {
            actionMsg = `${me.name} laat ${t.name} afleggen — het was de Prinses! ${t.name} ligt uit.`;
          }
          break;
        }
        case "Heks": {
          actionMsg = `${me.name} legt Heks af.`;
          break;
        }
        case "Prinses": {
          eliminate(room, me.id, "Prinses afgelegd");
          actionMsg = `${me.name} legt de Prinses af en verliest.`;
          break;
        }
        default:
          throw new Error("Onbekende kaartactie");
      }

      addLog(room, actionMsg);

      const alive = alivePlayers(room);
      if (alive.length <= 1) {
        endRound(room, alive[0] || null, "alleen speler over");
      } else {
        if (room.deck.length === 0) {
          endRoundByShowdown(room);
        } else {
          nextTurn(room); // auto-draw gebeurt hier
        }
      }

      broadcastState(room.id);
      ack && ack({ ok: true });
    } catch (e) {
      me.hand.push(card);
      const idx = room.discard.lastIndexOf(card);
      if (idx >= 0) room.discard.splice(idx, 1);
      ack && ack(String(e?.message || e));
    }
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      if (!room.players.has(socket.id)) continue;

      const wasTurn = room.roundActive && room.turnOrder[room.turnIdx] === socket.id;
      const name = room.players.get(socket.id)?.name || "Speler";
      addLog(room, `👋 ${name} vertrok.`);

      if (room.hostId === socket.id) {
        room.hostId = alivePlayers(room)[0] || null;
      }

      room.players.delete(socket.id);
      room.turnOrder = room.turnOrder.filter(id => id !== socket.id);

      if (room.turnOrder.length === 0) {
        rooms.delete(roomId);
        continue;
      }

      if (wasTurn) {
        room.turnIdx = room.turnIdx % room.turnOrder.length;
        nextTurn(room); // auto-draw voor nieuwe speler
      }

      broadcastState(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
