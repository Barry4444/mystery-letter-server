// index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();

// --- Config ---
const PORT = process.env.PORT || 3001;
const SOCKET_PATH = process.env.SOCKET_PATH || '/socket.io';

// Optionele allowlist (CSV) en/of regex voor origins (Netlify, preview URL's, …)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS_REGEX = process.env.ALLOWED_ORIGINS_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGINS_REGEX)
  : null;

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // server-to-server/curl
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (ALLOWED_ORIGINS_REGEX?.test(origin)) return true;
  return false;
};

// --- Middleware ---
app.use(cors({
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());

// --- Health & root routes ---
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.status(200).send('Mystery Letter server is running'));

// --- HTTP + Socket.IO ---
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
});

io.on('connection', (socket) => {
  console.log('client connected', socket.id);
  socket.on('ping', () => socket.emit('pong'));
  socket.on('disconnect', (reason) => {
    console.log('client disconnected', socket.id, reason);
  });
});

// Belangrijk: bind op 0.0.0.0 zodat Render extern kan verbinden
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server luistert op poort ${PORT}`);
  console.log('Socket path:', SOCKET_PATH);
  console.log('Allowed origins (list):', ALLOWED_ORIGINS);
  if (ALLOWED_ORIGINS_REGEX) console.log('Allowed origins (regex):', ALLOWED_ORIGINS_REGEX);
});
