/* ============ rank-fit.js: las reglas de los rankings, en el servidor ============
 * Lo mismo que js/net/ranking.js del juego (tests/ranking.test.cjs comprueba
 * que dan los mismos ids y los mismos topes): si cambia algo aquí, cambia allí.
 *
 *   tabla = modo + periodo, en hora de España (Europe/Madrid):
 *     s_d20261102a   solitario, hoy           g_...      en grupo
 *     s_w2026-45a    semana ISO               s_m202611a mes
 *     s_all4         histórico                s_all4_p25 histórico sólo con Pikachu
 *   Diario, semanal, mensual y por Pokémon guardan sólo el top 50 (de tiempo o
 *   de daño a Arceus); el histórico guarda a todos (tu puesto exacto). El daño
 *   a Arceus no va en las tablas de cada Pokémon.
 *
 *   periodIds(fecha)   { d, w, m, y, a } sin la letra de la generación (misiones)
 *   boardIds(fecha)    { d, w, m, y, a } con ella: los nombres de las tablas
 *   boardsFor(modo, dexes, t, fecha)  [[tabla, periodo]] donde va una partida
 *                      (periodo 'p' = histórico de un Pokémon, desde MIN_T_MON)
 *   parse(tabla)       { mode, period, dex, topOnly, y, m, d, w } o null si no vale
 *   fit(r)             tiempo, nivel, derrotados y daño dentro de lo posible
 *   expired(tabla, ahora)  ¿una tabla de periodo ya se puede borrar? (03-data-model.md)
 */
'use strict';

const TZ = 'Europe/Madrid';
const PERIODS = ['d', 'w', 'm', 'a'];
const TOP_ONLY = new Set(['d', 'w', 'm', 'p']);
const TOP = 50;
const MIN_T = 120;        // menos de 2 minutos no entra
const MIN_T_MON = 600;    // en el histórico de cada Pokémon, 10 minutos
const ALL = 'all4';
const GEN = 'a';
const DAY = 86400000;
// Cuánto se guardan las tablas viejas de cada periodo (la limpieza de cada noche).
const KEEP = { d: 40, w: 20, m: 24 };   // días, semanas, meses

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function madridDate(date) {
  const p = {};
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day };
}

/** Semana ISO (lunes a domingo) de una fecha y-m-d. */
function isoWeek(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - y0) / DAY + 1) / 7) };
}

const p2 = n => String(n).padStart(2, '0');
function periodIds(date = new Date()) {
  const { y, m, d } = madridDate(date);
  const w = isoWeek(y, m, d);
  return { d: 'd' + y + p2(m) + p2(d), w: 'w' + w.year + '-' + p2(w.week), m: 'm' + y + p2(m), y: 'y' + y, a: ALL };
}

function boardIds(date) {
  const p = periodIds(date);
  return Object.assign({}, p, { d: p.d + GEN, w: p.w + GEN, m: p.m + GEN, y: p.y + GEN });
}

/** Las tablas de una partida: cada periodo y, desde 10 min, el histórico de cada Pokémon. */
function boardsFor(mode, dexes, t, date) {
  const ids = boardIds(date);
  const out = PERIODS.map(p => [mode + '_' + ids[p], p]);
  if (t >= MIN_T_MON) for (const d of new Set(dexes)) out.push([mode + '_' + ALL + '_p' + d, 'p']);
  return out;
}

const BOARD_RE = /^([sg])_(?:d(\d{4})(\d{2})(\d{2})a|w(\d{4})-(\d{2})a|m(\d{4})(\d{2})a|(all4)(?:_p(\d{1,4}))?)$/;
function parse(b) {
  const x = typeof b === 'string' ? BOARD_RE.exec(b) : null;
  if (!x) return null;
  const mode = x[1];
  let r;
  if (x[2]) r = { period: 'd', y: +x[2], m: +x[3], d: +x[4] };
  else if (x[5]) r = { period: 'w', y: +x[5], w: +x[6] };
  else if (x[7]) r = { period: 'm', y: +x[7], m: +x[8] };
  else r = x[10] ? { period: 'p', dex: +x[10] } : { period: 'a' };
  r.mode = mode;
  r.topOnly = TOP_ONLY.has(r.period);
  return r;
}

/** El lunes (UTC) de la semana ISO w del año y. */
function isoMonday(y, w) {
  const jan4 = new Date(Date.UTC(y, 0, 4));
  return Date.UTC(y, 0, 4) - ((jan4.getUTCDay() || 7) - 1) * DAY + (w - 1) * 7 * DAY;
}

/** ¿Es una tabla de un periodo ya viejo (40 días, 20 semanas, 24 meses)? El histórico, nunca. */
function expired(b, now = Date.now()) {
  const p = parse(b);
  if (!p) return false;
  const today = madridDate(new Date(now));
  const dayNum = Date.UTC(today.y, today.m - 1, today.d);
  if (p.period === 'd') return dayNum - Date.UTC(p.y, p.m - 1, p.d) > KEEP.d * DAY;
  if (p.period === 'w') {
    const cur = isoWeek(today.y, today.m, today.d);
    return isoMonday(cur.year, cur.week) - isoMonday(p.y, p.w) > KEEP.w * 7 * DAY;
  }
  if (p.period === 'm') return (today.y * 12 + today.m) - (p.y * 12 + p.m) > KEEP.m;
  return false;
}

/*
 * Nivel, derrotados y daño a Arceus dentro de lo posible (los topes de
 * ranking.js): el daño sólo desde el minuto 30, hasta 50.000 por segundo de
 * Sentencia; nivel hasta 10 + t / 4; derrotados hasta 100 + 12 por segundo.
 */
function fit(r) {
  const n = v => (Number.isFinite(+v) ? +v : 0);
  const t = Math.min(86400, Math.max(1, Math.floor(n(r.t))));
  const dmg = t < 1800 ? 0 : Math.max(0, Math.min(Math.floor(n(r.dmg)), (t - 1799) * 50000));
  return {
    t,
    lv: Math.max(1, Math.min(Math.floor(n(r.lv)), 10 + Math.floor(t / 4))),
    kills: Math.max(0, Math.min(Math.floor(n(r.kills)), 100 + t * 12)),
    dmg,
  };
}

module.exports = { TZ, PERIODS, TOP_ONLY, TOP, MIN_T, MIN_T_MON, ALL, GEN, KEEP,
  madridDate, isoWeek, periodIds, boardIds, boardsFor, parse, expired, fit };
