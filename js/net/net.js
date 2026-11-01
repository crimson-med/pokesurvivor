/* ============ net.js: conexión entre los jugadores de una sala ============
 * Topología en estrella: el ANFITRIÓN habla con cada invitado; los invitados
 * sólo hablan con el anfitrión (él reenvía lo que haga falta).
 *
 * Un servidor (el del juego, server/) y dos caminos por pareja:
 *   directo   WebRTC (canal de datos entre navegadores). La negociación va por
 *             el socket del servidor (G.Relay 'sig', js/net/relay.js). STUN: los
 *             de /api/config (stunUrls; vacío = sin STUN); nada más.
 *   servidor  si el canal directo no abre en room.directWaitMs (x 10/6 en la
 *             misma red), esa pareja va por el servidor: G.Relay 'm' (to, seq,
 *             bytes), binario de G.NetCodec para los 'f' y JSON para lo demás.
 *             Ya no vuelve a directo por sí sola (sólo si el anfitrión rehace
 *             la pareja con «Conectar en local», ver setLanIp). Con «Siempre por
 *             el servidor» o un invitado que esconde su IP, ni se intenta WebRTC.
 *
 *   orden     cada mensaje de una pareja lleva un número (seq), por los dos
 *             caminos (por el directo va dentro: { k: 'sq', n, d }). Quien recibe
 *             tira lo que ya ha visto; quien manda guarda lo último (64 KB) y lo
 *             repite por el servidor si el canal directo se cierra a media
 *             partida o el otro vuelve. Un 'f' (el estado de la partida) más
 *             viejo que el último entregado llega marcado como viejo: coop.js
 *             sólo aplica sus eventos (una vez), no el estado.
 *   acks      el invitado confirma por el servidor el último número sin huecos
 *             (cada 5 mensajes, al menos una vez por segundo y al momento si le
 *             llega un repetido o se cierra un hueco). Al anfitrión le llegan
 *             como 'ack' (from, seq); hasta que llegue alguno, busy no cuenta lo
 *             pendiente por el servidor. Si las confirmaciones no avanzan, el
 *             anfitrión repite lo primero que falta; un hueco que no se llena en
 *             3 s se salta.
 *   recarga   cada carga de la página tiene su ep (relay.js), que sale en la
 *             foto de la sala. Si el de un jugador cambia (ha recargado), la
 *             pareja empieza de cero la numeración por los dos lados y se rehace
 *             la conexión.
 *   el anfitrión avisa al servidor del camino de cada invitado ('path'); el
 *             invitado lo ve en la foto de la sala y deja de esperar al directo.
 *
 * Se envía por el canal directo si está abierto; si no, por el servidor. El que
 * recibe escucha los dos, así que no hace falta ponerse de acuerdo.
 *
 * API:  open(roomId, isHost, hostUid) · close() · send(to, msg) · toHost(msg)
 *       broadcast(msg) · on(fn(from, msg, viejo)) · onPeer(fn(uid, state))
 *       peers() · mode(uid) -> 'connecting' | 'direct' | 'relay' | 'away' | 'closed'
 */
