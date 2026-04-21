'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const {
  newGame, handleAction, buildView, getBotAction, tieBreakTimeout, TIE_BREAK_MS,
} = require('./game.js');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const PORT      = process.env.PORT || 3000;
const GRACE_MS  = 45_000;   // reconnect window after disconnect
const BOT_MS    = 1_200;    // delay before bot acts (feels natural)
const PING_MS   = 20_000;   // server→client ws ping interval

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.mp3':  'audio/mpeg',
  '.mp4':  'video/mp4',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

// ══════════════════════════════════════════════════════════════════════════════
// LOBBY DEFINITIONS  (permanent, created at startup)
// 2 × 4-player | 2 × 2-player | 1 solo (4p rules, 3 bots)
// ══════════════════════════════════════════════════════════════════════════════
const LOBBY_DEFS = [
  { id: 'table-4p-1', name: 'Mesa 4J — 1', mode: '4p', max: 4, solo: false },
  { id: 'table-4p-2', name: 'Mesa 4J — 2', mode: '4p', max: 4, solo: false },
  { id: 'table-2p-1', name: 'Mesa 2J — 1', mode: '2p', max: 2, solo: false },
  { id: 'table-2p-2', name: 'Mesa 2J — 2', mode: '2p', max: 2, solo: false },
  { id: 'table-solo', name: 'Solo vs Bots', mode: '4p', max: 1, solo: true  },
];

const lobbies = {};   // id → lobbyObj
const wsState = new WeakMap();   // ws → { lobbyId, seat, token }
const sessions = {};  // token → { lobbyId, seat, name }

function makeLobby(def) {
  return {
    id:          def.id,
    name:        def.name,
    mode:        def.mode,
    maxHumans:   def.max,
    solo:        def.solo,
    players:     Array(def.max).fill(null),   // ws per seat
    names:       Array(def.max).fill(''),
    tokens:      Array(def.max).fill(null),
    game:        null,
    graceTimers: Array(def.max).fill(null),
    botTimer:    null,
    tieTimer:    null,
  };
}

for (const def of LOBBY_DEFS) lobbies[def.id] = makeLobby(def);

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function lobbyInfo(lobby) {
  return {
    id:        lobby.id,
    name:      lobby.name,
    mode:      lobby.mode,
    maxHumans: lobby.maxHumans,
    solo:      lobby.solo,
    seated:    lobby.names.filter(Boolean),
    inGame:    !!lobby.game,
  };
}

function broadcastLobbyList() {
  const list = Object.values(lobbies).map(lobbyInfo);
  for (const ws of wss.clients) {
    const st = wsState.get(ws);
    if (!st || !st.lobbyId) send(ws, { type: 'LOBBIES', lobbies: list });
  }
}

function broadcastGame(lobby) {
  const g = lobby.game;
  if (!g) return;
  lobby.players.forEach((ws, seat) => {
    if (ws) send(ws, { type: 'GAME_STATE', state: buildView(g, seat) });
  });
}

function sendLobbyState(lobby, ws, seat) {
  send(ws, {
    type:  'LOBBY_STATE',
    lobby: lobbyInfo(lobby),
    names: lobby.names,
    seat,
  });
}

function randToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// ══════════════════════════════════════════════════════════════════════════════
// BOT LOOP
// After every state change, schedule a bot action if needed.
// ══════════════════════════════════════════════════════════════════════════════
function scheduleBots(lobby) {
  if (!lobby.game) return;
  clearTimeout(lobby.botTimer);
  const gen = lobby.game.turnGen;
  lobby.botTimer = setTimeout(() => {
    try {
      const g = lobby.game;
      if (!g || g.turnGen !== gen) return;
      const act = getBotAction(g);
      if (!act) return;
      const result = handleAction(g, act.playerIdx, act.msg);
      if (result.error) {
        console.warn('[BOT]', act.playerIdx, act.msg.type, '\u2192', result.error);
        // Never stop the chain on error -- reschedule so next bot can act
        scheduleBots(lobby);
        return;
      }
      broadcastGame(lobby);
      scheduleBots(lobby);
      maybeStartTieTimer(lobby);
    } catch (e) {
      console.error('[BOT CRASH]', e);
      setTimeout(() => scheduleBots(lobby), 2000);
    }
  }, BOT_MS);
}

