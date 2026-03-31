/* =========================================================
   Monitor de Compras SC — nav.js
   ========================================================= */
(function () {
  // Marca tab ativa baseado na URL
  function setActive() {
    const current = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.tab-link').forEach(function (a) {
      const href = (a.getAttribute('href') || '').split('/').pop();
      a.classList.toggle('active', href === current || (current === '' && href === 'index.html'));
    });
  }

  // Smooth scroll
  function initScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        const t = document.getElementById(a.getAttribute('href').slice(1));
        if (t) { e.preventDefault(); t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    setActive();
    initScroll();
  });
})();
