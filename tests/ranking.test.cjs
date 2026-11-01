// Ranking: js/net/ranking.js de verdad, con un G.Api falso (el servidor, server/http/rank.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'js/net/ranking.js'), 'utf8');
const RF = require('../server/rank-fit.js');

const plain = o => JSON.parse(JSON.stringify(o));

// answer(método, ruta, cuerpo) -> lo que contesta el servidor (o lanza un error con .code).
function env({ me = { uid: 'U1', kind: 'email', name: 'Ash', admin: false }, answer = () => null } = {}) {
  const calls = [], toasts = [], store = new Map();
  const api = m => async (p, b) => { calls.push([m, p, b]); return answer(m, p, b); };
  const G = {
    U: { int: (v, max = 1e12) => (Number.isFinite(+v) && +v > 0 ? Math.min(max, Math.floor(+v)) : 0),
         str: (v, max = 64) => (typeof v === 'string' ? v.slice(0, max) : ''), list: (v, max = 50) => (Array.isArray(v) ? v.slice(0, max) : []) },
    DB: { online: true, me },
    Api: { get: api('GET'), post: api('POST') },
    UI: { toast: s => toasts.push(s) }
  };
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k), key: i => [...store.keys()][i], get length() { return store.size; } };
  const ctx = { G, localStorage, console: { warn() {}, log: console.log }, Intl, Date, Math, JSON, Object, Promise, Number, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { R: G.Ranking, G, calls, toasts, store };
}
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const tick = () => new Promise(r => setTimeout(r, 0));

test('los ids de las tablas y los topes son los del servidor (server/rank-fit.js)', () => {
  const { R } = env();
  const dates = ['2026-11-02T12:00:00Z', '2026-11-01T23:30:00Z', '2026-11-01T22:30:00Z', '2026-07-31T22:30:00Z',
    '2026-03-29T00:30:00Z', '2026-10-25T01:30:00Z', '2026-12-31T23:30:00Z', '2027-01-01T12:00:00Z', '2027-01-04T00:00:00Z', '2020-12-31T12:00:00Z'];
  for (const iso of dates) {
    const d = new Date(iso);
    assert.deepEqual(plain(R.periodIds(d)), RF.periodIds(d), iso);
    assert.deepEqual(plain(R.boardIds(d)), RF.boardIds(d), iso);
    for (const [mode, dexes, t] of [['s', [25], 599], ['g', [25, 25, 7], 600], ['s', [151], 3000]]) {
      assert.deepEqual(plain(R.boardsFor(mode, dexes, t, d)), RF.boardsFor(mode, dexes, t, d), iso);
    }
    for (const p of ['d', 'w', 'm', 'a']) assert.ok(RF.parse(R.board('s', p, null, d)), R.board('s', p, null, d));
    assert.equal(R.board('g', 'a', 25, d), 'g_all4_p25');
    assert.equal(R.board('g', 'w', 25, d), 'g_' + RF.boardIds(d).w, 'el filtro por Pokémon sólo en el histórico');
  }
  for (const r of [{ t: 2400, lv: 9999, kills: 1e9, dmg: 1e12 }, { t: 1700, lv: 3, kills: 10, dmg: 500 }, { t: 0, lv: 0, kills: 0 },
    { t: 1850.7, lv: 40.2, kills: 77.9, dmg: 123456.8 }, { t: 90000, lv: 5, kills: 5, dmg: 5 }]) {
    assert.deepEqual(plain(R.fit(r)), RF.fit(r), JSON.stringify(r));
  }
});

