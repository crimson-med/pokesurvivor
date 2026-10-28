/* ============ rooms.js: las salas del cooperativo (sin red) ============
 * Toda la lógica de las salas, sin sockets: funciones y un Map. server.js
 * llama a estas funciones y luego avisa a los jugadores según lo que devuelven.
 *
 * Sala    { key, code, mode, host, state, v, members, ... }
 *         key   clave de la sala: los cuatro números del código unidos con '-'
 *               (el orden cuenta) o, en el modo provisional { id }, el id, que
 *               tiene que ser el uid del anfitrión
 *         code  [d1, d2, d3, d4] o null en el modo provisional
 *         state 'lobby' | 'playing' (jugando no entra nadie nuevo)
 * Jugador { uid, name, dex, shiny, online, path, sameNet, hideIp, sid, pubIp, awayAt }
 *         path    null hasta que el anfitrión dice 'direct' o 'server'
 *         sameNet misma IP pública que el anfitrión (la IP nunca sale de aquí)
 *
 * Las funciones que cambian algo devuelven un resultado:
 *   { ok, err?, room?, changed: Set<sala>, closed: [{ room, why, except? }],
 *     gone: [{ room, uid, sid, away }], peer: [{ room, uid, sid, state }], kicked? }
 * changed: salas cuyo estado hay que mandar; closed: salas cerradas (except:
 * el uid al que no hay que avisar); gone: jugadores que dejan su hueco;
 * peer: jugadores que se van ('away') o vuelven ('online').
 */
'use strict';

const crypto = require('crypto');

const MAX_PLAYERS = 4;
const AWAY_MS = 30 * 1000;          // hueco guardado a quien se cae
const IDLE_MS = 30 * 60 * 1000;     // sala de espera sin cambios
const REUSE_MS = 10 * 60 * 1000;    // un código cerrado no se repite en este tiempo
const CODE_TRIES = 20;
const CODE_RE = /^\d+-\d+-\d+-\d+$/;
const PATHS = ['direct', 'server'];

function cleanInfo(info) {
  const i = info && typeof info === 'object' ? info : {};
  const name = typeof i.name === 'string' ? i.name.trim().slice(0, 32) : '';
  const dex = Number.isInteger(i.dex) && i.dex >= 0 && i.dex <= 100000 ? i.dex : 0;
  return { name, dex, shiny: i.shiny === true };
}

// Clave de sala a partir de lo que manda join: cuatro números o un id.
function keyOf(code) {
  if (Array.isArray(code)) {
    if (code.length !== 4 || !code.every(n => Number.isInteger(n) && n > 0)) return null;
    return code.join('-');
  }
  if (typeof code === 'string' && code && code.length <= 128) return code;
  return null;
}

