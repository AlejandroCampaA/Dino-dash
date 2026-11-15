// Dino Dash - servidor multijugador
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };

const server = http.createServer((req, res) => {
  const file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const head = { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || ''); // los videos necesitan "Range" (Safari/iOS lo exigen)
    if (m && (m[1] || m[2])) {
      let start = m[1] === '' ? Math.max(0, st.size - +m[2]) : +m[1];
      let end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(+m[2], st.size - 1);
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': st.size });
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e84393', '#34495e'];
const CHARS = ['dino', 'roo', 'turtle', 'cheetah', 'frog', 'penguin'];
const COUNTDOWN = 3500;
let nextId = 1;

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, exceptId) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
}
function lobbyInfo(room) {
  return {
    t: 'lobby', code: room.code, hostId: room.hostId, running: room.running,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, char: p.char, alive: p.alive,
      score: p.score, best: p.best, wins: p.wins, inRace: p.inRace,
    })),
  };
}

const YT_VIDEO = /^yt:v:[A-Za-z0-9_-]{11}$/;
function setMusic(room, uri, stop) {
  room.music = uri; room.musicAt = uri ? Date.now() : 0; room.musicSeq++;
  broadcast(room, { t: 'music', uri, at: room.musicAt, seq: room.musicSeq, stop: !!stop });
}
const qInfo = room => ({ t: 'queue', q: room.queue.map(i => ({ id: i.id, uri: i.uri, by: i.by, byId: i.byId })) });
function advance(room, skipped) {
  const n = room.queue.shift();
  if (n) { setMusic(room, n.uri); broadcast(room, { t: 'feed', msg: `▶ Suena ahora (de ${n.by})` }); }
  else setMusic(room, null, skipped);
  broadcast(room, qInfo(room));
}

function checkRaceEnd(room) {
  if (!room.running) return;
  const racers = [...room.players.values()].filter(p => p.inRace);
  if (racers.length && racers.some(p => p.alive)) return;
  room.running = false;
  racers.sort((a, b) => b.score - a.score);
  if (racers[0]) racers[0].wins++;
  const results = racers.map(p => ({ id: p.id, name: p.name, color: p.color, char: p.char, score: p.score }));
  broadcast(room, { t: 'results', results });
  broadcast(room, lobbyInfo(room));
}

function leave(player) {
  const room = player.room;
  if (!room) return;
  room.players.delete(player.id);
  player.room = null;
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === player.id) room.hostId = room.players.keys().next().value;
  broadcast(room, { t: 'left', id: player.id });
  broadcast(room, lobbyInfo(room));
  checkRaceEnd(room);
}

