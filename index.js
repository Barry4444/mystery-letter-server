// index.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();

/* (4) CORS: zet hier ALLE toegestane origins */
const allowedOrigins = [
  'https://mystery-letter-game.netlify.app', // jouw Netlify client
  'http://localhost:5173',                   // lokaal Vite dev
  // voeg hier extra domeinen toe als je die gebruikt
];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

/* simpele health endpoints voor Render */
app.get('/', (_req, res) => res.type('text').send('OK'));
app.get('/health', (_req, res) => res.json({ ok: true, at: Date.now() }));

const server = http.createServer(app);

/* Socket.IO server met hetzelfde path als de client gebruikt */
const io = new Server(server, {
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

/* (3) EVENT-HANDLERS: binnen io.on('connection', ...) */
io.on('connection', (socket) => {
  console.log('client connected', socket.id);

  // ping; client verwacht een ACK
  socket.on('ping:server', (_data, ack) => {
    ack?.({ ok: true, at: Date.now(), you: socket.id });
  });

  // join; client doet s.timeout(...).emit('join', {...}, ack)
  socket.on('join', ({ roomId, name } = {}, ack) => {
    try {
      if (!roomId) return ack?.({ ok: false, error: 'roomId required' });
      socket.join(roomId);
      socket.data.name = name || `User-${socket.id.slice(0, 4)}`;
      // Broadcast naar de room dat iemand binnen is
      socket.to(roomId).emit('room:user-joined', {
        id: socket.id,
        name: socket.data.name,
      });
      ack?.({ ok: true, roomId, id: socket.id });
    } catch (err) {
      ack?.({ ok: false, error: err.message || 'join failed' });
    }
  });

  socket.on('disconnect', (reason) => {
    // Optioneel: laat de room(s) weten dat iemand weg is
    const rooms = [...socket.rooms].filter((r) => r !== socket.id);
    rooms.forEach((r) =>
      io.to(r).emit('room:user-left', { id: socket.id, reason })
    );
    console.log('disconnect', socket.id, reason);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server luistert op poort ${PORT}`);
});