G.Net = (() => {
  const ICE_BATCH = 250, ICE_MAX = 40;    // candidatos: se juntan 250 ms (o 40) en un mensaje (ver newPeer)
  const CONFIG_MS = 4000;                 // espera máxima de /api/config (los STUN)
  // Lo que puede quedar por salir en el canal. El canal no pierde nada y va en orden:
  // si la conexión da menos de lo que se manda, lo de más se queda en cola y el otro lo
  // ve cada vez más tarde (27-10-2026: una invitada iba 4 min y 40 s por detrás). Con
  // más que esto en cola, coop.js espera en vez de mandar (ver busy).
  const BUSY_BYTES = 64 * 1024;
  // Espera del canal directo si el servidor no dice otra cosa (room.directWaitMs), y
  // cada cuánto confirma el invitado lo que le llega por el servidor.
  const DIRECT_WAIT = 6000, SAME_NET_WAIT = 10 / 6, ACK_EVERY = 5, ACK_MS = 1000;
  // Confirmaciones al momento (repetidos, huecos cerrados): como mucho una cada ACK_NOW_MS.
  const ACK_NOW_MS = 200;
  // Anfitrión: sin avanzar las confirmaciones en GAP_MS, repite lo primero sin confirmar.
  // Invitado: un hueco que sigue abierto tras SKIP_MS se da por perdido.
  const GAP_MS = 1500, SKIP_MS = 3000;
  // load() por el servidor: los últimos mandados que aún no se esperan confirmados.
  const LOAD_SKIP = 2 * ACK_EVERY;
  // Lo que se guarda para repetir por el servidor: los últimos BUSY_BYTES; el
  // anfitrión, por el servidor, hasta que el invitado lo confirme (con tope).
  const KEEP_MAX = 4 * BUSY_BYTES;
  // Números que llegan antes que alguno anterior (al pasar de un camino a otro): se
  // apuntan hasta AHEAD_MAX; un número disparatado (más de SEQ_JUMP por delante) se tira.
  // Una pareja que aún no ha recibido nada sólo acepta los AHEAD_MAX primeros: lo que
  // llegue con números altos es de antes de que el otro recargara.
  const AHEAD_MAX = 256, SEQ_JUMP = 100000;

  let uid = null, roomId = null, isHost = false, hostUid = null;
  // Por pareja (dura toda la sala, aunque la conexión se rehaga; empieza de cero si el
  // otro recarga): uid -> { out, inSeen, ahead, top, lastF, got, acked, ackSeen,
  // unacked: [[seq, bytes, msg]], bytes, ackN, ackT, quiet, gapT, watchT, mark, away }
  const pairs = new Map();
  // El ep (carga de la página, ver relay.js) de cada jugador según la última foto.
  const eps = new Map();
  // Invitado: el último camino que el servidor dice que tenemos (ver onRelayRoom).
  // relayDown: nuestro socket se ha caído (lo mandado entretanto no ha salido).
  let myPath = null, relayDown = false;
  // Misma wifi (28-10-2026): IP local que ha escrito el anfitrión (ver lanCandidate).
  let lanIp = null;
  const peers = new Map();         // uid -> { pc, dc, mode, timer, away }
  const handlers = new Set(), peerHandlers = new Set();
  const stats = { sent: 0, recv: 0, relaySent: 0,
    // Sólo los datos de la partida que se han mandado bien (sin ICE/SCTP/DTLS).
    sentBytes: 0, jsonBytes: 0, recvBytes: 0, binarySent: 0, binaryRecv: 0, invalidBinary: 0 };

  // ---------------- STUN (de /api/config) ----------------
  // Se pide una vez por página. Sin respuesta, esa vez sin STUN (y se vuelve a pedir).
  let ice = null, iceAsk = null;
  function iceServers() {
    if (ice) return Promise.resolve(ice);
    if (!iceAsk) {
      iceAsk = new Promise(resolve => {
        const t = setTimeout(() => resolve(null), CONFIG_MS);
        const done = c => { clearTimeout(t); resolve(c); };
        Promise.resolve().then(() => G.Api.get('/api/config')).then(done, () => done(null));
      }).then(c => {
        iceAsk = null;
        const urls = c && Array.isArray(c.stunUrls)
          ? c.stunUrls.filter(u => typeof u === 'string' && /^stuns?:[^\s]{1,200}$/.test(u)).slice(0, 8) : null;
        if (!urls) return [];
        ice = urls.length ? [{ urls }] : [];
        return ice;
      });
    }
    return iceAsk;
  }

  function emitPeer(u) {
    const p = peers.get(u);
    peerHandlers.forEach(fn => { try { fn(u, modeOf(p)); } catch (e) { console.warn(e); } });
  }

  /** 'away' (el servidor dice que se ha caído un momento) tapa el camino. */
  const modeOf = p => (p ? (p.away ? 'away' : p.mode) : 'closed');

  // ---------------- misma wifi ----------------
  /*
   * Dos aparatos detrás del mismo router no suelen conectar sólo con STUN: los dos
   * salen con la misma IP pública (y muchos routers no devuelven el tráfico hacia
   * dentro) y el navegador esconde la IP local con un nombre «xxxx.local» que el
   * otro tiene que resolver por mDNS (falla entre Windows y Mac, en wifis en malla
   * o si el router corta la multidifusión). El nombre se esconde, pero el puerto
   * no: si el anfitrión escribe su IP local («Conectar en local» en la sala, que
   * sale cuando el servidor dice que estáis en la misma red: sameNet), cada
   * candidato «xxxx.local PUERTO typ host» sale además con esa IP, y el invitado
   * llega directo. El anfitrión aprende la vía de vuelta con el primer paquete
   * (candidato prflx). Una IP equivocada no rompe nada: esa pareja sigue por el
   * servidor como cualquier otra.
   */

  /** ¿IPv4 privada (10/8, 172.16/12, 192.168/16)? Sólo esas: nunca una pública. */
  function isLocalIp(ip) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
    if (!m || m.slice(1).some(n => +n > 255 || (n.length > 1 && n[0] === '0'))) return false;
    const a = +m[1], b = +m[2];
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }

  /** "candidate:… 1 udp 2122… dirección puerto typ tipo …" -> { proto, addr, type } */
  function candParts(c) {
    const t = String(c && c.candidate || '').replace(/^a=/, '').split(' ');
    return t.length >= 8 && t[6] === 'typ' ? { t, proto: t[2].toLowerCase(), addr: t[4], type: t[7] } : null;
  }

  /** El mismo candidato con la IP local en vez del nombre .local, o null si no toca. */
  function lanCandidate(c, ip) {
    const p = candParts(c);
    if (!p || !isLocalIp(ip) || p.proto !== 'udp' || p.type !== 'host' || !/\.local$/i.test(p.addr)) return null;
    p.t[4] = ip.trim();
    return Object.assign({}, c, { candidate: p.t.join(' ') });
  }

  /** ¿u y nosotros salimos a internet por la misma IP pública? Lo sabe el servidor (sin decir la IP). */
  function sameNetwork(u) {
    const m = member(isHost ? u : uid);
    return !!(m && m.sameNet);
  }

  /**
   * Anfitrión: activa (ip) o quita (null) la IP local. Las parejas que aún no han
   * conectado directas se rehacen al momento, ya con ella.
   */
  function setLanIp(ip) {
    const v = isLocalIp(ip) ? String(ip).trim() : null;
    if (v === lanIp) return;
    lanIp = v;
    if (!isHost || !roomId || !lanIp) return;
    for (const [u, p] of [...peers]) if (p.mode !== 'direct') { drop(u, true); connect(u); }
  }

  // ---------------- la sala en el servidor ----------------
  /*
   * G.Relay (js/net/relay.js) es el socket. G.Relay.room es la última foto de la sala
   * que ha mandado el servidor: { mode, directWaitMs, members: [{ uid, sameNet,
   * hideIp, path, ep, ... }] } o null si aún no ha llegado.
   */
  function member(u) {
    const r = G.Relay && G.Relay.room;
    return r && Array.isArray(r.members) ? r.members.find(m => m && m.uid === u) || null : null;
  }

  /** Espera del canal directo con u (x 10/6 si el servidor dice que estáis en la misma red). */
  function directWait(u) {
    const r = G.Relay && G.Relay.room, ms = r && r.directWaitMs > 0 ? r.directWaitMs : DIRECT_WAIT;
    const m = member(isHost ? u : uid);
    return m && m.sameNet ? Math.round(ms * SAME_NET_WAIT) : ms;
  }

  /**
   * ¿La pareja con u va sólo por el servidor? Sala «Siempre por el servidor» o un
   * invitado que esconde su IP: no se intenta WebRTC (así nadie ve la IP de nadie).
   */
  function serverOnly(u) {
    const r = G.Relay && G.Relay.room, m = member(isHost ? u : uid);
    return !!(r && (r.mode === 'server' || (m && m.hideIp)));
  }

  function newPair(u, away) {
    return { out: 0, inSeen: 0, ahead: new Set(), top: 0, lastF: 0, got: false, acked: 0, ackSeen: false,
      unacked: [], bytes: 0, ackN: 0, ackT: 0, quiet: false, gapT: 0, watchT: 0, mark: 0, away: !!away };
  }
  function pairOf(u) {
    let s = pairs.get(u);
    if (!s) pairs.set(u, s = newPair(u));
    return s;
  }

  /*
   * ¿Está caído para el servidor ('away')? Se apunta en la pareja, que dura aunque se
   * rehaga la conexión (setLanIp, una oferta nueva): un peer nuevo nace con lo que había.
   */
  const awayOf = u => { const s = pairs.get(u); return !!(s && s.away); };

  function stopPair(s) {
    clearTimeout(s.ackT); clearTimeout(s.gapT); clearTimeout(s.watchT);
    s.ackT = s.gapT = s.watchT = 0;
  }

  function forgetPair(u) {
    const s = pairs.get(u);
    if (s) stopPair(s);
    pairs.delete(u);
  }

  /**
   * u ha recargado la página (su ep es otro): numeración nueva por los dos lados (la
   * suya ya empieza de cero) y conexión nueva. Lo guardado para repetir era para la
   * página de antes: se tira.
   */
  function renew(u) {
    const old = pairs.get(u);
    if (old) stopPair(old);
    pairs.set(u, newPair(u, old && old.away));
    if (!peers.has(u)) return;
    if (isHost) { drop(u, true); connect(u); }
    else if (u === hostUid) { drop(u, true); waitHost(); emitPeer(u); }
  }

  /**
   * Guarda un mensaje mandado por si hay que repetirlo. Sólo el anfitrión recibe
   * confirmaciones, y sólo por el servidor: ahí se guarda hasta que llegan (busy
   * para de mandar a los BUSY_BYTES); si no, basta con lo último. Si el servidor no
   * reenvía las confirmaciones (no ha llegado ninguna), también basta con lo último.
   */
  function keep(u, n, size, msg) {
    const s = pairOf(u), p = peers.get(u);
    s.unacked.push([n, size, msg]); s.bytes += size;
    const viaDc = !!(p && p.dc && p.dc.readyState === 'open');
    const max = isHost && s.ackSeen && !viaDc ? KEEP_MAX : BUSY_BYTES;
    while (s.bytes > max && s.unacked.length > 1) s.bytes -= s.unacked.shift()[1];
    if (isHost && s.ackSeen && !viaDc) watchAcks(u, s);
  }

  /**
   * Anfitrión, por el servidor: si en GAP_MS no avanza ninguna confirmación y queda
   * algo sin confirmar, el invitado está esperando un hueco (un mensaje que se perdió
   * al cambiar de camino): se le repite lo primero que falta. Sin esto, con la cola
   * llena (busy) no se manda nada, no llega nada que confirmar y se queda parado.
   */
  function watchAcks(u, s) {
    if (s.watchT) return;
    s.mark = s.acked;
    s.watchT = setTimeout(() => {
      s.watchT = 0;
      const p = peers.get(u);
      if (pairs.get(u) !== s || !s.unacked.length || !p || !viaServer(p)) return;
      if (s.acked === s.mark && !p.away && G.Relay.state === 'online') {
        const [n, , msg] = s.unacked[0];
        relayM(u, n, msg);
      }
      watchAcks(u, s);
    }, GAP_MS);
  }

  /** Lo que va por el servidor: binario para los 'f' (si ocupa menos), si no JSON. */
  function relayBytes(msg) {
    const json = JSON.stringify(msg), jsonBytes = G.NetCodec.size(json);
    const packed = msg && msg.k === 'f' ? G.NetCodec.encode(msg) : null;
    return packed && packed.byteLength < jsonBytes ? packed : json;
  }

  /** Por el servidor, con su número. Devuelve lo que ocupa. */
  function relayM(to, n, msg) {
    const bytes = relayBytes(msg), size = typeof bytes === 'string' ? G.NetCodec.size(bytes) : bytes.byteLength;
    G.Relay.emit('m', to, n, bytes);
    stats.relaySent++;
    return size;
  }

  /**
   * ¿Lo de esta pareja sale por el servidor? (por el servidor, o aún conectando). El
   * servidor tira lo que va a alguien desconectado: eso hay que repetirlo al volver.
   */
  const viaServer = p => p.mode !== 'closed' && !(p.dc && p.dc.readyState === 'open');

  /** Repite por el servidor lo que el otro quizá no recibió (él tira lo repetido). */
  function resend(u) {
    const s = pairs.get(u);
    if (!s) return;
    for (const [n, , msg] of s.unacked) relayM(u, n, msg);
  }

  /** Da por perdidos los huecos de abajo: entregado hasta el primero que llegó por encima. */
  function skipGap(s) {
    if (!s.ahead.size) return;
    s.inSeen = Math.min(...s.ahead); s.ahead.delete(s.inSeen);
    while (s.ahead.delete(s.inSeen + 1)) s.inSeen++;
  }

  /** Un hueco abierto (algo llegó por encima): si en SKIP_MS no se llena, se salta. */
  function watchGap(from, s) {
    if (!s.ahead.size) { clearTimeout(s.gapT); s.gapT = 0; return; }
    if (s.gapT) return;
    s.gapT = setTimeout(() => {
      s.gapT = 0;
      if (pairs.get(from) !== s || !s.ahead.size) return;
      skipGap(s);
      if (!isHost) sendAck(s);
      watchGap(from, s);
    }, SKIP_MS);
  }

  /**
   * ¿Es nuevo? Lo apunta. inSeen: entregados todos hasta ahí (sin huecos); ahead: los
   * entregados por encima (al pasar de conectando a directo, lo que salió por el
   * servidor puede llegar después que lo siguiente por el canal: se entrega igual, sin
   * repetir).
   */
  function fresh(from, n) {
    if (!Number.isInteger(n) || n < 1) return false;
    const s = pairOf(from);
    const lim = s.got ? SEQ_JUMP : AHEAD_MAX;
    if (n <= s.inSeen || s.ahead.has(n) || n > s.inSeen + lim) return false;
    s.got = true;
    s.ahead.add(n);
    if (n > s.top) s.top = n;
    while (s.ahead.delete(s.inSeen + 1)) s.inSeen++;
    // Huecos que ya no van a llegar (se perdieron más de los que se guardan): se saltan.
    if (s.ahead.size > AHEAD_MAX) skipGap(s);
    watchGap(from, s);
    return true;
  }

  /**
   * Entrega un mensaje con número. Un 'f' (estado de la partida) más viejo que el último
   * 'f' entregado de esta pareja llega marcado (viejo = true): sus eventos valen, su
   * estado no (si no, las posiciones y la vida volverían atrás).
   */
  function deliverNumbered(from, n, msg) {
    const s = pairOf(from);
    let old = false;
    if (msg && msg.k === 'f') { if (n < s.lastF) old = true; else s.lastF = n; }
    deliver(from, msg, old);
  }

  /**
   * Invitado: confirma cada ACK_EVERY mensajes llegados por el servidor, y al segundo
   * como mucho. now: al momento (un repetido o un hueco que se cierra: el anfitrión
   * está repitiendo y tiene que saber dónde estamos), como mucho cada ACK_NOW_MS.
   */
  function noteAck(from, now) {
    if (isHost) return;
    const s = pairOf(from);
    s.ackN++;
    const urgent = now && !s.quiet;
    if (urgent || s.ackN >= ACK_EVERY) {
      sendAck(s);
      if (urgent) { s.quiet = true; setTimeout(() => { s.quiet = false; }, ACK_NOW_MS); }
    } else if (!s.ackT) s.ackT = setTimeout(() => { s.ackT = 0; if (s.ackN && pairs.get(from) === s) sendAck(s); }, now ? ACK_NOW_MS : ACK_MS);
  }

  /** Confirma el último número sin huecos (no el más alto visto: lo de en medio puede faltar). */
  function sendAck(s) {
    clearTimeout(s.ackT); s.ackT = 0; s.ackN = 0;
    G.Relay.emit('ack', s.inSeen);
  }

  /** Anfitrión: el invitado confirma hasta seq; eso ya no hace falta guardarlo. */
  function onRelayAck(from, seq) {
    const s = pairs.get(from);
    if (!isHost || !s || typeof seq !== 'number' || !(seq > s.acked) || seq > s.out) return;
    s.acked = seq; s.ackSeen = true;
    while (s.unacked.length && s.unacked[0][0] <= seq) s.bytes -= s.unacked.shift()[1];
  }

  function onRelaySig(from, sig) {
    if (typeof from === 'string' && sig && typeof sig === 'object') onSignal(from, sig);
  }

  /** Mensaje de la partida por el servidor: (de quién, número, binario o JSON). */
  function onRelayMsg(from, seq, bytes) {
    if (typeof from !== 'string' || (isHost ? !peers.has(from) : from !== hostUid)) return;
    let m;
    if (typeof bytes === 'string') {
      try { m = JSON.parse(bytes); } catch (e) { return; }
      stats.recvBytes += G.NetCodec.size(bytes);
    } else {
      try {
        const buf = ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
        m = G.NetCodec.decode(buf);
        if (!m || m.k !== 'f') throw Error('not a frame');
        stats.recvBytes += buf.byteLength; stats.binaryRecv++;
      } catch (e) { stats.invalidBinary++; return; }
    }
    // (Mientras conecta, el anfitrión también manda por aquí: eso no dice que haya
    // renunciado al directo. Lo dice su 'path', ver onRelayRoom.)
    const s = pairOf(from), before = s.inSeen;
    const ok = fresh(from, seq);
    noteAck(from, !ok || s.inSeen > before + 1);
    if (ok) deliverNumbered(from, seq, m);
  }

  /** El servidor: un jugador se ha caído un momento ('away'), ha vuelto o ya no está. */
  function onRelayPeer(u, state) {
    const p = peers.get(u);
    if (!p) return;
    if (state === 'gone') { drop(u); return; }
    const away = state === 'away', s = pairOf(u);
    if (away === s.away) return;
    s.away = p.away = away;
    emitPeer(u);
    // De vuelta por el servidor: lo que se mandó mientras no estaba, otra vez.
    if (!away && viaServer(p)) resend(u);
  }

  /**
   * Nueva foto de la sala: alguien ha recargado (otro ep); alguien puede haber pedido
   * esconder su IP; el anfitrión ya sabe de un invitado al que esperaba (ver connect);
   * o, al invitado, el anfitrión le ha puesto por el servidor.
   */
  function onRelayRoom() {
    if (!roomId) return;
    noteEps(true);
    for (const [u, p] of [...peers]) {
      if (p.mode !== 'connecting') continue;
      if (serverOnly(u)) useRelay(u);
      else if (p.waiting && isHost && member(u)) { clearTimeout(p.timer); peers.delete(u); connect(u); }
    }
    if (isHost) return;
    const m = member(uid), path = (m && m.path) || null;
    if (path === myPath) return;
    myPath = path;
    const p = peers.get(hostUid);
    if (path === 'server' && p && p.mode === 'connecting') useRelay(hostUid);
  }

  /** Apunta el ep de cada uno (el anfitrión: todos; el invitado: el del anfitrión). check: rehace si cambió. */
  function noteEps(check) {
    const r = G.Relay && G.Relay.room;
    if (!r || !Array.isArray(r.members)) return;
    for (const m of r.members) {
      if (!m || !m.ep || m.uid === uid || (!isHost && m.uid !== hostUid)) continue;
      const was = eps.get(m.uid);
      eps.set(m.uid, m.ep);
      if (check && was && was !== m.ep) renew(m.uid);
    }
  }

  /** Nuestro socket vuelve: lo que se mandó por el servidor mientras estaba caído, otra vez. */
  function onRelayState(state) {
    if (state !== 'online') { relayDown = true; return; }
    if (!relayDown) return;
    relayDown = false;
    for (const [u, p] of [...peers]) if (viaServer(p)) resend(u);
  }

  const RELAY_EVENTS = { sig: onRelaySig, m: onRelayMsg, ack: onRelayAck, peer: onRelayPeer, room: onRelayRoom, state: onRelayState };

  // ---------------- apertura ----------------

  function open(id, host, hostId) {
    if (roomId === id) return;
    close();
    if (!G.Relay) return;
    uid = (G.DB && G.DB.me && G.DB.me.uid) || G.Relay.uid || null;
    if (!uid) return;
    roomId = id; isHost = host; hostUid = hostId;
    const me = member(uid);
    myPath = (me && me.path) || null; relayDown = G.Relay.state !== 'online';
    for (const ev in RELAY_EVENTS) G.Relay.on(ev, RELAY_EVENTS[ev]);
    if (G.Relay.state === 'off' && typeof G.Relay.connect === 'function') Promise.resolve(G.Relay.connect()).catch(() => {});
    noteEps(false);
    iceServers();     // ya, para no esperarlos al conectar
    if (!isHost) waitHost();
  }

  /**
   * Invitado: hueco para el anfitrión desde ya (se sustituye al llegar su oferta). Si
   * no llega en directWaitMs + 3 s, por el servidor (y al momento si esta pareja va
   * sólo por él: el anfitrión no mandará oferta).
   */
  function waitHost() {
    const p = { pc: null, dc: null, mode: 'connecting', timer: 0, away: awayOf(hostUid) };
    peers.set(hostUid, p);
    if (serverOnly(hostUid)) useRelay(hostUid);
    else p.timer = setTimeout(() => { if (peers.get(hostUid) === p && p.mode === 'connecting') useRelay(hostUid); }, directWait(hostUid) + 3000);
  }

  function close() {
    for (const u of [...peers.keys()]) drop(u);
    if (G.Relay) for (const ev in RELAY_EVENTS) G.Relay.off(ev, RELAY_EVENTS[ev]);
    for (const u of [...pairs.keys()]) forgetPair(u);
    eps.clear(); iceWait.clear(); pendingIce.clear();
    myPath = null; relayDown = false;
    roomId = null; isHost = false; hostUid = null;
    lanIp = null;
  }

  /** El anfitrión llama a esto cuando cambian los miembros de la sala. */
  function syncMembers(uids) {
    if (!roomId) return;
    if (isHost) {
      for (const u of uids) if (u !== uid && !peers.has(u)) connect(u);
      for (const u of [...peers.keys()]) if (!uids.includes(u)) drop(u);
    } else if (!uids.includes(hostUid)) {
      drop(hostUid);
    }
  }

  // ---------------- WebRTC ----------------

  function newPeer(u, iceList) {
    const p = { pc: null, dc: null, mode: 'connecting', timer: 0, away: awayOf(u) };
    peers.set(u, p);
    // Sin WebRTC (navegador antiguo o bloqueado): directamente por el servidor.
    let pc;
    try { pc = p.pc = new RTCPeerConnection({ iceServers: iceList }); }
    catch (e) { useRelay(u); return p; }
    /*
     * Los candidatos de conexión se juntan ICE_BATCH ms y van en un solo mensaje
     * ({ cs: [...] }), y en cuanto no hay más (candidate null), al momento. Quien
     * recibe entiende los dos (las versiones de antes mandan { c }).
     */
    const iceOut = [];
    let iceT = 0;
    const flushIce = () => { clearTimeout(iceT); iceT = 0; if (iceOut.length && peers.get(u) === p) signal(u, { cs: iceOut.splice(0) }); };
    pc.onicecandidate = e => {
      if (!e.candidate) { flushIce(); return; }
      const c = e.candidate.toJSON();
      iceOut.push(c);
      // Misma wifi: el anfitrión manda también su candidato con la IP local de verdad.
      const lan = isHost && lanIp ? lanCandidate(c, lanIp) : null;
      if (lan) iceOut.push(lan);
      if (iceOut.length >= ICE_MAX) flushIce();
      else if (!iceT) iceT = setTimeout(flushIce, ICE_BATCH);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && p.mode !== 'closed') useRelay(u);
    };
    // Si en unos segundos no hay canal directo, se sigue por el servidor.
    p.timer = setTimeout(() => { if (p.mode === 'connecting') useRelay(u); }, directWait(u));
    emitPeer(u);
    return p;
  }

  function wireChannel(u, p, dc) {
    p.dc = dc;
    p.binaryVersion = 0;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      // Una pareja que ya va por el servidor no vuelve a directo por sí sola.
      if (p.mode !== 'connecting') return;
      clearTimeout(p.timer); p.mode = 'direct';
      if (isHost) G.Relay.emit('path', u, 'direct');
      // Aviso de que entendemos binario (las versiones viejas lo ignoran); hasta que el otro
      // mande el suyo, se le habla en JSON.
      try { dc.send(JSON.stringify({ k: 'net-cap', binary: G.NetCodec.version })); } catch (e) { /* el JSON sigue valiendo */ }
      emitPeer(u);
    };
    // A media partida: sigue por el servidor y repite lo que quizá se perdió.
    dc.onclose = () => { if (p.mode === 'direct') { p.mode = 'connecting'; useRelay(u, true); } };
    dc.onmessage = e => {
      let m;
      if (typeof e.data === 'string') {
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m && m.k === 'net-cap') {
          p.binaryVersion = m.binary === G.NetCodec.version ? m.binary : 0;
          return;
        }
        stats.recvBytes += G.NetCodec.size(e.data);
      } else {
        try {
          if (p.binaryVersion !== G.NetCodec.version) throw Error('unnegotiated binary');
          m = G.NetCodec.decode(e.data);
          // El binario es un 'f' dentro de su número ({ k: 'sq', n, d }).
          const f = m && m.k === 'sq' ? m.d : m;
          if (!f || f.k !== 'f') throw Error('not a frame');
        } catch (err) { stats.invalidBinary++; return; }
        stats.recvBytes += e.data.byteLength; stats.binaryRecv++;
      }
      if (m && m.k === 'sq') {
        if (fresh(u, m.n)) deliverNumbered(u, m.n, m.d);
        return;
      }
      deliver(u, m);
    };
  }

  /** `again`: venía del directo (repite por el servidor lo último mandado). */
  function useRelay(u, again) {
    const p = peers.get(u);
    if (!p || p.mode === 'direct' || p.mode === 'closed' || p.mode === 'relay') return;
    clearTimeout(p.timer);
    p.mode = 'relay';
    try { if (p.dc) p.dc.close(); } catch (e) { /* nada */ }
    try { if (p.pc) p.pc.close(); } catch (e) { /* nada */ }
    if (isHost) G.Relay.emit('path', u, 'server');
    emitPeer(u);
    if (again) resend(u);
  }

  // Anfitrión: invitados a los que se va a ofrecer conexión en cuanto lleguen los STUN.
  const iceWait = new Map();       // uid -> marca (si cambia o se borra, ya no toca)

  /** Anfitrión: abre conexión con un invitado. */
  async function connect(u) {
    if (!roomId || peers.has(u) || iceWait.has(u)) return;
    // Sin WebRTC si esta pareja va sólo por el servidor.
    if (serverOnly(u)) {
      peers.set(u, { pc: null, dc: null, mode: 'connecting', timer: 0, away: awayOf(u) });
      useRelay(u);
      return;
    }
    // Aún no está en la foto de la sala del servidor: no se sabe si esconde su IP. Se
    // espera a que salga (onRelayRoom); si no sale a tiempo, por el servidor.
    if (!member(u)) {
      const p = { pc: null, dc: null, mode: 'connecting', timer: 0, waiting: true, away: awayOf(u) };
      peers.set(u, p);
      p.timer = setTimeout(() => { if (peers.get(u) === p && p.mode === 'connecting') useRelay(u); }, directWait(u));
      emitPeer(u);
      return;
    }
    const mark = {};
    iceWait.set(u, mark);
    const list = await iceServers();
    if (iceWait.get(u) !== mark) return;
    iceWait.delete(u);
    if (!roomId || peers.has(u)) return;
    const p = newPeer(u, list);
    if (!p.pc) return;
    wireChannel(u, p, p.pc.createDataChannel('g', { ordered: true }));
    try {
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      signal(u, { sdp: p.pc.localDescription.toJSON() });
    } catch (e) { useRelay(u); }
  }

  const pendingIce = new Map();     // candidatos que llegan antes que la oferta

  async function onSignal(from, sig) {
    let p = peers.get(from);
    try {
      if (sig.sdp && sig.sdp.type === 'offer') {
        if (isHost) return;
        // Quien esconde su IP no contesta (ni manda candidatos). (Una oferta nueva
        // estando ya por el servidor sí: «Conectar en local» en la sala.)
        if (serverOnly(from)) return;
        const room = roomId, list = await iceServers();
        if (roomId !== room) return;
        p = peers.get(from);
        if (p) drop(from, true);
        p = newPeer(from, list);
        if (!p.pc) return;
        p.pc.ondatachannel = e => wireChannel(from, p, e.channel);
        await p.pc.setRemoteDescription(sig.sdp);
        const ans = await p.pc.createAnswer();
        await p.pc.setLocalDescription(ans);
        signal(from, { sdp: p.pc.localDescription.toJSON() });
        for (const c of pendingIce.get(from) || []) await p.pc.addIceCandidate(c).catch(() => {});
        pendingIce.delete(from);
      } else if (sig.sdp && sig.sdp.type === 'answer') {
        if (p && p.pc) await p.pc.setRemoteDescription(sig.sdp);
      } else if (sig.c || Array.isArray(sig.cs)) {
        for (const c of sig.cs || [sig.c]) {
          if (p && p.pc && p.pc.remoteDescription) await p.pc.addIceCandidate(c).catch(() => {});
          else { if (!pendingIce.has(from)) pendingIce.set(from, []); pendingIce.get(from).push(c); }
        }
      }
    } catch (e) {
      console.warn('[Net] señalización:', e.message);
      useRelay(from);
    }
  }

  function signal(to, sig) { G.Relay.emit('sig', to, sig); }

  function drop(u, silent) {
    iceWait.delete(u);
    const p = peers.get(u);
    if (!p) return;
    clearTimeout(p.timer);
    p.mode = 'closed';
    try { if (p.dc) p.dc.close(); } catch (e) { /* nada */ }
    try { if (p.pc) p.pc.close(); } catch (e) { /* nada */ }
    peers.delete(u);
    // Se ha ido de verdad: su numeración empieza de nuevo. Al rehacer la conexión
    // (silent) se sigue con la misma, para no tirar nada que aún venga de camino.
    if (!silent) forgetPair(u);
    if (!silent) emitPeer(u);
  }

  // ---------------- envío / recepción ----------------

  /** Con su número, por el directo si está abierto y si no por el servidor. */
  function send(to, msg) {
    if (!roomId) return;
    const p = peers.get(to), s = pairOf(to), n = ++s.out;
    let size = 0;
    stats.sent++;
    if (p && p.dc && p.dc.readyState === 'open') {
      try {
        const wrap = { k: 'sq', n, d: msg };
        const json = JSON.stringify(wrap), jsonBytes = G.NetCodec.size(json);
        const packed = p.binaryVersion === G.NetCodec.version && msg && msg.k === 'f'
          ? G.NetCodec.encode(wrap) : null;
        const binary = packed && packed.byteLength < jsonBytes;
        p.dc.send(binary ? packed : json);
        size = binary ? packed.byteLength : jsonBytes;
        stats.sentBytes += size;
        stats.jsonBytes += jsonBytes;
        if (binary) stats.binarySent++;
      } catch (e) { size = 0; /* cae al servidor */ }
    }
    if (!size) size = relayM(to, n, msg);
    keep(to, n, size, msg);
  }

  function toHost(msg) { if (!isHost && hostUid) send(hostUid, msg); }
  function broadcast(msg, except) { for (const u of peers.keys()) if (u !== except) send(u, msg); }

  function deliver(from, msg, old) {
    stats.recv++;
    handlers.forEach(fn => { try { fn(from, msg, !!old); } catch (e) { console.error('[Net] mensaje:', e); } });
  }

  /**
   * ¿Saldría ahora lo que se mande? Por el canal directo abierto o por el servidor con
   * nuestro socket conectado y el otro no caído ('away': el servidor tira lo que va a
   * alguien desconectado). Si no, coop.js espera y guarda los eventos.
   */
  function ready(u) {
    const p = peers.get(u);
    if (p && p.dc && p.dc.readyState === 'open') return true;
    return !!(p && p.mode !== 'closed' && !p.away && G.Relay && G.Relay.state === 'online');
  }

  /**
   * Bytes que le quedan por salir: lo que espera en el canal directo o, por el
   * servidor, lo mandado al invitado y aún sin confirmar (0 si no llegan
   * confirmaciones). Por el servidor no cuentan los LOAD_SKIP últimos: el invitado
   * confirma cada ACK_EVERY y hay que sumar el viaje de ida y vuelta, así que eso
   * siempre está sin confirmar aunque la conexión vaya bien (con frames grandes
   * pasaba de los 16 KB de coop.js y los enemigos lejanos no salían nunca).
   */
  function load(u) {
    const p = peers.get(u);
    if (p && p.dc && p.dc.readyState === 'open') return p.dc.bufferedAmount;
    const st = isHost && pairs.get(u);
    if (!st || !st.ackSeen) return 0;
    let b = st.bytes;
    for (let i = st.unacked.length - 1, k = 0; i >= 0 && k < LOAD_SKIP; i--, k++) b -= st.unacked[i][1];
    return b;
  }

  function busy(u) {
    const p = peers.get(u);
    if (p && p.dc && p.dc.readyState === 'open') return p.dc.bufferedAmount > BUSY_BYTES;
    const st = isHost && pairs.get(u);
    return !!(st && st.ackSeen && st.bytes > BUSY_BYTES);
  }

  return {
    open, close, syncMembers, send, toHost, broadcast,
    on(fn) { handlers.add(fn); }, off(fn) { handlers.delete(fn); },
    onPeer(fn) { peerHandlers.add(fn); },
    mode(u) { return modeOf(peers.get(u)); },
    // Misma wifi (ver lanCandidate).
    setLanIp, sameNetwork, isLocalIp, lanCandidate,
    get lanIp() { return lanIp; },
    /**
     * ¿Hay que mandar menos a menudo? El servidor aguanta el ritmo normal: sólo si
     * el otro se ha caído o aún se conecta.
     */
    slow(u) {
      const p = peers.get(u);
      return !p || p.away || p.mode === 'connecting';
    },
    /**
     * ¿Le queda mucho por salir? Entonces mejor esperar que mandar más (ver BUSY_BYTES).
     * Por el servidor: lo mandado al invitado y aún sin confirmar (sólo si llegan
     * confirmaciones: un servidor que no las reenvía no lo atasca).
     */
    busy,
    ready,
    load,
    peers() { return [...peers.keys()]; },
    get open_() { return !!roomId; },
    get isHost() { return isHost; },
    get uid() { return uid; },
    get hostUid() { return hostUid; },
    stats
  };
})();
