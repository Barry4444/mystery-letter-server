// index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();

/* ---------------------- Config ---------------------- */
const PORT = process.env.PORT || 3001;
const SOCKET_PATH = process.env.SOCKET_PATH || '/socket.io';

// Optionele allowlist (CSV) en/of regex voor origins (Netlify, localhost, enz.)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Voor bijv. Netlify deploy previews kun je een regex gebruiken:
// ALLOWED_ORIGINS_REGEX="^https:\\/\\/.*--mystery-letter-client\\.netlify\\.app$"
const ALLOWED_ORIGINS_REGEX = process.env.ALLOWED_ORIGINS_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGINS_REGEX)
  : null;

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // server-to-server/curl
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (ALLOWED_ORIGINS_REGEX?.test(origin)) return true;
  return false;
};

/* -------------------- Middleware -------------------- */
app.use(cors({
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());

/* ---------------- Health & Root --------------------- */
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.status(200).send('Mystery Letter server is running'));

/* ------------------ HTTP + SIO ---------------------- */
const httpServer = createServer(app);

const io = new Server(httpServer, {
  path: SOCKET_PATH,
  cors: {
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST'],
  },
  // transports laat je standaard staan; Socket.IO schakelt zelf over naar wss
  // indien de client via HTTPS draait.
});

io.on('connection', (socket) => {
  console.log('client connected', socket.id, 'origin:', socket.handshake.headers.origin);

  socket.on('ping', () => socket.emit('pong'));

  socket.on('disconnect', (reason) => {
    console.log('client disconnected', socket.id, reason);
  });
});

/* Belangrijk op Render: bind aan 0.0.0.0 zodat externe connecties werken */
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server luistert op poort ${PORT}`);
  console.log('Socket path:', SOCKET_PATH);
  console.log('Allowed origins (list):', ALLOWED_ORIGINS);
  if (ALLOWED_ORIGINS_REGEX) console.log('Allowed origins (regex):', ALLOWED_ORIGINS_REGEX);
});