function maybeStartTieTimer(lobby) {
  const g = lobby.game;
  if (!g || g.phase !== 'TIE_BREAK') { clearTimeout(lobby.tieTimer); return; }
  clearTimeout(lobby.tieTimer);
  const gen = g.turnGen;
  lobby.tieTimer = setTimeout(() => {
    if (!lobby.game || lobby.game.turnGen !== gen) return;
    if (lobby.game.phase !== 'TIE_BREAK') return;
    tieBreakTimeout(lobby.game);
    broadcastGame(lobby);
    scheduleBots(lobby);
  }, TIE_BREAK_MS);
}

// ══════════════════════════════════════════════════════════════════════════════
// JOIN / LEAVE / RECONNECT
// ══════════════════════════════════════════════════════════════════════════════
function handleJoin(ws, msg) {
  const name = (msg.playerName || '').trim().slice(0, 20);
  if (!name) { send(ws, { type: 'ERROR', text: 'Nome inválido' }); return; }

  const lobby = lobbies[msg.lobbyId];
  if (!lobby) { send(ws, { type: 'ERROR', text: 'Mesa não encontrada' }); return; }
  if (lobby.game) { send(ws, { type: 'ERROR', text: 'Jogo já em curso nesta mesa' }); return; }

  const seat = lobby.players.indexOf(null);
  if (seat === -1) { send(ws, { type: 'ERROR', text: 'Mesa cheia' }); return; }

  const token              = randToken();
  lobby.players[seat]      = ws;
  lobby.names[seat]        = name;
  lobby.tokens[seat]       = token;
  sessions[token]          = { lobbyId: lobby.id, seat, name };
  wsState.set(ws, { lobbyId: lobby.id, seat, token });

  send(ws, { type: 'JOINED', seat, token, lobbyId: lobby.id, solo: lobby.solo });
  sendLobbyState(lobby, ws, seat);

  // Notify others
  lobby.players.forEach((p, i) => {
    if (p && i !== seat) send(p, { type: 'OPPONENT_JOINED', name, seat });
  });

  broadcastLobbyList();
}

function handleReconnect(ws, msg) {
  const sess = sessions[msg.token];
  if (!sess) { send(ws, { type: 'RECONNECT_FAIL' }); return; }

  const lobby = lobbies[sess.lobbyId];
  if (!lobby) { send(ws, { type: 'RECONNECT_FAIL' }); return; }

  const { seat, name } = sess;

  // Reject duplicate tab: seat already has a live connection
  const existing = lobby.players[seat];
  if (existing && existing !== ws && existing.readyState === 1) {
    send(ws, { type: 'RECONNECT_FAIL' }); return;
  }

  clearTimeout(lobby.graceTimers[seat]);
  lobby.players[seat] = ws;
  lobby.names[seat]   = name;
  wsState.set(ws, { lobbyId: lobby.id, seat, token: msg.token });

  send(ws, { type: 'RECONNECTED', seat, name, solo: lobby.solo });

  if (lobby.game) {
    broadcastGame(lobby);
  } else {
    sendLobbyState(lobby, ws, seat);
  }

  lobby.players.forEach((p, i) => {
    if (p && i !== seat) send(p, { type: 'OPPONENT_RECONNECTED', seat, name });
  });

  broadcastLobbyList();
}

function handleLeave(ws) {
  const st = wsState.get(ws);
  if (!st || !st.lobbyId) return;
  const lobby = lobbies[st.lobbyId];
  if (!lobby) return;
  hardLeave(lobby, st.seat);
}

