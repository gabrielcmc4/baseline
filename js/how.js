// Language switch for the behind-the-scenes page (same stored choice as the app).
let lang; try { lang = localStorage.getItem('baseline-lang'); } catch (e) {}
if (lang !== 'pt' && lang !== 'en') lang = (navigator.language || 'pt').toLowerCase().startsWith('pt') ? 'pt' : 'en';
function apply() { document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en'; document.querySelectorAll('[data-l]').forEach(e => { e.hidden = e.dataset.l !== lang; });
  document.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang))); document.title = lang === 'pt' ? 'Baseline — por trás das cenas' : 'Baseline — behind the scenes'; }
document.querySelectorAll('[data-lang]').forEach(b => { b.onclick = () => { lang = b.dataset.lang; try { localStorage.setItem('baseline-lang', lang); } catch (e) {} apply(); }; });
apply();
