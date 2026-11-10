/* TopKpop.io — The Evaluation Room: rehearsal page for one judge */
(function () {
  'use strict';
  var $ = ER.$, esc = ER.esc;
  ER.chrome();
  if (!ER.requireSignIn()) return;

  var key = new URLSearchParams(location.search).get('j');
  var PAGES = {
    visual: {
      trove: '01', sub: 'Show the Visual Judge your avatar and your poster.',
      entryTitle: 'Upload your avatar and poster',
      directions: '/pages/trove-01', submit: '/pages/submit-trove-01',
      steps: function (S) { return [
        { html: '<b>Create your avatar and your poster.</b> The full steps are on the <a href="/pages/trove-01" target="_blank" rel="noopener">Trove 01 page</a>.' },
        { html: '<b>Upload your avatar</b> in box 1 below.', done: function () { return !!S.files.avatar; } },
        { html: '<b>Upload your poster</b> in box 2 below. The judge needs both pictures.', done: function () { return !!S.files.poster; } },
        { html: '<b>Press Rehearse.</b> The Visual Judge scores your work out of 100 and gives feedback.', done: function () { return S.count > 0; } },
        { html: '<b>Revise and rehearse again.</b> Improve your pictures and see what changed.', done: function () { return S.count > 1; } },
        { html: '<b>Take the stage.</b> When your team is happy, <a href="/pages/submit-trove-01">submit Trove 01 officially</a>.' }
      ]; },
      next: 'Use the feedback to improve your avatar or poster, then rehearse again. When your team is happy, submit Trove 01 officially.',
      nextBtns: [['Submit Trove 01 officially', '/pages/submit-trove-01', 'amber'], ['Trove 01 directions', '/pages/trove-01', 'ghost']]
    },
    lyric: {
      trove: '02', sub: 'Show the Lyric Judge your rewritten song.',
      entryTitle: 'Paste your lyrics', workLabel: 'Your full lyrics', placeholder: 'Paste your full rewritten lyrics here…',
      directions: '/pages/trove-02', submit: '/pages/submit-trove-02',
      steps: function (S) { return [
        { html: '<b>Write your lyrics.</b> Use the <a href="/pages/evaluation-room/studio/">Songwriting Studio</a> or your own draft. The full steps are on the <a href="/pages/trove-02" target="_blank" rel="noopener">Trove 02 page</a>.', done: function () { return S.textLen >= 20 || S.count > 0; } },
        { html: '<b>Paste your full lyrics</b> in the box below. Include at least 10 Spanish or Korean vocabulary words.', done: function () { return S.textLen >= 20; } },
        { html: '<b>Press Rehearse.</b> The Lyric Judge scores your lyrics out of 90 and gives feedback.', done: function () { return S.count > 0; } },
        { html: '<b>Revise and rehearse again.</b> Change your lyrics and see what moved.', done: function () { return S.count > 1; } },
        { html: '<b>Make your song for up to 10 more points.</b> Paste your final lyrics into <a href="https://suno.com" target="_blank" rel="noopener">Suno</a> and copy the share link.' },
        { html: '<b>Take the stage.</b> <a href="/pages/submit-trove-02">Submit Trove 02 officially</a> with your lyrics and your song link.' }
      ]; },
      next: 'Use the feedback to revise your lyrics, then rehearse again. When your team is happy, turn the lyrics into a song in Suno for up to 10 more points and submit Trove 02 officially.',
      nextBtns: [['Submit Trove 02 officially', '/pages/submit-trove-02', 'amber'], ['Open Suno', 'https://suno.com', 'ghost'], ['Back to the studio', '/pages/evaluation-room/studio/', 'ghost']]
    },
    lesson: {
      trove: '03', sub: 'Show the Lesson Judge your lesson plan.',
      entryTitle: 'Paste your lesson plan', workLabel: 'Your full lesson plan', placeholder: 'Paste your full lesson plan here…',
      directions: '/pages/trove-03', submit: '/pages/submit-trove-03',
      steps: function (S) { return [
        { html: '<b>Write your lesson plan.</b> The full steps are on the <a href="/pages/trove-03" target="_blank" rel="noopener">Trove 03 page</a>.', done: function () { return S.textLen >= 20 || S.count > 0; } },
        { html: '<b>Paste the full lesson plan</b> in the box below, including the ELA standard, the sub-skill and your movement phrases.', done: function () { return S.textLen >= 20; } },
        { html: '<b>Press Rehearse.</b> The Lesson Judge scores your plan out of 100 and gives coaching feedback.', done: function () { return S.count > 0; } },
        { html: '<b>Revise and rehearse again.</b> Strengthen the plan and see what moved.', done: function () { return S.count > 1; } },
        { html: '<b>Take the stage.</b> When your team is happy, <a href="/pages/submit-trove-03">submit Trove 03 officially</a>.' }
      ]; },
      next: 'Use the feedback to strengthen your lesson plan, then rehearse again. When your team is happy, submit Trove 03 officially.',
      nextBtns: [['Submit Trove 03 officially', '/pages/submit-trove-03', 'amber'], ['Trove 03 directions', '/pages/trove-03', 'ghost']]
    }
  };
  var P = PAGES[key];
  if (!P) { location.replace(ER.ROOM); return; }

  var S = { files: { avatar: null, poster: null }, textLen: 0, count: 0, remaining: null, busy: false };
  var J = null, dir = null, cfg = null;
  var work = $('#work'), msg = $('#msg'), go = $('#go');

  ER.config().then(function (c) {
    cfg = c;
    J = c.judges.filter(function (j) { return j.key === key; })[0];
    document.title = J.name + ' | The Evaluation Room | TopKpop.io';
    $('#eyebrow').textContent = 'The Evaluation Room · Trove ' + P.trove;
    $('#title').innerHTML = esc(J.name.replace(' Judge', '')) + ' <em>Judge</em>';
    $('#sub').textContent = P.sub;
    $('#entryTitle').textContent = P.entryTitle;
    $('#max').textContent = J.max;
    if (J.input === 'images') { $('#imageEntry').hidden = false; }
    else {
      $('#textEntry').hidden = false;
      $('#workLabel').textContent = P.workLabel;
      work.placeholder = P.placeholder;
      work.maxLength = c.maxTextChars;
      var draft = ER.store.get('draft:' + key);
      if (draft) work.value = draft;
      countText();
    }
    dir = ER.directions($('#dir'), {
      id: 'judge-' + key, title: 'Rehearse with the ' + J.name, steps: P.steps(S),
      help: 'Stuck? Watch the mission video on the <a href="' + P.directions + '" target="_blank" rel="noopener">Trove ' + P.trove + ' page</a> or <a href="/pages/jeannie?q=' + encodeURIComponent('Help me with Trove ' + parseInt(P.trove, 10)) + '" target="_blank" rel="noopener">ask Jeannie</a>.'
    });
    return loadHistory(true);
  }).catch(function (e) {
    if (e.status === 401) { location.replace(ER.ROOM + '?next=' + encodeURIComponent(location.pathname + location.search)); return; }
    ER.showMsg(msg, e.message);
  });

  // ── Text entry: autosave on this device ──
  var saveTimer = null;
  function countText() {
    S.textLen = work.value.trim().length;
    $('#count').textContent = work.value.length.toLocaleString() + (cfg ? ' / ' + cfg.maxTextChars.toLocaleString() : '') + ' characters';
    if (dir) dir.update();
  }
  work.addEventListener('input', function () {
    countText();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { ER.store.set('draft:' + key, work.value); $('#saved').textContent = 'Draft saved on this device ·'; }, 500);
  });

  // ── Picture entry ──
  function wireFile(name) {
    var input = $('#' + name), box = $('#' + name + 'Box');
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      ER.hideMsg(msg);
      if (f && cfg && f.size > cfg.maxImageMb * 1024 * 1024) {
        ER.showMsg(msg, 'That picture is over ' + cfg.maxImageMb + ' MB. Save a smaller copy and choose it again.');
        input.value = ''; f = null;
      }
      if (f && !/^image\/(png|jpeg|webp)$/.test(f.type)) {
        ER.showMsg(msg, 'Please choose a picture saved as PNG or JPG.');
        input.value = ''; f = null;
      }
      S.files[name] = f || null;
      box.classList.toggle('has', !!f);
      var img = box.querySelector('img');
      if (img.src) { try { URL.revokeObjectURL(img.src); } catch (e) {} }
      if (f) { img.src = URL.createObjectURL(f); box.querySelector('.name').textContent = f.name; } else { img.removeAttribute('src'); box.querySelector('.name').textContent = ''; }
      if (dir) dir.update();
    });
  }
  wireFile('avatar'); wireFile('poster');

  $('#clear').addEventListener('click', function () {
    if (J && J.input === 'images') {
      ['avatar', 'poster'].forEach(function (n) { $('#' + n).value = ''; $('#' + n).dispatchEvent(new Event('change')); });
    } else {
      if (work.value && !window.confirm('Clear the box? Your saved draft on this device will be removed.')) return;
      work.value = ''; ER.store.del('draft:' + key); $('#saved').textContent = ''; countText();
    }
    ER.hideMsg(msg);
  });

  // ── Rehearse ──
  function setBusy(b) {
    S.busy = b;
    go.disabled = b || S.remaining === 0;
    go.textContent = b ? 'Rehearsing…' : 'Rehearse';
    $('#wait').classList.toggle('on', b);
  }
  function leftLine() {
    var t = S.remaining === null ? '' : S.remaining === 0
      ? 'Your team has used all of its rehearsals with this judge. Submit officially when you are ready.'
      : 'Your team has ' + S.remaining + ' rehearsal' + (S.remaining === 1 ? '' : 's') + ' left with this judge. Rehearsals never change the leaderboard.';
    $('#leftLine').textContent = t;
    go.disabled = S.busy || S.remaining === 0;
  }

  go.addEventListener('click', function () {
    if (S.busy || !J) return;
    ER.hideMsg(msg);
    var opts;
    if (J.input === 'images') {
      if (!S.files.avatar || !S.files.poster) { ER.showMsg(msg, 'Please upload BOTH your avatar AND your poster so the judge can use the full rubric.'); return; }
      var fd = new FormData();
      fd.append('avatar', S.files.avatar); fd.append('poster', S.files.poster);
      opts = { form: fd };
    } else {
      if (work.value.trim().length < 20) { ER.showMsg(msg, key === 'lyric' ? 'Please paste your full lyrics so the judge can use the complete rubric.' : 'Please paste your full lesson plan so the judge can use the complete rubric.'); return; }
      ER.store.set('draft:' + key, work.value);
      opts = { json: { text: work.value } };
    }
    setBusy(true);
    ER.api('/rehearse/' + key, opts).then(function (r) {
      if (!r.ok) { ER.showMsg(msg, r.message, 'info'); return; }
      S.count = r.used; S.remaining = r.remaining;
      render(r, r.previous, true);
      leftLine();
      return loadHistory(false);
    }).catch(function (e) {
      if (e.status === 401) { location.replace(ER.ROOM + '?next=' + encodeURIComponent(location.pathname + location.search)); return; }
      if (e.data && e.data.remaining === 0) { S.remaining = 0; leftLine(); }
      ER.showMsg(msg, e.message);
    }).then(function () { setBusy(false); if (dir) dir.update(); });
  });

  // ── Showing a result ──
  function render(r, prev, fresh) {
    $('#result').hidden = false;
    $('#resultLabel').textContent = fresh ? 'Rehearsal score (practice only)' : 'Earlier rehearsal (practice only)';
    $('#score').textContent = r.score;
    var d = $('#delta');
    if (prev && typeof prev.score === 'number') {
      var diff = r.score - prev.score;
      d.hidden = false;
      d.className = 'er-delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : 'same');
      d.textContent = diff > 0 ? '▲ Up ' + diff + ' from your last rehearsal' : diff < 0 ? '▼ Down ' + Math.abs(diff) + ' from your last rehearsal' : 'Same as your last rehearsal';
    } else d.hidden = true;
    var prevCats = {};
    if (prev && prev.categories) prev.categories.forEach(function (c) { prevCats[c.name] = c.score; });
    $('#cats').innerHTML = (r.categories || []).map(function (c) {
      var chg = '';
      if (c.name in prevCats && prevCats[c.name] !== null) {
        var x = c.score - prevCats[c.name];
        if (x !== 0) chg = '<span class="chg ' + (x > 0 ? 'up' : 'down') + '">' + (x > 0 ? '+' : '−') + Math.abs(x) + '</span>';
      }
      return '<div class="er-cat"><div class="top"><span>' + esc(c.name) + '</span><b>' + c.score + ' / ' + c.max + chg + '</b></div><div class="er-bar"><i data-w="' + Math.round(100 * c.score / c.max) + '"></i></div></div>';
    }).join('');
    requestAnimationFrame(function () { document.querySelectorAll('#cats .er-bar i').forEach(function (i) { i.style.width = i.getAttribute('data-w') + '%'; }); });
    $('#summary').textContent = r.summary || '';
    $('#summary').hidden = !r.summary;
    $('#strengths').innerHTML = (r.strengths || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    $('#improveLabel').textContent = (J && J.improveLabel) || 'Improvement Suggestions';
    $('#improvements').innerHTML = (r.improvements || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    $('#nextText').textContent = P.next;
    $('#nextBtns').innerHTML = P.nextBtns.map(function (b) {
      var ext = /^https?:/.test(b[1]);
      return '<a class="er-btn small ' + b[2] + '" href="' + b[1] + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + esc(b[0]) + '</a>';
    }).join('');
    if (fresh) $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Earlier rehearsals ──
  var rows = [];
  function loadHistory(showLatest) {
    return ER.api('/rehearsals/' + key).then(function (h) {
      rows = h.rehearsals || [];
      S.count = h.used; S.remaining = h.remaining;
      leftLine();
      if (dir) dir.update();
      var box = $('#history');
      box.hidden = rows.length === 0;
      $('#histList').innerHTML = rows.map(function (r, i) {
        var when = new Date(r.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        return '<li><span>Rehearsal ' + (rows.length - i) + ' · ' + esc(when) + '</span><span><b>' + r.score + ' / ' + r.max_score + '</b> &nbsp;<button class="er-linkbtn" data-i="' + i + '">View</button>' +
          (r.input_text ? ' <button class="er-linkbtn" data-load="' + i + '">Load text</button>' : '') + '</span></li>';
      }).join('');
      if (showLatest && rows.length) render(rows[0], rows[1], false);
    });
  }
  $('#histList').addEventListener('click', function (ev) {
    var t = ev.target;
    if (t.hasAttribute('data-i')) { var i = +t.getAttribute('data-i'); render(rows[i], rows[i + 1], false); $('#result').scrollIntoView({ behavior: 'smooth' }); }
    if (t.hasAttribute('data-load')) {
      var r = rows[+t.getAttribute('data-load')];
      if (work.value.trim() && work.value !== r.input_text && !window.confirm('Replace what is in the box with the text from this rehearsal?')) return;
      work.value = r.input_text; ER.store.set('draft:' + key, work.value); countText();
      $('#entry').scrollIntoView({ behavior: 'smooth' });
    }
  });
})();
