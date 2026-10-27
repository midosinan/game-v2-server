const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 5501;
const WAITING_ROOM_TIMEOUT_MS = 2 * 60 * 1000;
const RECONNECT_GRACE_MS = 30 * 1000;
const TURN_TIME_LIMIT_MS = 45 * 1000;
const ALLOWED_TURN_DURATIONS_MS = new Set([0, 45_000, 60_000, 90_000, 120_000]);
const ROOM_STATE_FILE = process.env.GAME_STATE_FILE || path.join(__dirname, '.runtime', 'online-matches.json');
const ROOM_STATE_VERSION = 1;
const ROOM_STATE_HEARTBEAT_MS = 5 * 1000;
const players = new Map();
const rooms = new Map();
const DEVELOPER_NOTES_FILE = process.env.DEVELOPER_NOTES_FILE || path.join(__dirname, '.runtime', 'developer-notes.json');
const DEVELOPER_ACCESS_PASSWORD = process.env.DEVELOPER_ACCESS_PASSWORD;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_NOTES_TABLE = 'developer_notes';

function ensureDeveloperNotesFile() {
  const directory = path.dirname(DEVELOPER_NOTES_FILE);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(DEVELOPER_NOTES_FILE)) {
    fs.writeFileSync(DEVELOPER_NOTES_FILE, JSON.stringify({ notes: [] }, null, 2), 'utf8');
  }
}

function loadDeveloperNotes() {
  try {
    ensureDeveloperNotesFile();
    const raw = fs.readFileSync(DEVELOPER_NOTES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.notes)) {
      throw new Error('Stored developer notes have an invalid format.');
    }
    const entries = parsed.notes;
    return entries
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : crypto.randomUUID(),
        message: String(entry.message || '').trim(),
        createdAt: String(entry.createdAt || new Date().toISOString()),
        source: String(entry.source || 'game')
      }))
      .filter((entry) => entry.message);
  } catch (error) {
    console.error('Unable to load developer notes:', error);
    throw error;
  }
}

function saveDeveloperNotes(notes) {
  const temporaryFile = `${DEVELOPER_NOTES_FILE}.${process.pid}.tmp`;
  try {
    ensureDeveloperNotesFile();
    const payload = JSON.stringify({ notes }, null, 2);
    fs.writeFileSync(temporaryFile, payload, 'utf8');
    fs.renameSync(temporaryFile, DEVELOPER_NOTES_FILE);
    return true;
  } catch (error) {
    console.error('Unable to persist developer notes:', error);
    if (fs.existsSync(temporaryFile)) {
      try {
        fs.unlinkSync(temporaryFile);
      } catch (cleanupError) {
        console.error('Unable to remove temporary developer notes:', cleanupError);
      }
    }
    return false;
  }
}

function getDeveloperNotesStorage() {
  const hasSupabaseUrl = Boolean(SUPABASE_URL);
  const hasSupabaseKey = Boolean(SUPABASE_SERVICE_ROLE_KEY);
  if (hasSupabaseUrl !== hasSupabaseKey) {
    throw new Error('Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.');
  }
  return hasSupabaseUrl ? 'supabase' : 'file';
}

