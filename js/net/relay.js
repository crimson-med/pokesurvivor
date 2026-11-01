/* ============ relay.js: el socket con el servidor del juego ============
 * Un socket (socket.io 4, js/vendor/socket.io.min.js) con el servidor del
 * juego (server/relay/io.js, protocolo en docs/relay-coop/02-protocol.md), en
 * el mismo origen que la página: sin dirección aparte. Lo usan net.js
 * (señalización y, si no hay vía directa, los mensajes de la partida) y
 * social.js (salas).
 *
 * Sólo con cuenta en el servidor y la página servida por http(s)
 * (G.DB.online): social.js lo abre al entrar (start) y lo cierra al salir
 * (stop). Si se corta, socket.io vuelve a conectar solo.
 *
 * Identidad: la cookie de la sesión (ps_sid, httpOnly), que el navegador manda
 * sola en el handshake. Aquí no hay token: el servidor sabe quién eres por la
 * cookie y el nombre es el de la cuenta. auth lleva { v: 2, dex, shiny, ep }:
 * ep es esta carga de la página (al azar), para que los demás sepan si has
 * recargado (ver net.js).
 *
 * Los errores van como códigos en err.code (los textos los pone la interfaz):
 *   connect()  'old-version' | 'signed-out' | 'banned' | 'busy' | 'unreachable'
 *              ('signed-out' también sin cuenta en el servidor; 'unreachable'
 *              sin http(s) o sin el cliente de socket.io)
 *   request()  'timeout' | 'unreachable' (sin conexión o se cortó) | el err del servidor
 *
 * API:  enabled · state ('off'|'connecting'|'online'|'offline') · uid · room · ep
 *       connect() · request(ev, payload) · emit(ev, ...args)
 *       on(ev, fn) · off(ev, fn) · disconnect()
 *   Eventos: 'room', 'sig', 'm', 'ack', 'peer', 'closed', 'invite', 'presence'
 *   (del servidor) y 'state' (fn(estado), o fn('offline', código) cuando se
 *   cierra del todo por un error).
 *   room es la última sala recibida: se borra con 'closed' o disconnect().
 */
