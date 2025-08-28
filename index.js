import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const PORT = process.env.PORT || 3001;

/**
 * Allowed origins:
 * - zet in Render env var ALLOWED_ORIGINS als CSV (bv. https://mystery-letter.netlify.app,https://mysteryletter.onrender.com)
 * - laat leeg tijdens lokale dev
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const originForCors =
  ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*'; // voor dev ok; in prod liever expliciet zetten

const app = express();
app.use(cors({ origin: originForCors, methods: ['GET', 'POST'] }));
app.use(express.json());

// Health + info
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'mystery-letter-server', time: new Date().toISOString() });
});
app.get('/healthz', (_req, res) => res.sendStatus(204));

const httpServer = createServer(app);

const io = new Server(httpServer, {
  // Cruciaal voor HTTPS-only: ga direct naar WebSocket (geen polling)
  transports: ['websocket'],
  cors: { origin: originForCors, methods: ['GET', 'POST'] },
  path: '/socket.io'
});

// --- Very basic socket events (pas aan naar je behoefte) ---
io.on('connection', (socket) => {
  console.log('client connected:', socket.id);

  socket.on('ping', () => socket.emit('pong'));

  socket.on('disconnect', (reason) => {
    console.log('client disconnected:', socket.id, reason);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});