wss.on('connection', ws => {
  const player = {
    id: nextId++, ws, name: 'Dino', color: COLORS[0], char: 'dino', room: null,
    alive: false, score: 0, best: 0, wins: 0, inRace: false,
  };
  send(ws, { t: 'hello', id: player.id });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const room = player.room;

    switch (m.t) {
      case 'ping': send(ws, { t: 'pong', c: m.c, s: Date.now() }); break;

      case 'create':
      case 'join': {
        if (room) leave(player);
        let r;
        if (m.t === 'create') {
          r = { code: makeCode(), hostId: player.id, players: new Map(), running: false, seed: 0, startAt: 0,
                music: null, musicAt: 0, musicSeq: 0, queue: [], qid: 0 };
          rooms.set(r.code, r);
        } else {
          r = rooms.get(String(m.code || '').toUpperCase().trim());
          if (!r) return send(ws, { t: 'error', msg: 'Sala no encontrada' });
          if (r.players.size >= 8) return send(ws, { t: 'error', msg: 'Sala llena (máx. 8)' });
        }
        player.name = String(m.name || 'Dino').slice(0, 12) || 'Dino';
        if (CHARS.includes(m.char)) player.char = m.char;
        const used = new Set([...r.players.values()].map(p => p.color));
        player.color = COLORS.find(c => !used.has(c)) || COLORS[0];
        Object.assign(player, { alive: false, score: 0, best: 0, wins: 0, inRace: false, room: r });
        r.players.set(player.id, player);
        send(ws, { t: 'joined', code: r.code, id: player.id });
        broadcast(r, lobbyInfo(r));
        if (r.music) send(ws, { t: 'music', uri: r.music, at: r.musicAt, seq: r.musicSeq });
        send(ws, qInfo(r));
        if (r.running) send(ws, { t: 'start', seed: r.seed, startAt: r.startAt, spectate: true });
        break;
      }

      case 'char': {
        if (!CHARS.includes(m.c)) return;
        if (room && room.running && player.inRace) return;
        player.char = m.c;
        if (room) broadcast(room, lobbyInfo(room));
        break;
      }

      case 'start': {
        if (!room || room.hostId !== player.id || room.running) return;
        room.running = true;
        room.seed = Math.floor(Math.random() * 2 ** 31);
        room.startAt = Date.now() + COUNTDOWN;
        for (const p of room.players.values()) { p.alive = true; p.score = 0; p.inRace = true; }
        broadcast(room, { t: 'start', seed: room.seed, startAt: room.startAt });
        broadcast(room, lobbyInfo(room));
        break;
      }

      case 's': {
        if (!room || !room.running || !player.alive) return;
        player.score = m.sc | 0;
        broadcast(room, { t: 's', id: player.id, k: m.k | 0, y: +m.y || 0, f: m.f | 0, sc: player.score }, player.id);
        break;
      }

      case 'dead': {
        if (!room || !room.running || !player.alive) return;
        player.alive = false;
        player.score = m.score | 0;
        player.best = Math.max(player.best, player.score);
        broadcast(room, { t: 'dead', id: player.id, score: player.score });
        broadcast(room, lobbyInfo(room));
        checkRaceEnd(room);
        break;
      }

      case 'atk': {
        if (!room || !room.running || !player.alive) return;
        if (m.k === 'bolt') {
          const target = room.players.get(m.to);
          if (!target || !target.alive || target.id === player.id) return;
          send(target.ws, { t: 'atk', k: 'bolt', from: player.id });
          broadcast(room, { t: 'feed', msg: `⚡ ${player.name} → ${target.name}` });
        } else if (m.k === 'ink') {
          for (const p of room.players.values())
            if (p.id !== player.id && p.alive) send(p.ws, { t: 'atk', k: 'ink', from: player.id });
          broadcast(room, { t: 'feed', msg: `🦑 ${player.name} lanzó tinta` });
        }
        break;
      }

      case 'music': { // el anfitrion elige la musica de toda la sala
        if (!room) return;
        if (Date.now() - (player.lastMusic || 0) < 4000)
          return send(ws, { t: 'feed', msg: '⏳ Espera unos segundos para cambiar la música' });
        const uri = String(m.uri || '');
        if (!/^(spotify:(playlist|album|artist|track):[A-Za-z0-9]{10,40}|yt:(v|l):[A-Za-z0-9_-]{10,50})$/.test(uri)) return;
        player.lastMusic = Date.now();
        setMusic(room, uri);
        broadcast(room, { t: 'feed', msg: `🎵 ${player.name} puso música` });
        break;
      }

      case 'qadd': { // añadir videos a la cola de la sala
        if (!room || !Array.isArray(m.items)) return;
        if (Date.now() - (player.lastQ || 0) < 800) return;
        player.lastQ = Date.now();
        const items = m.items.map(String).filter(u => YT_VIDEO.test(u)).slice(0, 15);
        if (!items.length) return;
        if (room.queue.length >= 40) return send(ws, { t: 'feed', msg: '⚠️ La cola está llena (máx. 40)' });
        let n = 0;
        for (const uri of items) {
          if (room.queue.length >= 40) break;
          n++;
          if (!room.music && room.queue.length === 0) setMusic(room, uri); // nada sonando: arranca el primero
          else room.queue.push({ id: ++room.qid, uri, by: player.name, byId: player.id });
        }
        broadcast(room, qInfo(room));
        broadcast(room, { t: 'feed', msg: `➕ ${player.name} añadió ${n} a la cola` });
        break;
      }

      case 'qnext': {
        if (!room) return;
        if (Date.now() - (room.lastSkip || 0) < 1500) return;
        room.lastSkip = Date.now();
        broadcast(room, { t: 'feed', msg: `⏭ ${player.name} saltó la canción` });
        advance(room, true);
        break;
      }

      case 'qremove': {
        if (!room) return;
        const i = room.queue.findIndex(x => x.id === m.id);
        if (i < 0) return;
        if (room.queue[i].byId !== player.id && room.hostId !== player.id) return;
        room.queue.splice(i, 1);
        broadcast(room, qInfo(room));
        break;
      }

      case 'qclear': {
        if (!room || room.hostId !== player.id) return;
        room.queue = [];
        broadcast(room, qInfo(room));
        break;
      }

      case 'ended': { // un cliente avisa que terminó (o falló) el video actual
        if (!room || m.seq !== room.musicSeq || !room.music || !YT_VIDEO.test(room.music)) return;
        if (m.err) broadcast(room, { t: 'feed', msg: '⚠️ Ese video no se pudo reproducir, saltando…' });
        advance(room, false);
        break;
      }

      case 'emo': {
        if (!room) return;
        broadcast(room, { t: 'emo', id: player.id, e: Math.abs(m.e | 0) % 6 }, player.id);
        break;
      }

      case 'leave': leave(player); break;
    }
  });

  ws.on('close', () => leave(player));
});

server.listen(PORT, () => {
  console.log(`\n🦖 Dino Dash corriendo:`);
  console.log(`   Local:  http://localhost:${PORT}`);
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) console.log(`   Red:    http://${i.address}:${PORT}`);
  console.log('');
});
