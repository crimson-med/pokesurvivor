/* ============ login.js: inicio, entrar con un código por correo o como invitado ============
 * Con el servidor del juego (G.DB.mode 'cloud', docs/relay-coop/04-auth.md):
 *   1. el correo y "Enviar código" (G.DB.sendCode)
 *   2. el código de 6 cifras en 6 casillas (pegarlo o el autocompletado del
 *      móvil las llena todas; G.DB.verifyCode), "Reenviar código" a los 30 s
 *      y "Usar otro correo"
 *   o "Jugar como invitado" (una cuenta sin correo, G.DB.playAsGuest).
 * Desde Ajustes, un invitado "añade un correo" con la misma pantalla
 * (open({ add: true })): sin el botón de invitado y con "Volver".
 * Abierto desde un archivo (modo local): nombre y contraseña de este navegador.
 */
G.LoginUI = (() => {
  const $ = G.UI.$;
  const RESEND_S = 30;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // Lo que dice cada error del servidor (G.Api: .code).
  const ERR = {
    invalid: 'Escribe un correo válido.',
    'bad-code': 'Ese código no es correcto. Revísalo y vuelve a probar.',
    expired: 'El código ha caducado. Pide otro.',
    'too-many': 'Demasiados intentos con este código. Pide otro.',
    rate: 'Demasiados intentos seguidos. Espera un poco.',
    mail: 'No se pudo mandar el correo. Vuelve a probar en un minuto.',
    offline: 'Sin conexión a internet.'
  };
  const errText = code => ERR[code] || 'Algo ha fallado. Vuelve a probar en un momento.';
  let mode = 'login';          // modo local: 'login' | 'register'
  let email = '';              // al que se ha mandado el código
  let resendT = 0, resendAt = 0;
  let busy = false;

  const boxes = () => [...document.querySelectorAll('#otp input')];
  const err = t => { $('login-err').textContent = t || ''; };

  function init() {
    // ---------- paso 1: el correo ----------
    $('login-email').onsubmit = async e => {
      e.preventDefault();
      if (busy) return;
      err('');
      const v = $('f-email').value.trim().toLowerCase();
      if (!EMAIL_RE.test(v) || v.length > 254) { err(errText('invalid')); $('f-email').focus(); return; }
      busy = true; $('btn-send').disabled = true;
      const r = await G.DB.sendCode(v);
      busy = false; $('btn-send').disabled = false;
      if (!r.ok) { err(errText(r.code)); return; }
      email = v;
      showCode();
    };

    // ---------- paso 2: el código ----------
    boxes().forEach((b, i, all) => {
      b.oninput = () => {
        let d = b.value.replace(/\D/g, '');
        // Varias cifras de golpe (el autocompletado del móvil, pegar): se reparten.
        if (d.length > 2) { fill(d, d.length >= 6 ? 0 : i); return; }
        if (d.length === 2) d = d.slice(-1);        // escribió encima de la que había
        b.value = d;
        if (d && i < all.length - 1) all[i + 1].focus();
        if (code().length === 6) $('login-code').requestSubmit();
      };
      b.onkeydown = e => {
        if (e.key === 'Backspace' && !b.value && i > 0) { all[i - 1].value = ''; all[i - 1].focus(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft' && i > 0) { all[i - 1].focus(); e.preventDefault(); }
        else if (e.key === 'ArrowRight' && i < all.length - 1) { all[i + 1].focus(); e.preventDefault(); }
      };
      b.onfocus = () => b.select();
      b.onpaste = e => {
        const t = ((e.clipboardData || window.clipboardData) || { getData: () => '' }).getData('text');
        const d = String(t || '').replace(/\D/g, '');
        if (!d) return;
        e.preventDefault();
        fill(d, d.length >= 6 ? 0 : i);
      };
    });
    $('login-code').onsubmit = async e => {
      e.preventDefault();
      if (busy) return;
      err('');
      const c = code();
      if (c.length !== 6) { err('Escribe las 6 cifras del código.'); focusFirstEmpty(); return; }
      busy = true; $('btn-verify').disabled = true;
      const r = await G.DB.verifyCode(email, c);
      busy = false; $('btn-verify').disabled = false;
      if (!r.ok) {
        err(errText(r.code));
        if (r.code === 'bad-code') { clearBoxes(); boxes()[0].focus(); }
        // Caducado o quemado: se puede pedir otro ya.
        if (r.code === 'expired' || r.code === 'too-many') { stopResend(); resendAt = 0; $('btn-resend').disabled = false; $('btn-resend').textContent = 'Reenviar código'; }
        return;
      }
      clearBoxes();
      stopResend();
      if (r.merged) G.UI.toast('Tu progreso de invitado se ha añadido a esta cuenta.', 4500);
      G.Flow.afterLogin();
    };
    $('btn-resend').onclick = async () => {
      if (busy || Date.now() < resendAt) return;
      err('');
      busy = true; $('btn-resend').disabled = true;
      const r = await G.DB.sendCode(email);
      busy = false;
      if (!r.ok) { err(errText(r.code)); startResend(); return; }
      clearBoxes(); boxes()[0].focus();
      G.UI.toast('Te hemos mandado otro código.', 3000);
      startResend();
    };
    $('btn-other').onclick = () => { err(''); showEmail(); };

    // ---------- invitado y volver ----------
    $('btn-guest').onclick = async () => {
      if (busy) return;
      err('');
      busy = true; $('btn-guest').disabled = true;
      const r = await G.DB.playAsGuest();
      busy = false; $('btn-guest').disabled = false;
      if (!r.ok) { err(errText(r.code)); return; }
      G.Flow.afterLogin();
    };
    $('btn-login-back').onclick = () => { stopResend(); G.Flow.goMenu(); };

    // ---------- modo local: nombre y contraseña de este navegador ----------
    document.querySelectorAll('#login-local .tab').forEach(t => {
      t.onclick = () => setMode(t.dataset.tab);
    });
    $('login-form').onsubmit = async e => {
      e.preventDefault();
      err('');
      $('btn-auth').disabled = true;
      const fn = mode === 'login' ? G.DB.login : G.DB.register;
      const r = await fn($('f-user').value, $('f-pass').value);
      $('btn-auth').disabled = false;
      if (!r.ok) { err(r.error); return; }
      $('f-pass').value = '';
      G.Flow.afterLogin();
    };
  }

  const code = () => boxes().map(b => b.value).join('');
  function fill(digits, from) {
    const all = boxes();
    for (let k = 0; k < digits.length && from + k < all.length; k++) all[from + k].value = digits[k];
    focusFirstEmpty();
    if (code().length === 6) $('login-code').requestSubmit();
  }
  function focusFirstEmpty() {
    const all = boxes();
    (all.find(b => !b.value) || all[all.length - 1]).focus();
  }
  function clearBoxes() { boxes().forEach(b => { b.value = ''; }); }

  // "Reenviar código" se puede pulsar a los 30 s (con la cuenta atrás).
  function startResend() {
    stopResend();
    resendAt = Date.now() + RESEND_S * 1000;
    const tick = () => {
      const left = Math.ceil((resendAt - Date.now()) / 1000);
      const b = $('btn-resend');
      if (left <= 0) { b.disabled = false; b.textContent = 'Reenviar código'; resendT = 0; return; }
      b.disabled = true;
      b.textContent = `Reenviar código (${left} s)`;
      resendT = setTimeout(tick, 1000);
    };
    tick();
  }
  function stopResend() { clearTimeout(resendT); resendT = 0; }

  function showEmail() {
    stopResend();
    $('login-code').classList.add('hidden');
    $('login-email').classList.remove('hidden');
    setTimeout(() => $('f-email').focus(), 50);
  }
  function showCode() {
    $('login-email').classList.add('hidden');
    $('login-code').classList.remove('hidden');
    $('code-email').textContent = email;
    clearBoxes();
    startResend();
    setTimeout(() => boxes()[0].focus(), 50);
  }

  /*
   * Avisos de una actualización: cada uno sale una vez por navegador, la
   * primera vez que se entra al menú después de subirla; si hay varios,
   * uno tras otro. Para uno nuevo, se añade aquí con su propia clave.
   */
  // (Con la partida sólo en este navegador, syncState 'local', no: hablan de la nube. paso 3.)
  const cloud = () => G.DB.mode === 'cloud' && !G.DB.guest && G.DB.syncState !== 'local';
  const NOTES = [
    { key: 'ps.savenote.1', when: cloud,              // botón Guardar (18-10-2026)
      title: ['Importante: guarda tu partida', 'Important: save your game'],
      body: ['<p>Debido a problemas con el guardado, a partir de ahora la partida se guarda en la nube automáticamente <b>cada 10 minutos</b>.</p>' +
             '<p>Hemos incorporado un botón <b class="gold">Guardar</b> arriba a la derecha. Úsalo antes de cerrar el juego o de cambiar de aparato: <b>es muy importante para no perder tu partida</b>.</p>',
             '<p>Because of problems with saving, from now on your game is saved to the cloud automatically <b>every 10 minutes</b>.</p>' +
             '<p>We have added a <b class="gold">Save</b> button at the top right. Use it before closing the game or switching devices: <b>it is very important so you don’t lose your progress</b>.</p>'] },
    { key: 'ps.ranknote.1', when: () => cloud() && ((G.DB.save.stats || {}).runs || 0) > 0,   // rankings desde cero (18-10-2026)
      title: ['Los rankings se han reiniciado', 'The leaderboards have been reset'],
      body: ['<p>Hemos ajustado la <b>Sentencia de Arceus</b>: huir corriendo con toda la velocidad subida y el veneno ya no sirven para aguantar para siempre.</p>' +
             '<p>Para que todos compitáis en igualdad, <b>todos los rankings empiezan de cero</b> (hoy, semana, mes, año e histórico). ¡A por el primer puesto!</p>',
             '<p>We have adjusted the <b>Judgment of Arceus</b>: running away with maxed-out speed and poison no longer let you last forever.</p>' +
             '<p>So everyone competes on equal terms, <b>all leaderboards start from scratch</b> (daily, weekly, monthly, yearly and all-time). Go for first place!</p>'] }
  ];
  /** → true si se ha enseñado alguno. */
  function updateNotices() {
    const queue = NOTES.filter(n => { try { return n.when() && !localStorage.getItem(n.key); } catch (e) { return false; } });
    if (!queue.length) return false;
    const en = G.I18n.lang === 'en' ? 1 : 0;
    const next = () => {
      const n = queue.shift();
      if (!n) { $('scr-savenote').classList.add('hidden'); return; }
      try { localStorage.setItem(n.key, '1'); } catch (e) { /* nada */ }
      $('savenote-title').textContent = n.title[en];
      // Otros idiomas: el aviso entero va traducido en su diccionario (por trozos sale raro); si falta, en inglés.
      const other = G.I18n.lang !== 'es' && !en, body = $('savenote-body');
      if (other) body.setAttribute('translate', 'no');
      body.innerHTML = !other ? n.body[en] : G.I18n.has(n.body[0]) ? G.T(n.body[0]) : n.body[1];
      $('savenote-ok').textContent = en ? 'Got it' : 'Entendido';
    };
    $('savenote-ok').onclick = next;
    next();
    $('scr-savenote').classList.remove('hidden');
    return true;
  }

  /** Explica dónde se guarda la partida según el modo de la base de datos. */
  function modeNote() {
    if (G.DB.mode === 'cloud') return 'Entra con tu correo desde cualquier aparato. Como invitado, tu partida queda en este navegador hasta que añadas un correo.';
    const why = G.DB.localReason === 'file'
      ? 'Abierto desde un archivo: la partida sólo se guarda en este navegador. Para guardar en la nube, juega en la versión publicada.'
      : G.DB.localReason === 'dev'
        ? 'Versión de pruebas: la partida sólo se guarda en este navegador. El juego de verdad está en pokesurvivor.com.'
      : G.DB.localReason === 'config'
        ? 'Nube sin configurar: la partida sólo se guarda en este navegador.'
        : 'No se pudo conectar con la nube: la partida sólo se guarda en este navegador.';
    return why;
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('#login-local .tab').forEach(t => t.classList.toggle('on', t.dataset.tab === m));
    $('btn-auth').textContent = m === 'login' ? 'Entrar' : 'Crear cuenta';
    $('f-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    err('');
  }

  /**
   * Abre la pantalla. opts.add: un invitado que añade su correo (desde
   * Ajustes): sin "Jugar como invitado" y con "Volver" al menú.
   */
  function open(opts = {}) {
    const cloud = G.DB.mode === 'cloud', add = !!opts.add && cloud;
    G.UI.chrome(false);
    G.UI.show('scr-login');
    err(!G.DB.storageOk ? 'Este navegador no deja guardar datos: juega como invitado.' : '');
    $('login-local').classList.toggle('hidden', cloud);
    $('login-code').classList.add('hidden');
    $('login-email').classList.toggle('hidden', !cloud);
    $('btn-guest').classList.toggle('hidden', add);
    $('btn-login-back').classList.toggle('hidden', !add);
    $('login-mode').textContent = add ? 'Tu progreso de invitado se queda en la cuenta del correo que pongas.' : modeNote();
    setTimeout(() => (cloud ? $('f-email') : $('f-user')).focus(), 50);
  }

  return { init, open, updateNotices };
})();
