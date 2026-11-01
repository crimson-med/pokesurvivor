/* ============ live-ui.js — botón de YouTube ============
 * Botón en la barra de arriba que lleva al canal.
 *
 * Antes se ponía rojo con «EN DIRECTO» leyendo live.json de la rama «live»
 * del repositorio original (GitHub). Ya no: el juego sólo habla con su propio
 * servidor (connect-src 'self' en dev.html).
 */
G.LiveUI = (() => {
  const $ = G.UI.$;
  const CHANNEL = 'https://www.youtube.com/@jpter78';

  function init() {
    const b = $('btn-yt');
    b.onclick = () => window.open(CHANNEL, '_blank', 'noopener');
    b.title = 'Mi canal de YouTube';
    b.innerHTML = G.Icons.html('yt', 18) + ' <span>YouTube</span>';
  }

  return { init };
})();