test('solitario: abre la partida al empezar y la termina al acabar; el récord sale de la respuesta', async () => {
  const x = env({ answer: (m, p, b) => {
    if (p === '/api/runs') return { run: 'RUN1' };
    if (p === '/api/runs/RUN1/finish') {
      return { boards: RF.boardsFor('s', [25], b.t).map(([board, period]) => ({ board, period, rank: 3, best: period !== 'a' })) };
    }
    return null;
  } });
  x.R.runStarted({ dex: 25, shiny: true });
  assert.deepEqual(plain(x.calls[0]), ['POST', '/api/runs', { dex: 25, shiny: true }]);
  const better = await x.R.submitSolo({ t: 900.4, lv: 50, kills: 300, dex: 25, shiny: true, dmg: 0 });
  assert.deepEqual(plain(x.calls[1]), ['POST', '/api/runs/RUN1/finish', { t: 900, lv: 50, kills: 300, dmg: 0 }]);
  assert.deepEqual(plain(better), ['d', 'w', 'm']);
  assert.equal(x.toasts.pop(), '¡Nueva mejor marca del mes en el ranking!');

  // La misma marca otra vez: este navegador ya sabe que no mejora nada y no manda nada.
  x.R.runStarted({ dex: 25, shiny: true });
  assert.equal((await x.R.submitSolo({ t: 900, lv: 50, kills: 300, dex: 25, dmg: 0 })).length, 0);
  assert.equal(x.calls.filter(c => c[1].endsWith('/finish')).length, 1);

  // Menos de 2 minutos: nada.
  x.R.runStarted({ dex: 25 });
  await x.R.submitSolo({ t: 119, lv: 5, kills: 5, dex: 25, dmg: 0 });
  assert.equal(x.calls.filter(c => c[1].endsWith('/finish')).length, 1);
});

test('solitario: invitado, servidor caído y partida rechazada', async () => {
  // Invitado: ni se abre la partida; al acabar, el aviso del correo.
  const g = env({ me: { uid: 'G1', kind: 'guest' } });
  g.R.runStarted({ dex: 25 });
  assert.equal(g.calls.length, 0);
  assert.equal((await g.R.submitSolo({ t: 900, lv: 5, kills: 5, dex: 25 })).length, 0);
  assert.deepEqual(g.toasts, ['Añade un correo para salir en el ranking.']);

  // Sin servidor al empezar: se dice al acabar.
  const o = env({ answer: () => fail('offline') });
  o.R.runStarted({ dex: 25 });
  await tick();
  assert.equal((await o.R.submitSolo({ t: 900, lv: 5, kills: 5, dex: 25 })).length, 0);
  assert.match(o.toasts[0], /no se pudo conectar/);

  // Más tiempo que el real (too-long): no entra, sin aviso, y no se apunta como marca.
  const t = env({ answer: (m, p) => (p === '/api/runs' ? { run: 'R2' } : fail('too-long')) });
  t.R.runStarted({ dex: 25 });
  assert.equal((await t.R.submitSolo({ t: 900, lv: 5, kills: 5, dex: 25 })).length, 0);
  assert.equal(t.toasts.length, 0);
  t.R.runStarted({ dex: 25 });
  await t.R.submitSolo({ t: 900, lv: 5, kills: 5, dex: 25 });
  assert.equal(t.calls.filter(c => c[1].endsWith('/finish')).length, 2, 'se vuelve a probar');
});

test('grupo: el anfitrión termina la partida que abrió el start (setCoopRun)', async () => {
  const x = env({ answer: (m, p) => (p.endsWith('/finish') ? { boards: [{ board: 'g_' + RF.boardIds().a, period: 'a', rank: 1, best: true }] } : null) });
  x.R.runStarted(null);
  x.R.setCoopRun('CO1');
  const members = [{ uid: 'U2', name: 'Misty', dex: 7 }, { uid: 'U1', name: 'Ash', dex: 25 }];
  assert.deepEqual(plain(await x.R.submitGroup({ t: 700, lv: 30, kills: 200, dmg: 0, members })), ['a']);
  assert.deepEqual(plain(x.calls), [['POST', '/api/runs/CO1/finish', { t: 700, lv: 30, kills: 200, dmg: 0 }]]);
  assert.ok(JSON.parse(x.store.get('ps.rk.best3.U1'))['g_' + RF.boardIds().a + ':U1_U2'], 'la marca del equipo, con los uid ordenados');
  // Sin partida (el start no la devolvió: el anfitrión solo): nada, sin avisos.
  const n = x.toasts.length;
  assert.equal((await x.R.submitGroup({ t: 800, lv: 30, kills: 200, dmg: 0, members })).length, 0);
  assert.equal(x.toasts.length, n);
  assert.equal(x.calls.length, 1);
});

