/* ============ server.js: servidor del cooperativo (salas y reenvío) ============
 * Servidor HTTP + socket.io. Hace de intermediario: salas, códigos de cuatro
 * Pokémon, la señalización de WebRTC (sig) y, para los invitados que no
 * llegan directos al anfitrión, los mensajes de la partida (m). Nunca mira lo
 * que llevan sig y m: sólo los reenvía, con el `from` que sale del token.
 * El protocolo está en docs/relay-coop/02-protocol.md.
 *
 * Variables de entorno:
 *   PORT              puerto (8787 en local)
 *   ORIGINS           webs que pueden conectar, separadas por comas
 *   FIREBASE_PROJECT  proyecto de Firebase de los tokens
 *   AUTH_EMULATOR     1 = tokens del emulador sin firma (nunca en producción)
 *   MAX_ROOMS         salas a la vez (1000)
 *   MAX_SOCKETS       conexiones a la vez (4000)
 *   MAX_MSG_BYTES     tamaño máximo de un sig o m (262144); más grande, se tira
 *   DIRECT_WAIT_MS    espera de la conexión directa que se manda a las salas (6000)
 *   TRUST_PROXY       1 = leer la IP de Fly-Client-IP / X-Forwarded-For (sólo detrás
 *                     de un proxy que las ponga; si no, cualquiera se las inventa)
 *
 * GET /healthz -> { rooms, sockets, paths: { direct, server }, bytes }
 * Nada de lo que llevan los mensajes va al registro; las IP sólo viven en
 * memoria (límites y "misma red"), nunca se mandan a nadie.
 */
'use strict';

const http = require('http');
const { Server } = require('socket.io');
const { createAuth } = require('./auth');
const { createRooms } = require('./rooms');
const { createLimits } = require('./limits');

const VERSION = 1;
const VERSIONS = [VERSION, VERSION - 1].filter(v => v >= 1);   // la actual y la anterior
const CLOSED_MEMORY_MS = 10 * 60 * 1000;

const rk = room => 'r:' + room.key;

