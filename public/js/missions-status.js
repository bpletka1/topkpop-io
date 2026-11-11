/* TopKpop.io — Missions page: each Trove shows the signed-in team where it stands and the door into its judge. */
(function () {
  'use strict';
  function stored(k) { try { var v = localStorage.getItem('er:' + k); return v === null ? null : JSON.parse(v); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var TROVES = [
    { n: 1, key: 'visual', judge: 'Visual Judge' },
    { n: 2, key: 'lyric', judge: 'Lyric Judge' },
    { n: 3, key: 'lesson', judge: 'Lesson Judge' }
  ];
  function holder(n) {
    var el = document.getElementById('trove0' + n + '-unlocked');
    if (!el && n === 1) { var all = document.querySelectorAll('.trove-panel-body'); for (var i = 0; i < all.length; i++) { if (!all[i].id) { el = all[i]; break; } } }
    return el;
  }
  function box(n, html) {
    var h = holder(n); if (!h) return;
    var b = document.getElementById('teamStatus' + n);
    if (!b) { b = document.createElement('div'); b.id = 'teamStatus' + n; b.style.cssText = 'margin:0 0 18px;padding:14px 16px;border:1px solid rgba(255,191,0,.35);border-radius:8px;background:rgba(255,191,0,.06);font-size:.9rem;line-height:1.6;color:rgba(224,224,224,.9)'; h.insertBefore(b, h.firstChild); }
    b.innerHTML = html;
  }
  function link(href, text) { return '<a href="' + href + '" style="color:#FFBF00;font-weight:700;white-space:nowrap">' + text + ' &rarr;</a>'; }
  var token = stored('token'), team = stored('team');
  function draw(locks) {
    TROVES.forEach(function (t) {
      var room = '/pages/evaluation-room/judge/?j=' + t.key;
      if (!token) { box(t.n, 'Sign in once to rehearse, take the stage and see your team’s progress. ' + link('/pages/evaluation-room/?next=' + encodeURIComponent('/pages/missions'), 'Team Sign In')); return; }
      var L = locks && locks[t.key];
      if (L) box(t.n, '<strong style="color:#fff">' + esc(team && team.name || 'Your team') + ':</strong> official score locked at <strong style="color:#fff">' + esc(L.score) + '</strong>' + (L.bonus ? ' plus <strong style="color:#fff">' + esc(L.bonus) + '</strong> bonus' : '') + '. ' + link(room, 'Open the ' + t.judge) + ' &nbsp; ' + link('/pages/evaluation-room/wall/', 'Share on the Wall'));
      else box(t.n, '<strong style="color:#fff">' + esc(team && team.name || 'Your team') + ':</strong> not on stage yet for this Trove. Read the directions, then rehearse. ' + link(room, 'Open the ' + t.judge));
    });
  }
  if (!token) { draw(null); return; }
  fetch('/api/evalroom/stage', { headers: { 'x-evalroom-token': token }, cache: 'no-store' })
    .then(function (r) { if (r.status === 401) { token = null; return {}; } return r.json(); })
    .then(function (d) { draw(d.locks || {}); })
    .catch(function () { draw({}); });
})();
