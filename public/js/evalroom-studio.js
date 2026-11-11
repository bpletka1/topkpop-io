/* TopKpop.io — The Evaluation Room: Songwriting Studio */
(function () {
  'use strict';
  var $ = ER.$, esc = ER.esc;
  ER.chrome();
  if (!ER.requireSignIn()) return;
  ER.config().catch(function () {});

  var S = { messages: ER.store.get('studio:messages') || [], busy: false, sentToJudge: !!ER.store.get('studio:sent') };
  var chat = $('#chat'), msg = $('#msg'), say = $('#say'), send = $('#send');
  var fields = { orig: $('#orig'), vocab: $('#vocab'), theme: $('#theme'), mode: $('#mode') };

  // ── Draft of the start form, saved on this device ──
  var draft = ER.store.get('studio:draft') || {};
  Object.keys(fields).forEach(function (k) {
    if (draft[k]) fields[k].value = draft[k];
    fields[k].addEventListener('input', saveDraft);
    fields[k].addEventListener('change', saveDraft);
  });
  var t = null;
  function saveDraft() {
    clearTimeout(t);
    t = setTimeout(function () {
      var d = {}; Object.keys(fields).forEach(function (k) { d[k] = fields[k].value; });
      ER.store.set('studio:draft', d); $('#draftNote').textContent = 'Saved on this device';
      dir.update();
    }, 400);
  }

  // ── Free starter songs ──
  var songs = window.ER_SONGS || [];
  $('#songs').innerHTML = songs.map(function (s, i) { return '<button type="button" class="er-song" data-i="' + i + '"><b>' + esc(s.title) + '</b><span>' + esc(s.note) + '</span></button>'; }).join('');
  $('#songs').addEventListener('click', function (ev) {
    var b = ev.target.closest('.er-song'); if (!b) return;
    var s = songs[+b.getAttribute('data-i')];
    if (fields.orig.value.trim() && !window.confirm('Replace the lyrics in the box with “' + s.title + '”?')) return;
    fields.orig.value = s.lyrics; saveDraft(); fields.orig.focus();
  });

  // ── Directions ──
  function botCount() { return S.messages.filter(function (m) { return m.role === 'assistant'; }).length; }
  function hasSong() { return S.messages.some(function (m) { return m.role === 'assistant' && cleanCopy(m.content); }); }
  var dir = ER.directions($('#dir'), {
    id: 'studio', title: 'Write your evidence song',
    intro: 'The studio keeps the rhythm of the original song and weaves in your vocabulary.',
    steps: [
      { html: '<b>Choose a song.</b> Pick one you know well, or use a free starter song in the box below. The full mission is on the <a href="/pages/trove-02" target="_blank" rel="noopener">Trove 02 page</a>.', done: function () { return fields.orig.value.trim().length >= 20 || S.messages.length > 0; } },
      { html: '<b>Paste the original lyrics</b> in box 1.', done: function () { return fields.orig.value.trim().length >= 20 || S.messages.length > 0; } },
      { html: '<b>Add your vocabulary list</b> in box 2, and a theme if you have one.', done: function () { return fields.vocab.value.trim().length >= 3 || S.messages.length > 0; } },
      { html: '<b>Press Write my song.</b> The studio may ask a question first. Answer it in the message box.', done: function () { return botCount() > 0; } },
      { html: '<b>Review and refine.</b> Sing it through. Ask the studio to fix any line that feels off.', done: function () { return botCount() > 1 && hasSong(); } },
      { html: '<b>Send it to the Lyric Judge.</b> Use the button under the finished song to rehearse your lyrics.', done: function () { return S.sentToJudge; } }
    ],
    help: 'Stuck? Watch the mission video on the <a href="/pages/trove-02" target="_blank" rel="noopener">Trove 02 page</a> or <a href="/pages/jeannie?q=Help+me+with+Trove+2" target="_blank" rel="noopener">ask Jeannie</a>.'
  });

  // ── Finding the finished lyrics in an answer ──
  function cleanCopy(text) {
    var lines = String(text || '').split('\n');
    var start = -1;
    for (var i = lines.length - 1; i >= 0; i--) {
      if (/clean\s+copy/i.test(lines[i]) && lines[i].replace(/[^a-z]/gi, '').length < 30) { start = i + 1; break; }
    }
    if (start === -1) return '';
    var out = [];
    for (var k = start; k < lines.length; k++) {
      var l = lines[k];
      if (/^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*$)/.test(l) && out.join('').trim()) break; // next heading
      if (/^\s*(-{3,}|⸻+)\s*$/.test(l)) { if (out.join('').trim()) break; else continue; }
      out.push(l.replace(/\*\*/g, '').replace(/^\s*#{1,6}\s*/, '').replace(/^```.*$/, ''));
    }
    var body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // Leave off a closing remark such as "Would you like any changes?"
    var stanzas = body.split(/\n\s*\n/);
    while (stanzas.length > 1) {
      var last = stanzas[stanzas.length - 1].trim();
      var oneLine = last.indexOf('\n') === -1;
      if (oneLine && (/\?\s*$/.test(last) || /^(would you|let me know|if you|want me|i can|feel free|note:|tip:|ready to)/i.test(last))) stanzas.pop(); else break;
    }
    body = stanzas.join('\n\n').trim();
    return body.length >= 40 ? body : '';
  }

  // ── Showing the conversation ──
  function bubble(m, live) {
    var b = ER.el('div', 'er-bubble ' + (m.role === 'user' ? 'user' : 'bot'));
    if (m.role === 'user') {
      if (m.content.length > 420) {
        var short = ER.el('span'); short.textContent = m.content.slice(0, 260).replace(/\s+\S*$/, '') + '\u2026 ';
        var more = ER.el('button', 'er-linkbtn', 'Show all'); more.type = 'button';
        more.addEventListener('click', function () { b.textContent = m.content; });
        b.appendChild(short); b.appendChild(more);
      } else b.textContent = m.content;
      return b;
    }
    b.innerHTML = '<div class="who">Songwriting Studio</div><div class="body">' + ER.md(m.content) + '</div>';
    if (!live) addActions(b, m.content);
    return b;
  }
  function addActions(b, content) {
    var copy = cleanCopy(content);
    if (!copy) return;
    var acts = ER.el('div', 'acts');
    var toJudge = ER.el('button', 'er-btn amber small', 'Send to the Lyric Judge'); toJudge.type = 'button';
    toJudge.addEventListener('click', function () {
      var existing = ER.store.get('draft:lyric');
      if (existing && existing.trim() && existing.trim() !== copy && !window.confirm('The Lyric Judge page already has a draft saved. Replace it with these lyrics?')) return;
      ER.store.set('draft:lyric', copy); ER.store.set('studio:sent', true);
      location.href = '/pages/evaluation-room/judge/?j=lyric';
    });
    var cp = ER.el('button', 'er-btn ghost small', 'Copy lyrics'); cp.type = 'button';
    cp.addEventListener('click', function () {
      var done = function () { cp.textContent = 'Copied'; setTimeout(function () { cp.textContent = 'Copy lyrics'; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(copy).then(done, function () {});
      else { var ta = ER.el('textarea'); ta.value = copy; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) {} ta.remove(); }
    });
    acts.appendChild(toJudge); acts.appendChild(cp);
    b.appendChild(acts);
  }
  function renderAll() {
    chat.innerHTML = '';
    S.messages.forEach(function (m) { chat.appendChild(bubble(m)); });
    $('#empty').hidden = S.messages.length > 0;
    $('#reset').hidden = S.messages.length === 0;
    dir.update();
  }
  function persist() {
    // Keep what fits on this device; drop the oldest turns if storage is tight.
    var keep = S.messages.slice(-30);
    ER.store.set('studio:messages', keep);
  }

  // ── Talking to the studio ──
  function setBusy(b) {
    S.busy = b; send.disabled = b; $('#write').disabled = b;
    $('#wait').classList.toggle('on', b);
  }

  // Send the first message (original lyrics + vocabulary) and as many recent turns as fit.
  function forSending(all) {
    if (all.length <= 3) return all;
    var first = all[0], rest = all.slice(1), budget = 70000 - first.content.length, keep = [];
    for (var i = rest.length - 1; i >= 0 && keep.length < 28; i--) { budget -= rest[i].content.length; if (budget < 0 && keep.length) break; keep.unshift(rest[i]); }
    return [first].concat(keep);
  }

  function ask(text) {
    if (S.busy) return;
    text = String(text || '').trim();
    if (!text) { ER.showMsg(msg, 'Type a message for the studio first.'); return; }
    ER.hideMsg(msg); ER.hideMsg($('#startMsg'));
    S.messages.push({ role: 'user', content: text });
    persist(); renderAll();
    var live = { role: 'assistant', content: '' };
    var node = bubble(live, true); node.hidden = true;
    chat.appendChild(node);
    setBusy(true);
    $('#session').scrollIntoView({ behavior: 'smooth', block: 'start' });

    var failed = null;
    fetch('/api/evalroom/studio/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-evalroom-token': ER.token() || '' },
      body: JSON.stringify({ messages: forSending(S.messages) })
    }).then(function (r) {
      if (r.status === 401) { ER.store.del('token'); location.replace(ER.ROOM + '?next=' + encodeURIComponent(location.pathname)); throw new Error('Please sign in again.'); }
      if (!r.ok || !r.body) return r.json().then(function (d) { throw new Error(d.error || 'The studio could not answer. Please try again.'); }, function () { throw new Error('The studio could not answer. Please try again.'); });
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      var paint = null;
      function draw() { paint = null; node.hidden = false; $('#wait').classList.remove('on'); node.querySelector('.body').innerHTML = ER.md(live.content); }
      function handle(block) {
        var ev = 'message', data = '';
        block.split('\n').forEach(function (l) { if (l.indexOf('event:') === 0) ev = l.slice(6).trim(); else if (l.indexOf('data:') === 0) data += l.slice(5).trim(); });
        if (!data) return;
        var d; try { d = JSON.parse(data); } catch (e) { return; }
        if (ev === 'delta') { live.content += d.text; if (!paint) paint = requestAnimationFrame(draw); }
        else if (ev === 'error') failed = d.error;
        else if (ev === 'done' && typeof d.remainingToday === 'number') $('#leftToday').textContent = d.remainingToday + ' studio messages left for your team today.';
      }
      function pump() {
        return reader.read().then(function (x) {
          if (x.done) { if (buf.trim()) handle(buf); return; }
          buf += dec.decode(x.value, { stream: true });
          var parts = buf.split('\n\n'); buf = parts.pop();
          parts.forEach(handle);
          return pump();
        });
      }
      return pump();
    }).catch(function (e) { failed = failed || e.message || 'No connection. Check your internet and try again.'; })
      .then(function () {
        setBusy(false);
        if (live.content.trim()) {
          S.messages.push(live); persist();
          if (failed) ER.showMsg(msg, 'The answer was cut short. ' + failed);
        } else {
          // Nothing came back: take the question out of the saved conversation so it can be sent again.
          S.messages.pop(); persist();
          say.value = say.value || (text.length < 600 ? text : '');
          ER.showMsg(msg, failed || 'The studio could not answer. Please try again.');
        }
        renderAll();
      });
  }

  $('#write').addEventListener('click', function () {
    var o = fields.orig.value.trim(), v = fields.vocab.value.trim(), th = fields.theme.value.trim();
    if (o.length < 20) { ER.showMsg($('#startMsg'), 'Paste the original lyrics in box 1 first, or tap a free starter song.'); fields.orig.focus(); return; }
    if (v.length < 3) { ER.showMsg($('#startMsg'), 'Add your vocabulary list in box 2 so the studio can weave the words in.'); fields.vocab.focus(); return; }
    if (S.messages.length && !window.confirm('Start a new song? Your current studio conversation will be cleared.')) return;
    S.messages = [];
    var parts = ['Here are the original lyrics:\n\n' + o, 'My vocabulary list:\n' + v];
    if (th) parts.push('My theme: ' + th);
    parts.push('Rewrite mode: ' + fields.mode.value + '. Please create new lyrics for me using my vocabulary.');
    ask(parts.join('\n\n'));
  });
  send.addEventListener('click', function () { var v = say.value; say.value = ''; ask(v); });
  say.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); send.click(); } });
  $('#reset').addEventListener('click', function () {
    if (!window.confirm('Start a new song? Your current studio conversation will be cleared from this device.')) return;
    S.messages = []; persist(); ER.hideMsg(msg); renderAll(); $('#starter').scrollIntoView({ behavior: 'smooth' });
  });

  renderAll();
})();