function list(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

function configFromEnv(env = process.env) {
  const num = (v, d) => (v != null && v !== '' && Number.isFinite(+v) && +v > 0 ? +v : d);
  return {
    port: num(env.PORT, 8787),
    origins: env.ORIGINS ? list(env.ORIGINS) : ['http://localhost:8000', 'http://127.0.0.1:8000'],
    project: env.FIREBASE_PROJECT || '',
    authEmulator: env.AUTH_EMULATOR === '1',
    nodeEnv: env.NODE_ENV || '',
    maxRooms: num(env.MAX_ROOMS, 1000),
    maxSockets: num(env.MAX_SOCKETS, 4000),
    maxMsgBytes: num(env.MAX_MSG_BYTES, 256 * 1024),
    directWaitMs: num(env.DIRECT_WAIT_MS, 6000),
    trustProxy: env.TRUST_PROXY === '1',
  };
}

function cleanIp(ip) {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

// IP pública: Fly-Client-IP, si no X-Forwarded-For (la primera), si no la del socket.
function publicIp(hs, trustProxy) {
  const h = hs.headers || {};
  if (trustProxy) {
    for (const name of ['fly-client-ip', 'x-forwarded-for']) {
      const first = String(h[name] || '').split(',')[0].trim();
      if (first) return cleanIp(first);
    }
  }
  return cleanIp(hs.address);
}

// Tamaño en bytes de lo que llega por el socket (binario, texto u objeto).
function sizeOf(x) {
  if (x == null) return 0;
  if (typeof x === 'string') return Buffer.byteLength(x);
  if (Buffer.isBuffer(x) || ArrayBuffer.isView(x)) return x.byteLength;
  if (x instanceof ArrayBuffer) return x.byteLength;
  try { return Buffer.byteLength(JSON.stringify(x)); } catch { return Infinity; }
}

const isSeq = n => Number.isSafeInteger(n) && n >= 0;

function createServer(cfg = {}) {
  const c = { ...configFromEnv({}), ...cfg };
  const auth = c.auth || createAuth({ emulator: c.authEmulator, project: c.project, nodeEnv: c.nodeEnv });
  const rooms = c.rooms || createRooms({ maxRooms: c.maxRooms, directWaitMs: c.directWaitMs });
  const limits = createLimits(c.limits);
  const sockets = new Map();        // uid -> socket actual
  const closedAway = new Map();     // uid -> { why, at }: perdió la sala mientras estaba caído
  let relayed = 0;                  // bytes reenviados (sig + m)
  const anyOrigin = c.origins.includes('*');

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/healthz') {
      const s = rooms.stats();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ rooms: s.rooms, sockets: sockets.size, paths: s.paths, bytes: relayed }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const io = new Server(httpServer, {
    cors: { origin: anyOrigin ? true : c.origins },
    // Tope duro del transporte: el doble del máximo, para que un mensaje algo
    // grande llegue al manejador y se tire allí sin cortar la conexión.
    maxHttpBufferSize: c.maxMsgBytes * 2,
    pingInterval: 10000,
    pingTimeout: 10000,
    connectionStateRecovery: { maxDisconnectionDuration: 120000 },
    // CORS no frena a los websockets: el origen se mira aquí. Sin Origin
    // (no es un navegador) se deja pasar: el token sigue siendo obligatorio.
    allowRequest: (req, cb) => {
      const o = req.headers.origin;
      cb(null, anyOrigin || !o || c.origins.includes(o));
    },
  });

  // ---------- Aplicar lo que devuelve rooms.js ----------
  // joinSocket: el socket que entra en f.room, después de cerrar las salas
  // viejas (en el modo { id } la sala nueva puede tener la misma clave).
  function apply(f, joinSocket) {
    const t = Date.now();
    if (f.kicked) {
      const { room, sid } = f.kicked;
      if (sid) {
        io.to(sid).emit('closed', 'kicked');
        io.in(sid).socketsLeave(rk(room));
      }
    }
    for (const g of f.gone) {
      if (g.sid) io.in(g.sid).socketsLeave(rk(g.room));
      io.to(rk(g.room)).emit('peer', g.uid, 'gone');
      if (g.away) {
        const kicked = f.kicked && f.kicked.uid === g.uid;
        closedAway.set(g.uid, kicked ? { why: 'kicked', at: t } : { gone: true, at: t });
      }
    }
    for (const cl of f.closed) {
      const r = cl.room;
      const exceptSid = cl.except && r.members.get(cl.except) ? r.members.get(cl.except).sid : null;
      let to = io.to(rk(r));
      if (exceptSid) to = to.except(exceptSid);
      to.emit('closed', cl.why);
      io.in(rk(r)).socketsLeave(rk(r));
      for (const m of r.members.values()) {
        if (!m.online && m.uid !== cl.except) closedAway.set(m.uid, { why: cl.why, at: t });
      }
      logClose(r, cl.why);
    }
    if (joinSocket && f.ok && f.room) joinSocket.join(rk(f.room));
    for (const p of f.peer) {
      let to = io.to(rk(p.room));
      if (p.sid) to = to.except(p.sid);
      to.emit('peer', p.uid, p.state);
    }
    for (const room of f.changed) io.to(rk(room)).emit('room', rooms.snapshot(room));
  }

  function logClose(r, why) {
    const paths = { direct: 0, server: 0 };
    for (const m of r.members.values()) if (m.path) paths[m.path]++;
    console.log(JSON.stringify({
      ev: 'room-closed', why, secs: Math.round((Date.now() - r.createdAt) / 1000),
      bytes: r.bytes, peak: r.peak, paths,
    }));
  }

  const reply = (cb, x) => { if (typeof cb === 'function') cb(x); };

  // Reenvío de sig, m y ack: directo al socket del jugador, no como envío a
  // una sala. Así socket.io no lo guarda para la recuperación de conexión
  // (serían MB por segundo en memoria). Si está caído, se pierde: los números
  // de secuencia y el reenvío de net.js ya cuentan con ello.
  function forward(member, ev, ...a) {
    const s = sockets.get(member.uid);
    if (!s || s.id !== member.sid || !s.connected) return false;
    s.emit(ev, ...a);
    return true;
  }

  // ---------- Entrada: versión, token, capacidad ----------
  io.use(async (socket, next) => {
    const a = socket.handshake.auth || {};
    if (!VERSIONS.includes(a.v)) return next(new Error('old-version'));
    let who;
    try { who = await auth.verify(a.token); } catch { return next(new Error('bad-token')); }
    if (sockets.size >= c.maxSockets && !sockets.has(who.uid)) return next(new Error('busy'));
    socket.data.uid = who.uid;
    socket.data.v = a.v;
    socket.data.info = { name: a.name, dex: a.dex, shiny: a.shiny };
    socket.data.ip = publicIp(socket.handshake, c.trustProxy);
    next();
  });

  io.on('connection', socket => {
    const uid = socket.data.uid;
    const prev = sockets.get(uid);
    sockets.set(uid, socket);
    if (prev && prev !== socket) prev.disconnect(true);   // la misma cuenta en otra pestaña

    const room = rooms.roomOf(uid);
    // Una conexión recuperada vuelve con sus salas de socket.io: fuera las
    // que ya no son la suya (hueco caducado, sala cerrada).
    for (const r of [...socket.rooms]) if (r.startsWith('r:') && (!room || r !== rk(room))) socket.leave(r);
    if (room) {
      closedAway.delete(uid);
      apply(rooms.markBack(uid, { sid: socket.id, pubIp: socket.data.ip }), socket);
    } else {
      // Perdió la sala mientras estaba caído. Si la conexión se recuperó, ya
      // le llegó el aviso con lo pendiente; si es nueva, se le dice ahora.
      const lost = closedAway.get(uid);
      closedAway.delete(uid);
      if (lost && Date.now() - lost.at < CLOSED_MEMORY_MS && !socket.recovered) {
        if (lost.gone) socket.emit('peer', uid, 'gone');
        else socket.emit('closed', lost.why);
      }
    }

    const extra = () => ({ pubIp: socket.data.ip, sid: socket.id, v: socket.data.v });
    // Eventos de control: tope por socket; los que llevan respuesta dicen 'rate'.
    const ctl = cb => {
      if (limits.ctl.take(uid)) return true;
      reply(cb, { ok: false, err: 'rate' });
      return false;
    };
    const args = (p, cb) => (typeof p === 'function' ? [{}, p] : [p && typeof p === 'object' ? p : {}, cb]);

    socket.on('create', (p0, cb0) => {
      const [p, cb] = args(p0, cb0);
      if (!ctl(cb)) return;
      if (!limits.create.take(uid)) return reply(cb, { ok: false, err: 'rate' });
      const f = rooms.create(uid, socket.data.info, { id: p.id, mode: p.mode }, extra());
      apply(f, socket);
      reply(cb, f.ok ? { ok: true, code: f.room.code ? f.room.code.slice() : null, room: rooms.snapshot(f.room) } : { ok: false, err: f.err });
    });

    socket.on('join', (p0, cb0) => {
      const [p, cb] = args(p0, cb0);
      if (!ctl(cb)) return;
      const okIp = limits.joinIp.take(socket.data.ip);
      const okUid = limits.joinUid.take(uid);
      if (!okIp || !okUid) return reply(cb, { ok: false, err: 'rate' });
      const f = rooms.join(p.code, uid, socket.data.info, { ...extra(), hideIp: p.hideIp === true });
      apply(f, socket);
      if (!f.ok) return reply(cb, { ok: false, err: f.err });
      const me = f.room.members.get(uid);
      reply(cb, { ok: true, room: rooms.snapshot(f.room), sameNet: !!(me && me.sameNet) });
    });

    socket.on('leave', (p0, cb0) => {
      const [, cb] = args(p0, cb0);
      if (!ctl(cb)) return;
      const room = rooms.roomOf(uid);
      const f = rooms.leave(uid);
      if (room) socket.leave(rk(room));
      apply(f);
      reply(cb, { ok: true });
    });

    socket.on('member', p0 => {
      const [p] = args(p0);
      if (!ctl()) return;
      socket.data.info = { name: p.name, dex: p.dex, shiny: p.shiny };
      apply(rooms.update(uid, socket.data.info));
    });

    for (const ev of ['start', 'end']) {
      socket.on(ev, (p0, cb0) => {
        const [, cb] = args(p0, cb0);
        if (!ctl(cb)) return;
        const f = rooms[ev](uid);
        apply(f);
        reply(cb, f.ok ? { ok: true } : { ok: false, err: f.err });
      });
    }

    socket.on('kick', (p0, cb0) => {
      const [p, cb] = args(p0, cb0);
      if (!ctl(cb)) return;
      const f = rooms.kick(uid, p.uid);
      apply(f);
      reply(cb, f.ok ? { ok: true } : { ok: false, err: f.err });
    });

    socket.on('path', (to, p) => {
      if (!ctl()) return;
      apply(rooms.path(uid, to, p));
    });

    // ---------- Reenvío: nunca se mira el contenido ----------
    socket.on('sig', (to, payload) => {
      if (!limits.sig.take(uid)) return;
      const n = sizeOf(payload);
      if (n > c.maxMsgBytes) return;
      const t = rooms.target(uid, to);
      if (!t || !forward(t.member, 'sig', uid, payload)) return;
      relayed += n;
      t.room.bytes += n;
    });

    // Para m y ack: si se pasa del tope 3 s seguidos, se corta la conexión.
    const mOk = () => {
      if (limits.m.take(uid)) return true;
      if (limits.flood.over(uid)) socket.disconnect(true);
      return false;
    };

    socket.on('m', (to, seq, bytes) => {
      if (!mOk()) return;
      if (!isSeq(seq)) return;
      const n = sizeOf(bytes);
      if (n > c.maxMsgBytes) return;
      const t = rooms.target(uid, to);
      if (!t || !forward(t.member, 'm', uid, seq, bytes)) return;
      relayed += n;
      t.room.bytes += n;
    });

    // ack(seq): del invitado al anfitrión; le llega como ack(from, seq).
    socket.on('ack', seq => {
      if (!mOk()) return;
      if (!isSeq(seq)) return;
      const room = rooms.roomOf(uid);
      if (!room || room.host === uid) return;
      const t = rooms.target(uid);
      if (t) forward(t.member, 'ack', uid, seq);
    });

    socket.on('disconnect', () => {
      if (sockets.get(uid) !== socket) return;   // ya lo sustituyó otra conexión
      sockets.delete(uid);
      apply(rooms.markAway(uid, socket.id));
    });
  });

  // ---------- Relojes ----------
  const sweep = setInterval(() => {
    apply(rooms.expire());
    const t = Date.now();
    for (const [k, x] of closedAway) if (t - x.at >= CLOSED_MEMORY_MS) closedAway.delete(k);
  }, c.sweepMs || 1000);
  const clean = setInterval(() => limits.clean(), 60000);
  sweep.unref();
  clean.unref();

  function listen(port = c.port, host) {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        resolve(httpServer.address().port);
      });
    });
  }

  // Aviso a todas las salas (al reiniciar el servidor) y cierre.
  function shutdown(why = 'server-restart') {
    for (const room of rooms.all()) io.to(rk(room)).emit('closed', why);
  }

  function close() {
    clearInterval(sweep);
    clearInterval(clean);
    return new Promise(resolve => io.close(() => resolve()));
  }

  return { http: httpServer, io, rooms, limits, listen, shutdown, close, stats: () => ({ sockets: sockets.size, bytes: relayed }) };
}

module.exports = { createServer, configFromEnv, publicIp, sizeOf, VERSION };

if (require.main === module) {
  const cfg = configFromEnv();
  let srv;
  try {
    srv = createServer(cfg);
  } catch (e) {
    console.error('[relay] no arranca: ' + e.message);
    process.exit(1);
  }
  srv.listen(cfg.port).then(port => {
    console.log('[relay] escuchando en el puerto ' + port + (cfg.authEmulator ? ' (emulador de Auth)' : ''));
  }, e => {
    console.error('[relay] no se pudo abrir el puerto: ' + e.message);
    process.exit(1);
  });
  const bye = () => {
    srv.shutdown('server-restart');
    setTimeout(() => srv.close().then(() => process.exit(0)), 300);
  };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
