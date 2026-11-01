/* ============ mail.js: los correos con el código para entrar ============
 * Dos modos (MAIL en config.js):
 *   console  el código sale en el registro: [mail] to=<correo> code=<código>
 *            (desarrollo y pruebas; no se manda nada)
 *   smtp     nodemailer con SMTP_URL, desde MAIL_FROM (cualquier proveedor)
 *
 * createMailer(cfg, opts) -> { send(to, subject, text, html), sendCode(to, code, lang) }
 *   opts.log   dónde escribe el modo console (console.log)
 * sendCode arma el correo en el idioma del jugador (los 7 del juego; si no
 * lo conoce, en inglés): asunto con el código, el código en grande, que vale
 * 10 minutos y que si no lo has pedido lo ignores. Texto y HTML sencillo,
 * sin imágenes ni seguimiento. Si no sale, lanza un error (auth.js responde
 * 502 mail).
 */
'use strict';

const T = {
  es: ['Tu código de PokéSurvivor: {code}', 'Escribe este código en el juego para entrar:', 'Vale 10 minutos.', 'Si no lo has pedido tú, ignora este correo.'],
  en: ['Your PokéSurvivor code: {code}', 'Enter this code in the game to sign in:', 'It is valid for 10 minutes.', "If you didn't ask for this, ignore this email."],
  fr: ['Ton code PokéSurvivor : {code}', 'Saisis ce code dans le jeu pour te connecter :', 'Il est valable 10 minutes.', "Si tu ne l'as pas demandé, ignore cet e-mail."],
  it: ['Il tuo codice PokéSurvivor: {code}', 'Inserisci questo codice nel gioco per accedere:', 'È valido per 10 minuti.', "Se non l'hai chiesto tu, ignora questa email."],
  'pt-BR': ['Seu código do PokéSurvivor: {code}', 'Digite este código no jogo para entrar:', 'Ele vale por 10 minutos.', 'Se não foi você que pediu, ignore este e-mail.'],
  'zh-Hans': ['你的 PokéSurvivor 验证码：{code}', '在游戏中输入此验证码即可登录：', '有效期 10 分钟。', '如果这不是你本人的请求，请忽略此邮件。'],
  'zh-Hant': ['你的 PokéSurvivor 驗證碼：{code}', '在遊戲中輸入此驗證碼即可登入：', '有效期 10 分鐘。', '如果這不是你本人的請求，請忽略此郵件。'],
};
const LANGS = Object.keys(T);

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// El correo del código en un idioma: { subject, text, html }.
function codeMail(code, lang) {
  const [subject, line, valid, ignore] = T[LANGS.includes(lang) ? lang : 'en'];
  const s = subject.replace('{code}', code);
  const text = line + '\n\n    ' + code + '\n\n' + valid + '\n' + ignore + '\n';
  const html = '<!doctype html><html><body style="font-family:sans-serif;color:#222">'
    + '<p>' + escHtml(line) + '</p>'
    + '<p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:16px 0">' + escHtml(code) + '</p>'
    + '<p>' + escHtml(valid) + '</p>'
    + '<p style="color:#666">' + escHtml(ignore) + '</p>'
    + '</body></html>';
  return { subject: s, text, html };
}

function createMailer(cfg, opts = {}) {
  const log = opts.log || console.log;
  let transport = null;
  const smtp = () => {
    if (!transport) transport = require('nodemailer').createTransport(cfg.smtpUrl);
    return transport;
  };

  async function send(to, subject, text, html) {
    if (cfg.mail === 'console') {
      log('[mail] to=' + to + ' subject=' + JSON.stringify(subject));
      return;
    }
    await smtp().sendMail({ from: cfg.mailFrom, to, subject, text, html });
  }

  async function sendCode(to, code, lang) {
    if (cfg.mail === 'console') {
      log('[mail] to=' + to + ' code=' + code);
      return;
    }
    const m = codeMail(code, lang);
    await send(to, m.subject, m.text, m.html);
  }

  return { send, sendCode };
}

module.exports = { createMailer, codeMail, LANGS };
