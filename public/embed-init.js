// Runs before a widget paints: picks the colour theme and the widget from the address, so the
// right one shows straight away. Kept as a tiny separate file so no inline script is needed.
(function () {
  var root = document.documentElement;
  var theme = root.getAttribute('data-default-theme') || 'dark';
  var widget = 'blocks';
  try {
    var query = new URLSearchParams(window.location.search);
    theme = (query.get('theme') || theme).toLowerCase();
    if ((query.get('widget') || '').toLowerCase() === 'leaderboard') widget = 'leaderboard';
    if (theme !== 'dark' && theme !== 'light') {
      theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  } catch (error) {
    theme = 'dark';
  }
  root.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  root.setAttribute('data-widget', widget);
})();
