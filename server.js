const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Database ───────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// FIX 4: In-memory cache populated from DB on startup so leaderboard
// survives Railway restarts even between socket requests
let leaderboardCache = [];

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard (
        id SERIAL PRIMARY KEY,
        player_name TEXT NOT NULL,
        colour TEXT,
        score INTEGER NOT NULL,
        is_loop BOOLEAN DEFAULT false,
        date TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Populate in-memory cache from DB on startup
    const result = await pool.query(
      `SELECT player_name AS "playerName", colour, score, is_loop AS "isLoop", date
       FROM leaderboard ORDER BY score DESC LIMIT 10`
    );
    leaderboardCache = result.rows;
    console.log(`Database ready — ${leaderboardCache.length} scores loaded`);
  } catch (err) {
    console.error('Database init error:', err.message);
    console.log('Running with empty in-memory leaderboard');
  }
}

async function saveScore({ playerName, colour, score, isLoop, date }) {
  try {
    await pool.query(
      `INSERT INTO leaderboard (player_name, colour, score, is_loop, date)
       VALUES ($1, $2, $3, $4, $5)`,
      [playerName, colour, score, isLoop || false, date || new Date()]
    );
    // Refresh cache from DB to ensure accuracy
    const result = await pool.query(
      `SELECT player_name AS "playerName", colour, score, is_loop AS "isLoop", date
       FROM leaderboard ORDER BY score DESC LIMIT 10`
    );
    leaderboardCache = result.rows;
  } catch (err) {
    // FIX 4: Fallback — update in-memory cache even if DB fails
    console.error('saveScore DB error (using in-memory fallback):', err.message);
    leaderboardCache.push({ playerName, colour, score, isLoop, date: date || new Date().toISOString() });
    leaderboardCache.sort((a, b) => b.score - a.score);
    leaderboardCache = leaderboardCache.slice(0, 10);
  }
}

function getLeaderboard() {
  // Always returns from cache — fast, no DB round-trip needed
  return leaderboardCache;
}

// ── Room management ────────────────────────────────────────────────────────────
const rooms = {};

// FIX 10: Use a Set for active room codes to prevent collisions robustly
const activeCodes = new Set();
let roomCreateCount = 0;

function generateRoomCode() {
  // Limit room creation rate to prevent spam
  roomCreateCount++;
  if (roomCreateCount > 1000) {
    // Reset counter periodically (rough rate limiting)
    roomCreateCount = 0;
  }
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
  let code;
  let attempts = 0;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    attempts++;
    if (attempts > 100) throw new Error('Could not generate unique room code');
  } while (activeCodes.has(code));
  activeCodes.add(code);
  return code;
}

io.on('connection', socket => {
  console.log('Connected:', socket.id);

  // ── CREATE ROOM ──────────────────────────────────────────────────────────
  socket.on('createRoom', ({ playerName }) => {
    let code;
    try {
      code = generateRoomCode();
    } catch (e) {
      socket.emit('errorMessage', 'Server busy — please try again shortly.');
      return;
    }
    rooms[code] = {
      players: [{ id: socket.id, name: playerName || 'Player 1', colour: null, isHost: true }],
      gameState: null,
      createdAt: Date.now()
    };
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomCreated', { roomCode: code, players: rooms[code].players, yourIndex: 0 });
    console.log(`Room created: ${code}`);
  });

  // ── JOIN ROOM ────────────────────────────────────────────────────────────
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) { socket.emit('errorMessage', 'Room not found. Check the code and try again.'); return; }
    if (room.gameState) { socket.emit('errorMessage', 'That game has already started.'); return; }
    if (room.players.length >= 4) { socket.emit('errorMessage', 'Room is full (max 4 players).'); return; }
    const yourIndex = room.players.length;
    room.players.push({ id: socket.id, name: playerName || `Player ${yourIndex + 1}`, colour: null, isHost: false });
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.emit('joinedRoom', { roomCode, players: room.players, yourIndex });
    io.to(roomCode).emit('playersUpdated', room.players);
    console.log(`${playerName} joined room ${roomCode}`);
  });

  // ── CHOOSE COLOUR ────────────────────────────────────────────────────────
  socket.on('chooseColour', ({ roomCode, colour }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const taken = room.players.some(p => p.id !== socket.id && p.colour === colour);
    if (taken) { socket.emit('errorMessage', 'That colour was just taken — please choose another.'); return; }
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.colour = colour;
      io.to(roomCode).emit('playersUpdated', room.players);
    }
  });

  // ── START GAME ───────────────────────────────────────────────────────────
  socket.on('startGame', ({ roomCode, gameState }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) { socket.emit('errorMessage', 'Only the host can start the game.'); return; }
    room.gameState = gameState;
    io.to(roomCode).emit('gameStarted', { gameState: room.gameState, players: room.players });
    console.log(`Game started in room ${roomCode} with ${room.players.length} players`);
  });

  // ── GAME STATE UPDATE ────────────────────────────────────────────────────
  socket.on('updateGame', ({ roomCode, gameState }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.gameState = gameState;
    socket.to(roomCode).emit('gameUpdated', gameState);
  });

  // ── LEADERBOARD ──────────────────────────────────────────────────────────
  socket.on('submitScore', async ({ playerName, colour, score, isLoop, date }) => {
    if (!playerName || !score || score <= 0) return;
    await saveScore({ playerName, colour, score, isLoop, date });
    console.log(`Score saved: ${playerName} — ${score}pts`);
    io.emit('leaderboard', getLeaderboard());
  });

  socket.on('getLeaderboard', () => {
    // Serve from cache instantly — no async DB call needed
    socket.emit('leaderboard', getLeaderboard());
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const leftName = room.players[idx].name;
    room.players.splice(idx, 1);
    if (room.players.length === 0) {
      delete rooms[code];
      activeCodes.delete(code); // FIX 10: free the code for reuse
      console.log(`Room ${code} closed`);
    } else {
      if (!room.players.some(p => p.isHost)) room.players[0].isHost = true;
      io.to(code).emit('playerLeft', { players: room.players, leftName });
    }
    console.log(`${leftName} left room ${code}`);
  });
});

// Periodically clean up stale rooms (older than 6 hours with no activity)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, room] of Object.entries(rooms)) {
    if (now - room.createdAt > 6 * 60 * 60 * 1000) {
      delete rooms[code];
      activeCodes.delete(code);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`Cleaned ${cleaned} stale rooms`);
}, 30 * 60 * 1000); // run every 30 minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Tantrix server running on port ${PORT}`);
  await initDB();
});
