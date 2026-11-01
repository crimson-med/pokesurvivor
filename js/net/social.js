/* ============ social.js: apodo, amigos, invitaciones y salas ============
 * Sólo funciona con cuenta en el servidor del juego (G.DB.online).
 *
 *   Salas: en el servidor (G.Relay, js/net/relay.js; docs/relay-coop/02-protocol.md)
 *     La sala vive en el servidor y es él quien manda en ella: crear, entrar,
 *     salir, empezar y acabar son eventos del socket, y la lista llega en el
 *     evento 'room'. La sala se llama por su código: cuatro números de la
 *     Pokédex en orden (room.id = '25-95-151-133'). Ver «salas» más abajo.
 *     start() abre el socket al entrar en la cuenta y stop() lo cierra al salir.
 *     Si recargas la página estando en una sala (en los 30 s que el servidor te
 *     guarda el hueco), al volver a conectar la sala vuelve sola.
 *
 *   Amigos, apodo, perfil e invitaciones: el código de Firestore de antes
 *     (names/, profiles/, friendships/, inv/). Sin Firebase (G.DB.fb es null
 *     desde el paso 2) no hace nada: el paso 6 lo pasa al servidor
 *     (docs/relay-coop/10-step-6-friends.md). Mientras, el apodo es el nombre de
 *     la cuenta.
 *
 * El resto del juego escucha los cambios con G.Social.on(fn).
 */
