/* ============ limits.test.js: cubos de fichas con reloj falso ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bucket, flood, createLimits } = require('../limits');

test('el cubo deja cap usos y se rellena con el tiempo', () => {
  const clock = { t: 0 };
  const b = bucket(5, 60000, () => clock.t);
  for (let i = 0; i < 5; i++) assert.equal(b.take('ip'), true);
  assert.equal(b.take('ip'), false);
  assert.equal(b.take('otra'), true);
  clock.t += 12000;   // una ficha
  assert.equal(b.take('ip'), true);
  assert.equal(b.take('ip'), false);
});

test('clean borra los cubos llenos (las IP no se quedan en memoria)', () => {
  const clock = { t: 0 };
  const b = bucket(5, 60000, () => clock.t);
  for (let i = 0; i < 5; i++) b.take('1.2.3.4');
  assert.equal(b.size, 1);
  clock.t += 30000;
  b.clean();
  assert.equal(b.size, 1);
  clock.t += 30000;
  b.clean();
  assert.equal(b.size, 0);
});

test('join: 5 por minuto por IP', () => {
  const clock = { t: 0 };
  const l = createLimits({ now: () => clock.t });
  const ok = [];
  for (let i = 0; i < 6; i++) ok.push(l.joinIp.take('1.2.3.4'));
  assert.deepEqual(ok, [true, true, true, true, true, false]);
});

test('m: 120 por segundo; pasarse 3 s seguidos corta', () => {
  const clock = { t: 0 };
  const l = createLimits({ now: () => clock.t });
  let n = 0;
  while (l.m.take('s')) n++;
  assert.equal(n, 120);
  const f = flood(3000, () => clock.t);
  assert.equal(f.over('s'), false);
  clock.t += 900;
  assert.equal(f.over('s'), false);
  clock.t += 900;
  assert.equal(f.over('s'), false);
  clock.t += 900;
  assert.equal(f.over('s'), false);
  clock.t += 900;
  assert.equal(f.over('s'), true);
  // Un segundo largo sin pasarse reinicia la cuenta.
  clock.t += 1500;
  assert.equal(f.over('s'), false);
});
