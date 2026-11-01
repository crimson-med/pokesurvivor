/* ============ social.js: apodo, amigos, invitaciones y salas ============
 * Sólo funciona con cuenta en el servidor del juego (G.DB.online). Todo va
 * por el servidor: la API (G.Api) para lo que se guarda y el socket (G.Relay)
 * para lo que pasa ahora. Protocolo en docs/relay-coop/02-protocol.md.
 *
 *   Salas (G.Relay)
 *     La sala vive en el servidor y es él quien manda en ella: crear, entrar,
 *     salir, empezar y acabar son eventos del socket, y la lista llega en el
 *     evento 'room'. La sala se llama por su código: cuatro números de la
 *     Pokédex en orden (room.id = '25-95-151-133'). Ver «salas» más abajo.
 *     start() abre el socket al entrar en la cuenta y stop() lo cierra al salir.
 *     Si recargas la página estando en una sala (en los 30 s que el servidor te
 *     guarda el hueco), al volver a conectar la sala vuelve sola.
 *
 *   Apodo (PUT /api/me/name)
 *     Único sin mirar mayúsculas. Hasta elegir uno, la cuenta se llama "Guest"
 *     y 4 cifras: con correo, start() dice 'need-nick' (y me es null hasta
 *     elegirlo); los invitados juegan con ese nombre.
 *
 *   Amigos (/api/friends, sólo cuentas con correo)
 *     La lista se pide al empezar y otra vez cuando el servidor avisa con
 *     'friends' (te piden, aceptan o quitan) o al volver a conectar el socket.
 *     "En línea" llega con la lista y luego con 'presence' (uid, online).
 *
 *   Invitaciones (socket)
 *     El anfitrión manda invite { to } a un amigo conectado; al amigo le llega
 *     'invite' { from, name, dex, shiny, code }. Aceptar contesta invite-answer
 *     (el servidor da el código) y entra en la sala con él. Caducan a los 3
 *     minutos (lo cuenta el servidor; aquí se borran a la vez).
 *
 *   Perfil público (PUT /api/profile, GET /api/profile/:uid)
 *     Como mucho una vez por minuto (el tope del servidor).
 *
 * El resto del juego escucha los cambios con G.Social.on(fn).
 */
