/* TopKpop.io — The Evaluation Room: shared page code */
(function () {
  'use strict';
  var ROOM = '/pages/evaluation-room/';
  var mem = {};

  // Saved on this device only. Falls back to memory if the browser blocks storage.
  var store = {
    get: function (k) { try { var v = localStorage.getItem('er:' + k); return v === null ? (k in mem ? mem[k] : null) : JSON.parse(v); } catch (e) { return k in mem ? mem[k] : null; } },
    set: function (k, v) { mem[k] = v; try { localStorage.setItem('er:' + k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { delete mem[k]; try { localStorage.removeItem('er:' + k); } catch (e) {} }
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  // Small, safe formatter for the studio's answers: headings, bold, line breaks.
  function md(text) {
    var out = [], para = [];
    function flush() { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } }
    String(text || '').split('\n').forEach(function (line) {
      var t = line.trim();
      var h = t.match(/^#{1,6}\s+(.*)$/) || t.match(/^\*\*([^*]{2,80})\*\*:?$/);
      if (h) { flush(); out.push('<h4>' + inline(h[1].replace(/[:：]\s*$/, '')) + '</h4>'); return; }
      if (/^(-{3,}|⸻+|_{3,}|\*{3,})$/.test(t)) { flush(); return; }
      if (!t) { flush(); return; }
      para.push(inline(line.replace(/\s+$/, '')));
    });
    flush();
    return out.join('');
    function inline(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>'); }
  }

  function token() { return store.get('token'); }
  function team() { return store.get('team'); }
  function signOut() { store.del('token'); store.del('team'); location.href = ROOM; }

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    var t = token();
    if (t) headers['x-evalroom-token'] = t;
    var body;
    if (opts.form) body = opts.form;
    else if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    return fetch('/api/evalroom' + path, { method: opts.method || (body ? 'POST' : 'GET'), headers: headers, body: body })
      .then(function (r) {
        return r.text().then(function (txt) {
          var data; try { data = JSON.parse(txt); } catch (e) { data = { error: 'Something went wrong. Please try again.' }; }
          if (r.status === 401 && t) { store.del('token'); store.del('team'); }
          if (!r.ok) { var err = new Error(data.error || 'Something went wrong. Please try again.'); err.status = r.status; err.data = data; throw err; }
          return data;
        });
      }, function () { throw new Error('No connection. Check your internet and try again.'); });
  }

  // Pages other than the room send signed-out visitors to the room to sign in.
  function requireSignIn() {
    if (token()) return true;
    location.replace(ROOM + '?next=' + encodeURIComponent(location.pathname + location.search));
    return false;
  }

  var NAV = [['/', 'Home'], ['/pages/missions', 'Missions'], [ROOM, 'Evaluation Room'], ['/pages/resources', 'Resources'], ['/pages/leaderboard', 'Leaderboard']];
  function chrome(cfg) {
    var ribbon = el('div', 'er-ribbon', 'Preview copy. Rehearsals here are for testing and do not count.');
    ribbon.id = 'erRibbon';
    var nav = el('nav', 'er-nav');
    nav.setAttribute('aria-label', 'Site');
    nav.innerHTML = '<a class="er-logo" href="/"><span>TOP</span>KPOP.IO</a>' +
      '<button class="er-burger" id="erBurger" aria-label="Open menu" aria-expanded="false">&#9776;</button>' +
      '<div class="er-links" id="erLinks">' + NAV.map(function (n) { return '<a href="' + n[0] + '"' + (n[0] === ROOM ? ' class="active"' : '') + '>' + n[1] + '</a>'; }).join('') + '</div>';
    document.body.insertBefore(nav, document.body.firstChild);
    document.body.insertBefore(ribbon, nav);
    var foot = el('footer', 'er-foot', '&copy; 2025&ndash;2026 Blockchain Spirits LLC &middot; Top K-Pop Entertainment &middot; <a href="/pages/legal/">Official Rules &middot; Privacy</a><br>The Evaluation Room is practice. Official scores are set when you submit your work.');
    document.body.appendChild(foot);
    var links = $('#erLinks'), burger = $('#erBurger');
    burger.addEventListener('click', function () { var o = links.classList.toggle('open'); burger.setAttribute('aria-expanded', o ? 'true' : 'false'); });
    if (cfg && cfg.preview) ribbon.classList.add('on');
  }

  var cfgPromise = null;
  function config() {
    if (!cfgPromise) cfgPromise = api('/config').then(function (c) { if (c.preview) { var r = $('#erRibbon'); if (r) r.classList.add('on'); } return c; });
    return cfgPromise;
  }

  /* Directions card
     spec: { id, title, intro, steps: [{ html, done: fn()->bool | undefined }], help: html }
     Steps with a done() function tick themselves. Steps without one are ticked by tapping the number. */
  function directions(root, spec) {
    var manual = store.get('dir:' + spec.id) || {};
    var C = 2 * Math.PI * 30;
    root.classList.add('er-card', 'glow');
    root.innerHTML =
      '<div class="er-dir"><div><p class="er-label">Directions</p><h2 class="er-h2">' + spec.title + '</h2>' +
      (spec.intro ? '<p class="er-muted" style="margin-top:8px">' + spec.intro + '</p>' : '') + '</div>' +
      '<div class="er-ring" role="img" aria-label="Progress"><svg viewBox="0 0 74 74"><circle class="track" cx="37" cy="37" r="30"/><circle class="bar" cx="37" cy="37" r="30" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + C.toFixed(1) + '"/></svg><span>0/' + spec.steps.length + '</span></div></div>' +
      '<ol class="er-steps">' + spec.steps.map(function (s, i) {
        return '<li class="er-step" data-i="' + i + '"><button type="button" class="dot" aria-label="Step ' + (i + 1) + '">' + (i + 1) + '</button><div class="txt">' + s.html + '</div></li>';
      }).join('') + '</ol>' + (spec.help ? '<p class="er-help">' + spec.help + '</p>' : '');
    var items = root.querySelectorAll('.er-step');
    function isDone(i) { var s = spec.steps[i]; return s.done ? !!s.done() : !!manual[i]; }
    function update() {
      var n = 0, firstOpen = -1;
      items.forEach(function (li, i) {
        var d = isDone(i);
        li.classList.toggle('done', d);
        li.classList.remove('now');
        var dot = li.querySelector('.dot');
        dot.textContent = d ? '✓' : String(i + 1);
        dot.setAttribute('aria-label', 'Step ' + (i + 1) + (d ? ', done' : ''));
        if (d) n++; else if (firstOpen === -1) firstOpen = i;
      });
      if (firstOpen !== -1) items[firstOpen].classList.add('now');
      root.querySelector('.bar').setAttribute('stroke-dashoffset', (C * (1 - n / spec.steps.length)).toFixed(1));
      root.querySelector('.er-ring span').textContent = n + '/' + spec.steps.length;
      root.querySelector('.er-ring').setAttribute('aria-label', n + ' of ' + spec.steps.length + ' steps done');
    }
    items.forEach(function (li, i) {
      var s = spec.steps[i];
      if (s.done) { li.querySelector('.dot').style.cursor = 'default'; return; }
      function tick(v) { manual[i] = v; store.set('dir:' + spec.id, manual); update(); }
      li.querySelector('.dot').addEventListener('click', function () { tick(!manual[i]); });
      // Opening a link inside a step counts as doing that step.
      li.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { tick(true); }); });
    });
    update();
    return { update: update };
  }

  function showMsg(node, text, kind) {
    node.className = 'er-msg on ' + (kind || 'err');
    node.textContent = text;
    node.setAttribute('role', kind === 'info' ? 'status' : 'alert');
  }
  function hideMsg(node) { node.className = 'er-msg'; node.textContent = ''; }

  window.ER = { ROOM: ROOM, store: store, esc: esc, $: $, el: el, md: md, token: token, team: team, signOut: signOut, api: api, requireSignIn: requireSignIn, chrome: chrome, config: config, directions: directions, showMsg: showMsg, hideMsg: hideMsg };
})();
