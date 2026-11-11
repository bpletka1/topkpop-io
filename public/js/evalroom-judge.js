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
        { html: '<b>Take the Stage.</b> When your team is happy, press Take the Stage under your score to lock it as official. A lock is final.', done: function () { return !!S.lock; } }
      ]; },
      next: 'Use the feedback to improve your avatar or poster, then rehearse again. When your team is happy, Take the Stage above.',
      nextBtns: [['Trove 01 directions', '/pages/trove-01', 'ghost']]
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
        { html: '<b>Take the Stage.</b> When your team is happy, press Take the Stage under your score to lock your lyrics as official. A lock is final.', done: function () { return !!S.lock; } },
        { html: '<b>Add your song for 10 more points.</b> Paste your locked lyrics into <a href="https://suno.com" target="_blank" rel="noopener">Suno</a> in Custom mode, tap Share, copy the link and turn it in here. Or make your song in the <a href="/pages/evaluation-room/karaoke/">Song Maker</a> and turn it in there.', done: function () { return !!(S.lock && S.lock.song_url); } }
      ]; },
      next: 'Use the feedback to revise your lyrics, then rehearse again. When your team is happy, Take the Stage above, then make your song in Suno for 10 more points.',
      nextBtns: [['Open Suno', 'https://suno.com', 'ghost'], ['Back to the studio', '/pages/evaluation-room/studio/', 'ghost']]
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
        { html: '<b>Take the Stage.</b> When your team is happy, press Take the Stage under your score to lock it as official. Add your dance video link there for 10 more points. A lock is final.', done: function () { return !!S.lock; } }
      ]; },
      next: 'Use the feedback to strengthen your lesson plan, then rehearse again. When your team is happy, Take the Stage above.',
      nextBtns: [['Trove 03 directions', '/pages/trove-03', 'ghost']]
    }
  };
  var P = PAGES[key];
  if (!P) { location.replace(ER.ROOM); return; }

  var S = { files: { avatar: null, poster: null }, textLen: 0, count: 0, remaining: null, busy: false, lock: null, shown: null, practice: false, songBonus: 10, danceBonus: 10 };
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
    return loadStage().then(function () { return loadHistory(true); });
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
      ? 'Your team has used all of its rehearsals with this judge. Choose one below and Take the Stage when you are ready.'
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
      if (r.repeat) ER.showMsg(msg, 'You already rehearsed this exact entry, so here is the score it earned. No rehearsal was used. Change your work to rehearse again.', 'info');
      leftLine();
      return loadHistory(false);
    }).catch(function (e) {
      if (e.status === 401) { location.replace(ER.ROOM + '?next=' + encodeURIComponent(location.pathname + location.search)); return; }
      if (e.data && e.data.remaining === 0) { S.remaining = 0; leftLine(); }
      ER.showMsg(msg, e.message);
      // If the connection dropped while the judge was working, the result may already be saved.
      if (!e.status) setTimeout(function () { var had = rows.length; loadHistory(false).then(function () { if (rows.length > had) { render(rows[0], rows[1], true); ER.showMsg(msg, 'Your connection dropped, but the judge finished. Here is your rehearsal.', 'info'); } }).catch(function () {}); }, 4000);
    }).then(function () { setBusy(false); if (dir) dir.update(); });
  });

  // ── Showing a result ──
  function render(r, prev, fresh) {
    $('#result').hidden = false;
    S.shown = r.id || null;
    updateStage();
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

  // ── Take the Stage ──
  function loadStage() {
    return ER.api('/stage').then(function (d) {
      S.lock = d.locks[key] || null; S.practice = d.practice; S.songBonus = d.songBonus; S.danceBonus = d.danceBonus;
      document.querySelectorAll('.songPts').forEach(function (n) { n.textContent = d.songBonus; });
      document.querySelectorAll('.dancePts').forEach(function (n) { n.textContent = d.danceBonus; });
      showOfficial(); updateStage();
    });
  }
  function showOfficial() {
    var L = S.lock, box = $('#official');
    box.hidden = !L;
    document.dispatchEvent(new CustomEvent('er:stage', { detail: { key: key, locked: !!L } }));
    if (!L) return;
    $('#offTotal').textContent = L.total; $('#offMax').textContent = L.max + (L.bonus ? ' + ' + L.bonus + ' bonus' : '');
    var canDance = key === 'lesson' && !L.dance_video_url; if ($('#addDance')) $('#addDance').hidden = !canDance;
    var b = $('#offBadge'); b.textContent = L.practice ? 'Practice lock (preview)' : 'Locked'; b.className = 'er-badge' + (L.practice ? ' practice' : '');
    var when = new Date(L.locked_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    var parts = [L.score + ' from the ' + (J ? J.name : 'judge')];
    if (L.bonus) parts.push(L.bonus + ' bonus');
    $('#offLine').textContent = parts.join(' + ') + '. Locked ' + when + '. ' + (L.practice ? 'This is a practice lock on the preview copy and does not reach the leaderboard.' : 'Your leaderboard score is updated. You can keep rehearsing for fun, but this score is final.');
    var hasSong = key === 'lyric' && !!L.song_url;
    $('#offSong').hidden = !hasSong;
    var roomSong = hasSong && /^room:/.test(L.song_url);
    $('#offPlayer').hidden = !!roomSong;
    if (roomSong && /^room:upload/.test(L.song_url)) { $('#offSongLink').removeAttribute('href'); $('#offSongLink').textContent = 'Your karaoke video was turned in as your team\u2019s song.'; }
    else if (roomSong) { $('#offSongLink').href = '/pages/evaluation-room/karaoke/'; $('#offSongLink').textContent = 'Your song \u201c' + (L.song_title || 'our song') + '\u201d was made in the Song Maker. Open the Song Maker'; }
    else if (hasSong) { if (L.embed_url && $('#offPlayer').src !== L.embed_url) $('#offPlayer').src = L.embed_url; $('#offSongLink').href = L.song_url; $('#offSongLink').textContent = 'Open \u201c' + (L.song_title || 'your song') + '\u201d on Suno'; }
    $('#addSong').hidden = !(key === 'lyric' && !L.song_url);
    $('#offLyrics').hidden = !(key === 'lyric' && L.locked_text);
    if (L.locked_text) $('#offLyricsText').textContent = L.locked_text;
  }
  function updateStage() {
    var box = $('#stage');
    box.hidden = !!S.lock || !S.shown;
    if (box.hidden) return;
    $('#stageIntro').textContent = 'Happy with this rehearsal? Lock it and the score you see becomes your team\u2019s official score for Trove ' + P.trove + '. The score you saw is the score you keep.' + (S.practice ? ' On this preview copy the lock is practice only.' : '');
    $('#songField').hidden = key !== 'lyric'; $('#danceField').hidden = key !== 'lesson'; $('#picsNote').hidden = key !== 'visual';
  }
  $('#offLyricsCopy').addEventListener('click', function () {
    var b = this, t = $('#offLyricsText').textContent, done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy locked lyrics'; }, 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function () {});
    else { var ta = ER.el('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) {} ta.remove(); }
  });
  $('#stageOpen').addEventListener('click', function () { $('#stagePanel').hidden = false; $('#stageOpen').hidden = true; });
  $('#stageCancel').addEventListener('click', function () { $('#stagePanel').hidden = true; $('#stageOpen').hidden = false; $('#stageConfirm').checked = false; $('#stageLock').disabled = true; ER.hideMsg($('#stageMsg')); });
  $('#stageConfirm').addEventListener('change', function () { $('#stageLock').disabled = !this.checked; });
  $('#songCheck').addEventListener('click', function () {
    var btn = this, m = $('#songMsg'), url = $('#songUrl').value.trim();
    if (!url) { ER.showMsg(m, 'Paste your Suno song link first.'); return; }
    btn.disabled = true; btn.textContent = 'Checking\u2026'; ER.hideMsg(m);
    ER.api('/stage/check-song', { json: { rehearsal_id: S.shown, song_url: url } })
      .then(function (d) { ER.showMsg(m, d.ok ? 'Song confirmed' + (d.title ? ': \u201c' + d.title + '\u201d' : '') + '. It matches these lyrics.' : d.message, d.ok ? 'info' : 'err'); })
      .catch(function (e) { ER.showMsg(m, e.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Check my song'; });
  });
  $('#stageLock').addEventListener('click', function () {
    var btn = this, m = $('#stageMsg'), opts;
    ER.hideMsg(m);
    if (key === 'visual') {
      var fd = new FormData(); fd.append('rehearsal_id', S.shown); fd.append('confirm', 'true');
      if (S.files.avatar && S.files.poster) { fd.append('avatar', S.files.avatar); fd.append('poster', S.files.poster); }
      opts = { form: fd };
    } else {
      opts = { json: { rehearsal_id: S.shown, confirm: 'true', song_url: $('#songUrl').value.trim(), dance_video_url: $('#danceUrl').value.trim() } };
    }
    if (!window.confirm('Lock ' + $('#score').textContent + ' out of ' + $('#max').textContent + ' as your team\u2019s official score for Trove ' + P.trove + '?\n\nThis is final. Your team cannot submit again for this Trove.')) return;
    btn.disabled = true; btn.textContent = 'Locking\u2026';
    ER.api('/stage/' + key, opts).then(function (d) {
      S.lock = d.lock; showOfficial(); updateStage(); if (dir) dir.update();
      $('#official').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) {
      if (e.data && e.data.lock) { S.lock = e.data.lock; showOfficial(); updateStage(); }
      ER.showMsg(m, e.message);
    }).then(function () { btn.textContent = 'Lock our official score'; btn.disabled = !$('#stageConfirm').checked; });
  });
  $('#songLaterBtn').addEventListener('click', function () {
    var btn = this, m = $('#songLaterMsg'), url = $('#songLater').value.trim();
    if (!url) { ER.showMsg(m, 'Paste your Suno song link first.'); return; }
    if (!window.confirm('Turn in this song? A team can turn in one song, and it cannot be changed.')) return;
    btn.disabled = true; btn.textContent = 'Checking\u2026'; ER.hideMsg(m);
    ER.api('/stage/lyric/song', { json: { song_url: url } })
      .then(function (d) { S.lock = d.lock; showOfficial(); if (dir) dir.update(); })
      .catch(function (e) { if (e.data && e.data.lock) { S.lock = e.data.lock; showOfficial(); } ER.showMsg(m, e.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Turn in my song'; });
  });

  if ($('#danceLaterBtn')) $('#danceLaterBtn').addEventListener('click', function () {
    var btn = this, m = $('#danceLaterMsg'), url = $('#danceLater').value.trim();
    if (!url) { ER.showMsg(m, 'Paste your dance video link first.'); return; }
    if (!window.confirm('Add this dance video? It can be added once.')) return;
    btn.disabled = true; btn.textContent = 'Adding\u2026'; ER.hideMsg(m);
    ER.api('/stage/lesson/dance', { json: { dance_video_url: url } })
      .then(function (d) { S.lock = d.lock; showOfficial(); if (dir) dir.update(); })
      .catch(function (e) { if (e.data && e.data.lock) { S.lock = e.data.lock; showOfficial(); } ER.showMsg(m, e.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Add our dance video'; });
  });
  // An extra task was turned in: show the new total.
  document.addEventListener('er:extras-changed', function () { loadStage().catch(function () {}); });

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
        return '<li><span>Rehearsal ' + (rows.length - i) + ' · ' + esc(when) + (S.lock && S.lock.rehearsal_id === r.id ? ' <span class="er-badge">Official</span>' : '') + '</span><span><b>' + r.score + ' / ' + r.max_score + '</b> &nbsp;<button class="er-linkbtn" data-i="' + i + '">View</button>' +
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
