// index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();

// ====== ORIGINS TOESTAAN ======
const ALLOWLIST = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://lambent-faloodeh-b37b2d.netlify.app', // jouw Netlify site
  // voeg hier extra sites toe als je later een custom domein gebruikt
]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server / curl
  try {
    const h = new URL(origin).origin;
    if (ALLOWLIST.has(h)) return true;
    // evt. alle Netlify subdomeinen toestaan:
    const host = new URL(origin).hostname;
    if (/\.netlify\.app$/i.test(host)) return true;
  } catch {}
  return false;
}

app.set('trust proxy', 1);

// CORS voor REST/health en preflight
app.use(cors({
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));
app.options('*', cors());

// Simpele healthcheck
app.get('/', (req, res) => {
  res.type('text').send('Mystery Letter server up');
});
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// HTTP + Socket.IO
const httpServer = createServer(app);

const io = new Server(httpServer, {
  path: '/socket.io',
  // CORS voor Socket.IO handshakes
  cors: {
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      cb(new Error('CORS (io): origin not allowed'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Extra guard: afgewezen origins expliciet blokkeren met duidelijke 400
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb('origin not allowed', false);
  },
});

// -------- Socket.IO events (voorbeeld) --------
io.on('connection', (socket) => {
  console.log('client connected:', socket.id, 'origin:', socket.handshake.headers.origin);

  socket.on('ping', () => socket.emit('pong'));

  socket.on('disconnect', (reason) => {
    console.log('client disconnected:', socket.id, reason);
  });
});

// ====== START SERVER ======
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('Server luistert op poort', PORT);
});
