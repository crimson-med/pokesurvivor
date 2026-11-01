/* ============ api.js: las llamadas a la API del servidor (/api/...) ============
 * Mismo origen que el juego: la cookie de la sesión (ps_sid, httpOnly) va
 * sola. Cada petición lleva X-PS: 1 (el servidor rechaza sin ella lo que
 * cambia algo: protección CSRF, docs/relay-coop/04-auth.md) y JSON.
 *
 *   G.Api.get(ruta), post(ruta, cuerpo), put(ruta, cuerpo), del(ruta, cuerpo)
 *     -> promesa con el cuerpo de la respuesta ya leído (null si viene vacío, 204)
 *
 * Si falla, la promesa se rechaza con un Error con:
 *   .code    el { error } del servidor ('signed-out', 'rate', 'bad-code'...);
 *            sin respuesta (sin red, servidor caído): 'offline'; una
 *            respuesta sin { error }: 'http'
 *   .status  el estado HTTP (0 si no hubo respuesta)
 *   .data    el cuerpo de la respuesta (409 de /api/save trae la otra copia)
 *   .retry   con 429, los segundos de Retry-After
 */
G.Api = (() => {
  function fail(code, status, data) {
    const e = new Error(code);
    e.code = code; e.status = status; e.data = data || null;
    return e;
  }

  async function call(method, path, body) {
    const headers = { 'X-PS': '1', Accept: 'application/json' };
    const opts = { method, credentials: 'same-origin', headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(path, opts); } catch (e) { throw fail('offline', 0); }
    let text = '';
    try { text = await r.text(); } catch (e) { throw fail('offline', 0); }
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (r.ok) return data;
    const code = data && typeof data.error === 'string' ? data.error : 'http';
    const e = fail(code, r.status, data);
    if (r.status === 429) e.retry = +(r.headers.get('Retry-After') || 0) || 0;
    throw e;
  }

  return {
    get: path => call('GET', path),
    post: (path, body = {}) => call('POST', path, body),
    put: (path, body = {}) => call('PUT', path, body),
    del: (path, body = {}) => call('DELETE', path, body)
  };
})();
