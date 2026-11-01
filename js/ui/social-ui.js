/* ============ social-ui.js — apodo, amigos, sala e invitaciones ============ */
(() => {
  const $ = G.UI.$;
  const esc = G.U.esc;

  /** ¿Se puede usar lo online (cuenta en el servidor del juego)? Si no, explica por qué. */
  function needOnline() {
    if (G.DB.online) return true;
    G.UI.toast(G.DB.guest ? 'Crea una cuenta para jugar con amigos y salir en el ranking.'
      : 'Esto necesita la versión online del juego (con la nube).', 3200);
    return false;
  }

  // ======================= APODO =======================

  G.NickUI = (() => {
    let then = null, skipped = false;

    function init() {
      $('nick-form').onsubmit = async e => {
        e.preventDefault();
        $('nick-err').textContent = '';
        $('nick-ok').disabled = true;
        const r = await G.Social.claimNick($('nick-in').value);
        $('nick-ok').disabled = false;
        if (!r.ok) { $('nick-err').textContent = r.error; G.Audio.sfx('error'); return; }
        G.Audio.sfx('confirm');
        G.UI.toast('Tu apodo es ' + G.Social.me.name);
        const cb = then; then = null;
        if (cb) cb(); else G.MenuUI.open();
      };
      $('nick-later').onclick = () => { skipped = true; then = null; G.MenuUI.open(); };
    }

    /** @param next  qué abrir después de elegirlo */
    function open(next) {
      then = next || null;
      G.UI.show('scr-nick');
      $('nick-err').textContent = '';
      $('nick-in').value = '';
      setTimeout(() => $('nick-in').focus(), 50);
    }

    return { init, open, get skipped() { return skipped; } };
  })();

  /** Abre `fn` si tienes apodo; si no, pide el apodo primero. */
  function withNick(fn) {
    if (!needOnline()) return;
    if (G.Social.me) { fn(); return; }
    G.Social.start().then(r => { if (r === 'ok') fn(); else G.NickUI.open(fn); });
  }

  // La última IP local que escribiste (para no tener que buscarla cada vez).
  const LAN_KEY = 'ps.lanip';
  function lastIp() { try { return localStorage.getItem(LAN_KEY) || ''; } catch (e) { return ''; } }
  function saveIp(ip) { try { localStorage.setItem(LAN_KEY, ip); } catch (e) { /* sin almacenamiento */ } }
  const LAN_HELP = '<b>Windows:</b> Configuración › Red e Internet › Wi-Fi › tu red › Dirección IPv4.<br>'
    + '<b>Mac:</b> Ajustes del Sistema › Wi-Fi › Detalles › TCP/IP › Dirección IP.<br>'
    + '<b>iPhone:</b> Ajustes › Wi-Fi › la (i) de tu red › Dirección IP.<br>'
    + '<b>Android:</b> Ajustes › Wi-Fi › tu red › Dirección IP (el menú cambia según el móvil).';

  // ======================= SALAS CON CÓDIGO =======================
  /*
   * Cooperativo por el servidor del juego (docs/relay-coop, paso 5): salas con un
   * código de cuatro Pokémon, elegir si se va directo o siempre por el servidor, y
   * cómo llega cada jugador al anfitrión. G.RoomCode puede no estar cargado: cada
   * uso lo comprueba.
   */
  const curLang = () => (G.I18n && G.I18n.lang) || 'es';

  // Errores del servidor (Error con .code; ver docs/relay-coop/02-protocol.md).
  const NO_SERVER = 'No se llega al servidor del juego en grupo. Revisa tu conexión a internet.';
  const RELAY_ERR = {
    'not-found': 'No hay ninguna sala con ese código. Revisa con tu anfitrión los cuatro Pokémon y su orden.',
    full: 'Esta sala está llena (4 jugadores).',
    started: 'La partida de esa sala ya ha empezado.',
    rate: 'Demasiados intentos. Espera un minuto y vuelve a probar.',
    'old-version': 'Actualiza el juego para jugar en grupo.',
    'signed-out': 'Vuelve a iniciar sesión para jugar en grupo.',
    banned: 'Esta cuenta no puede jugar en grupo.',
    busy: 'El juego en grupo está lleno ahora mismo. Prueba otra vez en unos minutos.',
    unreachable: NO_SERVER,
    timeout: NO_SERVER
  };
  /** Error del servidor (o respuesta { ok: false, err | error }) -> texto para el jugador. */
  function relayError(e, fallback) {
    if (e) for (const k of [e.code, e.err, e.error, e.message]) {
      if (typeof k === 'string' && Object.prototype.hasOwnProperty.call(RELAY_ERR, k)) return RELAY_ERR[k];
    }
    return (e && typeof e.error === 'string' && e.error) || fallback;
  }

  /** Texto de una respuesta { ok: false, code, error } de G.Social: el del código si lo hay. */
  const errText = r => relayError(r, (r && r.error) || '');

  /** Llama a G.Social y deja la respuesta en { ok, error }, tanto si lanza como si devuelve ok: false. */
  async function relayCall(fn, fallback) {
    try {
      const r = await fn();
      return r && r.ok === false ? { ok: false, error: relayError(r, fallback) } : { ok: true };
    } catch (e) { return { ok: false, error: relayError(e, fallback) }; }
  }

  /** Si `text` es un código entero, lo reparte en las cuatro casillas (con los nombres en tu idioma). */
  function fillCode(inputs, text) {
    const rc = G.RoomCode;
    const code = rc && rc.parseCode ? rc.parseCode(String(text || '')) : null;
    if (!code || code.length !== 4) return false;
    const names = rc.codeNames ? rc.codeNames(code, curLang()) : code.map(String);
    inputs.forEach((el, i) => { el.value = names[i] || ''; });
    return true;
  }

  /**
   * Cómo llega un invitado al anfitrión (lo dice el servidor en cada miembro).
   * -> { kind: 'lan' | 'direct' | 'server' | 'wait' | 'away', text }
   */
  function pathBadge(m, room) {
    if (m.online === false) return { kind: 'away', text: 'Reconectando…' };
    let p = m.path;
    // El anfitrión lo sabe por su propia conexión antes de que llegue del servidor.
    if (!p && room && room.isHost && G.Net && G.Net.mode) {
      const nm = G.Net.mode(m.uid);
      p = nm === 'direct' ? 'direct' : nm === 'relay' || nm === 'server' ? 'server' : null;
    }
    if (p === 'server' || p === 'relay') return { kind: 'server', text: 'Servidor' };
    if (p === 'direct') return m.sameNet ? { kind: 'lan', text: 'Misma wifi' } : { kind: 'direct', text: 'Directo' };
    return { kind: 'wait', text: 'Conectando…' };
  }

  /** Copia al portapapeles (y si el navegador no deja, a la antigua). -> true si se pudo */
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) { /* sin permiso: a la antigua */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }

  /** Abre la sala en cuanto llegue del servidor (puede tardar un momento tras crearla o entrar). */
  function openLobbyWhenReady(tries = 30) {
    if (G.Social.room) G.LobbyUI.open();
    else if (tries > 0 && G.UI.isOpen('scr-friends')) setTimeout(() => openLobbyWhenReady(tries - 1), 100);
  }

  // ======================= AMIGOS =======================

  G.FriendsUI = (() => {
    let codeMode = 'direct';
    const codeInputs = () => [...$('code-join').querySelectorAll('.code-inputs input')];

    function init() {
      $('fr-add').onsubmit = async e => {
        e.preventDefault();
        const name = $('fr-name').value;
        msg('');
        const r = await G.Social.request(name);
        msg(r.ok ? r.msg : r.error, !r.ok);
        if (r.ok) $('fr-name').value = '';
      };
      $('fr-room').onclick = () => G.LobbyUI.open();
      G.Social.on(() => { if (G.UI.isOpen('scr-friends')) render(); });

      // Crear sala (directa primero o siempre por el servidor) o entrar con código.
      $('code-mode').onclick = e => {
        const c = e.target.closest('[data-mode]');
        if (!c) return;
        codeMode = c.dataset.mode;
        $('code-mode').querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === c));
      };
      $('code-create').onclick = async () => {
        codeMsg('');
        const b = $('code-create');
        b.disabled = true;
        const r = await relayCall(() => G.Social.createRoom({ mode: codeMode }), 'No se pudo crear la sala.');
        b.disabled = false;
        if (!r.ok) { codeMsg(r.error, true); return; }
        openLobbyWhenReady();
      };
      const inputs = codeInputs();
      inputs.forEach((el, i) => {
        // Pegar el código entero en cualquier casilla rellena las cuatro.
        el.addEventListener('paste', e => {
          const cd = e.clipboardData || window.clipboardData;
          if (cd && fillCode(inputs, cd.getData('text'))) { e.preventDefault(); suggest(''); inputs[3].focus(); }
        });
        el.addEventListener('input', e => {
          // (También si llega escrito con espacios o guiones, o el móvil no avisa de que se pega.)
          if (/[\s,，、-]/.test(el.value.trim()) && fillCode(inputs, el.value)) { suggest(''); inputs[3].focus(); return; }
          suggest(el.value);
          // Elegido de la lista: a la casilla siguiente.
          if (e.inputType === 'insertReplacementText' && el.value && i < 3) inputs[i + 1].focus();
        });
        el.addEventListener('focus', () => suggest(el.value));
      });
      $('code-join').onsubmit = async e => {
        e.preventDefault();
        codeMsg('');
        const vals = inputs.map(el => el.value.trim());
        if (vals.some(v => !v)) { codeMsg('Escribe los cuatro Pokémon del código.', true); return; }
        let code = vals.join('-');
        if (G.RoomCode && G.RoomCode.parseCode) {
          code = G.RoomCode.parseCode(code);
          if (!code) { codeMsg(RELAY_ERR['not-found'], true); return; }
        }
        const b = $('code-join').querySelector('button[type=submit]');
        b.disabled = true;
        const r = await relayCall(() => G.Social.joinRoom(code), 'No se pudo entrar en la sala.');
        b.disabled = false;
        if (!r.ok) { codeMsg(r.error, true); return; }
        inputs.forEach(el => { el.value = ''; });
        G.Audio.sfx('confirm');
        openLobbyWhenReady();
      };
    }

    /** Nombres para el autocompletado, en el idioma del jugador. */
    function suggest(prefix) {
      const dl = $('code-dl');
      const rc = G.RoomCode && G.RoomCode.suggest ? G.RoomCode : null;
      const p = String(prefix || '').trim();
      let list = [];
      if (p && rc) { try { list = rc.suggest(p, curLang()) || []; } catch (e) { list = []; } }
      dl.innerHTML = '';
      for (const s of list.slice(0, 8)) {
        if (!s || !s.name || s.name.toLowerCase() === p.toLowerCase()) continue;
        const o = document.createElement('option');
        o.value = s.name;
        dl.appendChild(o);
      }
    }

    function codeMsg(t, bad) {
      $('code-msg').textContent = t || '';
      $('code-msg').style.color = bad ? '#ffb0b8' : '';
      if (t && bad) G.Audio.sfx('error');
    }

    function msg(t, bad) {
      $('fr-msg').textContent = t || '';
      $('fr-msg').style.color = bad ? '#ffb0b8' : '';
      if (t) G.Audio.sfx(bad ? 'error' : 'confirm');
    }

    function open() {
      withNick(() => {
        G.UI.show('scr-friends', true); msg(''); render();
        G.Social.ensureFriends().then(() => { if (G.UI.isOpen('scr-friends')) render(); });
      });
    }

    // (Sin "en línea" desde el 20-10-2026: costaba 1/4 de las escrituras de Firestore.)
    function stateText(f) {
      if (f.status === 'in') return 'Quiere ser tu amigo';
      if (f.status === 'out') return 'Solicitud enviada';
      return '';
    }

    function render() {
      const room = G.Social.room;
      $('fr-code').classList.toggle('hidden', !!room);
      // Los amigos todavía son los de Firebase (G.DB.fb): sin él, fuera hasta el paso 6.
      $('fr-online').classList.toggle('hidden', !G.DB.fb);
      $('fr-me').innerHTML = 'Tu apodo: <b class="gold" translate="no">' + esc(G.Social.me ? G.Social.me.name : '') + '</b> · dáselo a tus amigos para que te añadan.';
      $('fr-room').classList.toggle('hidden', !room);
      const list = G.Social.friends.sort((a, b) => {
        const rank = f => f.status === 'in' ? 0 : f.status === 'ok' ? 1 : 2;
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });
      const box = $('fr-list');
      box.innerHTML = '';
      if (!list.length) {
        box.innerHTML = '<p class="sub">Aún no tienes amigos añadidos. Escribe arriba el apodo de un amigo.</p>';
        return;
      }
      for (const f of list) {
        const el = document.createElement('div');
        el.className = 'fr-row';
        const dot = f.status !== 'ok' ? 'pend' : 'on';
        const inRoom = room && room.members.some(m => m.uid === f.uid);
        el.innerHTML = `<i class="dot ${dot}"></i><b translate="no"><a href="#" class="plink" title="Ver su perfil">${esc(f.name)}</a></b><span class="st">${inRoom ? 'En tu sala' : stateText(f)}</span><span class="grow"></span>`;
        if (f.status === 'ok') el.querySelector('.plink').onclick = e => { e.preventDefault(); G.ProfileUI.show(f.uid); };
        else el.querySelector('.plink').onclick = e => e.preventDefault();
        const btn = (txt, cls, fn) => {
          const b = document.createElement('button');
          b.className = 'btn small ' + cls; b.textContent = txt; b.onclick = fn; el.appendChild(b); return b;
        };
        if (f.status === 'in') {
          btn('Aceptar', 'gold', async () => { const r = await G.Social.accept(f.uid); msg(r.ok ? r.msg : r.error, !r.ok); });
          btn('Rechazar', 'ghost', () => G.Social.remove(f.uid));
        } else if (f.status === 'out') {
          btn('Cancelar', 'ghost', () => G.Social.remove(f.uid));
        } else {
          if (!inRoom && (!room || room.isHost)) {
            btn('Invitar', 'gold', async () => {
              const r = await G.Social.invite(f.uid);
              msg(r.ok ? r.msg : errText(r), !r.ok);
              if (r.ok) G.LobbyUI.open();
            });
          }
          btn('Quitar', 'ghost', () => { if (confirm('¿Quitar a ' + f.name + ' de tus amigos?')) G.Social.remove(f.uid); });
        }
        box.appendChild(el);
      }
    }

    return { init, open, render };
  })();

  // ======================= SALA =======================

  G.LobbyUI = (() => {
    let membersKey = '', hintKey = '', codeKey = '';
    // El botón Invitar de la sala abre la lista de amigos: llega con ellos (paso 6).
    const INVITE = false;

    function init() {
      $('lobby-leave').onclick = async () => {
        await G.Social.leaveRoom();
        G.Net.close();
        G.MenuUI.open();
      };
      $('lobby-menu').onclick = () => G.MenuUI.open();
      $('lobby-start').onclick = start;
      $('lobby-start').dataset.sfx = 'confirm';
      // Conecta / desconecta la red al entrar o salir de una sala.
      G.Social.on(what => {
        const room = G.Social.room;
        if (room) {
          G.Net.open(room.id, room.isHost, room.host);
          G.Net.setLanIp(room.isHost ? room.lanIp || null : null);
          // En partida la lista de la sala no echa a nadie (puede faltar alguien un
          // momento por un corte con la base de datos): manda el canal directo.
          if (!G.Coop.active && !room.lost) G.Net.syncMembers(room.members.map(m => m.uid));
        } else if (G.Net.open_) G.Net.close();
        if (what === 'room-closed') {
          G.UI.toast('La sala se ha cerrado', 2600);
          if (G.UI.isOpen('scr-lobby')) G.MenuUI.open();
        }
        if (G.UI.isOpen('scr-lobby')) render();
      });
      G.Net.onPeer(() => { if (G.UI.isOpen('scr-lobby')) render(); });
    }

    function open() {
      if (!G.Social.room) { G.MenuUI.open(); return; }
      G.Social.refreshMember();
      G.Social.ensureFriends().then(() => { if (G.UI.isOpen('scr-lobby')) { membersKey = ''; render(); } });
      G.UI.show('scr-lobby', true);
      membersKey = ''; hintKey = ''; codeKey = '';
      render();
    }

    function close() { G.UI.hide('scr-lobby'); }

    const connText = (m, room) => (m.uid === room.host ? 'Anfitrión' : pathBadge(m, room).text);

    function render() {
      const room = G.Social.room;
      if (!room) return;
      const ms = room.members;
      $('lobby-sub').textContent = room.isHost && room.code
        ? 'Eres el anfitrión. Comparte el código o invita a tus amigos (hasta ' + G.Social.MAX_PLAYERS + ') y empezad cuando estéis.'
        : room.isHost
        ? 'Eres el anfitrión. Invita a tus amigos (hasta ' + G.Social.MAX_PLAYERS + ') y empezad cuando estéis.'
        : 'Estás en la sala de ' + ((ms.find(m => m.uid === room.host) || {}).name || '…') + '. El anfitrión empezará la partida.';
      renderCode(room);

      // Las tarjetas sólo se rehacen si cambian los miembros (los sprites no parpadean).
      const key = ms.map(m => m.uid + ':' + m.dex + ':' + (m.shiny ? 1 : 0)).join('|');
      const box = $('lobby-members');
      if (key !== membersKey) {
        membersKey = key;
        box.innerHTML = '';
        for (let i = 0; i < G.Social.MAX_PLAYERS; i++) {
          const m = ms[i];
          const c = document.createElement('div');
          c.className = 'lob-card' + (m ? '' : ' empty');
          if (m) {
            c.style.setProperty('--pc', G.Coop.COLORS[i]);
            c.appendChild(G.UI.spriteCanvas(m.dex, 120, 96, { scale: 2, lively: true, shiny: !!m.shiny }));
            c.insertAdjacentHTML('beforeend', `<b translate="no">${esc(m.name)}</b><small>${esc((G.DEX_BY[m.dex] || {}).name || '')}</small><span class="conn" data-u="${m.uid}"></span>`);
          } else c.innerHTML = '<span>Libre</span>';
          box.appendChild(c);
        }
      }
      box.querySelectorAll('.conn').forEach(el => {
        const m = ms.find(x => x.uid === el.dataset.u);
        if (!m) return;
        const t = connText(m, room);
        el.textContent = t;
        el.className = m.uid !== room.host ? 'conn badge b-' + pathBadge(m, room).kind : 'conn';
      });

      // Misma wifi: «Conectar en local» si un invitado de tu red va por el servidor.
      renderLocal(room, ms);

      // Invitar (sólo el anfitrión y si queda sitio).
      const canInvite = INVITE && room.isHost && ms.length < G.Social.MAX_PLAYERS;
      $('lobby-inv-title').classList.toggle('hidden', !canInvite);
      const inv = $('lobby-invite');
      inv.classList.toggle('hidden', !canInvite);
      if (canInvite) {
        inv.innerHTML = '';
        const free = G.Social.friends.filter(f => f.status === 'ok' && !ms.some(m => m.uid === f.uid));
        if (!free.length) inv.innerHTML = '<p class="sub" style="margin:0">Aún no tienes amigos añadidos.</p>';
        for (const f of free) {
          const el = document.createElement('div');
          el.className = 'fr-row';
          el.innerHTML = `<i class="dot on"></i><b translate="no">${esc(f.name)}</b><span class="grow"></span>`;
          const b = document.createElement('button');
          b.className = 'btn small gold'; b.textContent = 'Invitar';
          b.onclick = async () => { const r = await G.Social.invite(f.uid); G.UI.toast(r.ok ? r.msg : errText(r)); };
          el.appendChild(b);
          inv.appendChild(el);
        }
      }

      const btn = $('lobby-start');
      btn.classList.toggle('hidden', !room.isHost);
      // Nadie se queda sin conectar: si no va directo, va por el servidor.
      const connecting = ms.some(m => m.uid !== room.host && ['wait', 'away'].includes(pathBadge(m, room).kind));
      btn.disabled = !room.isHost || ms.length < 2 || connecting;
      btn.textContent = 'Empezar partida (' + ms.length + '/' + G.Social.MAX_PLAYERS + ')';
      $('lobby-note').textContent = !room.isHost ? 'Cuando el anfitrión empiece, entraréis todos a la vez.'
        : ms.length < 2 ? 'Necesitas al menos un amigo en la sala.'
        : connecting ? 'Conectando con tus amigos…' : 'La partida empieza para todos a la vez.';
    }

    /** El código de la sala: cuatro Pokémon (con su nombre en tu idioma) y «Copiar código». */
    function renderCode(room) {
      const box = $('lobby-code');
      const code = Array.isArray(room.code) && room.code.length === 4 ? room.code : null;
      const key = code ? code.join('-') : '';
      if (key === codeKey) return;
      codeKey = key;
      box.classList.toggle('hidden', !code);
      box.innerHTML = '';
      if (!code) return;
      const rc = G.RoomCode;
      const names = rc && rc.codeNames ? rc.codeNames(code, curLang()) : code.map(d => (G.DEX_BY[d] || {}).name || '#' + d);
      box.innerHTML = '<small class="sub">Código de la sala</small><div class="code-chips" translate="no"></div>';
      const chips = box.querySelector('.code-chips');
      code.forEach((dex, i) => {
        const c = document.createElement('div');
        c.className = 'code-chip';
        c.appendChild(G.UI.spriteCanvas(dex, 44, 40, { scale: 1 }));
        c.insertAdjacentHTML('beforeend', `<span>${esc(names[i] || '')}</span>`);
        chips.appendChild(c);
      });
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.textContent = 'Copiar código';
      // Se copia en inglés (pikachu-onix-mew-eevee): así sirve en cualquier idioma.
      b.onclick = async () => {
        const ok = await copyText(rc && rc.format ? rc.format(code, 'en') : names.join('-'));
        G.UI.toast(ok ? 'Código copiado' : 'No se pudo copiar el código.');
        G.Audio.sfx(ok ? 'confirm' : 'error');
      };
      box.appendChild(b);
    }

    /*
     * Si un invitado está en tu misma wifi (lo dice el servidor: sameNet) pero juega
     * por el servidor (la conexión directa no abrió), el anfitrión puede poner su IP
     * local (G.Social.setLocal) y los de esa wifi vuelven a ir directos.
     * Sólo se rehace si cambia (si no, se borraría lo que estás escribiendo).
     */
    function renderLocal(room, ms) {
      const g = room.isHost && G.Social.setLocal
        ? ms.find(m => m.uid !== room.host && m.sameNet && pathBadge(m, room).kind === 'server') : null;
      const box = $('lobby-hint');
      const key = g ? 'local|' + g.name + '|' + (room.lanIp || '') : '';
      if (key === hintKey) return;
      hintKey = key;
      box.classList.toggle('hidden', !g);
      if (!g) { box.innerHTML = ''; return; }
      box.innerHTML = `<span>Estás en la misma wifi que ${esc(g.name)}. Usa el modo local para conectar directo.</span>` +
        `<form class="row" autocomplete="off"><input class="field" maxlength="15" inputmode="decimal" spellcheck="false" aria-label="Tu IP local" placeholder="Tu IP local">` +
        `<button class="btn small gold" type="submit">${room.lanIp ? 'Cambiar IP' : 'Conectar en local'}</button></form>` +
        `<button type="button" class="lan-link">¿Dónde la veo?</button><div class="lan-help hidden">${LAN_HELP}</div>` +
        `<p class="err"></p>`;
      box.querySelector('.lan-link').onclick = () => box.querySelector('.lan-help').classList.toggle('hidden');
      const input = box.querySelector('input');
      input.value = room.lanIp || lastIp();
      box.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const r = await G.Social.setLocal(input.value);
        if (!r || !r.ok) { box.querySelector('.err').textContent = errText(r); G.Audio.sfx('error'); return; }
        saveIp(input.value.trim());
        G.Audio.sfx('confirm');
      };
    }

    function start() {
      const room = G.Social.room;
      if (!room || !room.isHost || room.members.length < 2) return;
      const cfg = {
        k: 'start', seed: Math.floor(Math.random() * 1e6), host: room.host, hw: G.Halloween.on,   // hw: ¿partida de Halloween?
        members: room.members.map(m => ({ uid: m.uid, name: m.name, dex: m.dex, shiny: !!m.shiny }))
      };
      G.Social.setOpen(false);
      G.Net.broadcast(cfg);
      G.Flow.startCoop(cfg);
    }

    return { init, open, close, render };
  })();

  // ======================= INVITACIONES =======================

  G.InvitePop = (() => {
    let cur = null;

    function init() {
      $('inv-yes').onclick = async () => {
        if (!cur) return;
        const from = cur.from;
        hide();
        const r = await G.Social.acceptInvite(from);
        if (!r.ok) { G.UI.toast(errText(r), 3000); return; }
        G.LobbyUI.open();
      };
      $('inv-no').onclick = () => { if (cur) G.Social.declineInvite(cur.from); hide(); };
      G.Social.on(what => { if (what === 'invites' || what === 'room') refresh(); });
    }

    function hide() { cur = null; $('invite-pop').classList.add('hidden'); }

    /** Enseña la invitación más antigua si estás en los menús (no en plena partida). */
    function refresh() {
      const room = G.Social.room;
      const list = G.Social.invites.filter(i => !room || i.room !== room.id).sort((a, b) => a.at - b.at);
      if (!list.length || G.Game.state !== 'ui' || !G.DB.loggedIn) { hide(); return; }
      if (cur && cur.from === list[0].from) return;
      cur = list[0];
      $('inv-text').innerHTML = `${G.Icons.html('friends', 22)} <b class="gold" translate="no">${esc(cur.name)}</b> te invita a jugar en su sala`;
      $('invite-pop').classList.remove('hidden');
      G.Audio.sfx('shiny');
    }

    return { init, refresh };
  })();

  G.SocialUI = {
    init() { G.NickUI.init(); G.FriendsUI.init(); G.LobbyUI.init(); G.InvitePop.init(); },
    withNick, needOnline,
    relayError, pathBadge, fillCode   // (también para tests/lobby-ui.test.cjs)
  };
})();
