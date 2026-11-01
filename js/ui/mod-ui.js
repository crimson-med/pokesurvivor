/* ============ mod-ui.js: moderación del ranking (pantalla oculta) ============
 * Sólo la ven los correos de ADMIN_EMAILS del servidor (G.Ranking.isAdmin, que
 * mira G.DB.me.admin; aunque alguien abriera esta pantalla, /api/admin/* no le
 * dejaría hacer nada). Se abre con el botón "Moderación" del ranking.
 *
 *   Reportes          marcas reportadas por los jugadores, las más reportadas
 *                     primero: borrar la marca, banear (no puede volver a
 *                     salir en el ranking, y se borran sus marcas de todas las
 *                     tablas de ahora) o descartar el reporte.
 *   Baneados          las cuentas baneadas del ranking; se pueden desbanear.
 * Textos sólo en español (es una pantalla de moderación).
 */
G.ModUI = (() => {
  const $ = G.UI.$;
  const esc = G.U.esc;
  let tab = 'rep';

  function init() {
    $('mod-back').onclick = () => G.RankingUI.open();
    $('mod-purge').onclick = async () => {
      if (!confirm('¿Quitar del ranking TODAS las marcas de más de 1 hora (todas las tablas)? No se puede deshacer.')) return;
      const b = $('mod-purge');
      b.disabled = true;
      try {
        b.textContent = 'Quitando…';
        const r = await G.Ranking.purgeAbove(3600);
        G.UI.toast('Quitadas ' + r.rows + ' marcas de más de 1 hora (' + r.boards + ' tablas)', 5000);
      } catch (e) { G.UI.toast('No se pudo: ' + (e.code || e.message), 5000); }
      b.disabled = false; b.textContent = 'Quitar marcas de más de 1 hora';
      render();
    };
    document.querySelectorAll('#mod-tabs .tab').forEach(t => { t.onclick = () => { tab = t.dataset.tab; render(); }; });
  }

  function open() {
    if (!G.Ranking.isAdmin()) return;
    G.UI.show('scr-mod', true);
    render();
  }

  const fmt = t => G.U.mmss(t || 0);
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn small ' + cls; b.textContent = label; b.onclick = fn; return b; };

  async function render() {
    document.querySelectorAll('#mod-tabs .tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
    const list = $('mod-list');
    list.innerHTML = '<p class="sub">Cargando…</p>';
    try {
      if (tab === 'rep') await renderReports(list);
      else await renderMarked(list);
    } catch (e) {
      list.innerHTML = '<p class="sub">No se pudo cargar (' + esc(e.code || e.message) + ').</p>';
    }
  }

  /** "s_w2026-42" -> "Solo · Semana" */
  function boardName(b) {
    const [m, p] = b.split('_');
    const mode = m === 'g' ? 'Grupo' : 'Solo';
    const per = p.startsWith('d') ? 'Hoy' : p.startsWith('w') ? 'Semana' : p.startsWith('m') ? 'Mes' : 'Histórico';
    const dex = (b.match(/_p(\d+)$/) || [])[1];
    return mode + ' · ' + per + (dex && G.DEX_BY[dex] ? ' · sólo ' + G.DEX_BY[dex].name : '');
  }
  // Con la Sentencia de Arceus (minuto 30) casi nadie pasa de ~32-33 min.
  const SUSPECT_T = 33 * 60;

  async function renderReports(list) {
    const groups = await G.Ranking.reports();
    list.innerHTML = groups.length ? '' : '<p class="sub">No hay reportes.</p>';
    for (const g of groups) {
      const row = document.createElement('div');
      row.className = 'rk-row mod-row rep';
      const mode = g.board.startsWith('g_') ? 'g' : 's';
      // Lo que se ve de la marca ahora en su tabla (nivel, derrotados, Pokémon); null si ya no está.
      const info = g.info;
      const t = info ? info.t : 0;
      const sus = t > SUSPECT_T;
      const mons = document.createElement('span');
      mons.className = 'mons';
      if (info) info.dex.forEach((d, i) => { if (G.DEX_BY[d]) mons.appendChild(G.UI.spriteCanvas(d, 44, 40, { scale: 1, shiny: !!(info.shiny || [])[i] })); });
      row.innerHTML = `<span class="pos" title="veces reportada">${g.n}×</span>`;
      row.appendChild(mons);
      const names = info ? info.names : [g.e];
      row.insertAdjacentHTML('beforeend', `<span class="who"><b translate="no">${names.map(esc).join(' · ')}</b>
          <small>${esc(boardName(g.board))}${info ? ' · Nv. ' + (info.lv || 1) + ' · ' + (info.kills || 0).toLocaleString(G.I18n.locale) + ' derrotados' : ' · ya no está en la tabla'}</small>
          ${g.why.length ? '<small>' + g.why.map(esc).join(' · ') + '</small>' : ''}
          ${sus ? '<small class="mod-warn">Más de 33 min: casi imposible con la Sentencia de Arceus</small>' : ''}</span>
        <span class="time${sus ? ' mod-warn' : ''}">${fmt(t)}</span>`);
      const acts = document.createElement('span');
      acts.className = 'mod-acts';
      const busy = async (fn, msg) => {
        acts.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try { await fn(); G.UI.toast(msg); row.remove(); }
        catch (e) { G.UI.toast('No se pudo: ' + (e.code || e.message)); acts.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
      };
      acts.append(
        btn('Borrar marca', 'ghost', () => busy(() => G.Ranking.removeEntry(g.board, g.e), 'Marca borrada')),
        btn('Banear', 'danger', () => {
          // (Los uid salen de la marca: el id de grupo los une con "_", que también puede ir dentro de un uid.)
          const uids = info ? info.uids : mode === 's' ? [g.e] : [];
          if (!uids.length) { G.UI.toast('La marca ya no está: no se sabe a quién banear'); return; }
          if (!confirm('¿Banear a ' + names.join(', ') + '? No podrán volver a salir en el ranking y se borran sus marcas.')) return;
          busy(async () => {
            await G.Ranking.ban(uids);
            await G.Ranking.removeEntry(g.board, g.e);
          }, 'Baneado');
        }),
        btn('Descartar', 'ghost', () => busy(() => G.Ranking.dismiss(g.board, g.e), 'Reporte descartado'))
      );
      row.appendChild(acts);
      list.appendChild(row);
    }
  }

  async function renderMarked(list) {
    const accs = await G.Ranking.bannedAccounts();
    list.innerHTML = accs.length ? '' : '<p class="sub">No hay cuentas baneadas.</p>';
    for (const a of accs) {
      const row = document.createElement('div');
      row.className = 'rk-row mod-row';
      row.innerHTML = `<span class="pos"></span>
        <span class="who"><b translate="no">${esc(a.name)}</b><small translate="no">${esc(G.I18n.f('{x} monedas · {x} tickets · {x} ×10 · {x} Pokémon', a.coins.toLocaleString(G.I18n.locale), a.t1, a.t10, a.owned))} · ${esc(a.uid)}</small></span>`;
      const acts = document.createElement('span');
      acts.className = 'mod-acts';
      acts.append(btn('Desbanear', 'ghost', async () => {
        try { await G.Ranking.unban(a.uid); G.UI.toast('Desbaneada'); row.remove(); }
        catch (e) { G.UI.toast('No se pudo: ' + (e.code || e.message)); }
      }));
      row.appendChild(acts);
      list.appendChild(row);
    }
  }

  return { init, open };
})();
