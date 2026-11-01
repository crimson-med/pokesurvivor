/* ============ relay.js: conexión con el servidor del cooperativo ============
 * Un socket (socket.io 4, js/vendor/socket.io.min.js) con el servidor propio del
 * cooperativo (relay/, protocolo en docs/relay-coop/02-protocol.md). Lo usan
 * net.js (señalización y, si no hay vía directa, los mensajes de la partida) y
 * social.js (salas).
 *
 * Sólo se activa con G.RELAY_URL puesto (relay-config.js) Y ?relay en la URL.
 * Si no, no se abre ninguna conexión y el juego sigue como siempre.
 *
 * Identidad: el token de Firebase de la cuenta (G.DB.fb), pedido de nuevo en
 * cada conexión y reconexión (caducan a la hora). El servidor lo comprueba con
 * las claves públicas de Google; nunca se fía de un uid que mande el cliente.
 *
 * Los errores van como códigos en err.code (los textos los pone la interfaz):
 *   connect()  'old-version' | 'bad-token' | 'busy' | 'unreachable' | 'disabled'
 *   request()  'timeout' | 'unreachable' (sin conexión o se cortó) | el err del servidor
 *   connect() también da 'disabled' sin nube (modo local) y 'bad-token' sin sesión.
 *
 * API:  enabled · state ('off'|'connecting'|'online'|'offline') · uid · room
 *       connect() · request(ev, payload) · emit(ev, ...args)
 *       on(ev, fn) · off(ev, fn) · disconnect()
 *   Eventos: 'room', 'sig', 'm', 'ack', 'peer', 'closed' (del servidor) y 'state'
 *   (fn(estado), o fn('offline', código) cuando se cierra del todo por un error).
 *   room es la última sala recibida: se borra con 'closed' o disconnect().
 */
G.Relay = (() => {
  const V = 1;                       // versión del protocolo (auth.v)
  const ACK_MS = 8000;               // espera máxima de la respuesta de request()
  const SERVER_EVENTS = ['room', 'sig', 'm', 'ack', 'peer', 'closed'];
  const CODES = ['old-version', 'bad-token', 'busy'];   // rechazos del servidor al conectar

  let socket = null;
  let state = 'off';
  let uid = null, room = null;
  let wasOnline = false;             // este socket ya llegó a conectar (si se corta, socket.io reintenta solo)
  let tokenRetried = false;          // ya se pidió un token nuevo tras un 'bad-token'
  let forceToken = false;            // la próxima conexión pide el token sin caché
  let waiting = null;                // connect() en curso: { promise, resolve, reject }
  const asking = new Set();          // request() esperando respuesta: su reject
  const listeners = new Map();       // evento -> Set de funciones

  const fail = code => { const e = new Error(code); e.code = code; return e; };

  function enabled() {
    if (!G.RELAY_URL) return false;
    try { return new URLSearchParams(location.search).has('relay'); } catch (e) { return false; }
  }

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

  const user = () => { const fb = G.DB && G.DB.fb; return (fb && fb.auth && fb.auth.currentUser) || null; };
  /** Nombre y Pokémon de cabeza, como los manda social.js a la sala. */
  function who() {
    const s = (G.DB && G.DB.save) || {};
    const me = G.Social && G.Social.me;
    const dex = s.partner | 0;
    let shiny = false;
    try { shiny = !!s.partnerShiny && !!G.DB.ownsShiny(dex); } catch (e) { /* nada */ }
    return { name: (me && me.name) || (G.DB && G.DB.user) || '', dex, shiny };
  }
  // socket.io llama a esto en cada intento de conexión: siempre con token recién pedido.
  function auth(cb) {
    const force = forceToken; forceToken = false;
    const u = user();
    Promise.resolve(u ? u.getIdToken(force) : null).catch(() => null)
      .then(token => cb(Object.assign({ v: V, token: token || null }, who())));
  }

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
    wasOnline = true; tokenRetried = false;
    const u = user(), fb = G.DB && G.DB.fb;
    uid = (u && u.uid) || (fb && fb.uid) || null;
    setState('online');
    settle(null);
  }
  function onConnectError(err) {
    const msg = err && err.message;
    const code = CODES.includes(msg) ? msg : 'unreachable';
    if (code === 'bad-token' && !tokenRetried && socket) {
      // Token caducado o de otra sesión: uno nuevo, sin caché, y otra vez. Sólo una.
      tokenRetried = true; forceToken = true;
      socket.connect();
      return;
    }
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
    // El servidor nos echó: socket.io no reintenta; el próximo connect() abre uno nuevo.
    dropAsking();
    if (reason === 'io server disconnect') teardown();
    setState('offline');
  }

  function open() {
    socket = io(G.RELAY_URL, { auth, transports: ['websocket'], forceNew: true, autoConnect: false });
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
    if (!enabled() || typeof io !== 'function') return Promise.reject(fail('disabled'));
    if (!G.DB || !G.DB.fb) return Promise.reject(fail('disabled'));   // sin nube (modo local)
    if (!user()) return Promise.reject(fail('bad-token'));
    const w = {};
    w.promise = new Promise((res, rej) => { w.resolve = res; w.reject = rej; });
    waiting = w;
    tokenRetried = false;
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

  function disconnect() {
    teardown();
    room = null;
    settle(fail('disabled'));
    setState('off');
  }

  return {
    get enabled() { return enabled(); },
    get state() { return state; },
    get uid() { return uid; },
    get room() { return room; },
    connect, request, emit, on, off, disconnect
  };
})();