G.Social = (() => {
  const VALID = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;
  const DEFAULT_NAME = /^guest\d{4}$/i;   // el que pone el servidor hasta elegir apodo
  const MAX_PLAYERS = 4;
  const INVITE_TTL = 3 * 60 * 1000;
  const REINVITE_MS = 20 * 1000;     // volver a invitar al mismo amigo antes de esto no manda nada
  const PROFILE_MS = 60 * 1000;      // el perfil, como mucho una vez por minuto (como el servidor)
  /*
   * Hora real: la del servidor de la web (cabecera Date de version.json).
   * Si el reloj del aparato va adelantado (p. ej. la zona horaria mal puesta),
   * lo que cuenta con la hora sale mal (pasaba en 2026-10). Las invitaciones ya
   * caducan en el servidor, pero otros relojes del juego la usan.
   */
  let skew = 0;
  const now = () => Date.now() + skew;
  function measureSkew() {
    const t0 = Date.now();
    fetch('version.json?t=' + t0, { method: 'HEAD', cache: 'no-store' }).then(r => {
      const d = Date.parse(r.headers.get('date') || '');
      if (!d) return;
      const s = d + 500 - (t0 + Date.now()) / 2;          // (la cabecera va en segundos)
      skew = Math.abs(s) > 60000 ? s : 0;
      if (skew) console.warn('[Social] el reloj de este aparato va desfasado', Math.round(skew / 60000), 'min: se corrige');
    }).catch(() => {});
  }
  let uid = null;
  let me = null;                    // { uid, name }
  let friends = new Map();          // otherUid -> { uid, name, status: 'ok'|'in'|'out', online }
  const sentInv = new Map();        // a quién invitaste: uid -> { room, at } (para no repetir)
  let room = null;                  // { id, host, isHost, code, mode, state, members: [{ uid, name, dex,
                                    // shiny, online, path, sameNet, hideIp }] } (ver fromSnap)
  const invites = new Map();        // fromUid -> { from, name, dex, shiny, code, room, at }
  const listeners = new Set();
  let started = false;

  function emit(what) { listeners.forEach(fn => { try { fn(what); } catch (e) { console.warn(e); } }); }
  const errCode = e => (e && e.code) || 'error';
  /** ¿Puede tener amigos? (cuenta con correo en el servidor) */
  const canFriend = () => !!(G.DB.me && G.DB.me.kind === 'email');

  // ---------------- arranque ----------------

  /**
   * Tras iniciar sesión (y cada vez que hace falta el apodo: es barato).
   * → 'ok' | 'need-nick' | 'off' (sin cuenta en el servidor)
   */
  async function start() {
    if (!G.DB.online || !G.DB.me) return 'off';
    if (started) {
      // Un invitado que añade su correo sigue siendo la misma cuenta: ahora puede tener
      // amigos, así que se piden y, si aún tiene el nombre de serie, toca elegir apodo.
      if (canFriend()) {
        if (!friendsReady) loadFriends();
        if (me && DEFAULT_NAME.test(me.name)) me = null;
      }
      return me ? 'ok' : 'need-nick';
    }
    started = true;
    measureSkew();
    // Las salas, por el servidor: el socket se abre ya (y si la página se recargó
    // estando en una sala, el servidor la manda y se vuelve a ella, ver adopt).
    uid = G.DB.me.uid;
    hookRelay();
    if (G.Relay && G.Relay.enabled) {
      G.Relay.connect().then(() => adopt(G.Relay.room), e => console.warn('[Social] socket:', e.code || e.message));
    }
    if (canFriend()) loadFriends();
    const name = G.DB.me.name || '';
    // Con correo y sin apodo todavía: hay que elegirlo (los invitados juegan con el de serie).
    if (canFriend() && (!name || DEFAULT_NAME.test(name))) return 'need-nick';
    me = { uid, name };
    // El nombre de la partida es el apodo (pudo elegirse en otro aparato).
    if (name && G.DB.user !== name) G.DB.setName(name);
    return 'ok';
  }

  /** Elige el apodo (único) de la cuenta. → { ok } | { ok: false, error } */
  async function claimNick(name) {
    name = (name || '').trim();
    if (!VALID.test(name)) return { ok: false, error: 'El apodo debe tener 3-16 letras, números o _.' };
    if (DEFAULT_NAME.test(name)) return { ok: false, error: 'Ese apodo ya lo tiene otro jugador.' };
    let r;
    try { r = await G.Api.put('/api/me/name', { name }); } catch (e) {
      if (e.code === 'taken') return { ok: false, error: 'Ese apodo ya lo tiene otro jugador.' };
      if (e.code === 'invalid') return { ok: false, error: 'El apodo debe tener 3-16 letras, números o _.' };
      return { ok: false, error: 'No se pudo guardar el apodo (' + errCode(e) + ').' };
    }
    const m = r && r.me;
    if (m && G.DB.updateMe) G.DB.updateMe(m);
    me = { uid, name: (m && m.name) || name };
    G.DB.setName(me.name);
    publishProfile(true);
    emit('me');
    return { ok: true };
  }

  async function stop() {
    if (!started) return;
    await leaveRoom().catch(() => {});
    if (G.Relay) G.Relay.disconnect();          // (el leave sale antes: el socket va en orden)
    clearTimeout(pubT);
    for (const i of invites.values()) clearTimeout(i.timer);
    friends.clear(); invites.clear(); sentInv.clear(); profCache.clear();
    friendsReady = null; friendsSeq++;
    me = null; started = false; uid = null; playing = false; pubAt = 0; pubLast = '';
    emit('stop');
  }

  let playing = false;
  function setPlaying(p) {
    playing = !!p;
    if (room) relayRun(playing);
    // Al acabar la partida, la sala se vuelve a comprobar (los que se fueron, fuera).
    if (!playing && room) emit('room');
  }

  // ---------------- amigos ----------------

  let friendsReady = null, friendsSeq = 0;
  /** Pide la lista al servidor (si falla, se queda la de antes). Promesa que no falla. */
  function loadFriends() {
    if (!started || !canFriend()) return Promise.resolve();
    const seq = ++friendsSeq;
    const p = G.Api.get('/api/friends').then(list => {
      if (seq !== friendsSeq) return;                // ya hay otra en camino (o saliste)
      const next = new Map();
      for (const f of Array.isArray(list) ? list : []) {
        if (!f || typeof f.uid !== 'string' || !['ok', 'in', 'out'].includes(f.status)) continue;
        next.set(f.uid, { uid: f.uid, name: typeof f.name === 'string' ? f.name : '???', status: f.status,
                          online: f.status === 'ok' && f.online === true });
      }
      friends = next;
      // Las invitaciones de quien ya no es tu amigo, fuera.
      for (const [k, i] of invites) if (!next.has(k) || next.get(k).status !== 'ok') { clearTimeout(i.timer); invites.delete(k); }
      emit('friends');
      emit('invites');
    }, e => {
      console.warn('[Social] amigos:', errCode(e));
      if (friendsReady === p) friendsReady = null;   // (la próxima vez se vuelve a pedir)
    });
    if (!friendsReady) friendsReady = p;
    return p;
  }

  /** La lista de amigos, cargada (la primera vez la pide). */
  function ensureFriends() {
    if (!started || !canFriend()) return Promise.resolve();
    return friendsReady || loadFriends();
  }

  function onPresence(u, on) {
    const f = friends.get(u);
    if (!f || f.status !== 'ok') return;
    f.online = on === true;
    emit('friends');
  }

  const FRIEND_ERR = {
    'needs-email': 'Añade un correo para tener amigos.',
    'not-found': 'No hay ningún jugador con ese apodo.',
    invalid: 'Escribe el apodo exacto de tu amigo.',
    full: 'Uno de los dos ya tiene 200 amigos, el máximo.',
    'too-many': 'Tienes 50 solicitudes sin contestar. Espera a que te respondan.',
    rate: 'Demasiados intentos. Espera un minuto y vuelve a probar.'
  };

  /** Envía una solicitud de amistad (o acepta la que ya te había mandado). */
  async function request(name) {
    name = (name || '').trim();
    if (!canFriend()) return { ok: false, error: FRIEND_ERR['needs-email'] };
    if (!me) return { ok: false, error: 'Primero elige tu apodo.' };
    if (!VALID.test(name)) return { ok: false, error: FRIEND_ERR.invalid };
    if (name.toLowerCase() === me.name.toLowerCase()) return { ok: false, error: 'Ese eres tú.' };
    const known = () => [...friends.values()].find(x => x.name.toLowerCase() === name.toLowerCase());
    const f = known();
    if (f && f.status === 'ok') return { ok: false, error: 'Ya sois amigos.' };
    if (f && f.status === 'out') return { ok: false, error: 'Ya le enviaste una solicitud.' };
    if (f && f.status === 'in') return accept(f.uid);
    try { await G.Api.post('/api/friends', { name }); } catch (e) {
      if (e.code === 'conflict') {
        // Ya había algo entre los dos: la lista dice qué.
        await loadFriends();
        const g = known();
        return { ok: false, error: g && g.status === 'ok' ? 'Ya sois amigos.' : 'Ya le enviaste una solicitud.' };
      }
      return { ok: false, error: FRIEND_ERR[e.code] || 'No se pudo enviar (' + errCode(e) + ').' };
    }
    await loadFriends();
    const g = known();
    // (Si te la había mandado a la vez, el servidor la acepta.)
    if (g && g.status === 'ok') return { ok: true, msg: 'Ahora eres amigo de ' + g.name };
    return { ok: true, msg: 'Solicitud enviada a ' + (g ? g.name : name) };
  }

  async function accept(other) {
    const f = friends.get(other);
    if (!f || f.status !== 'in') return { ok: false, error: 'No hay solicitud.' };
    try { await G.Api.post('/api/friends/' + encodeURIComponent(other) + '/accept', {}); } catch (e) {
      if (e.code === 'not-found') { loadFriends(); return { ok: false, error: 'No hay solicitud.' }; }
      return { ok: false, error: FRIEND_ERR[e.code] || 'No se pudo aceptar (' + errCode(e) + ').' };
    }
    f.status = 'ok';
    emit('friends');
    loadFriends();                              // (con su "en línea")
    return { ok: true, msg: 'Ahora eres amigo de ' + f.name };
  }

  async function remove(other) {
    const f = friends.get(other);
    if (!f) return { ok: false };
    try { await G.Api.del('/api/friends/' + encodeURIComponent(other), {}); } catch (e) {
      return { ok: false, error: 'No se pudo borrar (' + errCode(e) + ').' };
    }
    friends.delete(other);
    emit('friends');
    return { ok: true };
  }

  // ---------------- salas ----------------
  /*
   * La sala está en el servidor, que manda en ella:
   *   createRoom -> create { mode }        joinRoom    -> join { code, hideIp }
   *   leaveRoom  -> leave                  refreshMember -> member { name, dex, shiny }
   *   setPlaying / setOpen -> start / end (una sala en partida no admite a nadie)
   *   dropMember -> kick { uid }
   * y del servidor llegan 'room' (la sala entera), 'peer' (alguien se corta,
   * vuelve o pierde la plaza) y 'closed' (la sala se acabó: emit('room-closed')).
   * La sala que ve la interfaz: id, host, isHost, members, más code, mode, state y,
   * por jugador, online, path, sameNet y hideIp.
   * Los fallos son Error con .code ('not-found', 'full', 'started', 'rate',
   * 'old-version', 'signed-out', 'banned', 'busy', 'unreachable', 'timeout'...): el
   * texto lo pone la interfaz. joinRoom devuelve { ok: false, code, error }.
   */

  /** Tu apodo y tu Pokémon, como se ven en la sala. */
  function pokeInfo() {
    const s = G.DB.save;
    return { name: me ? me.name : '', dex: s.partner, shiny: !!s.partnerShiny && G.DB.ownsShiny(s.partner) };
  }

  const codeKey = c => (Array.isArray(c) ? c.join('-') : '');
  const hideIp = () => !!(G.Settings && G.Settings.get && G.Settings.get('coopHideIp'));
  function codeErr(code) { const e = Error(code); e.code = code; return e; }
  const asErr = e => (e && e.code && typeof e.message === 'string' ? e : codeErr((e && e.code) || 'unreachable'));
  const failed = e => { const err = asErr(e); return { ok: false, code: err.code, error: err }; };

  /** Un código: [4 números], 'n1-n2-n3-n4' (room.id) o lo que escribe el jugador. -> [4] | null */
  function toCode(x) {
    let c = null;
    if (Array.isArray(x)) c = x.map(Number);
    else if (typeof x === 'string') {
      const s = x.trim();
      if (/^\d+(-\d+){3}$/.test(s)) c = s.split('-').map(Number);
      else if (s && G.RoomCode && G.RoomCode.parseCode) c = G.RoomCode.parseCode(s);
    }
    return Array.isArray(c) && c.length === 4 && c.every(n => Number.isInteger(n) && n > 0) ? c : null;
  }

  /** La sala del servidor (snapshot) con la forma de siempre; r: la que ya había (se rellena). */
  function fromSnap(s, r) {
    const host = s.host;
    const members = (Array.isArray(s.members) ? s.members : []).filter(m => m && m.uid).map(m => ({
      uid: m.uid, name: m.name, dex: m.dex, shiny: !!m.shiny,
      online: m.online !== false, path: m.path || null, sameNet: !!m.sameNet, hideIp: !!m.hideIp
    }))
      // El anfitrión siempre primero; el resto en el orden del servidor (el de llegada).
      .sort((a, b) => (a.uid === host ? -1 : b.uid === host ? 1 : 0));
    // run: lo último que pidió el anfitrión (start / end); sólo lo cambia relayRun.
    return Object.assign(r || { run: s.state === 'playing' }, {
      id: codeKey(s.code) || (r && r.id) || host, code: Array.isArray(s.code) ? s.code.slice() : r ? r.code : null,
      mode: s.mode === 'server' ? 'server' : 'direct', state: s.state,
      directWaitMs: s.directWaitMs, host, isHost: host === uid, members, open: s.state !== 'playing'
    });
  }

  let hooked = false, creating = null;
  let relayGen = 0;                 // sube al salir: una respuesta de create / join de antes ya no vale
  let leftId = '';                  // la última sala de la que saliste (no se vuelve a ella sola)
  let joining = 0;                  // join en camino: su foto llega antes que la respuesta (no es una recarga)
  function hookRelay() {
    if (hooked || !G.Relay) return;
    hooked = true;
    G.Relay.on('room', onRelayRoom);
    G.Relay.on('peer', onRelayPeer);
    G.Relay.on('closed', onRelayClosed);
    // Amigos e invitaciones.
    G.Relay.on('invite', onInvite);
    G.Relay.on('presence', onPresence);
    G.Relay.on('friends', () => loadFriends());
    // El amigo contestó (sí o no): se le puede volver a invitar sin esperar.
    G.Relay.on('invite-answer', u => { sentInv.delete(u); });
    // Al volver a conectar (no la primera vez), el "en línea" pudo cambiar sin aviso: la lista otra vez.
    let wasOnline = false;
    G.Relay.on('state', st => {
      if (st !== 'online') return;
      if (wasOnline && started && friendsReady) loadFriends();
      wasOnline = true;
    });
  }

  function onRelayRoom(s) {
    if (!s) return;
    if (!room) { adopt(s); return; }
    const k = codeKey(s.code);
    if (k ? k !== room.id : s.host !== room.host) return;            // otra sala (una de antes)
    if (!(s.members || []).some(m => m && m.uid === uid)) { closedRoom(); return; }   // ya no estás
    fromSnap(s, room);
    emit('room');
  }

  /*
   * El servidor te tiene en una sala y aquí no hay ninguna: has recargado la página
   * (o se cerró la pestaña) y has vuelto en los 30 s que te guarda el hueco. Se
   * vuelve a ella. Si eras el anfitrión y estaba en partida, se acaba (la partida
   * se perdió al recargar) para que la sala vuelva a admitir gente.
   */
  function adopt(s) {
    if (room || creating || joining || !started || !s || !uid) return;
    const k = codeKey(s.code);
    if (!k || k === leftId || !(s.members || []).some(m => m && m.uid === uid)) return;
    room = fromSnap(s, null);
    if (room.isHost && room.run && !(G.Coop && G.Coop.active)) relayRun(false);
    emit('room');
  }

  function onRelayPeer(u, st) {
    if (!room) return;
    const m = room.members.find(x => x.uid === u);
    if (!m) return;
    if (st === 'gone') room.members = room.members.filter(x => x !== m);
    else m.online = st === 'online';
    emit('room');
  }

  function onRelayClosed() {
    if (room) closedRoom();
  }

  /** opts: { mode: 'direct' | 'server' } o el modo tal cual. */
  function createRoom(opts) {
    if (room) return Promise.resolve(room);
    return creating || (creating = relayCreate(opts).finally(() => { creating = null; }));
  }

  async function relayCreate(opts) {
    const mode = (typeof opts === 'string' ? opts : opts && opts.mode) === 'server' ? 'server' : 'direct';
    hookRelay();
    const gen = relayGen;
    let a;
    try {
      await G.Relay.connect();
      leftId = '';
      a = await G.Relay.request('create', { mode });
    } catch (e) { throw asErr(e); }
    if (gen !== relayGen || room) {           // saliste (o entraste en otra) mientras tanto
      if (!room) G.Relay.request('leave', {}).catch(() => {});
      if (room) return room;
      throw codeErr('left');
    }
    const s = (a && a.room) || { state: 'lobby', mode, host: uid, members: [Object.assign({ uid }, pokeInfo())] };
    room = fromSnap(a && a.code ? Object.assign({}, s, { code: a.code }) : s, null);
    emit('room');
    return room;
  }

  async function joinRoom(x) {
    const code = toCode(x);
    if (!code) return failed(codeErr('not-found'));
    if (room && room.id === codeKey(code)) return { ok: true };
    if (room) await leaveRoom();
    hookRelay();
    const gen = relayGen;
    let a;
    joining++;
    try {
      await G.Relay.connect();
      leftId = '';
      a = await G.Relay.request('join', { code, hideIp: hideIp() });
    } catch (e) { return failed(e); }
    finally { joining--; }
    if (gen !== relayGen || room) {           // saliste mientras tanto: fuera también en el servidor
      if (!room) G.Relay.request('leave', {}).catch(() => {});
      return failed(codeErr('left'));
    }
    const last = G.Relay.room;
    const s = (a && a.room) || (last && codeKey(last.code) === codeKey(code) ? last : null);
    if (!s) return failed(codeErr('not-found'));
    room = fromSnap(Object.assign({}, s, { code: s.code || code }), null);
    room.sameNet = !!(a && a.sameNet);
    emit('room');
    return { ok: true, sameNet: room.sameNet };
  }

  /** Anfitrión: quita a alguien de la sala (se cortó en partida y no volvió). */
  function dropMember(u) {
    if (room && room.isHost && u !== uid) G.Relay.request('kick', { uid: u }).catch(e => console.warn('[Social] kick:', e.code || e.message));
  }

  function closedRoom() {
    if (!room) return;
    room = null;
    retractInvites();
    emit('room-closed');
  }

  async function leaveRoom() {
    if (!room && creating) { relayGen++; return; }      // aún creándose: se deshace al llegar la respuesta
    if (!room) return;
    relayGen++;
    leftId = room.id;
    room = null;
    // Sin esperar la respuesta: el socket manda los eventos en orden (un join
    // después llega detrás) y, sin conexión, el servidor libera la plaza solo.
    G.Relay.request('leave', {}).catch(() => {});
    retractInvites();
    emit('room');
  }

  /** El anfitrión cierra la sala a nuevos jugadores al empezar la partida (va con start / end). */
  function setOpen(open) { relayRun(!open); }

  /** Actualiza tu Pokémon en la sala (si cambias de compañero). */
  function refreshMember() {
    if (room && me) G.Relay.emit('member', pokeInfo());
  }

  /*
   * Anfitrión: empieza (on) o acaba la partida en el servidor, una sola vez por cambio.
   * El ack de 'start' trae la partida del ranking que abre el servidor (run, o null si
   * estás solo): va a G.Ranking (setCoopRun) y queda en runId para cuando se suba.
   */
  let runId = null;
  function relayRun(on) {
    if (!room || !room.isHost || room.run === on) return;
    room.run = on;
    room.open = !on;
    if (on) setRun(null);                      // (la de la partida de antes ya no vale)
    G.Relay.request(on ? 'start' : 'end', {}).then(a => {
      if (on) setRun(a && typeof a.run === 'string' && a.run ? a.run : null);
    }, e => console.warn('[Social] ' + (on ? 'start' : 'end') + ':', e.code || e.message));
  }
  function setRun(run) {
    runId = run;
    if (G.Ranking && G.Ranking.setCoopRun) G.Ranking.setCoopRun(run);
  }

  // ---------------- misma wifi ----------------
  /*
   * En la misma wifi no se suele poder conectar sólo con STUN (ver net.js,
   * lanCandidate). Si el servidor dice que un invitado está en tu red (sameNet) y va
   * por el servidor, la sala ofrece «Conectar en local»: el anfitrión escribe su IP
   * local y el juego la usa para conectar directo. La IP sólo se queda aquí
   * (room.lanIp): no se manda a nadie.
   */
  const BAD_IP = 'Esa no es una IP local. Empieza por 192.168., 10. o 172.16 a 172.31.';

  /** Anfitrión: pone su sala (la crea si hace falta) en modo local con su IP. */
  async function setLocal(ip) {
    ip = String(ip || '').trim();
    if (!G.Net.isLocalIp(ip)) return { ok: false, error: BAD_IP };
    if (room && !room.isHost) return { ok: false, error: 'Sólo el anfitrión de la sala puede hacerlo.' };
    let r = room;
    // Si no se puede crear la sala, el fallo es el resultado (como en joinRoom).
    if (!r) { try { r = await createRoom(); } catch (e) { return failed(e); } }
    r.lanIp = ip;
    emit('room');
    return { ok: true };
  }

  // ---------------- invitaciones ----------------
  /*
   * invite -> invite { to } (sólo el anfitrión, a un amigo conectado). Errores del
   * servidor en .code: not-friend, offline, rate, full, started... (el texto lo
   * pone la interfaz). Al amigo le llega 'invite'; acceptInvite contesta
   * invite-answer y entra con el código que da el servidor.
   */

  async function invite(other) {
    const f = friends.get(other);
    if (!f || f.status !== 'ok') return { ok: false, error: 'Sólo puedes invitar a tus amigos.' };
    if (room && room.members.length >= MAX_PLAYERS) return { ok: false, error: 'La sala está llena.' };
    if (room && !room.isHost) return { ok: false, error: 'Sólo el anfitrión de la sala puede invitar.' };
    if (!room) { try { await createRoom(); } catch (e) { return failed(e); } }
    // Acabas de invitarle a esta sala: ya la tiene (pulsar otra vez no manda nada; 25-10-2026).
    const s = sentInv.get(other);
    if (s && s.room === room.id && Date.now() - s.at < REINVITE_MS) return { ok: true, msg: 'Invitación enviada a ' + f.name };
    try { await G.Relay.request('invite', { to: other }); } catch (e) {
      // El código lo traduce la interfaz; si no lo conoce, este texto.
      const r = failed(e);
      return Object.assign(r, { error: 'No se pudo invitar (' + r.code + ').' });
    }
    sentInv.set(other, { room: room.id, at: Date.now() });
    return { ok: true, msg: 'Invitación enviada a ' + f.name };
  }

  /** Al salir de la sala se olvida a quién invitaste (si aceptan una de antes, el servidor dice que ya no está). */
  function retractInvites() { sentInv.clear(); }

  function onInvite(v) {
    if (!v || typeof v.from !== 'string' || v.from === uid) return;
    const code = toCode(v.code);
    if (!code) return;
    // (El servidor sólo deja invitar a amigos: si la lista aún no lo sabe, se pide otra vez.)
    if (!friends.has(v.from)) loadFriends();
    const old = invites.get(v.from);
    if (old) clearTimeout(old.timer);
    const inv = { from: v.from, name: typeof v.name === 'string' ? v.name : '???', dex: v.dex | 0, shiny: v.shiny === true,
                  code, room: codeKey(code), at: Date.now() };
    // Caduca a la vez que en el servidor.
    inv.timer = setTimeout(() => { if (invites.get(v.from) === inv) { invites.delete(v.from); emit('invites'); } }, INVITE_TTL);
    invites.set(v.from, inv);
    emit('invites');
  }

  async function acceptInvite(from) {
    const inv = invites.get(from);
    if (!inv || Date.now() - inv.at > INVITE_TTL) { invites.delete(from); emit('invites'); return { ok: false, error: 'La invitación ha caducado.' }; }
    clearTimeout(inv.timer);
    invites.delete(from);
    emit('invites');
    let a;
    try { a = await G.Relay.request('invite-answer', { from, accept: true }); } catch (e) {
      if (e && (e.code === 'expired' || e.code === 'not-found')) return { ok: false, error: 'La invitación ha caducado.' };
      return failed(e);
    }
    return joinRoom((a && toCode(a.code)) || inv.code);
  }

  function declineInvite(from) {
    const inv = invites.get(from);
    if (inv) clearTimeout(inv.timer);
    invites.delete(from);
    if (G.Relay && G.Relay.state === 'online') G.Relay.request('invite-answer', { from, accept: false }).catch(() => {});
    emit('invites');
  }

  // ---------------- perfil público ----------------

  /** Lo que se enseña de ti (también para tu vista previa, sin subirlo). */
  function profileData() {
    const s = G.DB.save, st = s.stats, prof = s.profile || {};
    const unlocked = G.AchDefs.LIST.filter(a => s.ach && s.ach[a.id]);
    const medals = unlocked.slice().sort((a, b) => (b.tier - a.tier) || (s.ach[b.id] - s.ach[a.id])).slice(0, 8).map(a => a.id);
    return {
      name: me ? me.name : G.DB.user,
      favs: (prof.favs || []).slice(0, 3).map(f => ({ dex: f.dex | 0, shiny: !!f.shiny })),
      title: prof.title || '',
      best: { solo: st.bestTime | 0, group: st.bestGroupTime | 0, level: st.bestLevel | 0, bosses: st.bossesTotal | 0,
              legends: Object.keys(s.legends || {}).length, kills: st.totalKills | 0, medals: unlocked.length },
      medals
    };
  }

  let pubT = 0, pubAt = 0, pubLast = '';
  /**
   * Sube tu perfil (con un poco de espera, por si cambias varias cosas
   * seguidas), pero SÓLO si ha cambiado algo de lo que se ve a primera vista:
   * récords de tiempo y nivel, legendarios, medallas, título o favoritos. Los
   * jefes y derrotados (que cambian en cada partida) se suben con lo demás
   * cuando toca, no por sí solos. Sin force, como mucho una vez cada 6 h; con
   * force (favoritos, título, apodo), en cuanto el servidor deja (una vez por minuto).
   */
  function publishProfile(force = false) {
    if (!me || !canFriend()) return;
    if (!force && pubAt && Date.now() - pubAt < 6 * 3600 * 1000) return;
    clearTimeout(pubT);
    // (Con un poco de margen: el servidor cuenta desde que le llega la anterior.)
    const wait = Math.max(800, pubAt ? PROFILE_MS + 2000 - (Date.now() - pubAt) : 0);
    pubT = setTimeout(() => {
      if (!me || !canFriend()) return;
      const d = profileData();
      // Para decidir si se sube (se recuerda entre sesiones): sin jefes ni derrotados.
      const key = JSON.stringify(Object.assign({}, d, { best: Object.assign({}, d.best, { kills: 0, bosses: 0 }) }));
      const lsKey = 'ps.pub.' + uid;
      if (!pubLast) { try { pubLast = localStorage.getItem(lsKey) || ''; } catch (e) { /* nada */ } }
      if (key === pubLast) return;
      pubLast = key; pubAt = Date.now();
      try { localStorage.setItem(lsKey, key); } catch (e) { /* nada */ }
      G.Api.put('/api/profile', { profile: d }).catch(e => {
        pubLast = '';
        try { localStorage.removeItem(lsKey); } catch (x) { /* nada */ }
        // Demasiado pronto (p. ej. tras recargar la página): otra vez cuando deje el servidor.
        if (e && e.code === 'rate' && me) {
          pubAt = 0;
          clearTimeout(pubT);
          pubT = setTimeout(() => publishProfile(true), Math.max(1, e.retry || 60) * 1000 + 500);
          return;
        }
        console.warn('[Social] perfil:', errCode(e));
      });
    }, wait);
  }

  /** El perfil de otro jugador, limpio (ver G.U.int / str): sólo lo que el juego sabe pintar. */
  function cleanProfile(d) {
    const U = G.U, b = d.best || {};
    return {
      name: U.str(d.name, 24), title: U.str(d.title, 40),
      favs: U.list(d.favs, 3).filter(f => f && G.DEX_BY[U.int(f.dex)]).map(f => ({ dex: U.int(f.dex), shiny: f.shiny === true })),
      best: { solo: U.int(b.solo, 86400), group: U.int(b.group, 86400), level: U.int(b.level, 999), bosses: U.int(b.bosses, 1e9),
              legends: U.int(b.legends, 999), kills: U.int(b.kills, 1e12), medals: U.int(b.medals, 999) },
      medals: U.list(d.medals, 8).map(x => U.str(x, 40))
    };
  }

  /** El perfil público de otro jugador (null si no tiene). */
  const profCache = new Map();
  async function getProfile(other) {
    if (!started) return null;
    // El tuyo sale de tu partida (sin pedir nada y siempre al día).
    if (other === uid && me) return Object.assign(profileData(), { name: me.name });
    const c = profCache.get(other);
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.v;     // lo leído vale 10 min
    let v = null;
    try {
      const r = await G.Api.get('/api/profile/' + encodeURIComponent(other));
      v = r && r.profile ? cleanProfile(r.profile) : null;
    } catch (e) {
      if (e.code !== 'not-found') return null;                   // (sin red: no se recuerda)
    }
    profCache.set(other, { at: Date.now(), v });
    return v;
  }

  // Al cerrar sesión o borrar la cuenta (lo del servidor se borra con la cuenta).
  G.DB.onLeave(() => stop());

  return {
    start, stop, claimNick, request, accept, remove, publishProfile, getProfile, profileData,
    createRoom, joinRoom, leaveRoom, setOpen, refreshMember, dropMember, setPlaying, ensureFriends,
    invite, acceptInvite, declineInvite, setLocal,
    on(fn) { listeners.add(fn); }, off(fn) { listeners.delete(fn); },
    get me() { return me; },
    get started() { return started; },
    /** ¿Puede tener amigos? (con correo; los invitados no) */
    get canFriend() { return canFriend(); },
    get friends() { return [...friends.values()]; },
    get invites() { return [...invites.values()]; },
    get room() { return room; },
    get uid() { return uid; },
    /** Anfitrión: la partida en grupo del ranking de esta sala (del ack de 'start'), o null. */
    get runId() { return runId; },
    /** La hora real (corrige el reloj del aparato si va desfasado). */
    now,
    VALID, MAX_PLAYERS
  };
})();