async function supabaseNotesRequest(query, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_NOTES_TABLE}${query}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${responseText.slice(0, 500)}`);
  }
  if (!responseText) return [];
  return JSON.parse(responseText);
}

async function loadDeveloperNotesFromSupabase() {
  const notes = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await supabaseNotesRequest(
      `?select=id,message,created_at,source&order=created_at.desc,id.desc&limit=${pageSize}`,
      {
        headers: {
          'Range-Unit': 'items',
          Range: `${offset}-${offset + pageSize - 1}`
        }
      }
    );
    if (!Array.isArray(page)) {
      throw new Error('Supabase returned an invalid developer notes response.');
    }
    notes.push(...page.map((entry) => ({
      id: String(entry.id),
      message: String(entry.message || '').trim(),
      createdAt: String(entry.created_at || new Date().toISOString()),
      source: String(entry.source || 'game')
    })).filter((entry) => entry.message));
    if (page.length < pageSize) return notes;
  }
}

async function saveDeveloperNote(message) {
  if (getDeveloperNotesStorage() === 'supabase') {
    const inserted = await supabaseNotesRequest('?select=id', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: { message, source: 'game' }
    });
    if (!Array.isArray(inserted) || inserted.length !== 1) {
      throw new Error('Supabase did not confirm that the developer note was saved.');
    }
    return inserted.length;
  }

  const notes = loadDeveloperNotes();
  notes.unshift({
    id: crypto.randomUUID(),
    message,
    createdAt: new Date().toISOString(),
    source: 'game'
  });
  if (!saveDeveloperNotes(notes.slice(0, 100))) {
    throw new Error('Unable to persist developer notes to the local file.');
  }
  return notes.length;
}

async function getDeveloperNotes() {
  return getDeveloperNotesStorage() === 'supabase'
    ? loadDeveloperNotesFromSupabase()
    : loadDeveloperNotes();
}

async function deleteAllDeveloperNotes() {
  if (getDeveloperNotesStorage() === 'supabase') {
    const notesBeforeDeletion = await loadDeveloperNotesFromSupabase();
    await supabaseNotesRequest('?id=gte.0', {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
    const remaining = await loadDeveloperNotesFromSupabase();
    if (remaining.length > 0) {
      throw new Error('Developer notes remain in Supabase after deletion.');
    }
    return notesBeforeDeletion.length;
  }

  const notes = loadDeveloperNotes();
  if (!saveDeveloperNotes([])) {
    throw new Error('Unable to delete developer notes from the local file.');
  }
  if (loadDeveloperNotes().length > 0) {
    throw new Error('Developer notes remain in the local file after deletion.');
  }
  return notes.length;
}

function normalizeTurnDurationMs(value) {
  const durationMs = Number(value);
  if (ALLOWED_TURN_DURATIONS_MS.has(durationMs)) return durationMs;
  const durationFromSecondsMs = durationMs * 1000;
  return ALLOWED_TURN_DURATIONS_MS.has(durationFromSecondsMs)
    ? durationFromSecondsMs
    : TURN_TIME_LIMIT_MS;
}

function getTurnRemainingMs(room, now = Date.now()) {
  if (room.turnDurationMs === 0) return null;
  return Math.max(0, room.turnDeadline - now);
}

function persistRooms() {
  const persistedAt = Date.now();
  const activeRooms = Array.from(rooms.values())
    .filter((room) => room.state === 'active' || room.state === 'paused')
    .map((room) => ({
      roomId: room.roomId,
      state: room.state,
      currentTurn: room.currentTurn,
      firstTurn: room.firstTurn,
      players: room.players.map((player) => ({
        sessionId: player.sessionId,
        name: player.name,
        team: player.team
      })),
      challengerTeam: room.challengerTeam,
      targetTeam: room.targetTeam,
      turnDurationMs: room.turnDurationMs,
      stateSnapshot: room.stateSnapshot,
      turnStartPending: room.turnStartPending,
      turnRemainingMs: room.state === 'paused'
        ? room.pausedTurnRemainingMs
        : getTurnRemainingMs(room, persistedAt),
      reconnectDeadline: room.reconnectDeadline || null
    }));
  const state = JSON.stringify({ version: ROOM_STATE_VERSION, persistedAt, rooms: activeRooms });
  const directory = path.dirname(ROOM_STATE_FILE);
  const temporaryFile = `${ROOM_STATE_FILE}.${process.pid}.tmp`;

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryFile, state, 'utf8');
    fs.renameSync(temporaryFile, ROOM_STATE_FILE);
  } catch (error) {
    console.error('Unable to persist online matches:', error);
    if (fs.existsSync(temporaryFile)) {
      try {
        fs.unlinkSync(temporaryFile);
      } catch (cleanupError) {
        console.error('Unable to remove temporary online match state:', cleanupError);
      }
    }
  }
}

function restoreRooms() {
  if (!fs.existsSync(ROOM_STATE_FILE)) return;

  let persisted;
  try {
    persisted = JSON.parse(fs.readFileSync(ROOM_STATE_FILE, 'utf8'));
  } catch (error) {
    console.error('Unable to read persisted online matches; starting with an empty match list:', error);
    return;
  }
  if (persisted?.version !== ROOM_STATE_VERSION || !Array.isArray(persisted.rooms)) {
    console.error('Persisted online match state has an unsupported format; starting with an empty match list.');
    return;
  }

  const now = Date.now();
  const savedAt = Number(persisted.persistedAt);
  if (!Number.isFinite(savedAt)) {
    console.error('Persisted online match state has no valid timestamp; starting with an empty match list.');
    return;
  }

  let restoredCount = 0;
  let expiredCount = 0;
  persisted.rooms.forEach((storedRoom) => {
    if (!storedRoom || typeof storedRoom.roomId !== 'string' || !Array.isArray(storedRoom.players) || storedRoom.players.length !== 2) return;
    const disconnectedAt = storedRoom.state === 'paused'
      && storedRoom.reconnectDeadline != null
      && Number.isFinite(Number(storedRoom.reconnectDeadline))
      ? Number(storedRoom.reconnectDeadline)
      : savedAt + RECONNECT_GRACE_MS;
    if (disconnectedAt <= now) {
      expiredCount += 1;
      return;
    }

    const playersInRoom = storedRoom.players.map((player) => ({
      socketId: null,
      sessionId: String(player.sessionId || ''),
      name: sanitizePlayerName(player.name),
      team: player.team === 'dark' ? 'dark' : 'light',
      disconnectedAt: savedAt
    }));
    if (playersInRoom.some((player) => !player.sessionId)) return;

    const turnDurationMs = storedRoom.turnDurationMs === undefined
      ? TURN_TIME_LIMIT_MS
      : normalizeTurnDurationMs(storedRoom.turnDurationMs);
    const persistedTurnRemaining = turnDurationMs === 0
      ? null
      : Math.max(0, Number(storedRoom.turnRemainingMs) || 0);
    const downtime = Math.max(0, now - savedAt);
    const remainingTurnMs = turnDurationMs === 0
      ? null
      : (storedRoom.state === 'paused'
          ? persistedTurnRemaining
          : Math.max(0, persistedTurnRemaining - downtime));
    const room = {
      roomId: storedRoom.roomId,
      state: 'paused',
      currentTurn: storedRoom.currentTurn,
      firstTurn: storedRoom.firstTurn || storedRoom.currentTurn,
      players: playersInRoom,
      challengerId: null,
      challengerTeam: storedRoom.challengerTeam || playersInRoom[0].team,
      targetTeam: storedRoom.targetTeam || playersInRoom[1].team,
      turnDurationMs,
      waitingTimer: null,
      reconnectTimer: null,
      stateSnapshot: storedRoom.stateSnapshot || null,
      turnStartPending: Boolean(storedRoom.turnStartPending),
      turnDeadline: 0,
      pausedTurnRemainingMs: remainingTurnMs,
      reconnectDeadline: disconnectedAt
    };
    room.reconnectTimer = setTimeout(() => {
      if (rooms.get(room.roomId) !== room || room.state !== 'paused') return;
      emitRoomEnded(room, 'opponent-left');
      emitLobbyList();
      persistRooms();
    }, Math.max(0, disconnectedAt - now));
    rooms.set(room.roomId, room);
    restoredCount += 1;
  });

  if (restoredCount > 0 || expiredCount > 0) {
    console.log(`Restored ${restoredCount} online match(es); expired ${expiredCount} match(es) past reconnect grace.`);
  }
  persistRooms();
}

restoreRooms();
const roomStateHeartbeat = setInterval(persistRooms, ROOM_STATE_HEARTBEAT_MS);
roomStateHeartbeat.unref();

process.on('SIGINT', () => {
  clearInterval(roomStateHeartbeat);
  persistRooms();
  process.exit(0);
});
process.on('SIGTERM', () => {
  clearInterval(roomStateHeartbeat);
  persistRooms();
  process.exit(0);
});

function sanitizePlayerName(name) {
  return String(name || 'Player').trim().slice(0, 20) || 'Player';
}

function emitLobbyList(targetSocket = null) {
  const onlinePlayers = Array.from(players.values()).filter((player) => !findRoomForSession(player.sessionId)).map((player) => ({
    id: player.id,
    name: player.name,
    team: player.team || null
  }));

  if (targetSocket) targetSocket.emit('lobby:list', onlinePlayers);
  else io.emit('lobby:list', onlinePlayers);
}

function findRoomForSocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((player) => player.socketId === socketId)) {
      return room;
    }
  }
  return null;
}

function findRoomForSession(sessionId) {
  if (!sessionId) return null;
  for (const room of rooms.values()) {
    if (room.players.some((player) => player.sessionId === sessionId)) return room;
  }
  return null;
}

function emitRoomEnded(room, reason) {
  clearRoomTimers(room);
  room.players.forEach((player) => {
    if (player.socketId) io.to(player.socketId).emit('match:ended', { reason });
  });
  rooms.delete(room.roomId);
  persistRooms();
}

function scheduleWaitingRoomExpiry(room) {
  room.waitingTimer = setTimeout(() => {
    if (rooms.get(room.roomId) !== room || room.state !== 'waiting') return;
    emitRoomEnded(room, 'challenge-expired');
    emitLobbyList();
  }, WAITING_ROOM_TIMEOUT_MS);
}

function clearRoomTimers(room) {
  if (room.waitingTimer) clearTimeout(room.waitingTimer);
  if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
  room.waitingTimer = null;
  room.reconnectTimer = null;
}

function getRoomPlayer(room, socketId) {
  return room?.players.find((player) => player.socketId === socketId) || null;
}

function isRoomMember(room, socketId) {
  return Boolean(getRoomPlayer(room, socketId));
}

function roomIsFullyConnected(room) {
  return room.players.every((player) => player.socketId && players.has(player.socketId));
}

function emitRoomTurn(room) {
  if (room.state !== 'active' || !roomIsFullyConnected(room)) return;
  io.to(room.players.map((player) => player.socketId)).emit('match:turn', {
    roomId: room.roomId,
    currentTurnId: room.currentTurn,
    turnRemainingMs: getTurnRemainingMs(room),
    turnDurationMs: room.turnDurationMs
  });
}

function roomSummary(room) {
  return {
    roomId: room.roomId,
    players: room.players.map((player) => ({
      id: player.socketId || player.sessionId,
      name: player.name,
      team: player.team
    })),
    currentTurnId: room.currentTurn,
    firstTurnId: room.firstTurn,
    state: room.state,
    turnDurationMs: room.turnDurationMs,
    stateSnapshot: room.stateSnapshot,
    turnStartPending: room.turnStartPending,
    turnRemainingMs: room.state === 'paused'
      ? room.pausedTurnRemainingMs
      : getTurnRemainingMs(room)
  };
}

io.on('connection', (socket) => {
  socket.emit('server:ready', { message: 'Connected' });

  socket.on('player:join', ({ name, sessionId: requestedSessionId } = {}) => {
    const safeName = sanitizePlayerName(name);
    const previousRoom = findRoomForSession(requestedSessionId);
    const sessionId = previousRoom
      ? requestedSessionId
      : crypto.randomBytes(18).toString('hex');
    const previousPlayer = previousRoom?.players.find((player) => player.sessionId === sessionId);
    const previousSocketId = previousPlayer?.socketId;
    const player = {
      id: socket.id,
      sessionId,
      name: previousPlayer?.name || safeName,
      team: previousPlayer?.team || null
    };
    players.set(socket.id, player);

    if (previousPlayer) {
      previousPlayer.socketId = socket.id;
      previousPlayer.disconnectedAt = null;
      if (previousRoom.currentTurn === previousSocketId) previousRoom.currentTurn = socket.id;
      if (previousRoom.firstTurn === previousSocketId) previousRoom.firstTurn = socket.id;
      previousRoom.state = roomIsFullyConnected(previousRoom) ? 'active' : 'paused';
      if (previousRoom.state === 'active') {
        clearRoomTimers(previousRoom);
        previousRoom.turnDeadline = previousRoom.turnDurationMs === 0
          ? 0
          : Date.now() + Math.max(0, previousRoom.pausedTurnRemainingMs ?? previousRoom.turnDurationMs);
        previousRoom.pausedTurnRemainingMs = null;
        previousRoom.reconnectDeadline = null;
      }
      persistRooms();
      socket.emit('match:resume', roomSummary(previousRoom));
      previousRoom.players.forEach((roomPlayer) => {
        if (roomPlayer.socketId && roomPlayer.socketId !== socket.id) {
          io.to(roomPlayer.socketId).emit('match:resumed', roomSummary(previousRoom));
        }
      });
    } else if (requestedSessionId) {
      socket.emit('match:resume-failed', { reason: 'match-ended' });
    }

    socket.emit('player:session', { id: socket.id, name: player.name, sessionId });
    emitLobbyList();
  });

  socket.on('lobby:refresh', () => {
    if (!players.has(socket.id)) return;
    emitLobbyList(socket);
  });

  socket.on('player:challenge', ({ targetId, team, turnDurationMs }) => {
    const challenger = players.get(socket.id);
    const target = players.get(targetId);
    if (!challenger || !target || targetId === socket.id) return;
    if (findRoomForSession(challenger.sessionId) || findRoomForSession(target.sessionId)) {
      socket.emit('challenge:error', { message: 'أحد اللاعبين موجود بالفعل في تحدٍ آخر.' });
      return;
    }

    const challengerTeam = team === 'dark' ? 'dark' : 'light';
    const targetTeam = challengerTeam === 'light' ? 'dark' : 'light';
    const matchTurnDurationMs = normalizeTurnDurationMs(turnDurationMs);
    const roomId = `room-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    rooms.set(roomId, {
      roomId,
      state: 'waiting',
      currentTurn: socket.id,
      firstTurn: socket.id,
      players: [
        { socketId: socket.id, sessionId: challenger.sessionId, name: challenger.name, team: challengerTeam },
        { socketId: targetId, sessionId: target.sessionId, name: target.name, team: targetTeam }
      ],
      challengerId: socket.id,
      challengerTeam,
      targetTeam,
      turnDurationMs: matchTurnDurationMs,
      waitingTimer: null,
      reconnectTimer: null,
      stateSnapshot: null,
      turnStartPending: false,
      turnDeadline: 0,
      pausedTurnRemainingMs: null
    });
    scheduleWaitingRoomExpiry(rooms.get(roomId));

    socket.to(targetId).emit('challenge:incoming', {
      roomId,
      challengerId: socket.id,
      challengerName: challenger.name,
      challengerTeam,
      targetTeam,
      forcedTeam: targetTeam,
      turnDurationMs: matchTurnDurationMs
    });

    socket.emit('challenge:sent', {
      roomId,
      targetId,
      targetName: target.name,
      selectedTeam: challengerTeam
    });
    emitLobbyList();
  });

  socket.on('challenge:accept', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'waiting') return;
    const target = room.players.find((player) => player.socketId === socket.id);
    if (!target || !room.players.every((player) => player.socketId && players.has(player.socketId))) return;

    room.state = 'active';
    clearRoomTimers(room);
    room.turnDeadline = room.turnDurationMs === 0 ? 0 : Date.now() + room.turnDurationMs;
    room.turnStartPending = false;
    const roomPlayers = room.players.map((player) => ({
      id: player.socketId,
      name: player.name,
      team: player.team
    }));

    io.to(room.players.map((player) => player.socketId)).emit('match:start', {
      roomId,
      mode: 'online',
      currentTurnId: room.currentTurn,
      firstTurnId: room.firstTurn,
      players: roomPlayers,
      turnRemainingMs: getTurnRemainingMs(room),
      turnDurationMs: room.turnDurationMs
    });
    persistRooms();
  });

  socket.on('match:action', (payload) => {
    const room = rooms.get(payload?.roomId);
    if (!room || room.state !== 'active' || !roomIsFullyConnected(room) || !isRoomMember(room, socket.id) || room.currentTurn !== socket.id) return;

    const opponent = room.players.find((player) => player.socketId !== socket.id);
    if (!opponent) return;

    if (payload?.type === 'sync') {
      room.stateSnapshot = payload;
      if (room.turnStartPending) room.turnStartPending = false;
      persistRooms();
    }
    socket.to(opponent.socketId).emit('match:action', payload);
  });

  socket.on('match:end-turn', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'active' || !roomIsFullyConnected(room) || !isRoomMember(room, socket.id) || room.currentTurn !== socket.id) return;

    const nextPlayer = room.players.find((player) => player.socketId !== socket.id);
    if (!nextPlayer) return;

    room.currentTurn = nextPlayer.socketId;
    room.turnDeadline = room.turnDurationMs === 0 ? 0 : Date.now() + room.turnDurationMs;
    room.turnStartPending = true;
    persistRooms();
    emitRoomTurn(room);
  });

  socket.on('match:ended', ({ roomId, reason }) => {
    const room = rooms.get(roomId);
    if (!room || !isRoomMember(room, socket.id)) return;
    clearRoomTimers(room);
    emitRoomEnded(room, reason === 'finished' ? 'finished' : 'opponent-left');
    emitLobbyList();
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);

    for (const [roomId, room] of rooms.entries()) {
      const playerInRoom = room.players.find((player) => player.socketId === socket.id);
      if (!playerInRoom) continue;
      playerInRoom.socketId = null;
      playerInRoom.disconnectedAt = Date.now();

      if (room.state === 'waiting') {
        emitRoomEnded(room, 'opponent-left');
        continue;
      }

      room.state = 'paused';
      if (room.turnDeadline) {
        room.pausedTurnRemainingMs = Math.max(0, room.turnDeadline - Date.now());
        room.turnDeadline = 0;
      }
      room.reconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
      const otherPlayers = room.players.filter((player) => player.socketId);
      otherPlayers.forEach((player) => io.to(player.socketId).emit('match:paused', { roomId, graceMs: RECONNECT_GRACE_MS }));
      room.reconnectTimer = setTimeout(() => {
        if (rooms.get(roomId) !== room || room.state !== 'paused') return;
        emitRoomEnded(room, 'opponent-left');
        emitLobbyList();
      }, Math.max(0, room.reconnectDeadline - Date.now()));
      persistRooms();
    }

    emitLobbyList();
  });
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));
app.get('/health', (req, res) => {
  res.json({ ok: true, onlinePlayers: players.size });
});

