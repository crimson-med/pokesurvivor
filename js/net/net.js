/* ============ net.js: conexión entre los jugadores de una sala ============
 * Topología en estrella: el ANFITRIÓN habla con cada invitado; los invitados
 * sólo hablan con el anfitrión (él reenvía lo que haga falta).
 *
 * Dos caminos, a la vez:
 *   directo  WebRTC (canal de datos entre navegadores). La negociación
 *            (señalización) va por la base de datos. STUN gratuito de Google y,
 *            si la red no deja conectar directo (algunos routers y datos
 *            móviles), el TURN propio turn.pokesurvivor.com hace de puente.
 *            Sus credenciales caducan y se piden a
 *            ice.pokesurvivor.com con la sesión de Firebase; si no las da, se
 *            sigue sólo con STUN. Sólo se usa al reintentar una pareja que no
 *            conectó directa, y aun así el navegador prefiere la vía directa.
 *   relé     (APAGADO) los mensajes irían por la Realtime Database:
 *            rooms/{sala}/q/{destinatario}/{id}, a 1 $ el GB.
 *
 * Con ?relay (G.Relay.enabled, ver docs/relay-coop) todo pasa por el socket del
 * servidor del cooperativo (js/net/relay.js) y la base de datos no se toca:
 *   señalización  G.Relay 'sig' (to, sig) en vez de rooms/{sala}/q.
 *   relé          G.Relay 'm' (to, seq, bytes): binario de G.NetCodec para los
 *                 'f', JSON para lo demás. Sin TURN: si el canal directo no abre
 *                 en room.directWaitMs (x 10/6 en la misma red), esa pareja va
 *                 por el servidor ('relay') y ya no vuelve a directo por sí sola.
 *                 Con «Siempre por el servidor» o un invitado que esconde su IP,
 *                 el anfitrión ni lo intenta. Nunca hay 'failed'.
 *   orden         cada mensaje de una pareja lleva un número (seq), por los dos
 *                 caminos (por el directo va dentro: { k: 'sq', n, d }). Quien
 *                 recibe tira lo que ya ha visto; quien manda guarda lo último
 *                 (64 KB) y, si el canal directo se cierra a media partida, lo
 *                 repite por el servidor. El invitado confirma (ack) lo recibido
 *                 por el servidor cada 5 mensajes y al menos una vez por segundo.
 *                 Al anfitrión le llegan como 'ack' (from, seq); hasta que llegue
 *                 alguno, busy no cuenta lo pendiente por el servidor.
 *   el anfitrión  avisa al servidor del camino de cada invitado ('path'); el
 *                 invitado lo ve en la foto de la sala y deja de esperar al directo.
 *
 * Se envía por el canal directo si está abierto; si no, por el relé. El que
 * recibe escucha los dos, así que no hace falta ponerse de acuerdo.
 *
 * API:  open(roomId, isHost, hostUid) · close() · send(to, msg) · toHost(msg)
 *       broadcast(msg) · on(fn(from, msg)) · onPeer(fn(uid, state))
 *       peers() · mode(uid) -> 'connecting' | 'direct' | 'relay' | 'away' | 'closed'
 *       ('failed' sólo sin ?relay; 'away' sólo con él)
 */
