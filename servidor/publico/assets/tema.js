// Aplica o tema (claro/escuro) ANTES de desenhar a página: sem piscar branco no tema escuro.
// Fica no <head> e roda antes do corpo; o resto (botão de trocar) é do base.js.
(function () {
  var t = null;
  try { t = localStorage.getItem('dmkacs-tema'); } catch (e) { /* sem armazenamento */ }
  if (t !== 'dark' && t !== 'light') t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
})();
