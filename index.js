// index.js
import 'dotenv/config';               // voor lokaal .env gebruik
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();

// ---- Config via ENV ----
const PORT = process.env.PORT || 3001;
const SOCKET_PATH = process.env.SOCKET_PATH || '/socket.io';

// CSV lijst (exacte matches)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Optioneel: regex voor bv. Netlify deploy previews
// vb: ^https:\/\/[a-z0-9-]+--mystery-letter-client\.netlify\.app$
const ALLOWED_ORIGINS_REGEX = process.env.ALLOWED_ORIGINS_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGINS_REGEX)
  : null;

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // server-to-server / curl
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (ALLOWED_ORIGINS_REGEX && ALLOWED_ORIGINS_REGEX.test(origin)) return true;
  return false;
};

// ---- CORS (Express + Socket.IO) ----
app.use(cors({
  origin(origin, cb) {
    isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.get('/health', (_, res) => res.status(200).send('OK'));

const httpServer = createServer(app);

const io = new Server(httpServer, {
  path: SOCKET_PATH,
  cors: {
    origin(origin, cb) {
      isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'));
    },
    credentials: true
  },
  transports: ['websocket'] // zorgt voor wss in prod
});

// ---- Sockets ----
io.on('connection', (socket) => {
  console.log('client connected', socket.id);
  socket.on('ping', () => socket.emit('pong'));
  socket.on('disconnect', (reason) => console.log('client disconnected', socket.id, reason));
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log('Allowed origins:', ALLOWED_ORIGINS);
  if (ALLOWED_ORIGINS_REGEX) console.log('Allowed origins (regex):', ALLOWED_ORIGINS_REGEX);
  console.log('Socket path:', SOCKET_PATH);
});
