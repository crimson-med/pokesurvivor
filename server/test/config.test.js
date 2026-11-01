/* ============ config.test.js: variables de entorno y sus valores por defecto ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadConfig } = require('../config');

test('valores por defecto (desarrollo)', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8787);
  assert.equal(c.siteUrl, 'http://localhost:8787');
  assert.equal(c.origin, 'http://localhost:8787');
  assert.equal(c.dev, true);
  assert.equal(c.secureCookie, false);
  assert.equal(c.dbPath, path.join(__dirname, '..', '.data', 'ps.db'));
  assert.equal(c.staticDir, path.resolve(__dirname, '..', '..'));
  assert.equal(c.mail, 'console');
  assert.deepEqual(c.adminEmails, []);
  assert.deepEqual(c.stunUrls, ['stun:stun.l.google.com:19302']);
  assert.equal(c.trustProxy, 0);
  assert.equal(c.maxRooms, 1000);
  assert.equal(c.maxSockets, 4000);
  assert.equal(c.maxMsgBytes, 256 * 1024);
  assert.equal(c.directWaitMs, 6000);
  assert.ok(Object.isFrozen(c));
});

test('lo que llega del entorno', () => {
  const c = loadConfig({
    PORT: '9000', SITE_URL: 'https://play.example.com/', DB_PATH: '/data/ps.db', STATIC_DIR: '/app/public',
    MAIL: 'smtp', SMTP_URL: 'smtps://u:p@smtp.example.com:465', MAIL_FROM: 'X <a@b.c>',
    ADMIN_EMAILS: ' A@Example.com, b@example.com ,', STUN_URLS: 'stun:a:1, stun:b:2', TRUST_PROXY: '1',
    MAX_ROOMS: '5', DIRECT_WAIT_MS: '10000',
  });
  assert.equal(c.port, 9000);
  assert.equal(c.siteUrl, 'https://play.example.com');
  assert.equal(c.origin, 'https://play.example.com');
  assert.equal(c.secureCookie, true);
  assert.equal(c.dbPath, '/data/ps.db');
  assert.equal(c.staticDir, '/app/public');
  assert.equal(c.smtpUrl, 'smtps://u:p@smtp.example.com:465');
  assert.equal(c.mailFrom, 'X <a@b.c>');
  assert.deepEqual(c.adminEmails, ['a@example.com', 'b@example.com']);
  assert.deepEqual(c.stunUrls, ['stun:a:1', 'stun:b:2']);
  assert.equal(c.trustProxy, 1);
  assert.equal(c.maxRooms, 5);
  assert.equal(c.directWaitMs, 10000);
  assert.equal(loadConfig({ PORT: '8795' }).siteUrl, 'http://localhost:8795');
});

test('STUN_URLS vacío: sin STUN', () => {
  assert.deepEqual(loadConfig({ STUN_URLS: '' }).stunUrls, []);
});

test('producción: CODE_PEPPER obligatorio; MAIL y SITE_URL tienen que valer', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /CODE_PEPPER/);
  const c = loadConfig({ NODE_ENV: 'production', CODE_PEPPER: 'x' });
  assert.equal(c.production, true);
  assert.equal(c.dev, false);
  assert.throws(() => loadConfig({ MAIL: 'paloma' }), /MAIL/);
  assert.throws(() => loadConfig({ MAIL: 'smtp' }), /SMTP_URL/);
  assert.throws(() => loadConfig({ SITE_URL: 'esto no' }), /SITE_URL/);
});