test('pestañas: top, tu puesto (fuera del top 50 en diario) y daño a Arceus; una sola petición por tabla', async () => {
  const row = (id, t, d = 0) => ({ id, t, d, lv: 10, kills: 50, uids: [id], names: [id], dex: [25], shiny: [false] });
  const x = env({ answer: (m, p) => {
    const [b, q] = p.slice('/api/boards/'.length).split('?');
    if (q.includes('by=d')) return { top: [row('B', 1900, 9e6)], me: { rank: 60, entry: row('U1', 1850, 10) } };
    if (b.includes('_d')) return { top: [row('A', 1500)], me: null };
    return { top: [row('A', 1500), row('U1', 900)], me: { rank: 1234, entry: row('U1', 900) } };
  } });
  const [rows, me, dmg] = await Promise.all([x.R.top('s', 'a', null, false), x.R.myRank('s', 'a', null), x.R.topDmg('s', 'a', false)]);
  assert.deepEqual(rows.map(r => r.id), ['A', 'U1']);
  assert.deepEqual(plain(me), { pos: 1234, t: 900, row: plain(rows[1]) });
  assert.deepEqual(plain(dmg), { rows: [plain(dmg.rows[0])], me: { out: true } });
  assert.equal(dmg.rows[0].d, 9e6);
  assert.equal(x.calls.filter(c => c[1].includes('by=t')).length, 1, 'top y myRank comparten la petición');
  // Diario: sin marca tuya, fuera del top 50.
  assert.deepEqual(plain(await x.R.myRank('s', 'd', null)), { out: true });
  // Sólo amigos.
  await x.R.top('g', 'a', null, true);
  assert.ok(x.calls.some(c => c[1] === '/api/boards/g_all4?by=t&friends=1'));
  // Las tablas de ahora no se guardan: otra vez, otra petición.
  const n = x.calls.length;
  await x.R.top('s', 'a', null, false);
  assert.equal(x.calls.length, n + 1);
});

test('reportar: una vez por marca; moderación con G.DB.me.admin', async () => {
  const x = env();
  const b = x.R.board('s', 'a');
  assert.equal(await x.R.report(b, { id: 'BAD', names: ['Cheat'] }), true);
  await x.R.report(b, { id: 'BAD', names: ['Cheat'] });
  assert.deepEqual(plain(x.calls), [['POST', '/api/reports', { board: b, id: 'BAD', why: '' }]]);
  assert.ok(x.R.reported().has(b + '__BAD'));
  // Sin red: no cuenta como enviado (se puede volver a probar).
  const off = env({ answer: () => fail('offline') });
  assert.equal(await off.R.report(b, { id: 'BAD' }), false);
  assert.equal(off.R.reported().has(b + '__BAD'), false);
  assert.equal(x.R.isAdmin(), false);
  // Un invitado no reporta.
  const g = env({ me: { uid: 'G1', kind: 'guest' } });
  assert.equal(await g.R.report(b, { id: 'BAD' }), false);
  assert.equal(g.calls.length, 0);

  const a = env({ me: { uid: 'M', kind: 'email', admin: true }, answer: (m, p) => (p === '/api/admin/reports'
    ? { reports: [{ board: b, id: 'BAD', n: 3, at: 5, why: ['x'], entry: { id: 'BAD', t: 4000, uids: ['BAD'], names: ['Cheat'], dex: [25] } }] } : null) });
  assert.equal(a.R.isAdmin(), true);
  const reps = await a.R.reports();
  assert.equal(reps[0].e, 'BAD'); assert.equal(reps[0].n, 3); assert.deepEqual(plain(reps[0].info.uids), ['BAD']);
  await a.R.ban(['BAD']); await a.R.removeEntry(b, 'BAD'); await a.R.dismiss(b, 'BAD'); await a.R.unban('BAD'); await a.R.purgeAbove(3600);
  assert.deepEqual(plain(a.calls.slice(1).map(c => [c[1], c[2]])), [
    ['/api/admin/ban', { uids: ['BAD'] }], ['/api/admin/remove', { board: b, id: 'BAD' }], ['/api/admin/dismiss', { board: b, id: 'BAD' }],
    ['/api/admin/unban', { uid: 'BAD' }], ['/api/admin/purge', { over: 3600 }]]);
});

test('ni rastro del servidor de sellos ni de Firestore', () => {
  assert.doesNotMatch(SRC, /ice\.pokesurvivor|seal|firestore|fbx/i);
});
