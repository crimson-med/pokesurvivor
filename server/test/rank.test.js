/* ============ rank.test.js: partidas cronometradas, tablas y moderación ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../index');
const { loadConfig } = require('../config');
const store = require('../db');
const R = require('../rank-fit');
const { sessionCookie } = require('./helpers');

const ORIGIN = 'http://localhost:8000';
// El reloj del servidor (sesiones incluidas): el de verdad al empezar, luego se adelanta a mano.
let NOW = Date.now();
const DAY = 86400000;

let s;
test.before(async () => {
  const srv = createServer(loadConfig({ SITE_URL: ORIGIN, ADMIN_EMAILS: 'boss@example.com' }), {
    store: store.open(':memory:', { log: false }),
    now: () => NOW,
    mailer: { async sendCode() {} },
    limits: { api: [100000, 60000] },
  });
  const port = await srv.listen(0, '127.0.0.1');
  s = { srv, url: 'http://127.0.0.1:' + port, rank: srv.deps.rank };
});
test.after(() => s.srv.close());

const rows = (sql, ...a) => s.srv.store.prep(sql).all(...a);

// Un jugador con su sesión: kind 'email' salvo que se diga.
function player(uid, o = {}) {
  const cookie = sessionCookie(s.srv.store, uid, { kind: 'email', name: o.name || uid, ...o });
  async function call(method, p, body) {
    const headers = { 'content-type': 'application/json', 'x-ps': '1', origin: ORIGIN, cookie };
    const r = await fetch(s.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  return { uid, get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b) };
}

const ids = () => R.boardIds(new Date(NOW));
const sb = p => 's_' + ids()[p];

async function solo(pl, mark, wait = mark.t * 1000) {
  const st = await pl.post('/api/runs', { dex: mark.dex || 25, shiny: false });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  NOW += wait;
  return pl.post('/api/runs/' + st.body.run + '/finish', mark);
}

test('ids de las tablas: cada periodo en hora de Madrid, semanas ISO y generación', () => {
  const at = iso => R.boardIds(new Date(iso));
  assert.deepEqual(at('2026-11-02T12:00:00Z'), { d: 'd20261102a', w: 'w2026-45a', m: 'm202611a', y: 'y2026a', a: 'all4' });
  // 23:30 UTC del 1 de noviembre ya es el 2 en Madrid (y otra semana: el 1 es domingo).
  assert.equal(at('2026-11-01T23:30:00Z').d, 'd20261102a');
  assert.equal(at('2026-11-01T23:30:00Z').w, 'w2026-45a');
  assert.equal(at('2026-11-01T22:30:00Z').w, 'w2026-44a');
  // Verano (UTC+2) y fin de mes.
  assert.equal(at('2026-07-31T22:30:00Z').m, 'm202608a');
  // Fin de año: el 1 de enero de 2027 (viernes) es de la semana 53 de 2026; el 4, de la 1 de 2027.
  assert.equal(at('2027-01-01T12:00:00Z').w, 'w2026-53a');
  assert.equal(at('2027-01-04T12:00:00Z').w, 'w2027-01a');
  assert.equal(at('2027-01-01T12:00:00Z').m, 'm202701a');
  // Las tablas de una partida: por Pokémon sólo desde 10 min, una por Pokémon distinto.
  assert.deepEqual(R.boardsFor('g', [25, 25, 7], 599, new Date(NOW)).map(x => x[1]), ['d', 'w', 'm', 'a']);
  assert.deepEqual(R.boardsFor('g', [25, 25, 7], 600, new Date(NOW)).map(x => x[0]).slice(4), ['g_all4_p25', 'g_all4_p7']);
  for (const b of ['s_d20261102a', 'g_w2026-45a', 's_m202611a', 's_all4', 'g_all4_p25']) assert.ok(R.parse(b), b);
  for (const b of ['s_d20261102', 'x_all4', 's_all3', 's_all4_p', "s_all4'--"]) assert.equal(R.parse(b), null, b);
});

test('tablas viejas: diarias de más de 40 días, semanales de 20 semanas, mensuales de 24 meses', () => {
  const t = Date.UTC(2026, 10, 2, 12);   // 2 de noviembre de 2026, semana 45
  assert.equal(R.expired('s_d20260923a', t), false);   // 40 días
  assert.equal(R.expired('s_d20260922a', t), true);
  assert.equal(R.expired('s_w2026-25a', t), false);    // 20 semanas antes de la 45
  assert.equal(R.expired('s_w2026-24a', t), true);
  assert.equal(R.expired('g_m202411a', t), false);
  assert.equal(R.expired('g_m202410a', t), true);
  assert.equal(R.expired('s_all4', t), false);
  assert.equal(R.expired('s_all4_p25', t), false);
});

test('fit: los topes de ranking.js', () => {
  assert.deepEqual(R.fit({ t: 2400, lv: 9999, kills: 1e9, dmg: 1e12 }), { t: 2400, lv: 610, kills: 100 + 2400 * 12, dmg: 601 * 50000 });
  assert.deepEqual(R.fit({ t: 1700, lv: 3, kills: 10, dmg: 500 }), { t: 1700, lv: 3, kills: 10, dmg: 0 });
  assert.deepEqual(R.fit({ t: 'x', lv: -4, kills: -1 }), { t: 1, lv: 1, kills: 0, dmg: 0 });
});

test('solitario: el servidor cronometra; más tiempo que el real, no; una vez por partida', async () => {
  const ash = player('ash');
  const st = await ash.post('/api/runs', { dex: 25, shiny: true });
  assert.equal(st.status, 200);
  assert.match(st.body.run, /^[A-Za-z0-9_-]{22}$/);
  NOW += 5000;
  // 600 s después de 5 s reales: fuera.
  let r = await ash.post('/api/runs/' + st.body.run + '/finish', { t: 600, lv: 5, kills: 10, dmg: 0 });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'too-long');
  // 15 s (5 reales más 10 de margen) sí.
  r = await ash.post('/api/runs/' + st.body.run + '/finish', { t: 15, lv: 2, kills: 4, dmg: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.boards.map(x => x.board), ['d', 'w', 'm', 'a'].map(sb));
  assert.ok(r.body.boards.every(x => x.best && x.rank === 1));
  // Otra vez la misma: no.
  r = await ash.post('/api/runs/' + st.body.run + '/finish', { t: 15, lv: 2, kills: 4, dmg: 0 });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'finished');
  const e = rows('SELECT * FROM entries WHERE board = ? AND id = ?', sb('a'), 'ash')[0];
  assert.equal(e.t, 15);
  assert.deepEqual(JSON.parse(e.team), { uids: ['ash'], names: ['ash'], dex: [25], shiny: [true] });

  // La tabla: el top y tu puesto.
  const bd = await ash.get('/api/boards/' + sb('w'));
  assert.equal(bd.status, 200);
  assert.equal(bd.body.top[0].id, 'ash');
  assert.deepEqual(bd.body.me, { rank: 1, entry: bd.body.top[0] });
});

test('solitario: invitados (needs-email), partida ajena, inexistente y caducada', async () => {
  const guest = player('guesty', { kind: 'guest' });
  assert.equal((await guest.post('/api/runs', { dex: 25 })).body.error, 'needs-email');
  assert.equal((await guest.get('/api/boards/' + sb('a'))).status, 200, 'los invitados ven las tablas');
  assert.equal((await guest.post('/api/reports', { board: sb('a'), id: 'ash' })).body.error, 'needs-email');

  const brock = player('brock'), misty = player('misty');
  const st = await brock.post('/api/runs', { dex: 74 });
  NOW += 1000;
  assert.equal((await misty.post('/api/runs/' + st.body.run + '/finish', { t: 1 })).body.error, 'not-yours');
  assert.equal((await brock.post('/api/runs/' + 'x'.repeat(22) + '/finish', { t: 1 })).status, 404);
  assert.equal((await brock.post('/api/runs/' + st.body.run + '/finish', { t: -1 })).body.error, 'invalid');
  NOW += 3 * 3600 * 1000;
  const r = await brock.post('/api/runs/' + st.body.run + '/finish', { t: 30 });
  assert.equal(r.status, 410); assert.equal(r.body.error, 'expired');
  assert.equal((await brock.post('/api/runs', { dex: 'x' })).body.error, 'invalid');
});

test('marca: lo mejor de cada cosa; por Pokémon desde 10 min y sin daño; topes de fit', async () => {
  const gary = player('gary');
  let r = await solo(gary, { t: 2400, lv: 9999, kills: 1e9, dmg: 5e6, dex: 133 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.boards.map(x => x.board).slice(4), ['s_all4_p133']);
  const a = rows('SELECT * FROM entries WHERE board = ? AND id = ?', sb('a'), 'gary')[0];
  assert.equal(a.lv, 610); assert.equal(a.kills, 100 + 2400 * 12); assert.equal(a.dmg, 5e6);
  assert.equal(rows('SELECT dmg FROM entries WHERE board = ?', 's_all4_p133')[0].dmg, 0);
  // Peor tiempo pero más daño: se queda el tiempo (con su nivel y derrotados) y sube el daño.
  r = await solo(gary, { t: 2000, lv: 30, kills: 50, dmg: 9e6, dex: 133 });
  const b = rows('SELECT * FROM entries WHERE board = ? AND id = ?', sb('a'), 'gary')[0];
  assert.deepEqual([b.t, b.lv, b.kills, b.dmg], [2400, 610, 100 + 2400 * 12, 9e6]);
  assert.ok(r.body.boards.find(x => x.board === sb('a')).best);
  assert.equal(r.body.boards.find(x => x.board === 's_all4_p133').best, false);
  // Nada mejor: best false en todas.
  r = await solo(gary, { t: 100, lv: 3, kills: 3, dmg: 0, dex: 133 });
  assert.ok(r.body.boards.every(x => !x.best));
  // El top de daño.
  const d = await gary.get('/api/boards/' + sb('a') + '?by=d');
  assert.equal(d.body.top[0].id, 'gary'); assert.equal(d.body.top[0].d, 9e6);
  assert.equal(d.body.me.rank, 1);
  assert.deepEqual((await gary.get('/api/boards/s_all4_p133?by=d')).body, { top: [], me: null });
  assert.equal((await gary.get('/api/boards/nope')).status, 400);
});

test('top 50: diario, semanal y mensual sólo guardan el top 50; el histórico, a todos (tu puesto)', async () => {
  NOW += 8 * DAY;                                     // otra semana: tablas vacías
  const users = [];
  for (let i = 0; i < 55; i++) {
    const uid = 'p' + String(i).padStart(2, '0');
    s.srv.store.prep("INSERT INTO users (uid, kind, email, name, created, seen) VALUES (?, 'email', ?, ?, ?, ?)")
      .run(uid, uid + '@example.com', uid, NOW, NOW);
    users.push(uid);
  }
  const runs = users.map(uid => s.rank.openSoloRun(uid, 25, false));
  NOW += 300 * 1000;
  for (const [i, uid] of users.entries()) s.rank.finish(runs[i], uid, { t: 200 + i, lv: 5, kills: 5, dmg: 0 });
  const count = b => rows('SELECT COUNT(*) AS n FROM entries WHERE board = ?', b)[0].n;
  assert.equal(count(sb('d')), 50);
  assert.equal(count(sb('w')), 50);
  assert.equal(count(sb('m')), 50);
  assert.ok(count(sb('a')) >= 55);
  assert.equal(count('s_all4_p25') <= 50, true, 'por Pokémon, también sólo el top 50');
  assert.equal(rows('SELECT 1 FROM entries WHERE board = ? AND id = ?', sb('w'), 'p00').length, 0, 'el peor, fuera');
  const low = player('p00');
  const w = await low.get('/api/boards/' + sb('w'));
  assert.equal(w.body.top.length, 50); assert.equal(w.body.me, null);
  const a = await low.get('/api/boards/' + sb('a'));
  assert.equal(a.body.top.length, 50);
  const above = rows('SELECT COUNT(*) AS n FROM entries WHERE board = ? AND t > 200', sb('a'))[0].n;
  assert.ok(above >= 54);
  assert.equal(a.body.me.rank, above + 1, 'tu puesto exacto, fuera del top 50');
  // Sólo amigos: tú y ellos, también fuera del top 50 del histórico.
  s.srv.store.prep("INSERT INTO friendships (a, b, from_uid, status, at) VALUES ('p00', 'p01', 'p00', 'ok', 0)").run();
  const f = await low.get('/api/boards/' + sb('a') + '?friends=1');
  assert.deepEqual(f.body.top.map(x => x.id), ['p01', 'p00']);
});

test('grupo: openCoopRun con los de la sala; sólo el anfitrión termina; uno sin correo, fuera', async () => {
  NOW += 8 * DAY;
  const host = player('zed'), mate = player('amy');
  const room = { host: 'zed', members: new Map([
    ['zed', { uid: 'zed', name: 'Zed', dex: 6, shiny: false }],
    ['amy', { uid: 'amy', name: 'Amy', dex: 9, shiny: true }],
  ]) };
  assert.equal(s.rank.openCoopRun({ host: 'zed', members: [{ uid: 'zed', dex: 6 }] }), null, 'solo en la sala: sin partida');
  const run = s.rank.openCoopRun(room);
  const row = rows('SELECT * FROM runs WHERE run = ?', run)[0];
  assert.equal(row.mode, 'g');
  assert.deepEqual(JSON.parse(row.uids), ['amy', 'zed']);
  assert.deepEqual(JSON.parse(row.team), { host: 'zed', names: ['Amy', 'Zed'], dex: [9, 6], shiny: [true, false] });
  NOW += 700 * 1000;
  assert.equal((await mate.post('/api/runs/' + run + '/finish', { t: 650 })).body.error, 'not-yours');
  const r = await host.post('/api/runs/' + run + '/finish', { t: 650, lv: 40, kills: 900, dmg: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 'amy_zed');
  assert.deepEqual(r.body.boards.map(x => x.board), [...['d', 'w', 'm', 'a'].map(p => 'g_' + ids()[p]), 'g_all4_p9', 'g_all4_p6']);
  const g = await mate.get('/api/boards/g_' + ids().a);
  assert.equal(g.body.top[0].id, 'amy_zed');
  assert.deepEqual(g.body.top[0].names, ['amy', 'zed']);
  assert.equal(g.body.me.rank, 1);
  // Con un invitado en el equipo: termina, sin tablas.
  player('gus', { kind: 'guest' });
  const run2 = s.rank.openCoopRun({ host: 'zed', members: [{ uid: 'zed', dex: 6 }, { uid: 'gus', dex: 1 }] });
  NOW += 200 * 1000;
  const r2 = await host.post('/api/runs/' + run2 + '/finish', { t: 150 });
  assert.deepEqual(r2.body, { boards: [], skipped: 'needs-email' });
});

test('moderación: sólo admins; reportar, quitar, banear, desbanear, descartar y purgar', async () => {
  NOW += 8 * DAY;
  const boss = player('boss', { email: 'boss@example.com' });
  const cheat = player('cheat'), fan = player('fan');
  await solo(cheat, { t: 3000, lv: 5, kills: 5, dmg: 0 });
  await solo(fan, { t: 500, lv: 5, kills: 5, dmg: 0 });

  // Los demás, fuera.
  for (const [m, p] of [['get', '/api/admin/reports'], ['post', '/api/admin/remove'], ['post', '/api/admin/ban'],
    ['post', '/api/admin/unban'], ['get', '/api/admin/bans'], ['post', '/api/admin/dismiss'], ['post', '/api/admin/purge']]) {
    const r = await fan[m](p, {});
    assert.equal(r.status, 403, p); assert.equal(r.body.error, 'not-admin', p);
  }
  assert.equal((await player('g2', { kind: 'guest' }).get('/api/admin/reports')).status, 403);

  // Reportes: de una marca que existe; dos veces la misma persona cuenta una.
  assert.equal((await fan.post('/api/reports', { board: sb('a'), id: 'nobody' })).status, 404);
  assert.equal((await fan.post('/api/reports', { board: 'bad', id: 'cheat' })).status, 400);
  assert.equal((await fan.post('/api/reports', { board: sb('a'), id: 'cheat', why: 'muy largo' })).status, 204);
  assert.equal((await fan.post('/api/reports', { board: sb('a'), id: 'cheat' })).status, 204);
  assert.equal((await boss.post('/api/reports', { board: sb('w'), id: 'cheat' })).status, 204);
  let list = (await boss.get('/api/admin/reports')).body.reports;
  assert.equal(list.length, 2);
  const rep = list.find(x => x.board === sb('a'));
  assert.equal(rep.n, 1); assert.deepEqual(rep.why, ['muy largo']); assert.equal(rep.entry.id, 'cheat');

  // Quitar: de esa tabla y de las de ahora del mismo modo (por Pokémon también), y sus reportes.
  let r = await boss.post('/api/admin/remove', { board: sb('a'), id: 'cheat' });
  assert.equal(r.body.removed, 5);
  assert.equal(rows("SELECT 1 FROM entries WHERE id = 'cheat'").length, 0);
  assert.equal((await boss.get('/api/admin/reports')).body.reports.length, 0);
  // Descartar: los reportes se van y la marca se queda.
  assert.equal((await boss.post('/api/reports', { board: sb('w'), id: 'fan' })).status, 204);
  assert.equal((await boss.post('/api/admin/dismiss', { board: sb('w'), id: 'fan' })).status, 204);
  assert.equal((await boss.get('/api/admin/reports')).body.reports.length, 0);
  assert.equal(rows('SELECT 1 FROM entries WHERE board = ? AND id = ?', sb('w'), 'fan').length, 1);

  // Banear: users.banned, el correo en bans y fuera sus marcas; sus partidas ya no entran.
  await solo(cheat, { t: 900, lv: 5, kills: 5, dmg: 0 });
  r = await boss.post('/api/admin/ban', { uids: ['cheat'] });
  assert.equal(r.body.removed, 5);
  assert.equal(rows("SELECT banned FROM users WHERE uid = 'cheat'")[0].banned, 1);
  assert.equal(rows('SELECT * FROM bans').length, 1);
  assert.equal(rows("SELECT 1 FROM entries WHERE id = 'cheat'").length, 0);
  r = await solo(cheat, { t: 900, lv: 5, kills: 5, dmg: 0 });
  assert.deepEqual(r.body, { boards: [] });
  assert.deepEqual((await boss.get('/api/admin/bans')).body.bans.map(x => x.uid), ['cheat']);
  assert.equal((await boss.post('/api/admin/ban', { uids: [] })).status, 400);
  // Desbanear.
  assert.equal((await boss.post('/api/admin/unban', { uid: 'cheat' })).status, 204);
  assert.equal(rows('SELECT * FROM bans').length, 0);
  r = await solo(cheat, { t: 900, lv: 5, kills: 5, dmg: 0 });
  assert.ok(r.body.boards.length);

  // Purgar: todas las marcas de más de N segundos.
  r = await boss.post('/api/admin/purge', { over: 800 });
  assert.ok(r.body.rows >= 4 && r.body.boards >= 4);
  assert.equal(rows('SELECT 1 FROM entries WHERE t > 800').length, 0);
  assert.ok(rows("SELECT 1 FROM entries WHERE id = 'fan'").length);
  assert.equal((await boss.post('/api/admin/purge', { over: 5 })).status, 400);
});

test('limpieza de cada noche: fuera las tablas de periodos viejos y las partidas de más de un día', () => {
  const ins = b => s.srv.store.prep(`INSERT INTO entries (board, id, team, t, lv, kills, dmg, t_at) VALUES (?, 'x', '{}', 1, 1, 0, 0, 0)`).run(b);
  for (const b of ['s_d20250101a', 'g_w2024-01a', 's_m202301a', 's_d' + ids().d.slice(1)]) ins(b);
  s.srv.store.prep("INSERT INTO runs (run, mode, uids, team, t0) VALUES ('oldrun', 's', '[]', '{}', ?)").run(NOW - 2 * 86400000);
  // Y las marcas de una cuenta borrada.
  s.srv.store.prep(`INSERT INTO entries (board, id, team, t, lv, kills, dmg, t_at) VALUES ('s_all4', 'ghost', '{"uids":["ghost"]}', 1, 1, 0, 0, 0)`).run();
  assert.equal(s.rank.cleanup(), 3);
  assert.equal(rows("SELECT 1 FROM entries WHERE id = 'ghost'").length, 0);
  assert.ok(rows("SELECT 1 FROM entries WHERE id = 'fan'").length, 'las de cuentas que existen, se quedan');
  assert.deepEqual(rows("SELECT board FROM entries WHERE id = 'x'").map(r => r.board), ['s_d' + ids().d.slice(1)]);
  assert.equal(rows("SELECT 1 FROM runs WHERE run = 'oldrun'").length, 0);
});
