// index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();

/* =========================
   CORS / ORIGIN-ALLOWLIST
   ========================= */
// Voorbeeld (Render → Environment):
// ALLOWED_ORIGINS=https://mystery-letter.netlify.app
// ALLOWED_ORIGINS_REGEX=^https:\/\/.*--mystery-letter.*\.netlify\.app$
const RAW_ORIGINS = process.env.ALLOWED_ORIGINS || '';
const ALLOWED_ORIGINS = RAW_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
const ORIGINS_REGEX = process.env.ALLOWED_ORIGINS_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGINS_REGEX)
  : null;

// Als je niets geconfigureerd hebt, laten we ALLES toe (handig tijdens debug).
// Zet ALLOWED_ORIGINS/REGEX zodra het werkt.
const allowAll = ALLOWED_ORIGINS.length === 0 && !ORIGINS_REGEX;

const isAllowedOrigin = (origin) => {
  // server-naar-server / curl request (zonder Origin) mag
  if (!origin) return true;
  if (allowAll) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (ORIGINS_REGEX?.test(origin)) return true;
  console.warn('[CORS BLOCKED]', origin);
  return false;
};

// Express CORS (voor HTTP/polling)
app.use(cors({
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

// Eenvoudige healthcheck
app.get('/health', (_req, res) => res.type('text').send('OK'));

/* =========================
   HTTP + Socket.IO
   ========================= */
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
  // Iets ruimer timen achter proxies
  pingTimeout: 25_000,
  pingInterval: 25_000,
});

// Handige logs in Render -> Logs (helpt bij CORS/upgrade debugging)
io.engine.on('initial_headers', (_headers, req) => {
  console.log('[SIO handshake] origin:', req.headers.origin, 'url:', req.url);
});
io.engine.on('headers', (_headers, req) => {
  console.log('[SIO upgrade] origin:', req.headers.origin);
});
io.engine.on('connection_error', (err) => {
  console.warn('[SIO connection_error]', err?.code, err?.message);
});

// === Socket handlers (voeg je eigen events hier toe) ===
io.on('connection', (socket) => {
  console.log('client connected:', socket.id, 'origin:', socket.request.headers.origin);

  socket.on('ping', () => socket.emit('pong'));
  // Voorbeeld:
  // socket.on('joinRoom', (roomId) => {
  //   socket.join(roomId);
  //   socket.to(roomId).emit('joined', socket.id);
  // });

  socket.on('disconnect', (reason) => {
    console.log('client disconnected:', socket.id, 'reason:', reason);
  });
});

/* =========================
   START SERVER
   ========================= */
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log('Server luistert op poort', PORT);
  console.log('Allowed origins:', ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '(none, fallback allow-all ON)');
  if (ORIGINS_REGEX) console.log('Allowed regex:', ORIGINS_REGEX);
});

// Netjes afsluiten op Render
process.on('SIGTERM', () => {
  console.log('SIGTERM ontvangen – sluit HTTP en Socket.IO…');
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
});
