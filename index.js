// index.js (ESM)
// ------------------------------
import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

// ======= Config =======
const PORT = process.env.PORT || 10000;

// Voeg hier je Netlify URL(s) toe, komma-gescheiden, bv:
// CLIENT_ORIGIN="https://mystery-letter-game.netlify.app,http://localhost:5173"
const FROM_ENV = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Fallbacks die meestal handig zijn tijdens dev
const DEFAULT_ALLOW = [
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
  /\.netlify\.app$/i,
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // health checks / server-to-server
  if (FROM_ENV.includes(origin)) return true;
  if (DEFAULT_ALLOW.some(re => re.test(origin))) return true;
  return false;
}

// ======= Express app =======
const app = express();
app.set('trust proxy', 1);

app.use(
  cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error('CORS blocked'), false);
    },
    credentials: true,
  })
);

app.use(express.json());

// Health & info endpoints (Render kijkt graag mee)
app.get('/', (_req, res) => res.status(200).send('OK'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, at: Date.now() }));
app.get('/ping', (_req, res) => res.json({ pong: true, at: Date.now() }));

// ======= HTTP server + Socket.IO =======
const server = http.createServer(app);

const io = new Server(server, {
  path: '/socket.io', // moet matchen met de client
  transports: ['websocket', 'polling'], // polling fallback kan handig zijn
  allowEIO3: false,
  cors: {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin) ? true : false),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.on('connection', (sock) => {
  const ip = sock.handshake.headers['x-forwarded-for'] || sock.handshake.address;
  const origin = sock.handshake.headers.origin;
  console.log(`[conn] ${sock.id} from ${ip} (origin: ${origin})`);

  // Log alle inkomende events
  sock.onAny((event, ...args) => {
    console.log('[in]', event, ...args);
  });

  // Eenvoudige ping -> ack
  sock.on('ping:server', (payload, ack) => {
    console.log('[ping:server]', payload);
    ack?.({ ok: true, now: Date.now() }); // BELANGRIJK: ack terugsturen
  });

  // Join handler die meerdere eventnamen accepteert
  const handleJoin = (payload = {}, ack) => {
    try {
      const { roomId, name } = payload;
      if (!roomId || !name) {
        return ack?.({ ok: false, error: 'missing roomId/name' });
      }

      sock.join(roomId);
      console.log(`[join] ${sock.id} -> ${roomId} (${name})`);

      // Ack naar de aanvrager
      ack?.({ ok: true, roomId, id: sock.id });

      // Broadcast naar de room
      sock.to(roomId).emit('user:joined', { id: sock.id, name });
    } catch (e) {
      ack?.({ ok: false, error: e.message });
    }
  };

  sock.on('join', handleJoin);
  sock.on('joinRoom', handleJoin);
  sock.on('room:join', handleJoin);

  // Optioneel: een simpel message-event
  sock.on('room:message', ({ roomId, text }, ack) => {
    if (!roomId || !text) return ack?.({ ok: false, error: 'missing roomId/text' });
    sock.to(roomId).emit('room:message', { id: sock.id, text, at: Date.now() });
    ack?.({ ok: true });
  });

  sock.on('disconnect', (reason) => {
    console.log(`[disc] ${sock.id} – ${reason}`);
  });
});

// ======= Start =======
server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
  console.log('Toegestane origins:', FROM_ENV.length ? FROM_ENV : '(defaults incl. *.netlify.app & localhost)');
});