function hardLeave(lobby, seat) {
  clearTimeout(lobby.graceTimers[seat]);
  const name = lobby.names[seat];

  if (sessions[lobby.tokens[seat]]) delete sessions[lobby.tokens[seat]];

  lobby.players[seat] = null;
  lobby.names[seat]   = '';
  lobby.tokens[seat]  = null;

  // If game running, abort it (player left permanently)
  if (lobby.game) {
    lobby.game = null;
    lobby.players.forEach(p => p && send(p, { type: 'GAME_ABORTED', reason: `${name} saiu do jogo.` }));
  } else {
    lobby.players.forEach((p, i) => {
      if (p && i !== seat) send(p, { type: 'OPPONENT_LEFT', seat, name });
    });
  }

  broadcastLobbyList();
}

// ══════════════════════════════════════════════════════════════════════════════
// GAME START
// ══════════════════════════════════════════════════════════════════════════════
function handleStart(lobby) {
  const seated = lobby.players.map((ws, i) => ws ? i : -1).filter(i => i !== -1);

  if (lobby.solo) {
    // 1 human + 3 bots
    const humanSeat  = seated[0];
    const humanName  = lobby.names[humanSeat];
    const botNames   = ['Bot Alfa', 'Bot Beta', 'Bot Gama'];
    const allPlayers = [
      { name: humanName, isBot: false },
      ...botNames.map(n => ({ name: n, isBot: true })),
    ];
    lobby.game = newGame(allPlayers, '4p');
    // Seat 0 = human (index 0 in game), bots fill remainder
    broadcastGame(lobby);
    scheduleBots(lobby);
    return;
  }

  const minNeeded = lobby.maxHumans;
  if (seated.length < minNeeded) {
    const host = lobby.players[seated[0]];
    send(host, { type: 'ERROR', text: `Precisas de ${minNeeded} jogadores para iniciar.` });
    return;
  }

  const lobbyPlayers = seated.map(i => ({ name: lobby.names[i], isBot: false }));
  lobby.game = newGame(lobbyPlayers, lobby.mode);
  broadcastGame(lobby);
  scheduleBots(lobby); // no-op for human-only games but safe to call
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ACTION DISPATCHER
// ══════════════════════════════════════════════════════════════════════════════
function dispatch(ws, msg) {
  // Stateless / pre-lobby messages
  if (msg.type === 'PING')      { send(ws, { type: 'PONG' }); return; }
  if (msg.type === 'LOBBIES')   { send(ws, { type: 'LOBBIES', lobbies: Object.values(lobbies).map(lobbyInfo) }); return; }
  if (msg.type === 'RECONNECT') { handleReconnect(ws, msg); return; }
  if (msg.type === 'JOIN_LOBBY'){ handleJoin(ws, msg); return; }

  // All other messages require a seated player
  const st = wsState.get(ws);
  if (!st || !st.lobbyId) { send(ws, { type: 'ERROR', text: 'Não estás numa mesa' }); return; }

  const lobby = lobbies[st.lobbyId];
  if (!lobby) return;
  const seat  = st.seat;

  if (msg.type === 'LEAVE_LOBBY') { handleLeave(ws); return; }

  if (msg.type === 'REQUEST_STATE') {
    if (lobby.game) send(ws, { type: 'GAME_STATE', state: buildView(lobby.game, seat) });
    else            sendLobbyState(lobby, ws, seat);
    return;
  }

  if (msg.type === 'START') {
    if (seat !== 0 && !lobby.solo) {
      send(ws, { type: 'ERROR', text: 'Só o anfitrião pode iniciar o jogo' });
      return;
    }
    handleStart(lobby);
    return;
  }

  if (msg.type === 'RESTART') {
    lobby.game = null;
    lobby.players.forEach((p, i) => {
      if (p) sendLobbyState(lobby, p, i);
    });
    broadcastLobbyList();
    return;
  }

  // In-game actions — forward to game.js
  const g = lobby.game;
  if (!g) { send(ws, { type: 'ERROR', text: 'Nenhum jogo em curso' }); return; }

  const result = handleAction(g, seat, msg);

  if (result.error) {
    send(ws, { type: 'ERROR', text: result.error });
    // Re-sync client with current state so it doesn't get stuck
    send(ws, { type: 'GAME_STATE', state: buildView(g, seat) });
    return;
  }

  broadcastGame(lobby);
  scheduleBots(lobby);
  maybeStartTieTimer(lobby);
}

// ══════════════════════════════════════════════════════════════════════════════
// PWA MANIFEST + SERVICE WORKER (served from memory)
// ══════════════════════════════════════════════════════════════════════════════
const MANIFEST = `{
  "name": "Bulbous",
  "short_name": "Bulbous",
  "description": "Jogo de bluff e estratégia com criaturas mágicas",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#0d0d1a",
  "theme_color": "#c084fc",
  "categories": ["games", "entertainment"],
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ],
  "screenshots": [
    { "src": "/screenshot.png", "sizes": "1280x800", "type": "image/png", "form_factor": "wide" }
  ]
}`;

// Service worker — caches only static assets (cards/icons), never the HTML
// Cache name includes build timestamp so it busts automatically on each deploy
const SW = `
const CACHE = 'bulbous-assets-1771878784711';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Never intercept WebSockets or HTML navigation — always fresh from server
  if (e.request.url.includes('ws://') || e.request.url.includes('wss://')) return;
  if (e.request.mode === 'navigate') return;
  // Cache card images and icons (static assets)
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/cards/') || url.pathname.startsWith('/icon') || url.pathname.startsWith('/favicon')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(r => {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return r;
        });
      })
    );
  }
});
`;

// ══════════════════════════════════════════════════════════════════════════════
// STATIC FILE SERVER
// ══════════════════════════════════════════════════════════════════════════════
function serveStatic(req, res) {
  const safe = path.normalize(req.url.split('?')[0]).replace(/^(\.\.[\\/])+/, '');
  const file = path.join(__dirname, 'public', safe.replace(/^\//, ''));
  const ext  = path.extname(file).toLowerCase();
  const mime = MIME[ext];
  if (!mime) { res.writeHead(404); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'public,max-age=86400',
    });
    res.end(data);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'client.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('client.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(MANIFEST);
    return;
  }

  if (url === '/sw.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Service-Worker-Allowed': '/',
    });
    res.end(SW);
    return;
  }

  serveStatic(req, res);
});

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET SERVER
// ══════════════════════════════════════════════════════════════════════════════
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  // Send lobby list immediately on connect
  send(ws, { type: 'LOBBIES', lobbies: Object.values(lobbies).map(lobbyInfo) });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    dispatch(ws, msg);
  });

  ws.on('close', () => {
    const st = wsState.get(ws);
    if (!st || !st.lobbyId) return;

    const lobby = lobbies[st.lobbyId];
    if (!lobby) return;

    const seat = st.seat;
    const name = lobby.names[seat];

    // Null the socket but keep seat reserved
    lobby.players[seat] = null;

    // ── Solo: never abort the game on disconnect.
    // Cold-starts, mobile backgrounding, etc. cause brief drops.
    // The bot loop keeps running; the human reconnects via their token.
    if (lobby.solo) {
      broadcastLobbyList();
      return;
    }

    // ── Multiplayer: notify others and start grace timer ──────────
    lobby.players.forEach((p, i) => {
      if (p && i !== seat)
        send(p, { type: 'OPPONENT_DISCONNECTED_GRACE', seat, name, graceMs: GRACE_MS });
    });

    broadcastLobbyList();

    clearTimeout(lobby.graceTimers[seat]);
    lobby.graceTimers[seat] = setTimeout(() => hardLeave(lobby, seat), GRACE_MS);
  });

  ws.on('error', () => {});
});

// ══════════════════════════════════════════════════════════════════════════════
// KEEP-ALIVE PING
// ══════════════════════════════════════════════════════════════════════════════
setInterval(() => {
  for (const ws of wss.clients) if (ws.readyState === 1) ws.ping();
}, PING_MS);

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`Bulbous a correr em http://localhost:${PORT}`);
});
