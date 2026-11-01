/* ============ relay/io.js: el socket del cooperativo (salas y reenvío) ============
 * socket.io sobre el http.Server de index.js. Hace de intermediario: salas,
 * códigos de cuatro Pokémon, la señalización de WebRTC (sig) y, para los
 * invitados que no llegan directos al anfitrión, los mensajes de la partida
 * (m). Nunca mira lo que llevan sig y m: sólo los reenvía, con el `from` de
 * quien manda. El protocolo está en docs/relay-coop/02-protocol.md.
 *
 * attach(httpServer, deps) -> { io, rooms, limits, stats(), shutdown(why), kick(uid, hash),
 *                               online(uid), send(uid, ev, ...args), rename(uid, name), close() }
 *   deps.cfg        config.js (siteUrl, maxRooms, maxSockets, maxMsgBytes,
 *                   directWaitMs, trustProxy, dev)
 *   deps.sessionOf  cabecera Cookie -> { uid, name, kind, hash, banned? } o null
 *                   (guard.fromCookie, la sesión ps_sid de http/guard.js)
 *   deps.rank       (opcional) rankings: openCoopRun(sala) -> run o null, al
 *                   empezar el anfitrión una partida (start)
 *   deps.db         (opcional) la base de datos: para no dejar entrar a una
 *                   cuenta baneada (users.banned, o su correo en bans con
 *                   deps.rank.standing), y los amigos (friendships) para
 *                   'presence' e 'invite'
 *   deps.rooms, deps.limits, deps.sweepMs, deps.now   para las pruebas
 *
 * Entrada: auth { v: 2, dex, shiny, ep } y la cookie de la sesión, que el
 * navegador manda en el handshake (mismo origen). Sin sesión válida:
 * signed-out; cuenta bloqueada: banned. El nombre es el de la cuenta. ep: un
 * texto al azar por carga de la página (ver rooms.js).
 * Las salas sólo se crean con código (create { mode }).
 * kick(uid, hash) cierra los sockets de una cuenta (con hash, sólo los de esa
 * sesión): al salir, salir de todas partes, borrar la cuenta o banearla
 * (http/admin.js).
 *
 * Amigos (paso 6, http/social.js guarda las amistades):
 *   presence(uid, online)   a sus amigos conectados, al abrir su primer socket y
 *                           al cerrarse el último (online(uid): ¿tiene socket?)
 *   invite { to }           el anfitrión a un amigo conectado: le llega
 *                           invite { from, name, dex, shiny, code }. Errores:
 *                           not-friend, offline, rate (10 por minuto, y al mismo
 *                           amigo y sala una vez cada 20 s), not-in-room, not-host,
 *                           full, started. Dura 3 minutos (en memoria)
 *   invite-answer { from, accept }   el invitado contesta: al anfitrión le llega
 *                           invite-answer(uid, accept); ack { ok, code } (con
 *                           accept) para entrar con join como siempre. expired si
 *                           ya no está; not-found si la sala ya no existe
 *   send(uid, 'friends')    lo usa social.js: la lista de amigos ha cambiado
 *   rename(uid, name)       el apodo nuevo, para la sala y las invitaciones
 *
 * Nada de lo que llevan los mensajes va al registro; las IP sólo viven en
 * memoria (límites y "misma red"), nunca se mandan a nadie.
 */
'use strict';

const { Server } = require('socket.io');
const { createRooms } = require('./rooms');
const { createLimits } = require('./limits');
const words = require('./words');
const { isLocalOrigin } = require('../config');

const VERSION = 2;
const VERSIONS = [VERSION, VERSION - 1].filter(v => v >= 1);   // la actual y la anterior
const CLOSED_MEMORY_MS = 10 * 60 * 1000;
const INVITE_MS = 3 * 60 * 1000;    // lo que dura una invitación
const REINVITE_MS = 20 * 1000;      // al mismo amigo, una vez en este tiempo
const MAX_PLAYERS = 4;

const rk = room => 'r:' + room.key;

// Mismo origen que SITE_URL; en desarrollo, también localhost con otro
// puerto. Sin Origin (no es un navegador) se deja pasar: la entrada sigue
// pidiendo la cookie de la sesión.
function originOk(o, cfg) {
  if (!o) return true;
  if (o === cfg.origin) return true;
  return !cfg.production && isLocalOrigin(o);
}