G.Net = (() => {
  const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const TURN_API = 'https://ice.pokesurvivor.com/v1/ice';
  // Primero se intenta sin TURN (lo normal es conectar directo) y sólo si falla se
  // reintenta al momento con él: el navegador reserva un hueco en el TURN por cada
  // conexión que lo lleve, aunque luego vaya directa, y así los huecos llegan para todos.
  const DIRECT_TIMEOUT = 9000, TURN_TIMEOUT = 15000;   // ms para conseguir canal
  // Relé por la Realtime Database APAGADO (12-10-2026): a 1 $ el GB era lo que más
  // costaba del cooperativo. Sin conexión directa, esa pareja no puede jugar
  // junta ('failed') y el anfitrión lo reintenta cada RETRY_MS. Por la base de datos
  // sólo pasa la señalización (unos pocos mensajes pequeños para conectarse).
  // Con ?relay el relé vuelve, por el socket del servidor (ver la cabecera y relayOn).
  const RETRY_MS = 15000;
  const ICE_BATCH = 250, ICE_MAX = 40;    // candidatos: se juntan 250 ms (o 40) en un mensaje (ver newPeer)
  // Lo que puede quedar por salir en el canal. El canal no pierde nada y va en orden:
  // si la conexión da menos de lo que se manda, lo de más se queda en cola y el otro lo
  // ve cada vez más tarde (27-10-2026: una invitada iba 4 min y 40 s por detrás). Con
  // más que esto en cola, coop.js espera en vez de mandar (ver busy).
  const BUSY_BYTES = 64 * 1024;
  // Con ?relay: espera del canal directo si el servidor no dice otra cosa
  // (room.directWaitMs), y cada cuánto confirma el invitado lo que le llega por él.
  const RELAY_WAIT = 6000, SAME_NET_WAIT = 10 / 6, ACK_EVERY = 5, ACK_MS = 1000;
  // Lo que se guarda para repetir por el servidor: los últimos BUSY_BYTES; el
  // anfitrión, por el servidor, hasta que el invitado lo confirme (con tope).
  const KEEP_MAX = 4 * BUSY_BYTES;
  // Números que llegan antes que alguno anterior (al pasar de un camino a otro): se
  // apuntan hasta AHEAD_MAX; un número disparatado (más de SEQ_JUMP por delante) se tira.
  const AHEAD_MAX = 256, SEQ_JUMP = 100000;


  let rtdb = null, uid = null, roomId = null, isHost = false, hostUid = null;
  let qref = null;
  // ¿Esta sala va por el servidor del cooperativo (G.Relay)? Se mira al abrir.
  let relayOn = false;
  // Con ?relay, por pareja (dura toda la sala, aunque la conexión se rehaga):
  // uid -> { out, inSeen, ahead, top, acked, ackSeen, unacked: [[seq, bytes, msg]], bytes, ackN, ackT }
  const pairs = new Map();
  // Invitado: el último camino que el servidor dice que tenemos (ver onRelayRoom).
  // relayDown: nuestro socket se ha caído (lo mandado entretanto no ha salido).
  let myPath = null, relayDown = false;
  // Misma wifi (28-10-2026): IP local que ha escrito el anfitrión (ver lanCandidate).
  // Y las IP públicas que salen en los candidatos srflx (STUN): las nuestras y las de
  // cada jugador, para saber si una pareja que no conecta está detrás del mismo router.
  let lanIp = null;
  const myPub = new Set(), theirPub = new Map();   // uid -> Set
  const peers = new Map();         // uid -> { pc, dc, mode, timer }
  // Anfitrión: invitados con los que ya falló la vía directa. Se recuerda toda la
  // sesión (no sólo la sala) para no perder otra vez la espera sin TURN; y si ha
  // fallado con 2 o más, el problema será la red propia: TURN desde el principio.
  const needTurn = new Set();
  const handlers = new Set(), peerHandlers = new Set();
  const stats = { sent: 0, recv: 0, relaySent: 0,
    // Sólo los datos de la partida que se han mandado bien (sin ICE/SCTP/DTLS/TURN).
    sentBytes: 0, jsonBytes: 0, recvBytes: 0, binarySent: 0, binaryRecv: 0, invalidBinary: 0 };

  // ---------------- TURN propio ----------------
  // Credenciales temporales (2 h) por cuenta. Una conexión por el TURN deja de
  // funcionar cuando caducan las suyas (el servidor ya no le renueva el hueco), así
  // que sólo se reutilizan si les queda más que una partida larga (TURN_KEEP) o si
  // acaban de llegar (TURN_FRESH: unas nuevas no durarían más). Se piden ya al
  // entrar en la sala (open): el servidor puede tardar varios segundos y, si se
  // esperaba al primer fallo, el reintento salía sin ellas. Si no las da (cuenta no
  // autorizada, caído, sin red), se juega sólo con STUN y se vuelve a preguntar al
  // poco (a la media hora si la cuenta no tiene TURN).
  let turn = null, turnUid = null, turnAsk = null, turnRetry = 0;
  const TURN_KEEP = 80 * 60000, TURN_FRESH = 2 * 60000, TURN_WAIT = 10000;

  function cleanIce(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 4).map(s => ({
      urls: (Array.isArray(s && s.urls) ? s.urls : []).filter(x => typeof x === 'string' &&
        /^turns?:turn\.pokesurvivor\.com:\d{2,5}(\?transport=(udp|tcp))?$/.test(x)).slice(0, 4),
      username: String(s && s.username || '').slice(0, 200),
      credential: String(s && s.credential || '').slice(0, 200)
    })).filter(s => s.urls.length && s.username && s.credential);
  }

  function turnUser() {
    const fb = G.DB.fb, user = fb && !fb.emulator && fb.auth && fb.auth.currentUser;
    return user && !user.isAnonymous ? user : null;
  }

  /** Lo que ya se sabe sin preguntar: la lista (puede ir vacía) o null si hay que pedirla. */
  function turnNow() {
    const user = turnUser();
    if (!user) return [];
    if (turn && turnUid === user.uid && (turn.expiresAt * 1000 - Date.now() > TURN_KEEP || Date.now() - turn.at < TURN_FRESH)) return turn.iceServers;
    return Date.now() < turnRetry ? [] : null;
  }

  function turnServers() {
    const now = turnNow(), user = turnUser();
    if (now) return Promise.resolve(now);
    if (!turnAsk) {
      turnAsk = (async () => {
        const ctl = new AbortController(), stop = setTimeout(() => ctl.abort(), TURN_WAIT);
        try {
          const token = await user.getIdToken();
          const r = await fetch(TURN_API, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal });
          // 403: esta cuenta no tiene TURN (todavía); no insistir en media hora. 429: demasiadas, en un minuto.
          if (!r.ok) { turnRetry = Date.now() + (r.status === 403 ? 1800000 : r.status === 429 ? 60000 : 10000); return; }
          const j = await r.json(), iceServers = cleanIce(j && j.iceServers);
          if (!iceServers.length || !(j.expiresAt * 1000 > Date.now())) { turnRetry = Date.now() + 10000; return; }
          turn = { iceServers, expiresAt: j.expiresAt, at: Date.now() }; turnUid = user.uid;
        } catch (e) { turnRetry = Date.now() + 10000; }
        finally { clearTimeout(stop); turnAsk = null; }
      })();
    }
    return turnAsk.then(() => turn && turnUid === user.uid ? turn.iceServers : []);
  }

  /** ¿La conexión con u ha acabado pasando por el TURN? (para la sala) */
  async function checkTurn(u, p) {
    try {
      const st = await p.pc.getStats();
      let pair = null;
      st.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId); });
      if (!pair) st.forEach(r => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      const local = pair && st.get(pair.localCandidateId), remote = pair && st.get(pair.remoteCandidateId);
      const via = !!((local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay'));
      if (via !== !!p.viaTurn && peers.get(u) === p) { p.viaTurn = via; emitPeer(u); }
    } catch (e) { /* sólo es para el texto de la sala */ }
  }

  function emitPeer(u) {
    const p = peers.get(u);
    peerHandlers.forEach(fn => { try { fn(u, modeOf(p)); } catch (e) { console.warn(e); } });
  }

  /** 'away' (con ?relay: el servidor dice que se ha caído un momento) tapa el camino. */
  const modeOf = p => (p ? (p.away ? 'away' : p.mode) : 'closed');

  // ---------------- misma wifi ----------------
  /*
   * Dos aparatos detrás del mismo router no suelen conectar sólo con STUN: los dos
   * salen con la misma IP pública (y muchos routers no devuelven el tráfico hacia
   * dentro) y el navegador esconde la IP local con un nombre «xxxx.local» que el
   * otro tiene que resolver por mDNS (falla entre Windows y Mac, en wifis en malla
   * o si el router corta la multidifusión). El nombre se esconde, pero el puerto
   * no: si el anfitrión escribe su IP local, cada candidato «xxxx.local PUERTO typ
   * host» sale además con esa IP, y el invitado llega directo. El anfitrión aprende
   * la vía de vuelta con el primer paquete (candidato prflx). Una IP equivocada no
   * rompe nada: esa pareja falla como cualquier otra.
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

  /** Apunta la IP pública de un candidato srflx (de = null: nuestro). */
  function notePub(c, from) {
    const p = candParts(c);
    if (!p || p.type !== 'srflx') return;
    if (!from) { myPub.add(p.addr); return; }
    if (!theirPub.has(from)) theirPub.set(from, new Set());
    theirPub.get(from).add(p.addr);
  }

  /** ¿u y nosotros salimos a internet por la misma IP pública (mismo router)? */
  function sameNetwork(u) {
    // Con ?relay lo sabe el servidor (sin decir nunca la IP): sameNet del invitado.
    if (relayOn) { const m = member(isHost ? u : uid); return !!(m && m.sameNet); }
    const s = theirPub.get(u);
    if (!s) return false;
    for (const a of s) if (myPub.has(a)) return true;
    return false;
  }

  /**
   * Nuestra IP pública (IPv4) según el STUN de siempre, o null si no se consigue en
   * unos segundos (sin red, o la red corta el STUN). Sólo hace falta para las salas
   * locales (social.js): no se manda a ningún sitio más que al STUN.
   */
  function publicIp(wait = 4000) {
    return new Promise(resolve => {
      let pc, done = false;
      const end = ip => {
        if (done) return;
        done = true; clearTimeout(t);
        try { pc.close(); } catch (e) { /* nada */ }
        if (ip) myPub.add(ip);
        resolve(ip || null);
      };
      const t = setTimeout(() => end(null), wait);
      try {
        pc = new RTCPeerConnection({ iceServers: ICE });
        pc.createDataChannel('ip');
        pc.onicecandidate = e => {
          if (!e.candidate) { end(null); return; }
          const p = candParts(e.candidate);
          if (p && p.type === 'srflx' && /^\d+\.\d+\.\d+\.\d+$/.test(p.addr)) end(p.addr);
        };
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => end(null));
      } catch (e) { end(null); }
    });
  }

  /**
   * Anfitrión: activa (ip) o quita (null) la IP local. Las parejas que aún no han
   * conectado se rehacen al momento, ya con ella.
   */
  function setLanIp(ip) {
    const v = isLocalIp(ip) ? String(ip).trim() : null;
    if (v === lanIp) return;
    lanIp = v;
    if (!isHost || !roomId || !lanIp) return;
    for (const [u, p] of [...peers]) if (p.mode !== 'direct') { drop(u, true); connect(u); }
  }

  // ---------------- servidor del cooperativo (?relay) ----------------
  /*
   * G.Relay (js/net/relay.js) es el socket. G.Relay.room es la última foto de la sala
   * que ha mandado el servidor: { mode, directWaitMs, members: [{ uid, sameNet,
   * hideIp, ... }] } o null si aún no ha llegado.
   */
  const relayEnabled = () => !!(G.Relay && G.Relay.enabled);

  function member(u) {
    const r = G.Relay && G.Relay.room;
    return r && Array.isArray(r.members) ? r.members.find(m => m && m.uid === u) || null : null;
  }

  /** Espera del canal directo con u (x 10/6 si el servidor dice que estáis en la misma red). */
  function directWait(u) {
    const r = G.Relay && G.Relay.room, ms = r && r.directWaitMs > 0 ? r.directWaitMs : RELAY_WAIT;
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

  function pairOf(u) {
    let s = pairs.get(u);
    if (!s) pairs.set(u, s = { out: 0, inSeen: 0, ahead: new Set(), top: 0, acked: 0, ackSeen: false, unacked: [], bytes: 0, ackN: 0, ackT: 0 });
    return s;
  }

  function forgetPair(u) {
    const s = pairs.get(u);
    if (s) clearTimeout(s.ackT);
    pairs.delete(u);
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
    const max = isHost && s.ackSeen && !(p && p.dc && p.dc.readyState === 'open') ? KEEP_MAX : BUSY_BYTES;
    while (s.bytes > max && s.unacked.length > 1) s.bytes -= s.unacked.shift()[1];
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

  /**
   * ¿Es nuevo? Lo apunta. inSeen: entregados todos hasta ahí; ahead: los entregados
   * por encima (al pasar de conectando a directo, lo que salió por el servidor puede
   * llegar después que lo siguiente por el canal: se entrega igual, sin repetir).
   */
  function fresh(from, n) {
    if (!Number.isInteger(n) || n < 1) return false;
    const s = pairOf(from);
    if (n <= s.inSeen || s.ahead.has(n) || n > s.inSeen + SEQ_JUMP) return false;
    s.ahead.add(n);
    if (n > s.top) s.top = n;
    while (s.ahead.delete(s.inSeen + 1)) s.inSeen++;
    // Huecos que ya no van a llegar (se perdieron más de los que se guardan): se saltan.
    if (s.ahead.size > AHEAD_MAX) {
      s.inSeen = Math.min(...s.ahead); s.ahead.delete(s.inSeen);
      while (s.ahead.delete(s.inSeen + 1)) s.inSeen++;
    }
    return true;
  }

  /** Invitado: confirma cada ACK_EVERY mensajes llegados por el servidor, y al segundo como mucho. */
  function noteAck(from) {
    if (isHost) return;
    const s = pairOf(from);
    if (++s.ackN >= ACK_EVERY) sendAck(s);
    else if (!s.ackT) s.ackT = setTimeout(() => { s.ackT = 0; if (s.ackN && relayOn) sendAck(s); }, ACK_MS);
  }

  function sendAck(s) {
    clearTimeout(s.ackT); s.ackT = 0; s.ackN = 0;
    G.Relay.emit('ack', s.top);
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
    const ok = fresh(from, seq);
    noteAck(from);
    if (ok) deliver(from, m);
  }

  /** El servidor: un jugador se ha caído un momento ('away'), ha vuelto o ya no está. */
  function onRelayPeer(u, state) {
    const p = peers.get(u);
    if (!p) return;
    if (state === 'gone') { drop(u); return; }
    const away = state === 'away';
    if (away === !!p.away) return;
    p.away = away;
    emitPeer(u);
    // De vuelta por el servidor: lo que se mandó mientras no estaba, otra vez.
    if (!away && viaServer(p)) resend(u);
  }

  /**
   * Nueva foto de la sala: alguien puede haber pedido esconder su IP; el anfitrión
   * ya sabe de un invitado al que esperaba (ver connect); o, al invitado, el
   * anfitrión le ha puesto por el servidor.
   */
  function onRelayRoom() {
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
    const fb = G.DB.fb;
    rtdb = fb.rtdb; uid = fb.uid;
    roomId = id; isHost = host; hostUid = hostId;
    relayOn = relayEnabled();
    if (relayOn) {
      const me = member(uid);
      myPath = (me && me.path) || null; relayDown = G.Relay.state !== 'online';
      // Todo por el socket: la base de datos no se usa para nada.
      for (const ev in RELAY_EVENTS) G.Relay.on(ev, RELAY_EVENTS[ev]);
      if (G.Relay.state === 'off' && typeof G.Relay.connect === 'function') G.Relay.connect();
    } else {
      qref = rtdb.ref('rooms/' + id + '/q/' + uid);
      qref.on('child_added', s => {
        const raw = s.val();
        s.ref.remove().catch(() => {});
        let m;
        try { m = JSON.parse(raw); } catch (e) { return; }
        if (!m || !m.f) return;
        if (m.sig) onSignal(m.f, m.sig);
        else deliver(m.f, m.d);
      });
    }
    // Invitado: hueco para el anfitrión desde ya (se sustituye al llegar su
    // oferta). Así, si no llega nunca, se sigue por el relé y se sabe cuándo se va.
    // Con ?relay, si no llega en directWaitMs + 3 s, por el servidor (y al momento
    // si esta pareja va sólo por él: el anfitrión no mandará oferta).
    if (!isHost) {
      const p = { pc: null, dc: null, mode: 'connecting', timer: 0 };
      peers.set(hostId, p);
      if (relayOn && serverOnly(hostId)) useRelay(hostId);
      else if (relayOn) p.timer = setTimeout(() => { if (p.mode === 'connecting') useRelay(hostId); }, directWait(hostId) + 3000);
      else p.timer = setTimeout(() => { if (p.mode === 'connecting') { p.mode = 'failed'; emitPeer(hostId); } }, DIRECT_TIMEOUT + TURN_TIMEOUT + 3000);
    }
    if (!relayOn && turnNow() === null) turnServers();
  }

  function close() {
    for (const u of [...peers.keys()]) drop(u);
    if (qref) { qref.off(); qref = null; }
    if (relayOn && G.Relay) for (const ev in RELAY_EVENTS) G.Relay.off(ev, RELAY_EVENTS[ev]);
    for (const u of [...pairs.keys()]) forgetPair(u);
    relayOn = false; myPath = null; relayDown = false;
    roomId = null; isHost = false; hostUid = null;
    lanIp = null; theirPub.clear();
  }

  const turnFirst = u => needTurn.has(u) || needTurn.size >= 2;

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

  /** `withTurn`: intento con TURN (el de cualquiera de los dos; turnIce son los nuestros, si los hay). */
  function newPeer(u, turnIce, withTurn) {
    const p = { pc: null, dc: null, mode: 'connecting', timer: 0, viaTurn: false, turn: !!(withTurn || (turnIce && turnIce.length)) };
    peers.set(u, p);
    // Sin WebRTC (navegador antiguo o bloqueado): directamente por el relé.
    let pc;
    try { pc = p.pc = new RTCPeerConnection({ iceServers: ICE.concat(turnIce || []) }); }
    catch (e) {
      if (relayOn) { useRelay(u); return p; }
      p.mode = 'relay'; emitPeer(u); return p;
    }
    /*
     * Los candidatos de conexión se juntan ICE_BATCH ms y van en un solo mensaje
     * ({ cs: [...] }), y en cuanto no hay más (candidate null), al momento.
     * Antes iba uno por mensaje: unos 4.000 por minuto por la base de datos
     * (25-10-2026), lo que más se descargaba de ella. Quien recibe entiende los
     * dos (las versiones de antes mandan { c }).
     */
    const iceOut = [];
    let iceT = 0;
    const flushIce = () => { clearTimeout(iceT); iceT = 0; if (iceOut.length && peers.get(u) === p) signal(u, { cs: iceOut.splice(0) }); };
    pc.onicecandidate = e => {
      if (!e.candidate) { flushIce(); return; }
      const c = e.candidate.toJSON();
      notePub(c, null);
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
    // Si en unos segundos no hay canal directo, se sigue por el relé.
    p.timer = setTimeout(() => { if (p.mode === 'connecting') useRelay(u); }, relayOn ? directWait(u) : p.turn ? TURN_TIMEOUT : DIRECT_TIMEOUT);
    emitPeer(u);
    return p;
  }

  function wireChannel(u, p, dc) {
    p.dc = dc;
    p.binaryVersion = 0;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      // Con ?relay, una pareja que ya va por el servidor no vuelve a directo por sí sola.
      if (relayOn && p.mode !== 'connecting') return;
      clearTimeout(p.timer); p.mode = 'direct';
      if (relayOn && isHost) G.Relay.emit('path', u, 'direct');
      if (p.pc) checkTurn(u, p);
      // Aviso de que entendemos binario (las versiones viejas lo ignoran); hasta que el otro
      // mande el suyo, se le habla en JSON.
      try { dc.send(JSON.stringify({ k: 'net-cap', binary: G.NetCodec.version })); } catch (e) { /* el JSON sigue valiendo */ }
      emitPeer(u);
    };
    // Con ?relay, a media partida: sigue por el servidor y repite lo que quizá se perdió.
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
          // Con ?relay el binario es un 'f' dentro de su número ({ k: 'sq', n, d }).
          const f = relayOn && m && m.k === 'sq' ? m.d : m;
          if (!f || f.k !== 'f') throw Error('not a frame');
        } catch (err) { stats.invalidBinary++; return; }
        stats.recvBytes += e.data.byteLength; stats.binaryRecv++;
      }
      if (relayOn && m && m.k === 'sq') {
        if (fresh(u, m.n)) deliver(u, m.d);
        return;
      }
      deliver(u, m);
    };
  }

  /** `again`: con ?relay, venía del directo (repite por el servidor lo último mandado). */
  function useRelay(u, again) {
    const p = peers.get(u);
    if (!p || p.mode === 'direct' || p.mode === 'closed' || p.mode === 'failed') return;
    if (relayOn) {
      // Sin TURN ni reintentos: por el servidor. No vuelve a directo por sí sola
      // (sólo si el anfitrión rehace la pareja con «Conectar en local», ver setLanIp).
      if (p.mode === 'relay') return;
      clearTimeout(p.timer);
      p.mode = 'relay';
      try { if (p.dc) p.dc.close(); } catch (e) { /* nada */ }
      try { if (p.pc) p.pc.close(); } catch (e) { /* nada */ }
      if (isHost) G.Relay.emit('path', u, 'server');
      emitPeer(u);
      if (again) resend(u);
      return;
    }
    // Sin relé: no se puede jugar con esa persona por ahora. El anfitrión reintenta.
    clearTimeout(p.timer);
    p.mode = 'failed';
    try { if (p.pc) p.pc.close(); } catch (e) { /* nada */ }
    emitPeer(u);
    if (!isHost) return;
    // Primer fallo sin TURN: se reintenta ya, esta vez con él. Basta con que lo tenga
    // uno de los dos: si el anfitrión no consigue el suyo, el invitado pone el propio.
    const withTurn = !p.turn && !needTurn.has(u);
    if (withTurn) needTurn.add(u);
    p.timer = setTimeout(() => { if (peers.get(u) === p && p.mode === 'failed' && roomId) { drop(u, true); connect(u); } }, withTurn ? 0 : RETRY_MS);
  }

  /** Anfitrión: abre conexión con un invitado. */
  async function connect(u) {
    if (!roomId || peers.has(u)) return;
    // Con ?relay: sin TURN, y sin WebRTC si esta pareja va sólo por el servidor.
    if (relayOn && serverOnly(u)) {
      peers.set(u, { pc: null, dc: null, mode: 'connecting', timer: 0 });
      useRelay(u);
      return;
    }
    // Aún no está en la foto de la sala del servidor: no se sabe si esconde su IP. Se
    // espera a que salga (onRelayRoom); si no sale a tiempo, por el servidor.
    if (relayOn && !member(u)) {
      const p = { pc: null, dc: null, mode: 'connecting', timer: 0, waiting: true };
      peers.set(u, p);
      p.timer = setTimeout(() => { if (peers.get(u) === p && p.mode === 'connecting') useRelay(u); }, directWait(u));
      emitPeer(u);
      return;
    }
    const withTurn = !relayOn && turnFirst(u);
    let turnIce = withTurn ? turnNow() : [];
    if (!turnIce) {
      const room = roomId; turnIce = await turnServers();
      if (roomId !== room || peers.has(u)) return;
    }
    const p = newPeer(u, turnIce, withTurn);
    if (!p.pc) return;
    wireChannel(u, p, p.pc.createDataChannel('g', { ordered: true }));
    try {
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      // t: el invitado también usa el TURN en este intento, aunque el anfitrión no
      // tenga el suyo (las versiones viejas lo ignoran).
      signal(u, p.turn ? { sdp: p.pc.localDescription.toJSON(), t: 1 } : { sdp: p.pc.localDescription.toJSON() });
    } catch (e) { useRelay(u); }
  }

  const pendingIce = new Map();     // candidatos que llegan antes que la oferta

  async function onSignal(from, sig) {
    let p = peers.get(from);
    try {
      if (sig.sdp && sig.sdp.type === 'offer') {
        if (isHost) return;
        // Con ?relay, quien esconde su IP no contesta (ni manda candidatos), y sin TURN.
        // (Una oferta nueva estando ya por el servidor sí: «Conectar en local» en la sala.)
        if (relayOn && serverOnly(from)) return;
        let turnIce = sig.t && !relayOn ? turnNow() : [];
        if (!turnIce) {
          const room = roomId; turnIce = await turnServers();
          if (roomId !== room) return;
          p = peers.get(from);
        }
        if (p) drop(from, true);
        p = newPeer(from, turnIce, !!sig.t && !relayOn);
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
          notePub(c, from);
          if (p && p.pc && p.pc.remoteDescription) await p.pc.addIceCandidate(c).catch(() => {});
          else { if (!pendingIce.has(from)) pendingIce.set(from, []); pendingIce.get(from).push(c); }
        }
      }
    } catch (e) {
      console.warn('[Net] señalización:', e.message);
      useRelay(from);
    }
  }

  function signal(to, sig) {
    if (relayOn) G.Relay.emit('sig', to, sig);
    else relayPush(to, { f: uid, sig });
  }

  function drop(u, silent) {
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

  /*
   * Cada remitente tiene 100 huecos por destinatario (tuUid_00 ... tuUid_99) y
   * los va usando en orden; quien recibe borra cada mensaje al leerlo. Antes cada
   * mensaje era nuevo (push) y sin tope de tamaño, y el 23-10-2026 se llenó la
   * base de datos de basura (ver social.js, createRoom). Las reglas
   * (database.rules.json) sólo admiten estos huecos y mensajes de hasta 16.000.
   */
  let slot = 0;
  function relayPush(to, env) {
    if (!rtdb || !roomId) return;
    const key = uid + '_' + String(slot++ % 100).padStart(2, '0');
    rtdb.ref('rooms/' + roomId + '/q/' + to + '/' + key).set(JSON.stringify(env)).catch(e => console.warn('[Net] relé:', e.code || e.message));
  }

  function send(to, msg) {
    if (!roomId) return;
    if (relayOn) { sendNumbered(to, msg); return; }
    const p = peers.get(to);
    stats.sent++;
    if (p && p.dc && p.dc.readyState === 'open') {
      try {
        const json = JSON.stringify(msg), jsonBytes = G.NetCodec.size(json);
        const packed = p.binaryVersion === G.NetCodec.version && msg && msg.k === 'f'
          ? G.NetCodec.encode(msg) : null;
        const binary = packed && packed.byteLength < jsonBytes;
        p.dc.send(binary ? packed : json);
        stats.sentBytes += binary ? packed.byteLength : jsonBytes;
        stats.jsonBytes += jsonBytes;
        if (binary) stats.binarySent++;
        return;
      } catch (e) { /* cae al relé */ }
    }
    // Sin relé, los datos de la partida no van por la base de datos (se pierden: esa
    // pareja no está conectada). Sólo pasa el aviso de empezar.
    if (!(msg && msg.k === 'start')) return;
    stats.relaySent++;
    relayPush(to, { f: uid, d: msg });
  }

  /** Con ?relay: con su número, por el directo si está abierto y si no por el servidor. */
  function sendNumbered(to, msg) {
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

  function deliver(from, msg) {
    stats.recv++;
    handlers.forEach(fn => { try { fn(from, msg); } catch (e) { console.error('[Net] mensaje:', e); } });
  }

  return {
    open, close, syncMembers, send, toHost, broadcast,
    on(fn) { handlers.add(fn); }, off(fn) { handlers.delete(fn); },
    onPeer(fn) { peerHandlers.add(fn); },
    mode(u) { return modeOf(peers.get(u)); },
    /** ¿Conectado pero pasando por el TURN propio? */
    viaTurn(u) { const p = peers.get(u); return !!(p && p.mode === 'direct' && p.viaTurn); },
    // Misma wifi (ver lanCandidate).
    setLanIp, publicIp, sameNetwork, isLocalIp, lanCandidate,
    get lanIp() { return lanIp; },
    /**
     * ¿Va por el relé (o no hay conexión)? Entonces se manda menos a menudo. Con
     * ?relay el servidor aguanta el ritmo normal: sólo si se ha caído o aún conecta.
     */
    slow(u) {
      const p = peers.get(u);
      if (relayOn) return !p || p.away || p.mode === 'connecting';
      return !p || p.mode !== 'direct';
    },
    /**
     * ¿Le queda mucho por salir? Entonces mejor esperar que mandar más (ver BUSY_BYTES).
     * Con ?relay, por el servidor: lo mandado al invitado y aún sin confirmar (sólo
     * si llegan confirmaciones: un servidor que no las reenvía no lo atasca).
     */
    busy(u) {
      const p = peers.get(u);
      if (p && p.dc && p.dc.readyState === 'open') return p.dc.bufferedAmount > BUSY_BYTES;
      const s = relayOn && isHost && pairs.get(u);
      return !!(s && s.ackSeen && s.bytes > BUSY_BYTES);
    },
    peers() { return [...peers.keys()]; },
    get open_() { return !!roomId; },
    get isHost() { return isHost; },
    get uid() { return uid; },
    get hostUid() { return hostUid; },
    stats
  };
})();