app.post('/api/developer-note', async (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 1000);
  if (!message) {
    return res.status(400).json({ ok: false, error: 'Message is required.' });
  }

  try {
    const count = await saveDeveloperNote(message);
    return res.json({ ok: true, count });
  } catch (error) {
    console.error('Unable to save developer note:', error);
    return res.status(500).json({ ok: false, error: 'Unable to save note.' });
  }
});

app.post('/api/developer-access', async (req, res) => {
  if (!DEVELOPER_ACCESS_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'Developer access is not configured.' });
  }
  const password = String(req.body?.password || '');
  if (password !== DEVELOPER_ACCESS_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Invalid password.' });
  }

  try {
    const notes = await getDeveloperNotes();
    return res.json({ ok: true, notes });
  } catch (error) {
    console.error('Unable to read saved notes:', error);
    return res.status(500).json({ ok: false, error: 'Unable to read saved notes.' });
  }
});

app.post('/api/developer-notes/delete', async (req, res) => {
  if (!DEVELOPER_ACCESS_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'Developer access is not configured.' });
  }
  const password = String(req.body?.password || '');
  if (password !== DEVELOPER_ACCESS_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Invalid password.' });
  }

  try {
    const deletedCount = await deleteAllDeveloperNotes();
    return res.json({ ok: true, deletedCount });
  } catch (error) {
    console.error('Unable to delete saved notes:', error);
    return res.status(500).json({ ok: false, error: 'Unable to delete saved notes.' });
  }
});

server.listen(PORT, () => {
  try {
    if (getDeveloperNotesStorage() === 'file') {
      console.warn('Supabase is not configured; developer notes are stored in a local file and may be lost on ephemeral hosts.');
    } else {
      console.log('Developer notes are configured to use Supabase.');
    }
  } catch (error) {
    console.error('Invalid developer notes storage configuration:', error.message);
  }
  console.log(`Game server listening on http://localhost:${PORT}`);
});