function cleanIp(ip) {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

// IP pública. Detrás de `hops` proxies de confianza (TRUST_PROXY), la que
// puso el último de ellos en X-Forwarded-For (contando desde la derecha, como
// Express): lo de la izquierda lo puede inventar el jugador. Sin proxy, o si
// la cabecera trae menos, la del socket.
function publicIp(hs, hops) {
  const h = hs.headers || {};
  const n = Number(hops) || 0;
  if (n > 0) {
    const xff = String(h['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    if (xff.length >= n) return cleanIp(xff[xff.length - n]);
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
// La carga de la página que manda el juego (relay.js): corta y sin rarezas.
const cleanEp = x => (typeof x === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(x) ? x : null);

function attach(httpServer, deps = {}) {
  const c = deps.cfg;
  if (!c) throw new Error('attach: falta deps.cfg');
  const rooms = deps.rooms || createRooms({ maxRooms: c.maxRooms, directWaitMs: c.directWaitMs, words: words.load(c.staticDir) });
  const limits = deps.limits || createLimits();
  const sessionOf = deps.sessionOf || (() => null);
  // Baneada: users.banned o, si el ranking lo sabe (rank.standing), su correo en bans
  // (que queda aunque se borre la cuenta y se vuelva a hacer con el mismo).
  const userQ = deps.db ? deps.db.prep('SELECT uid, kind, email, name, banned FROM users WHERE uid = ?') : null;
  const isBanned = who => {
    if (who.banned) return true;
    const u = userQ && userQ.get(who.uid);
    if (!u) return false;
    if (u.banned) return true;
    return !!(deps.rank && deps.rank.standing && deps.rank.standing(u) === 'banned');
  };
  const sockets = new Map();        // uid -> socket actual
  const closedAway = new Map();     // uid -> { why, at }: perdió la sala mientras estaba caído
  const invites = new Map();        // to + ' ' + from -> { from, to, key, code, at }
  const now = deps.now || Date.now;
  let relayed = 0;                  // bytes reenviados (sig + m)

  // Amigos aceptados (friendships, a < b). Sin base de datos, ninguno.
  const friendsQ = deps.db ? deps.db.prep(`SELECT CASE WHEN a = @uid THEN b ELSE a END AS uid FROM friendships
                                           WHERE (a = @uid OR b = @uid) AND status = 'ok'`) : null;
  const pairQ = deps.db ? deps.db.prep("SELECT 1 AS x FROM friendships WHERE a = ? AND b = ? AND status = 'ok'") : null;
  const friendsOf = uid => (friendsQ ? friendsQ.all({ uid }).map(r => r.uid) : []);
  const areFriends = (x, y) => !!(pairQ && pairQ.get(...(x < y ? [x, y] : [y, x])));
  const nameOf = (uid, fallback) => {
    const u = userQ && userQ.get(uid);
    return (u && u.name) || fallback || '';
  };

  const io = new Server(httpServer, {
    // Tope duro del transporte: el doble del máximo, para que un mensaje algo
    // grande llegue al manejador y se tire allí sin cortar la conexión.
    maxHttpBufferSize: c.maxMsgBytes * 2,
    pingInterval: 10000,
    pingTimeout: 10000,
    // Al recuperar una conexión también se mira la cookie (si no, una sesión
    // cerrada mientras estaba caído volvería a entrar).
    connectionStateRecovery: { maxDisconnectionDuration: 120000, skipMiddlewares: false },
    // Mismo origen: sin CORS. Los websockets no lo respetan, así que el
    // origen se mira aquí.
    allowRequest: (req, cb) => cb(null, originOk(req.headers.origin, c)),
  });

  // ---------- Aplicar lo que devuelve rooms.js ----------
  // joinSocket: el socket que entra en f.room, después de cerrar las salas viejas.
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
    // La foto antes que peer: quien vuelve tras recargar trae otro ep, y net.js tiene
    // que verlo antes de repetirle nada con la numeración de antes.
    for (const room of f.changed) io.to(rk(room)).emit('room', rooms.snapshot(room));
    for (const p of f.peer) {
      let to = io.to(rk(p.room));
      if (p.sid) to = to.except(p.sid);
      to.emit('peer', p.uid, p.state);
    }
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

  // ---------- Entrada: versión, cuenta, capacidad ----------
  io.use((socket, next) => {
    const a = socket.handshake.auth || {};
    if (!VERSIONS.includes(a.v)) return next(new Error('old-version'));
    let who = null;
    try { who = sessionOf(socket.request.headers.cookie); } catch (e) { console.error('[io] sesión: ' + e.message); }
    if (!who) return next(new Error('signed-out'));
    let banned = false;
    try { banned = isBanned(who); } catch (e) { console.error('[io] banned: ' + e.message); }
    if (banned) return next(new Error('banned'));
    if (sockets.size >= c.maxSockets && !sockets.has(who.uid)) return next(new Error('busy'));
    socket.data.uid = who.uid;
    socket.data.session = who.hash;
    socket.data.v = a.v;
    socket.data.ep = cleanEp(a.ep);
    socket.data.info = { name: who.name, dex: a.dex, shiny: a.shiny };
    socket.data.ip = publicIp(socket.handshake, c.trustProxy);
    next();
  });

  // presence(uid, online) a los amigos de uid que tienen el socket abierto.
  function presence(uid, on) {
    let list = [];
    try { list = friendsOf(uid); } catch (e) { console.error('[io] amigos: ' + e.message); }
    for (const f of list) send(f, 'presence', uid, on);
  }

  io.on('connection', socket => {
    const uid = socket.data.uid;
    const prev = sockets.get(uid);
    sockets.set(uid, socket);
    if (prev && prev !== socket) prev.disconnect(true);   // la misma cuenta en otra pestaña
    else if (!prev) presence(uid, true);

    const room = rooms.roomOf(uid);
    // Una conexión recuperada vuelve con sus salas de socket.io: fuera las
    // que ya no son la suya (hueco caducado, sala cerrada).
    for (const r of [...socket.rooms]) if (r.startsWith('r:') && (!room || r !== rk(room))) socket.leave(r);
    if (room) {
      closedAway.delete(uid);
      apply(rooms.markBack(uid, { sid: socket.id, pubIp: socket.data.ip, ep: socket.data.ep }), socket);
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

    const extra = () => ({ pubIp: socket.data.ip, sid: socket.id, v: socket.data.v, ep: socket.data.ep });
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
      const f = rooms.create(uid, socket.data.info, { mode: p.mode }, extra());
      apply(f, socket);
      reply(cb, f.ok ? { ok: true, code: f.room.code.slice(), room: rooms.snapshot(f.room) } : { ok: false, err: f.err });
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
      // El nombre es el de la cuenta (de la entrada): sólo cambian dex y shiny.
      socket.data.info = { name: socket.data.info.name, dex: p.dex, shiny: p.shiny };
      apply(rooms.update(uid, socket.data.info));
    });

    // start también abre la partida en grupo del ranking (paso 7, deps.rank):
    // el servidor apunta quién juega y cuándo empieza.
    socket.on('start', (p0, cb0) => {
      const [, cb] = args(p0, cb0);
      if (!ctl(cb)) return;
      const before = rooms.roomOf(uid);
      const fresh = !!(before && before.state === 'lobby');
      const f = rooms.start(uid);
      apply(f);
      if (!f.ok) return reply(cb, { ok: false, err: f.err });
      // Una partida por start de verdad (de la sala de espera): repetir start jugando no
      // abre otra (si no, el anfitrión podría elegir la que más le conviniera).
      // (Puede devolver el run o una promesa con él; si falla, la partida sigue sin ranking.)
      let run = null;
      try {
        run = fresh && deps.rank && deps.rank.openCoopRun ? deps.rank.openCoopRun(before) : null;
      } catch (e) { console.error('[io] openCoopRun: ' + e.message); }
      Promise.resolve(run)
        .catch(e => { console.error('[io] openCoopRun: ' + (e && e.message)); return null; })
        .then(r => reply(cb, { ok: true, run: r ?? null }));
    });

    socket.on('end', (p0, cb0) => {
      const [, cb] = args(p0, cb0);
      if (!ctl(cb)) return;
      const f = rooms.end(uid);
      apply(f);
      reply(cb, f.ok ? { ok: true } : { ok: false, err: f.err });
    });

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

    // ---------- Invitaciones a la sala (sólo a amigos conectados) ----------
    socket.on('invite', (p0, cb0) => {
      const [p, cb] = args(p0, cb0);
      if (!ctl(cb)) return;
      const to = typeof p.to === 'string' ? p.to : '';
      const room = rooms.roomOf(uid);
      if (!room) return reply(cb, { ok: false, err: 'not-in-room' });
      if (room.host !== uid) return reply(cb, { ok: false, err: 'not-host' });
      if (room.state === 'playing') return reply(cb, { ok: false, err: 'started' });
      if (room.members.size >= MAX_PLAYERS) return reply(cb, { ok: false, err: 'full' });
      if (!to || to === uid || !areFriends(uid, to)) return reply(cb, { ok: false, err: 'not-friend' });
      if (!sockets.has(to)) return reply(cb, { ok: false, err: 'offline' });
      const k = to + ' ' + uid, t = now();
      const old = invites.get(k);
      if (old && old.key === room.key && t - old.at < REINVITE_MS) return reply(cb, { ok: false, err: 'rate' });
      if (!limits.invite.take(uid)) return reply(cb, { ok: false, err: 'rate' });
      invites.set(k, { from: uid, to, key: room.key, code: room.code.slice(), at: t });
      // dex y shiny, los de la sala (ya limpios en rooms.js).
      const m = room.members.get(uid);
      send(to, 'invite', { from: uid, name: nameOf(uid, m.name), dex: m.dex, shiny: m.shiny === true, code: room.code.slice() });
      reply(cb, { ok: true });
    });

    socket.on('invite-answer', (p0, cb0) => {
      const [p, cb] = args(p0, cb0);
      if (!ctl(cb)) return;
      const from = typeof p.from === 'string' ? p.from : '';
      const k = uid + ' ' + from;
      const inv = invites.get(k);
      if (!inv || now() - inv.at >= INVITE_MS) { invites.delete(k); return reply(cb, { ok: false, err: 'expired' }); }
      invites.delete(k);
      const accept = p.accept === true;
      send(from, 'invite-answer', uid, accept);
      if (!accept) return reply(cb, { ok: true });
      const room = rooms.roomOf(from);
      if (!room || room.key !== inv.key) return reply(cb, { ok: false, err: 'not-found' });
      reply(cb, { ok: true, code: inv.code.slice() });
    });

    socket.on('disconnect', () => {
      if (sockets.get(uid) !== socket) return;   // ya lo sustituyó otra conexión
      sockets.delete(uid);
      apply(rooms.markAway(uid, socket.id));
      presence(uid, false);
    });
  });

  // ---------- Relojes ----------
  const sweep = setInterval(() => {
    apply(rooms.expire());
    const t = Date.now();
    for (const [k, x] of closedAway) if (t - x.at >= CLOSED_MEMORY_MS) closedAway.delete(k);
    const ti = now();
    for (const [k, x] of invites) if (ti - x.at >= INVITE_MS) invites.delete(k);
  }, deps.sweepMs || 1000);
  const clean = setInterval(() => limits.clean(), 60000);
  sweep.unref();
  clean.unref();

  // Aviso a todas las salas (al reiniciar el servidor) y cierre.
  function shutdown(why = 'server-restart') {
    for (const room of rooms.all()) io.to(rk(room)).emit('closed', why);
  }

  // Cierra los sockets de una cuenta (o sólo los de una sesión): sesión borrada.
  function kick(uid, hash) {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.uid === uid && (!hash || s.data.session === hash)) s.disconnect(true);
    }
  }

  // ¿Tiene esta cuenta un socket abierto? (el "en línea" de los amigos)
  const online = uid => sockets.has(uid);

  // Un evento al socket de una cuenta, si lo tiene abierto. -> true si salió
  function send(uid, ev, ...a) {
    const s = sockets.get(uid);
    if (!s || !s.connected) return false;
    s.emit(ev, ...a);
    return true;
  }

  // El apodo nuevo de una cuenta: en su socket y, si está en una sala, para los demás.
  function rename(uid, name) {
    const s = sockets.get(uid);
    if (!s) return;
    s.data.info = { ...s.data.info, name };
    if (rooms.roomOf(uid)) apply(rooms.update(uid, s.data.info));
  }

  function close() {
    clearInterval(sweep);
    clearInterval(clean);
    return new Promise(resolve => io.close(() => resolve()));
  }

  function stats() {
    const r = rooms.stats();
    return { rooms: r.rooms, sockets: sockets.size, paths: r.paths, bytes: relayed };
  }

  return { io, rooms, limits, stats, shutdown, kick, online, send, rename, close };
}

module.exports = { attach, publicIp, sizeOf, originOk, VERSION };