G.Relay = (() => {
  const V = 2;                       // versión del protocolo (auth.v)
  const ACK_MS = 8000;               // espera máxima de la respuesta de request()
  const SERVER_EVENTS = ['room', 'sig', 'm', 'ack', 'peer', 'closed', 'invite', 'presence'];
  const CODES = ['old-version', 'signed-out', 'banned', 'busy'];   // rechazos del servidor al conectar

  // Esta carga de la página: cambia al recargar, no al reconectar.
  const EP = (() => {
    const b = new Uint8Array(12);
    try { crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  })();

  let socket = null;
  let state = 'off';
  let uid = null, room = null;
  let wasOnline = false;             // este socket ya llegó a conectar (si se corta, socket.io reintenta solo)
  let waiting = null;                // connect() en curso: { promise, resolve, reject }
  const asking = new Set();          // request() esperando respuesta: su reject
  const listeners = new Map();       // evento -> Set de funciones

  const fail = code => { const e = new Error(code); e.code = code; return e; };

  const web = () => { try { return /^https?:$/.test(location.protocol); } catch (e) { return false; } };
  const me = () => (G.DB && G.DB.me) || null;
  /** ¿Se puede usar? Cuenta en el servidor y la página por http(s). */
  const enabled = () => web() && !!(G.DB && G.DB.online);

  function fire(ev, ...args) {
    const set = listeners.get(ev);
    if (!set) return;
    for (const fn of [...set]) { try { fn(...args); } catch (e) { console.warn('[Relay]', e); } }
  }
  // code: por qué se cerró del todo (p. ej. 'old-version' al reconectar solo, sin connect() esperando).
  function setState(s, code) {
    if (s === state && !code) return;
    state = s;
    if (code) fire('state', s, code); else fire('state', s);
  }

  /** Tu Pokémon de cabeza, como lo enseña la sala. */
  function who() {
    const s = (G.DB && G.DB.save) || {};
    const dex = s.partner | 0;
    let shiny = false;
    try { shiny = !!s.partnerShiny && !!G.DB.ownsShiny(dex); } catch (e) { /* nada */ }
    return { dex, shiny };
  }
  // socket.io llama a esto en cada intento de conexión (el Pokémon puede haber cambiado).
  function auth(cb) { cb(Object.assign({ v: V, ep: EP }, who())); }

  function settle(err) {
    const w = waiting;
    if (!w) return;
    waiting = null;
    if (err) w.reject(err); else w.resolve();
  }

  // Las respuestas que no llegaron ya no llegarán: se cortó la conexión.
  function dropAsking() {
    const rs = [...asking];
    asking.clear();
    for (const r of rs) r(fail('unreachable'));
  }

  function teardown() {
    const s = socket;
    socket = null; wasOnline = false; uid = null;
    dropAsking();
    if (!s) return;
    s.off();
    s.disconnect();
  }

  function onConnect() {
    wasOnline = true;
    const m = me();
    uid = (m && m.uid) || null;
    setState('online');
    settle(null);
  }
  function onConnectError(err) {
    const msg = err && err.message;
    const code = CODES.includes(msg) ? msg : 'unreachable';
    // Rechazado por el servidor (no reintenta solo) o nunca llegó a conectar: se cierra.
    // Si ya estuvo conectado y es la red, socket.io sigue reintentando por su cuenta.
    if (code !== 'unreachable' || !wasOnline || (socket && socket.active === false)) {
      teardown();
      setState('offline', code);
    } else setState('offline');
    settle(fail(code));
  }
  function onDisconnect(reason) {
    // 'io client disconnect' es nuestro disconnect(): ya se ocupa él.
    if (reason === 'io client disconnect') return;
    // El servidor nos echó (sesión cerrada, la misma cuenta en otra pestaña): socket.io
    // no reintenta; el próximo connect() abre uno nuevo.
    dropAsking();
    if (reason === 'io server disconnect') teardown();
    setState('offline');
  }

  function open() {
    // Mismo origen: sin dirección, y la cookie va sola.
    socket = io({ auth, transports: ['websocket'], forceNew: true, autoConnect: false });
    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.on('disconnect', onDisconnect);
    socket.on('room', r => { room = r || null; fire('room', room); });
    socket.on('closed', (...a) => { room = null; fire('closed', ...a); });
    for (const ev of SERVER_EVENTS) {
      if (ev !== 'room' && ev !== 'closed') socket.on(ev, (...a) => fire(ev, ...a));
    }
  }

  /** Conecta (si no lo está ya). Promesa: se cumple al estar 'online'. */
  function connect() {
    if (state === 'online' && socket && socket.connected) return Promise.resolve();
    if (waiting) return waiting.promise;
    if (!web() || typeof io !== 'function') return Promise.reject(fail('unreachable'));
    if (!enabled() || !me()) return Promise.reject(fail('signed-out'));
    const w = {};
    w.promise = new Promise((res, rej) => { w.resolve = res; w.reject = rej; });
    waiting = w;
    setState('connecting');
    if (socket && socket.active === false) teardown();
    if (!socket) { open(); socket.connect(); }
    // Si el socket sigue vivo, ya está reintentando: se espera a su 'connect'.
    return w.promise;
  }

  /** Mensaje con respuesta del servidor. Promesa de la respuesta. */
  function request(ev, payload) {
    if (state !== 'online' || !socket) return Promise.reject(fail('unreachable'));
    const s = socket;
    return new Promise((resolve, reject) => {
      let t = null;
      const end = () => { clearTimeout(t); asking.delete(drop); };
      const drop = err => { end(); reject(err); };
      asking.add(drop);
      t = setTimeout(() => drop(fail('timeout')), ACK_MS);
      s.emit(ev, payload === undefined ? {} : payload, res => {
        if (!asking.has(drop)) return;            // ya venció o se cortó
        end();
        if (res && typeof res === 'object' && res.ok === false) reject(fail(res.err || 'error'));
        else resolve(res);
      });
    });
  }

  /** Sin respuesta. No hace nada si no hay conexión. */
  function emit(ev, ...args) {
    if (state !== 'online' || !socket) return false;
    socket.emit(ev, ...args);
    return true;
  }

  function on(ev, fn) {
    if (typeof fn !== 'function') return;
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(fn);
  }
  function off(ev, fn) {
    const set = listeners.get(ev);
    if (set) set.delete(fn);
  }

  /** Cierra el socket (al salir de la cuenta). */
  function disconnect() {
    teardown();
    room = null;
    settle(fail('signed-out'));
    setState('off');
  }

  return {
    get enabled() { return enabled(); },
    get state() { return state; },
    get uid() { return uid; },
    get room() { return room; },
    ep: EP,
    connect, request, emit, on, off, disconnect
  };
})();