function createRooms(opts = {}) {
  const words = opts.words || require('./words');
  const now = opts.now || Date.now;
  const randomInt = opts.randomInt || crypto.randomInt;
  const maxRooms = opts.maxRooms || 1000;
  const directWaitMs = opts.directWaitMs || 6000;

  const rooms = new Map();    // key -> sala
  const where = new Map();    // uid -> key de su sala
  const recent = new Map();   // key -> cuándo se cerró (para no repetir el código)

  const fx = () => ({ ok: true, changed: new Set(), closed: [], gone: [], peer: [] });
  const fail = (f, err) => Object.assign(f, { ok: false, err });

  function touch(room, f) {
    room.lastActive = now();
    f.changed.add(room);
  }

  function member(uid, info, o) {
    return {
      uid, ...cleanInfo(info),
      online: true, path: null, sameNet: false, hideIp: !!o.hideIp,
      sid: o.sid || null, pubIp: o.pubIp || null, awayAt: null,
    };
  }

  function sameNetAll(room) {
    const host = room.members.get(room.host);
    for (const m of room.members.values()) {
      m.sameNet = m.uid !== room.host && !!host && !!host.pubIp && m.pubIp === host.pubIp;
    }
  }

  function closeRoom(room, why, f, except) {
    if (rooms.get(room.key) !== room) return;
    rooms.delete(room.key);
    for (const uid of room.members.keys()) if (where.get(uid) === room.key) where.delete(uid);
    if (room.code) recent.set(room.key, now());
    room.closedAt = now();
    f.changed.delete(room);
    f.closed.push({ room, why, except });
  }

  function removeMember(room, uid, f) {
    const m = room.members.get(uid);
    if (!m) return;
    room.members.delete(uid);
    if (where.get(uid) === room.key) where.delete(uid);
    f.gone.push({ room, uid, sid: m.sid, away: !m.online });
    touch(room, f);
  }

  // Saca al jugador de la sala en la que esté. Si es el anfitrión, la sala se
  // cierra para los demás (a él no se le avisa: es quien se va).
  function detach(uid, f) {
    const room = roomOf(uid);
    if (!room) return;
    if (room.host === uid) closeRoom(room, 'host-left', f, uid);
    else removeMember(room, uid, f);
  }

  function recentlyClosed(key) {
    const t = recent.get(key);
    return t != null && now() - t < REUSE_MS;
  }

  function pickCode() {
    for (let i = 0; i < CODE_TRIES; i++) {
      const code = [0, 1, 2, 3].map(() => words[randomInt(words.length)]);
      const key = code.join('-');
      if (!rooms.has(key) && !recentlyClosed(key)) return code;
    }
    return null;
  }

  function roomOf(uid) {
    const key = where.get(uid);
    return key != null ? rooms.get(key) || null : null;
  }

  // create(uid, info, { id } | { mode }, extra) con extra = { pubIp, sid, v }
  function create(uid, info, o = {}, extra = {}) {
    const f = fx();
    const mode = o.mode === 'server' ? 'server' : 'direct';
    let key = null, code = null;
    if (o.id != null) {
      // El id es el uid del anfitrión (como la sala de hoy): nadie puede
      // quedarse con el de otro.
      if (o.id !== uid || CODE_RE.test(o.id)) return fail(f, 'bad-id');
      key = o.id;
    }
    // Lleno: sólo se puede crear si se cierra a la vez la sala que ya tienes.
    const mine = roomOf(uid);
    if (rooms.size >= maxRooms && !(mine && mine.host === uid)) return fail(f, 'busy');
    detach(uid, f);   // una sala por cuenta: la vieja se cierra
    if (key == null) {
      code = pickCode();
      if (!code) return fail(f, 'busy');
      key = code.join('-');
    }
    const t = now();
    const room = {
      key, code, mode, host: uid, state: 'lobby', v: extra.v,
      createdAt: t, lastActive: t, closedAt: null,
      peak: 1, bytes: 0, members: new Map(),
    };
    room.members.set(uid, member(uid, info, extra));
    rooms.set(key, room);
    where.set(uid, key);
    touch(room, f);
    f.room = room;
    return f;
  }

  // join(code, uid, info, { pubIp, sid, v, hideIp })
  function join(code, uid, info, o = {}) {
    const f = fx();
    const key = keyOf(code);
    const room = key != null ? rooms.get(key) : null;
    if (!room) return fail(f, 'not-found');
    const back = room.members.get(uid);
    if (back) {
      // Ya estaba (vuelve tras caerse o repite el join): recupera su hueco.
      Object.assign(back, cleanInfo(info));
      if (uid !== room.host) back.hideIp = !!o.hideIp;
      reattach(room, back, o, f);
      f.room = room;
      return f;
    }
    if (room.v !== o.v) return fail(f, 'old-version');
    if (room.state === 'playing') return fail(f, 'started');
    if (room.members.size >= MAX_PLAYERS) return fail(f, 'full');
    detach(uid, f);
    room.members.set(uid, member(uid, info, o));
    room.peak = Math.max(room.peak, room.members.size);
    where.set(uid, key);
    sameNetAll(room);
    touch(room, f);
    f.room = room;
    return f;
  }

  function reattach(room, m, o, f) {
    if (o.sid) m.sid = o.sid;
    if (o.pubIp) m.pubIp = o.pubIp;
    if (!m.online) {
      m.online = true;
      m.awayAt = null;
      f.peer.push({ room, uid: m.uid, sid: m.sid, state: 'online' });
    }
    sameNetAll(room);
    touch(room, f);
  }

  function leave(uid) {
    const f = fx();
    detach(uid, f);
    return f;
  }

  function update(uid, info) {
    const f = fx();
    const room = roomOf(uid);
    if (!room) return fail(f, 'not-in-room');
    Object.assign(room.members.get(uid), cleanInfo(info));
    touch(room, f);
    return f;
  }

  function hostRoom(uid, f) {
    const room = roomOf(uid);
    if (!room) { fail(f, 'not-in-room'); return null; }
    if (room.host !== uid) { fail(f, 'not-host'); return null; }
    return room;
  }

  function setState(uid, state) {
    const f = fx();
    const room = hostRoom(uid, f);
    if (!room) return f;
    room.state = state;
    touch(room, f);
    return f;
  }

  const start = uid => setState(uid, 'playing');
  const end = uid => setState(uid, 'lobby');

  function kick(hostUid, uid) {
    const f = fx();
    const room = hostRoom(hostUid, f);
    if (!room) return f;
    const m = room.members.get(uid);
    if (!m || uid === room.host) return fail(f, 'not-found');
    f.kicked = { room, uid, sid: m.sid };
    removeMember(room, uid, f);
    return f;
  }

  function path(hostUid, uid, p) {
    const f = fx();
    const room = hostRoom(hostUid, f);
    if (!room) return f;
    const m = room.members.get(uid);
    if (!m || uid === room.host || !PATHS.includes(p)) return fail(f, 'bad-path');
    if (m.path !== p) {
      m.path = p;
      touch(room, f);
    }
    return f;
  }

  // Se cayó el socket `sid` del jugador. Si ya tiene otro socket, no cuenta.
  function markAway(uid, sid) {
    const f = fx();
    const room = roomOf(uid);
    const m = room && room.members.get(uid);
    if (!m || (sid && m.sid !== sid) || !m.online) return f;
    m.online = false;
    m.awayAt = now();
    f.peer.push({ room, uid, sid: m.sid, state: 'away' });
    touch(room, f);
    return f;
  }

  // Vuelve con un socket nuevo (o el mismo, si se recuperó la conexión).
  function markBack(uid, o = {}) {
    const f = fx();
    const room = roomOf(uid);
    const m = room && room.members.get(uid);
    if (!m) return fail(f, 'not-in-room');
    reattach(room, m, o, f);
    f.room = room;
    return f;
  }

  // Pasa el tiempo: huecos caducados, salas de espera abandonadas y códigos
  // viejos. server.js la llama cada segundo.
  function expire() {
    const f = fx();
    const t = now();
    for (const room of [...rooms.values()]) {
      for (const m of [...room.members.values()]) {
        if (m.online || t - m.awayAt < AWAY_MS) continue;
        if (m.uid === room.host) { closeRoom(room, 'host-left', f); break; }
        removeMember(room, m.uid, f);
      }
      if (rooms.get(room.key) === room && room.state === 'lobby' && t - room.lastActive >= IDLE_MS) {
        closeRoom(room, 'idle', f);
      }
    }
    for (const [k, at] of recent) if (t - at >= REUSE_MS) recent.delete(k);
    return f;
  }

  // A quién va un sig, m o ack: los invitados sólo llegan al anfitrión, diga
  // lo que diga `to`; el anfitrión llega a cualquier otro jugador de su sala.
  function target(fromUid, to) {
    const room = roomOf(fromUid);
    if (!room) return null;
    if (fromUid !== room.host) {
      const host = room.members.get(room.host);
      return host ? { room, member: host } : null;
    }
    if (typeof to !== 'string' || to === room.host) return null;
    const m = room.members.get(to);
    return m ? { room, member: m } : null;
  }

  function snapshot(room) {
    return {
      code: room.code ? room.code.slice() : null,
      state: room.state,
      mode: room.mode,
      host: room.host,
      directWaitMs,
      members: [...room.members.values()].map(m => ({
        uid: m.uid, name: m.name, dex: m.dex, shiny: m.shiny,
        online: m.online, path: m.path, sameNet: m.sameNet, hideIp: m.hideIp,
      })),
    };
  }

  function stats() {
    const paths = { direct: 0, server: 0 };
    for (const room of rooms.values()) {
      for (const m of room.members.values()) if (m.path) paths[m.path]++;
    }
    return { rooms: rooms.size, paths };
  }

  return {
    create, join, leave, update, start, end, kick, path,
    markAway, markBack, expire, target, snapshot, stats, roomOf,
    all: () => [...rooms.values()],
    get size() { return rooms.size; },
  };
}

module.exports = { createRooms, keyOf, cleanInfo, MAX_PLAYERS, AWAY_MS, IDLE_MS, REUSE_MS };
