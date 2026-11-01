/* ============ auth.js: comprobación del token de Firebase ============
 * El jugador se identifica con su ID token de Firebase (dura una hora). Se
 * comprueba con las claves públicas de Google: nada de Firebase Admin ni de
 * Identity Platform, así que no cuesta nada por usuario.
 *
 *   normal    firma RS256 con las claves de securetoken@system, emisor
 *             https://securetoken.google.com/<proyecto> y audiencia <proyecto>
 *   emulador  (AUTH_EMULATOR=1) el emulador no firma (alg: none): se lee el
 *             token sin comprobar la firma y sólo se exige la audiencia.
 *             Prohibido con NODE_ENV=production: el servidor no arranca.
 *
 * verify(token) -> Promise<{ uid }>; si no vale, lanza un error.
 */
'use strict';

const jose = require('jose');

const GOOGLE_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function checkSub(payload) {
  const sub = payload && payload.sub;
  if (typeof sub !== 'string' || !sub || sub.length > 128) throw new Error('token sin uid');
  return { uid: sub };
}

function createAuth(opts = {}) {
  const emulator = !!opts.emulator;
  const project = opts.project || (emulator ? 'demo-pokesurvivor' : '');
  if (!project) throw new Error('Falta FIREBASE_PROJECT');

  if (emulator) {
    if (opts.nodeEnv === 'production') {
      throw new Error('AUTH_EMULATOR=1 no se permite con NODE_ENV=production');
    }
    return {
      emulator: true,
      project,
      async verify(token) {
        if (typeof token !== 'string' || !token) throw new Error('sin token');
        const p = jose.decodeJwt(token);
        const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
        if (!aud.includes(project)) throw new Error('token de otro proyecto');
        if (typeof p.exp === 'number' && p.exp * 1000 < Date.now()) throw new Error('token caducado');
        return checkSub(p);
      },
    };
  }

  const keys = opts.jwks || jose.createRemoteJWKSet(new URL(GOOGLE_JWKS));
  const issuer = 'https://securetoken.google.com/' + project;
  return {
    emulator: false,
    project,
    async verify(token) {
      if (typeof token !== 'string' || !token) throw new Error('sin token');
      const { payload } = await jose.jwtVerify(token, keys, {
        issuer, audience: project, algorithms: ['RS256'],
      });
      return checkSub(payload);
    },
  };
}

module.exports = { createAuth, GOOGLE_JWKS };
