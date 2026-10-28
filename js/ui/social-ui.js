/* ============ social-ui.js — apodo, amigos, sala e invitaciones ============ */
(() => {
  const $ = G.UI.$;
  const esc = G.U.esc;

  /** ¿Se puede usar lo online? Si no, explica por qué. */
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

  // ======================= AMIGOS =======================

  G.FriendsUI = (() => {
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

      // Misma wifi: crear sala local o entrar por la IP del anfitrión.
      $('fr-tabs').onclick = e => { const t = e.target.closest('.tab'); if (t) tab(t.dataset.tab); };
      $('lan-help-btn').onclick = () => $('lan-help').classList.toggle('hidden');
      $('lan-host').onsubmit = async e => {
        e.preventDefault();
        lanMsg('');
        const ip = $('lan-ip').value.trim();
        const r = await G.Social.setLocal(ip);
        if (!r.ok) { lanMsg(r.error, true); return; }
        saveIp(ip);
        G.LobbyUI.open();
      };
      $('lan-join').onsubmit = async e => {
        e.preventDefault();
        lanMsg('');
        $('lan-found').innerHTML = '';
        const btn = $('lan-join').querySelector('button');
        btn.disabled = true; btn.textContent = 'Buscando…';
        const r = await G.Social.findLocal($('lan-join-ip').value);
        btn.disabled = false; btn.textContent = 'Buscar sala';
        if (!r.ok) { lanMsg(r.error, true); return; }
        G.Audio.sfx('confirm');
        const own = !!(G.Social.room && G.Social.room.id === r.room.id);
        const el = document.createElement('div');
        el.className = 'fr-row';
        el.innerHTML = `<i class="dot on"></i><b translate="no">${esc(r.room.name)}</b><span class="st">En tu wifi · ${r.room.n}/${G.Social.MAX_PLAYERS}</span><span class="grow"></span>`;
        const b = document.createElement('button');
        b.className = 'btn small gold'; b.textContent = own ? 'Ir a la sala' : 'Unirme';
        b.onclick = async () => {
          if (!own) {
            b.disabled = true;
            const j = await G.Social.joinRoom(r.room.id);
            b.disabled = false;
            if (!j.ok) { lanMsg(j.error, true); return; }
          }
          G.LobbyUI.open();
        };
        el.appendChild(b);
        $('lan-found').appendChild(el);
      };
    }

    function tab(t) {
      document.querySelectorAll('#fr-tabs .tab').forEach(x => x.classList.toggle('on', x.dataset.tab === t));
      $('fr-online').classList.toggle('hidden', t !== 'online');
      $('fr-lan').classList.toggle('hidden', t !== 'lan');
      if (t === 'lan' && !$('lan-ip').value) $('lan-ip').value = lastIp();
    }

    function lanMsg(t, bad) {
      $('lan-msg').textContent = t || '';
      $('lan-msg').style.color = bad ? '#ffb0b8' : '';
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
              msg(r.ok ? r.msg : r.error, !r.ok);
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
    let membersKey = '', hintKey = '';

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
      membersKey = ''; hintKey = '';
      render();
    }

    function close() { G.UI.hide('scr-lobby'); }

    function connText(m, room) {
      if (m.uid === room.host) return 'Anfitrión';
      if (!room.isHost) return m.uid === G.Social.uid ? 'Tú' : 'En la sala';
      const mode = G.Net.mode(m.uid);
      return mode === 'direct' ? (G.Net.viaTurn(m.uid) ? 'Conectado (por servidor)' : G.Net.lanIp ? 'Conectado (local)' : 'Conectado') : mode === 'relay' ? 'Conectado (por servidor)' : mode === 'failed' ? 'No se pudo conectar (reintentando…)' : 'Conectando…';
    }

    function render() {
      const room = G.Social.room;
      if (!room) return;
      const ms = room.members;
      $('lobby-sub').textContent = room.isHost
        ? 'Eres el anfitrión. Invita a tus amigos (hasta ' + G.Social.MAX_PLAYERS + ') y empezad cuando estéis.'
        : 'Estás en la sala de ' + ((ms.find(m => m.uid === room.host) || {}).name || '…') + '. El anfitrión empezará la partida.';

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
        el.className = 'conn' + (t === 'Conectando…' ? ' wait' : '');
      });

      // Misma wifi: la IP con la que entran los demás, y qué hacer si alguien no conecta.
      const lan = $('lobby-lan');
      lan.classList.toggle('hidden', !(room.isHost && room.lanIp));
      if (room.isHost && room.lanIp) {
        lan.innerHTML = `<small class="sub">Tus amigos en la misma wifi entran con</small><div class="lan-ip" translate="no">${esc(room.lanIp)}</div>`;
      }
      const hint = lanHint(room, ms);
      renderHint(hint);

      // Invitar (sólo el anfitrión y si queda sitio).
      const canInvite = room.isHost && ms.length < G.Social.MAX_PLAYERS;
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
          b.onclick = async () => { const r = await G.Social.invite(f.uid); G.UI.toast(r.ok ? r.msg : r.error); };
          el.appendChild(b);
          inv.appendChild(el);
        }
      }

      const btn = $('lobby-start');
      btn.classList.toggle('hidden', !room.isHost);
      const connecting = ms.some(m => m.uid !== room.host && G.Net.mode(m.uid) === 'connecting');
      const failed = ms.some(m => m.uid !== room.host && G.Net.mode(m.uid) === 'failed');
      btn.disabled = !room.isHost || ms.length < 2 || connecting || failed;
      btn.textContent = 'Empezar partida (' + ms.length + '/' + G.Social.MAX_PLAYERS + ')';
      $('lobby-note').textContent = !room.isHost ? 'Cuando el anfitrión empiece, entraréis todos a la vez.'
        : ms.length < 2 ? 'Necesitas al menos un amigo en la sala.'
        : failed && hint ? ''
        : failed ? 'No se puede conectar con algún amigo: su red (o la tuya) no deja jugar en grupo. Probad con otra wifi o datos móviles; se reintenta solo.'
        : connecting ? 'Conectando con tus amigos…' : 'La partida empieza para todos a la vez.';
    }

    /*
     * Misma wifi (28-10-2026). Si una pareja no conecta y los dos salen a internet
     * por la misma IP pública (mismo router), el aviso de siempre no ayuda: el
     * anfitrión puede escribir su IP local (ver net.js, lanCandidate). Con el modo
     * local ya puesto y aun así sin conectar, la wifi no deja que los aparatos se
     * hablen (o la IP no es la de este aparato).
     * -> null | { kind: 'offer' | 'blocked' | 'ask', name }
     */
    function lanHint(room, ms) {
      if (room.isHost) {
        const f = ms.find(m => m.uid !== room.host && G.Net.mode(m.uid) === 'failed' && (room.lanIp || G.Net.sameNetwork(m.uid)));
        return f ? { kind: room.lanIp ? 'blocked' : 'offer', name: f.name } : null;
      }
      if (G.Net.mode(room.host) !== 'failed' || !G.Net.sameNetwork(room.host)) return null;
      return { kind: 'ask', name: (ms.find(m => m.uid === room.host) || {}).name || '' };
    }

    // Sólo se rehace si cambia (si no, se borraría lo que estás escribiendo).
    function renderHint(h) {
      const box = $('lobby-hint');
      const key = h ? h.kind + '|' + h.name + '|' + (G.Social.room.lanIp || '') : '';
      if (key === hintKey) return;
      hintKey = key;
      box.classList.toggle('hidden', !h);
      if (!h) { box.innerHTML = ''; return; }
      const name = esc(h.name);
      if (h.kind === 'ask') {
        box.innerHTML = `<span>Estás en la misma wifi que ${name}. Pide al anfitrión que active el modo local.</span>`;
        return;
      }
      box.innerHTML = (h.kind === 'offer'
        ? `<span>Estás en la misma wifi que ${name}. Usa el modo local para conectar directo.</span>`
        : `<span>No se llega al aparato de ${name}. Algunas wifis (de invitados o de hotel) no dejan que los aparatos se hablen. Prueba con la zona wifi de un móvil, o revisa que la IP sea la de este aparato.</span>`) +
        `<form class="row" autocomplete="off"><input class="field" maxlength="15" inputmode="decimal" spellcheck="false" aria-label="Tu IP local" placeholder="Tu IP local">` +
        `<button class="btn small gold" type="submit">${h.kind === 'offer' ? 'Conectar en local' : 'Cambiar IP'}</button></form>` +
        `<p class="err"></p>`;
      const input = box.querySelector('input');
      input.value = G.Social.room.lanIp || lastIp();
      box.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const r = await G.Social.setLocal(input.value);
        if (!r.ok) { box.querySelector('.err').textContent = r.error; G.Audio.sfx('error'); return; }
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
        if (!r.ok) { G.UI.toast(r.error, 3000); return; }
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
    withNick, needOnline
  };
})();
