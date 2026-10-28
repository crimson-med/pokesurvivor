/* ============ auth.test.js: tokens de Firebase (firma de verdad y emulador) ============ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jose = require('jose');
const { createAuth } = require('../auth');

const PROJECT = 'pokesurvivor-free';

async function keys() {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return { privateKey, jwks: jose.createLocalJWKSet({ keys: [jwk] }) };
}

function sign(privateKey, claims = {}, o = {}) {
  return new jose.SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(o.iss || 'https://securetoken.google.com/' + PROJECT)
    .setAudience(o.aud || PROJECT)
    .setSubject(o.sub == null ? 'uid1' : o.sub)
    .setIssuedAt()
    .setExpirationTime(o.exp || '1h')
    .sign(privateKey);
}

test('firma buena: devuelve el uid', async () => {
  const { privateKey, jwks } = await keys();
  const a = createAuth({ project: PROJECT, jwks });
  assert.deepEqual(await a.verify(await sign(privateKey)), { uid: 'uid1' });
});

test('se rechaza otro proyecto, otro emisor, caducado, sin uid u otra clave', async () => {
  const { privateKey, jwks } = await keys();
  const other = await keys();
  const a = createAuth({ project: PROJECT, jwks });
  await assert.rejects(a.verify(await sign(privateKey, {}, { aud: 'otro' })));
  await assert.rejects(a.verify(await sign(privateKey, {}, { iss: 'https://securetoken.google.com/otro' })));
  await assert.rejects(a.verify(await sign(privateKey, {}, { exp: Math.floor(Date.now() / 1000) - 60 })));
  await assert.rejects(a.verify(await sign(privateKey, {}, { sub: '' })));
  await assert.rejects(a.verify(await sign(other.privateKey)));
  await assert.rejects(a.verify('basura'));
  await assert.rejects(a.verify(undefined));
});

test('un token sin firma no vale fuera del emulador', async () => {
  const { jwks } = await keys();
  const a = createAuth({ project: PROJECT, jwks });
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = b64({ alg: 'none' }) + '.' + b64({ sub: 'x', aud: PROJECT, iss: 'https://securetoken.google.com/' + PROJECT }) + '.';
  await assert.rejects(a.verify(t));
});

test('emulador: exige la audiencia y no arranca en producción', async () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = aud => b64({ alg: 'none' }) + '.' + b64({ sub: 'u', aud }) + '.';
  const a = createAuth({ emulator: true });
  assert.equal(a.project, 'demo-pokesurvivor');
  assert.deepEqual(await a.verify(t('demo-pokesurvivor')), { uid: 'u' });
  await assert.rejects(a.verify(t('pokesurvivor-free')));
  assert.throws(() => createAuth({ emulator: true, nodeEnv: 'production' }));
  assert.throws(() => createAuth({}));
});
