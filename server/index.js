import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import db from './db.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-prod';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

const upload = multer({ dest: path.join(__dirname, '../uploads') });

// --- Auth endpoints ---
app.post('/api/signup', async (req, res) => {
  const { email, name, password } = req.body || {};
  if (!email || !name || !password) return res.status(400).json({ error: 'Missing fields' });
  const hash = await bcrypt.hash(password, 12);
  try {
    const stmt = db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)');
    const info = stmt.run(email, name, hash, Date.now());
    const user = { id: info.lastInsertRowid, email, name };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

// --- Rooms & Invites ---
app.post('/api/rooms', authMiddleware, (req, res) => {
  const { id, name } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'Missing room id/name' });
  try {
    db.prepare('INSERT INTO rooms (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)').run(id, name, req.user.id, Date.now());
    res.json({ id, name });
  } catch {
    res.status(409).json({ error: 'Room already exists' });
  }
});

app.post('/api/rooms/:roomId/invites', authMiddleware, (req, res) => {
  const { roomId } = req.params;
  const { emails } = req.body || {};
  if (!Array.isArray(emails) || emails.length === 0) return res.status(400).json({ error: 'No emails provided' });

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.owner_user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

  const stmt = db.prepare('INSERT OR IGNORE INTO room_invites (room_id, email, invited_by, created_at) VALUES (?, ?, ?, ?)');
  emails.forEach(email => stmt.run(roomId, email.toLowerCase(), req.user.id, Date.now()));
  res.json({ ok: true });
});

// --- File upload ---
app.post('/upload', authMiddleware, upload.single('file'), (req, res) => {
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ fileUrl, originalName: req.file.originalname });
});

// --- Polls list (optional API) ---
app.get('/api/rooms/:roomId/polls', authMiddleware, (req, res) => {
  const { roomId } = req.params;
  const polls = db.prepare('SELECT * FROM polls WHERE room_id = ? ORDER BY created_at DESC').all(roomId);
  res.json(polls.map(p => ({ ...p, options: JSON.parse(p.options_json), options_json: undefined })));
});

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// --- Socket.IO with auth ---
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('auth required'));
  try { socket.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { next(new Error('invalid token')); }
});

const roomsPeers = new Map();

io.on('connection', (socket) => {
  socket.on('join', ({ roomId }) => {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room) return socket.emit('error-msg', 'Room not found');

    const invited = db.prepare('SELECT 1 FROM room_invites WHERE room_id = ? AND email = ?')
      .get(roomId, (socket.user.email || '').toLowerCase());
    const isOwner = room.owner_user_id === socket.user.id;
    if (!invited && !isOwner) return socket.emit('error-msg', 'You are not invited to this room');

    socket.join(roomId);
    socket.data = { roomId };
    const peers = roomsPeers.get(roomId) || new Set();
    peers.add(socket.id);
    roomsPeers.set(roomId, peers);

    socket.to(roomId).emit('peer-joined', { id: socket.id, name: socket.user.name });
    io.to(socket.id).emit('peers', [...peers].filter(id => id !== socket.id));
  });

  socket.on('chat-message', ({ roomId, message }) => {
    if (!isInRoom(socket, roomId)) return;
    io.to(roomId).emit('chat-message', { id: socket.id, name: socket.user.name, message, at: Date.now() });
  });

  socket.on('file-shared', ({ roomId, fileUrl, originalName }) => {
    if (!isInRoom(socket, roomId)) return;
    io.to(roomId).emit('file-shared', { id: socket.id, name: socket.user.name, fileUrl, originalName, at: Date.now() });
  });

  // Polls create/vote
  socket.on('poll-create', ({ roomId, question, options }) => {
    if (!isInRoom(socket, roomId)) return;
    if (!question || !Array.isArray(options) || options.length < 2) return;
    const pollId = `poll_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    db.prepare('INSERT INTO polls (id, room_id, question, options_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(pollId, roomId, question, JSON.stringify(options), socket.user.id, Date.now());
    io.to(roomId).emit('poll-created', { id: pollId, roomId, question, options, createdBy: socket.user.name, createdAt: Date.now() });
  });

  socket.on('poll-vote', ({ roomId, pollId, optionIndex }) => {
    if (!isInRoom(socket, roomId)) return;
    const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND room_id = ?').get(pollId, roomId);
    if (!poll) return;
    try {
      db.prepare('INSERT INTO poll_votes (poll_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)')
        .run(pollId, socket.user.id, optionIndex, Date.now());
    } catch { /* already voted */ }
    const counts = db.prepare('SELECT option_index, COUNT(*) as c FROM poll_votes WHERE poll_id = ? GROUP BY option_index').all(pollId);
    io.to(roomId).emit('poll-results', { pollId, counts });
  });

  // WebRTC signaling
  socket.on('signal', ({ roomId, targetId, data }) => {
    if (!isInRoom(socket, roomId)) return;
    io.to(targetId).emit('signal', { fromId: socket.id, data });
  });

  socket.on('disconnect', () => {
    const { roomId } = socket.data || {};
    if (!roomId) return;
    const peers = roomsPeers.get(roomId);
    if (peers) {
      peers.delete(socket.id);
      if (peers.size === 0) roomsPeers.delete(roomId);
      socket.to(roomId).emit('peer-left', { id: socket.id, name: socket.user?.name });
    }
  });
});

function isInRoom(socket, roomId) {
  return socket.data?.roomId === roomId;
}

httpServer.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});
