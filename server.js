const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', socket => {
  console.log('Connected:', socket.id);

  // ── CREATE ROOM ────────────────────────────────────────────────────────────
  socket.on('createRoom', ({ playerName }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = {
      players: [{ id: socket.id, name: playerName || 'Player 1', colour: null, isHost: true }],
      gameState: null
    };

    socket.join(code);
    socket.roomCode = code;

    socket.emit('roomCreated', { roomCode: code, players: rooms[code].players, yourIndex: 0 });
    console.log(`Room created: ${code}`);
  });

  // ── JOIN ROOM ──────────────────────────────────────────────────────────────
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

  // ── CHOOSE COLOUR ──────────────────────────────────────────────────────────
  socket.on('chooseColour', ({ roomCode, colour }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Check colour not taken by another player
    const taken = room.players.some(p => p.id !== socket.id && p.colour === colour);
    if (taken) { socket.emit('errorMessage', 'That colour was just taken — please choose another.'); return; }

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.colour = colour;
      io.to(roomCode).emit('playersUpdated', room.players);
      console.log(`${player.name} chose ${colour} in room ${roomCode}`);
    }
  });

  // ── START GAME ─────────────────────────────────────────────────────────────
  socket.on('startGame', ({ roomCode, gameState }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) { socket.emit('errorMessage', 'Only the host can start the game.'); return; }

    room.gameState = gameState;
    io.to(roomCode).emit('gameStarted', { gameState: room.gameState, players: room.players });
    console.log(`Game started in room ${roomCode} with ${room.players.length} players`);
  });

  // ── GAME STATE UPDATE ──────────────────────────────────────────────────────
  socket.on('updateGame', ({ roomCode, gameState }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.gameState = gameState;
    socket.to(roomCode).emit('gameUpdated', gameState);
  });

  // ── DISCONNECT ─────────────────────────────────────────────────────────────
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
      console.log(`Room ${code} closed`);
    } else {
      if (!room.players.some(p => p.isHost)) room.players[0].isHost = true;
      io.to(code).emit('playerLeft', { players: room.players, leftName });
    }
    console.log(`${leftName} left room ${code}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tantrix server running on port ${PORT}`));
