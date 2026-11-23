// Sets the colour theme before the page paints. Kept as a tiny separate file so no inline script is needed.
(function () {
  var root = document.documentElement;
  var theme = 'dark';
  try {
    var saved = localStorage.getItem('sv2blocks:theme');
    var fallback = root.getAttribute('data-default-theme') || 'dark';
    if (saved === 'dark' || saved === 'light') theme = saved;
    else if (fallback === 'system') theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    else if (fallback === 'light') theme = 'light';
  } catch (error) {
    theme = 'dark';
  }
  root.setAttribute('data-theme', theme);
})();