G.Social = (() => {
  const VALID = /^[A-Za-z0-9_ñÑáéíóúÁÉÍÓÚ]{3,16}$/;
  const MAX_PLAYERS = 4;
  const INVITE_TTL = 3 * 60 * 1000;
  const REINVITE_MS = 20 * 1000;     // volver a invitar al mismo amigo antes de esto no escribe nada
  /*
   * Hora real: la del servidor de la web (cabecera Date de version.json, gratis).
   * Si el reloj del aparato va adelantado (p. ej. la zona horaria mal puesta),
   * todas las invitaciones parecían caducadas y se borraban sin enseñarse, y
   * los amigos salían siempre desconectados (pasaba en 2026-10).
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
  let fb = null, uid = null;
  let me = null;                    // { uid, name }
  let friends = new Map();          // otherUid -> { uid, name, pid, status: 'ok'|'in'|'out', online, play }
  let unFriends = null;
  let listening = false, unInv = null;  // listening: ya se ha puesto en marcha (online)
  const sentInv = new Map();        // a quién invitaste: uid -> { room, at } (para retirarlo al salir)
  let room = null;                  // { id, host, isHost, code, mode, state, members: [{ uid, name, dex,
                                    // shiny, online, path, sameNet, hideIp }] } (ver fromSnap)
  const invites = new Map();        // fromUid -> { from, name, room, code?, at }
  const listeners = new Set();
  let started = false;

  function emit(what) { listeners.forEach(fn => { try { fn(what); } catch (e) { console.warn(e); } }); }
  const fts = () => firebase.firestore.FieldValue.serverTimestamp();
  const msOf = v => (v && v.toMillis ? v.toMillis() : +v || 0);

  // ---------------- arranque ----------------

  /** Tras iniciar sesión. → 'ok' | 'need-nick' | 'off' (sin cuenta en el servidor) */
  async function start() {
    if (!G.DB.online || !G.DB.me) return 'off';
    if (started) return me ? 'ok' : 'need-nick';
    started = true;
    measureSkew();
    // Las salas, por el servidor: el socket se abre ya (y si la página se recargó
    // estando en una sala, el servidor la manda y se vuelve a ella, ver adopt).
    uid = G.DB.me.uid;
    hookRelay();
    if (G.Relay && G.Relay.enabled) {
      G.Relay.connect().then(() => adopt(G.Relay.room), e => console.warn('[Social] socket:', e.code || e.message));
    }
    // Sin Firebase (paso 6): el apodo es el nombre de la cuenta y no hay amigos todavía.
    fb = G.DB.fb || null;
    if (!fb) {
      me = { uid, name: G.DB.me.name || G.DB.user || '' };
      return 'ok';
    }
    // El apodo no cambia nunca: se recuerda en este navegador y así no se lee
    // el perfil en cada visita (una lectura menos por jugador y sesión).
    const NICK = 'ps.nick.' + uid;
    let cachedNick = null;
    try { cachedNick = localStorage.getItem(NICK); } catch (e) { /* nada */ }
    const prof = cachedNick ? { name: cachedNick }
      : await fb.fs.collection('profiles').doc(uid).get().then(s => s.exists ? s.data() : null).catch(() => null);
    if (prof) {
      me = { uid, name: prof.name };
      if (G.DB.user !== prof.name) G.DB.setName(prof.name);
      try { localStorage.setItem(NICK, prof.name); } catch (e) { /* nada */ }
    }
    else if (G.DB.nameAccount) {
      // Cuentas de nombre y contraseña: su nombre ya es único, se usa de apodo.
      const r = await claimNick(G.DB.save.name);
      if (!r.ok) return 'need-nick';
    } else return 'need-nick';
    online();
    return 'ok';
  }

  /** Reserva un apodo único y crea el perfil público. */
  async function claimNick(name) {
    name = (name || '').trim();
    if (!VALID.test(name)) return { ok: false, error: 'El apodo debe tener 3-16 letras, números o _.' };
    const lower = name.toLowerCase();
    try {
      await fb.fs.runTransaction(async tx => {
        const nref = fb.fs.collection('names').doc(lower);
        const n = await tx.get(nref);
        if (n.exists && n.data().uid !== uid) throw { code: 'taken' };
        if (!n.exists) tx.set(nref, { uid });
        tx.set(fb.fs.collection('profiles').doc(uid),
          { name, lower, at: firebase.firestore.FieldValue.serverTimestamp() });
      });
    } catch (e) {
      if (e && e.code === 'taken') return { ok: false, error: 'Ese apodo ya lo tiene otro jugador.' };
      return { ok: false, error: 'No se pudo guardar el apodo (' + ((e && e.code) || 'error') + ').' };
    }
    me = { uid, name };
    try { localStorage.setItem('ps.nick.' + uid, name); } catch (e) { /* nada */ }
    G.DB.setName(name);
    if (started && !listening) online();
    publishProfile(true);
    return { ok: true };
  }

  /*
   * Amigos e invitaciones. Nada de esto usa la Realtime Database.
   * Desde el 20-10-2026 la lista de amigos NO se carga al entrar (1 lectura por
   * amigo en cada carga de la página, para todos): sólo al abrir Amigos, la sala
   * o el ranking de amigos (ensureFriends). Las invitaciones sí se escuchan desde
   * el principio si este navegador sabe que tienes amigos (hasFrKey); el servidor
   * ya comprueba que sean de un amigo.
   */
  const hasFrKey = () => 'ps.hasfr.' + uid;
  function online() {
    if (listening) return;                    // ya estaba en marcha
    listening = true;
    let known = false;
    try { known = localStorage.getItem(hasFrKey()) === '1'; } catch (e) { /* nada */ }
    if (known) listenInvites();
  }

  /** Carga la lista de amigos (y la sigue escuchando) la primera vez que hace falta. */
  let friendsReady = null;
  function ensureFriends() {
    if (!fb || !me) return Promise.resolve();
    if (!friendsReady) friendsReady = new Promise(res => listenFriends(res));
    return friendsReady;
  }

  /** Invitaciones a salas: sólo te pueden llegar de amigos, así que sin amigos no se escucha (lecturas). */
  function listenInvites() {
    if (unInv || !fb) return;
    unInv = fb.fs.collection('inv').where('to', '==', uid).onSnapshot(snap => {
      snap.docChanges().forEach(ch => {
        const v = ch.doc.data();
        if (ch.type === 'removed') { invites.delete(v.from); emit('invites'); return; }
        onInvite(ch.doc.ref, v);
      });
    }, e => console.warn('[Social] invitaciones:', e.code || e.message));
  }

  let playing = false;
  /** ¿Tienes algún amigo confirmado? (si no, nadie te puede invitar) */
  const hasFriends = () => [...friends.values()].some(f => f.status === 'ok');
  // El "en línea" de los amigos se quitó el 20-10-2026: era 1/4 de todas las
  // escrituras de Firestore (unas 2 millones al día). Ya no se escribe ni se lee
  // pres/{uid}; se puede invitar a cualquier amigo (la invitación caduca sola).
  const presKey = () => 'ps.pres.' + uid;    // (sólo para borrar lo que quedó de entonces)
  function setPlaying(p) {
    playing = !!p;
    if (room) relayRun(playing);
    // Al acabar la partida, la sala se vuelve a comprobar (los que se fueron, fuera).
    if (!playing && room) { if (room.lost) room.tries = 0; emit('room'); }
  }

  async function stop(why) {
    if (!started) return;
    await leaveRoom().catch(() => {});
    if (G.Relay) G.Relay.disconnect();          // (el leave sale antes: el socket va en orden)
    if (unFriends) { unFriends(); unFriends = null; }
    if (unInv) { unInv(); unInv = null; }
    listening = false; friendsReady = null;
    try { localStorage.removeItem(presKey()); } catch (e) { /* nada */ }
    if (why === 'delete') {
      try { localStorage.removeItem('ps.nick.' + uid); } catch (e) { /* nada */ }
      if (fb) await deleteAll().catch(e => console.warn('[Social] borrar:', e));
    }
    friends.clear(); invites.clear(); sentInv.clear();
    me = null; started = false; fb = null; uid = null; playing = false;
    emit('stop');
  }

  /** Al borrar la cuenta: amistades, marcas del ranking, perfil y apodo. */
  async function deleteAll() {
    // Cada paso por separado: si uno falla, los demás se borran igual.
    const step = async (what, fn) => { try { await fn(); } catch (e) { console.warn('[Social] no se pudo borrar ' + what + ':', e.code || e.message); } };
    const del = async q => { const s = await q.get(); await Promise.all(s.docs.map(d => d.ref.delete().catch(() => {}))); };
    await step('amistades', () => del(fb.fs.collection('friendships').where('users', 'array-contains', uid)));
    await step('filas del ranking', () => G.Ranking.removeMine());
    await step('invitaciones', () => del(fb.fs.collection('inv').where('to', '==', uid)));
    await step('marcas', () => del(fb.fs.collectionGroup('e').where('uids', 'array-contains', uid)));
    await step('partida en curso', () => fb.fs.collection('runs').doc(uid).delete());
    await step('en línea', () => fb.fs.collection('pres').doc(uid).delete());
    await step('apodo', async () => {
      const prof = await fb.fs.collection('profiles').doc(uid).get();
      const lower = prof.exists ? prof.data().lower : me && me.name.toLowerCase();
      if (lower) await fb.fs.collection('names').doc(lower).delete().catch(() => {});
      if (prof.exists) await fb.fs.collection('profiles').doc(uid).delete();
    });
  }

  // ---------------- amigos ----------------

  function listenFriends(ready) {
    unFriends = fb.fs.collection('friendships').where('users', 'array-contains', uid).onSnapshot(snap => {
      const next = new Map();
      snap.forEach(d => {
        const f = d.data();
        const other = f.users[0] === uid ? f.users[1] : f.users[0];
        next.set(other, {
          uid: other, pid: d.id, name: (f.names && f.names[other]) || '???',
          status: f.status === 'ok' ? 'ok' : f.to === uid ? 'in' : 'out',
          online: false, play: false, room: '', seen: 0
        });
      });
      friends = next;
      emit('friends');
      // Con amigos ya te pueden invitar (y este navegador lo recuerda para la próxima vez).
      try { if (hasFriends()) localStorage.setItem(hasFrKey(), '1'); else localStorage.removeItem(hasFrKey()); } catch (e) { /* nada */ }
      if (hasFriends()) listenInvites();
      if (ready) { ready(); ready = null; }
    }, e => { console.warn('[Social] amigos:', e.code || e.message); if (ready) { ready(); ready = null; } });
  }

  /** (Quitado el 20-10-2026 con el "en línea": ya no lee nada.) */

  /** Envía una solicitud de amistad (o acepta la que ya te había mandado). */
  async function request(name) {
    name = (name || '').trim();
    if (!me) return { ok: false, error: 'Primero elige tu apodo.' };
    if (!VALID.test(name)) return { ok: false, error: 'Escribe el apodo exacto de tu amigo.' };
    const n = await fb.fs.collection('names').doc(name.toLowerCase()).get().catch(() => null);
    if (!n || !n.exists) return { ok: false, error: 'No hay ningún jugador con ese apodo.' };
    const other = n.data().uid;
    if (other === uid) return { ok: false, error: 'Ese eres tú.' };
    const f = friends.get(other);
    if (f && f.status === 'ok') return { ok: false, error: 'Ya sois amigos.' };
    if (f && f.status === 'out') return { ok: false, error: 'Ya le enviaste una solicitud.' };
    if (f && f.status === 'in') return accept(other);
    const prof = await fb.fs.collection('profiles').doc(other).get().catch(() => null);
    const otherName = prof && prof.exists ? prof.data().name : name;
    const users = [uid, other].sort();
    try {
      await fb.fs.collection('friendships').doc(users[0] + '_' + users[1]).set({
        users, from: uid, to: other, status: 'pending',
        names: { [uid]: me.name, [other]: otherName },
        at: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { ok: true, msg: 'Solicitud enviada a ' + otherName };
    } catch (e) { return { ok: false, error: 'No se pudo enviar (' + (e.code || 'error') + ').' }; }
  }

  async function accept(other) {
    const f = friends.get(other);
    if (!f || f.status !== 'in') return { ok: false, error: 'No hay solicitud.' };
    try {
      await fb.fs.collection('friendships').doc(f.pid).update({
        status: 'ok', at: firebase.firestore.FieldValue.serverTimestamp(), ['names.' + uid]: me.name
      });
      return { ok: true, msg: 'Ahora eres amigo de ' + f.name };
    } catch (e) { return { ok: false, error: 'No se pudo aceptar (' + (e.code || 'error') + ').' }; }
  }

  async function remove(other) {
    const f = friends.get(other);
    if (!f) return { ok: false };
    try { await fb.fs.collection('friendships').doc(f.pid).delete(); return { ok: true }; }
    catch (e) { return { ok: false, error: 'No se pudo borrar (' + (e.code || 'error') + ').' }; }
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
    return Object.assign(r || { lost: false, run: s.state === 'playing' }, {
      id: codeKey(s.code) || (r && r.id) || host, code: Array.isArray(s.code) ? s.code.slice() : r ? r.code : null,
      mode: s.mode === 'server' ? 'server' : 'direct', state: s.state,
      directWaitMs: s.directWaitMs, host, isHost: host === uid, members, open: s.state !== 'playing'
    });
  }

  let hooked = false, creating = null;
  let relayGen = 0;                 // sube al salir: una respuesta de create / join de antes ya no vale
  let leftId = '';                  // la última sala de la que saliste (no se vuelve a ella sola)
  function hookRelay() {
    if (hooked || !G.Relay) return;
    hooked = true;
    G.Relay.on('room', onRelayRoom);
    G.Relay.on('peer', onRelayPeer);
    G.Relay.on('closed', onRelayClosed);
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
    if (room || creating || !started || !s || !uid) return;
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
    try {
      await G.Relay.connect();
      leftId = '';
      a = await G.Relay.request('join', { code, hideIp: hideIp() });
    } catch (e) { return failed(e); }
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

  async function invite(other) {
    const f = friends.get(other);
    if (!f || f.status !== 'ok') return { ok: false, error: 'Sólo puedes invitar a tus amigos.' };
    if (room && room.members.length >= MAX_PLAYERS) return { ok: false, error: 'La sala está llena.' };
    if (room && !room.isHost) return { ok: false, error: 'Sólo el anfitrión de la sala puede invitar.' };
    if (!room) { try { await createRoom(); } catch (e) { return failed(e); } }
    // Acabas de invitarle a esta sala: ya la tiene (pulsar otra vez no escribe nada; 25-10-2026).
    const s = sentInv.get(other);
    if (s && s.room === room.id && now() - s.at < REINVITE_MS) return { ok: true, msg: 'Invitación enviada a ' + f.name };
    try {
      // Va también el código (room sigue ahí para los que aún no lo usan).
      await fb.fs.collection('inv').doc(other + '_' + uid).set(Object.assign(
        { to: other, from: uid, room: room.id, name: me.name, at: fts() }, room.code ? { code: room.code } : {}));
    } catch (e) { return { ok: false, error: 'No se pudo invitar (' + (e.code || 'error') + ').' }; }
    sentInv.set(other, { room: room.id, at: now() });
    return { ok: true, msg: 'Invitación enviada a ' + f.name };
  }

  /** Retira las invitaciones que mandaste (al salir de la sala). */
  function retractInvites() {
    if (!fb) return;
    // Sólo las que pueden seguir ahí: las caducadas ya no cuentan, y borrar las que
    // ya no están (aceptadas o rechazadas) lo rechazaban las reglas (~200 por hora).
    for (const [o, s] of sentInv) if (now() - s.at < INVITE_TTL) fb.fs.collection('inv').doc(o + '_' + uid).delete().catch(() => {});
    sentInv.clear();
  }

  function onInvite(ref, v) {
    // Las caducadas se borran; sólo se aceptan de amigos confirmados.
    if (!v || (v.at && now() - msOf(v.at) > INVITE_TTL)) { ref.delete().catch(() => {}); return; }
    const f = friends.get(v.from);
    if (f && f.status !== 'ok') return;
    const code = Array.isArray(v.code) ? toCode(v.code) : null;
    invites.set(v.from, Object.assign({ from: v.from, name: v.name, room: v.room, at: msOf(v.at) || now() }, code ? { code } : {}));
    emit('invites');
  }

  const invDoc = from => fb.fs.collection('inv').doc(uid + '_' + from);

  async function acceptInvite(from) {
    const inv = invites.get(from);
    if (!inv || now() - inv.at > INVITE_TTL) { invites.delete(from); emit('invites'); return { ok: false, error: 'La invitación ha caducado.' }; }
    invites.delete(from);
    invDoc(from).delete().catch(() => {});
    emit('invites');
    return joinRoom(inv.code || inv.room);
  }

  function declineInvite(from) {
    invites.delete(from);
    invDoc(from).delete().catch(() => {});
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
   * récords de tiempo y nivel, legendarios, medallas, título o favoritos.
   * Los jefes y derrotados (que cambian en cada partida) se suben con lo demás
   * cuando toca, no por sí solos: el perfil se escribía 200.000 veces al día
   * (13-10-2026). Si cambias favoritos o título (force), al momento.
   */
  function publishProfile(force = false) {
    if (!me || !fb) return;
    if (!force && Date.now() - pubAt < 6 * 3600 * 1000) return;    // como mucho cada 6 h (2 h hasta el 25-10-2026; antes 30 min)
    clearTimeout(pubT);
    pubT = setTimeout(() => {
      if (!me || !fb) return;
      const d = profileData();
      // Para decidir si se sube (se recuerda entre sesiones): sin jefes ni derrotados.
      const key = JSON.stringify(Object.assign({}, d, { best: Object.assign({}, d.best, { kills: 0, bosses: 0 }) }));
      const lsKey = 'ps.pub.' + uid;
      if (!pubLast) { try { pubLast = localStorage.getItem(lsKey) || ''; } catch (e) { /* nada */ } }
      if (key === pubLast) return;
      pubLast = key; pubAt = Date.now();
      try { localStorage.setItem(lsKey, key); } catch (e) { /* nada */ }
      fb.fs.collection('profiles').doc(uid).set(Object.assign(d, {
        name: me.name, lower: me.name.toLowerCase(), at: firebase.firestore.FieldValue.serverTimestamp()
      })).catch(e => { pubLast = ''; console.warn('[Social] perfil:', e.code || e.message); });
    }, 800);
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

  /** El perfil público de otro jugador. */
  const profCache = new Map();
  async function getProfile(other) {
    if (!fb) return null;
    // El tuyo sale de tu partida (sin leer nada y siempre al día).
    if (other === uid && me) return Object.assign(profileData(), { name: me.name });
    const c = profCache.get(other);
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.v;     // lo leído vale 10 min
    const d = await fb.fs.collection('profiles').doc(other).get().catch(() => null);
    const v = d && d.exists ? cleanProfile(d.data()) : null;
    profCache.set(other, { at: Date.now(), v });
    return v;
  }

  // Al cerrar sesión o borrar la cuenta.
  G.DB.onLeave(why => stop(why));

  return {
    start, stop, claimNick, request, accept, remove, publishProfile, getProfile, profileData,
    createRoom, joinRoom, leaveRoom, setOpen, refreshMember, dropMember, setPlaying, ensureFriends,
    invite, acceptInvite, declineInvite, setLocal,
    on(fn) { listeners.add(fn); }, off(fn) { listeners.delete(fn); },
    get me() { return me; },
    get started() { return started; },
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
