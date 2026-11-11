/* TopKpop.io — The Evaluation Room: Song Maker (karaoke) */
(function () {
  'use strict';
  var $ = ER.$, esc = ER.esc;
  ER.chrome();
  if (!ER.requireSignIn()) return;
  ER.config().catch(function () {});

  var S = { songs: [], current: null, lines: [], poll: null, fixing: false, taps: [] };
  var audio = $('#audio'), f = { title: $('#title'), orig: $('#orig'), neu: $('#neu'), song: $('#song'), rights: $('#rights') };
  // Same rule the server uses: labels like [Chorus] or "Verse 1" are skipped, sung lines are kept.
  var lines = function (t) { return String(t || '').split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && !/^\[[^\]]*\]$/.test(l) && !/^(verse|chorus|bridge|intro|outro|pre-chorus|hook|refrain)\s*\d*\s*[:.-]?$/i.test(l); }); };

  // ── Start with what the team already has ──
  var studio = ER.store.get('studio:draft') || {}, saved = ER.store.get('karaoke:draft') || {};
  f.title.value = saved.title || '';
  f.orig.value = saved.orig || studio.orig || '';
  f.neu.value = saved.neu || ER.store.get('draft:lyric') || '';
  ER.api('/stage').then(function (d) { var L = d.locks.lyric; if (L && L.locked_text && !saved.neu) { f.neu.value = L.locked_text; hint(); } }).catch(function () {});
  var t = null;
  function hint() {
    var a = lines(f.orig.value).length, b = lines(f.neu.value).length, h = $('#lineHint');
    h.style.color = '';
    if (a && b && a !== b) h.textContent = 'Your new lyrics have ' + b + ' lines and box 2 has ' + a + '. That is fine if the recording is only part of the song: the room matches your lines, in order, to the lines it hears.';
    else h.textContent = 'Lyrics only, please: leave out the song title. Each new line takes the timing of the matching line in the recording.' + (a && b ? ' Both boxes have ' + a + ' lines.' : '');
    dir.update();
  }
  ['title', 'orig', 'neu'].forEach(function (k) { f[k].addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { ER.store.set('karaoke:draft', { title: f.title.value, orig: f.orig.value, neu: f.neu.value }); hint(); }, 400); }); });
  f.song.addEventListener('change', function () { dir.update(); });

  var dir = ER.directions($('#dir'), {
    id: 'karaoke', title: 'Make your karaoke song',
    intro: 'The room keeps the music, takes out the singing, and lights up your new lyrics in time.',
    steps: [
      { html: '<b>Finish your lyrics first.</b> Write them in the <a href="/pages/evaluation-room/studio/">Songwriting Studio</a> and rehearse with the <a href="/pages/evaluation-room/judge/?j=lyric">Lyric Judge</a>.', done: function () { return lines(f.neu.value).length >= 2 || S.songs.length > 0; } },
      { html: '<b>Choose the original song file</b> in box 1. It must be a song your team bought or may use.', done: function () { return !!(f.song.files && f.song.files[0]) || S.songs.length > 0; } },
      { html: '<b>Paste your new lyrics</b> in box 3, one line per line. The original lyrics in box 2 help the room find each line, but you can leave box 2 empty.', done: function () { return lines(f.neu.value).length >= 2 || S.songs.length > 0; } },
      { html: '<b>Press Make my song.</b> It takes a few minutes.', done: function () { return S.songs.length > 0; } },
      { html: '<b>Press Play and sing along.</b> If a line is out of step, use Fix the timing.', done: function () { return !!ER.store.get('karaoke:played'); } }
    ],
    help: 'Song in another language? Use <a href="https://www.mykaraoke.video" target="_blank" rel="noopener">MyKaraoke.Video</a>. Stuck? Watch the mission video on the <a href="/pages/trove-02" target="_blank" rel="noopener">Trove 02 page</a> or <a href="/pages/jeannie?q=Help+me+with+Trove+2" target="_blank" rel="noopener">ask Jeannie</a>.'
  });
  hint();

  // ── List of songs ──
  function loadList() {
    return ER.api('/karaoke').then(function (d) {
      S.songs = d.songs; $('#maxMb').textContent = d.maxMb;
      var today = d.songs.filter(function (s) { return s.status !== 'failed' && Date.now() - new Date(s.created_at).getTime() < 864e5; }).length;
      $('#leftToday').textContent = Math.max(0, d.perDay - today) + ' of ' + d.perDay + ' songs left today';
      if (!d.ready) ER.showMsg($('#makeMsg'), 'The song maker is not switched on yet.', 'info');
      $('#mine').hidden = !d.songs.length;
      $('#songList').innerHTML = d.songs.map(function (s) {
        var when = new Date(s.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        var state = s.status === 'ready' ? '<button class="er-linkbtn" data-id="' + esc(s.id) + '">Open</button> <button class="er-linkbtn" data-del="' + esc(s.id) + '">Delete</button>' : s.status === 'failed' ? '<span style="color:#ff9dc4">' + esc(s.error || 'Did not work') + '</span>' : '<button class="er-linkbtn" data-id="' + esc(s.id) + '">In progress…</button>';
        return '<li><span><b>' + esc(s.title || 'Our song') + '</b> · ' + esc(when) + '</span><span>' + state + '</span></li>';
      }).join('');
      dir.update();
      return d;
    });
  }
  $('#songList').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-id]'); if (b) { open(b.getAttribute('data-id'), true); return; }
    var d = ev.target.closest('button[data-del]'); if (!d) return;
    if (!window.confirm('Delete this song and its music track? This cannot be undone.')) return;
    var id = d.getAttribute('data-del');
    ER.api('/karaoke/' + id + '/delete', { json: {} }).then(function () {
      if (S.current && S.current.id === id) { audio.pause(); audio.removeAttribute('src'); audio.removeAttribute('data-id'); $('#player').hidden = true; S.current = null; }
      return loadList();
    }).catch(function (e) { ER.showMsg($('#makeMsg'), e.message); });
  });

  // ── Making a song ──
  $('#make').addEventListener('click', function () {
    var m = $('#makeMsg'), btn = this, file = f.song.files && f.song.files[0];
    ER.hideMsg(m);
    if (!file) { ER.showMsg(m, 'Choose the original song file in box 1.'); return; }
    if (lines(f.neu.value).length < 2) { ER.showMsg(m, 'Paste your new lyrics in box 3, one line per line.'); return; }
    if (!f.rights.checked) { ER.showMsg(m, 'Tick the box to confirm your team bought this song or has the right to use it.'); return; }
    var fd = new FormData();
    fd.append('song', file); fd.append('title', f.title.value); fd.append('original_lyrics', f.orig.value); fd.append('new_lyrics', f.neu.value); fd.append('rights', 'true');
    btn.disabled = true; btn.textContent = 'Uploading…';
    ER.api('/karaoke', { form: fd }).then(function (d) {
      if (d.lineNote) ER.showMsg(m, d.lineNote, 'info');
      return loadList().then(function () { open(d.song.id, true); });
    }).catch(function (e) { ER.showMsg(m, e.message); m.scrollIntoView({ behavior: 'smooth', block: 'center' }); })
      .then(function () { btn.disabled = false; btn.textContent = 'Make my song'; });
  });

  // ── Opening a song: progress, then the player ──
  var blips = 0;
  function open(id, scroll) {
    clearTimeout(S.poll);
    ER.api('/karaoke/' + id).then(function (d) {
      blips = 0;
      var s = d.song; S.current = s;
      if (s.status === 'ready') { $('#progress').hidden = true; showPlayer(d); if (scroll) $('#player').scrollIntoView({ behavior: 'smooth', block: 'start' }); loadList(); return; }
      if (s.status === 'failed') { $('#progress').hidden = true; var m = $('#makeMsg'); ER.showMsg(m, s.error || 'The song could not be prepared. Please try again.'); m.scrollIntoView({ behavior: 'smooth', block: 'center' }); loadList(); return; }
      $('#progress').hidden = false; $('#progTitle').textContent = s.note || 'Working on it';
      var order = ['queued', 'splitting', 'timing', 'ready'], at = order.indexOf(s.status);
      document.querySelectorAll('#progSteps .er-step').forEach(function (li, i) { li.classList.toggle('done', i < at); li.classList.toggle('now', i === at); li.querySelector('.dot').textContent = i < at ? '\u2713' : String(i + 1); });
      if (scroll) $('#progress').scrollIntoView({ behavior: 'smooth', block: 'start' });
      S.poll = setTimeout(function () { open(id, false); }, 5000);
    }).catch(function (e) {
      // A dropped connection should not end the wait: keep checking.
      if (!e.status && blips++ < 40 && !$('#progress').hidden) { $('#progTitle').textContent = 'Reconnecting\u2026'; S.poll = setTimeout(function () { open(id, false); }, 6000); return; }
      ER.showMsg($('#makeMsg'), e.message);
    });
  }

  // ── The player ──
  function fmt(x) { x = Math.max(0, x || 0); return Math.floor(x / 60) + ':' + ('0' + Math.floor(x % 60)).slice(-2); }
  function showPlayer(d) {
    S.lines = d.lines || [];
    document.dispatchEvent(new CustomEvent('er:karaoke-open', { detail: { id: d.song.id } }));
    $('#player').hidden = false; $('#playerTitle').textContent = d.song.title || 'Our song';
    if (audio.getAttribute('data-id') !== d.song.id || audio.getAttribute('data-stale')) { audio.src = d.audio_url; audio.setAttribute('data-id', d.song.id); audio.removeAttribute('data-stale'); $('#seek').value = 0; $('#seek').max = 100; }
    var q = d.song.quality || {}, w = $('#timingWarn'), parts = [];
    w.hidden = true; w.className = 'er-warn';
    if (!d.song.edited) {
      if (q.mode === 'nothing-heard' || !S.lines.length) parts.push('<b>The room could not hear any singing in this file.</b> Check that it is the full song with vocals, then make it again. You can also press Fix the timing and tap the lines in yourself.');
      else {
        if (q.mode === 'matched' && q.sungLines < q.originalLines) parts.push('<b>The room heard ' + q.sungLines + ' of the ' + q.originalLines + ' lines in box 2 in this recording</b> and timed your lyrics to those. Lines that are not in the recording were left out.');
        if (q.mode === 'heard-instead' && q.reasons && q.reasons.indexOf('line-counts-differ') !== -1) parts.push('<b>Box 2 and box 3 have different numbers of lines,</b> so the room went by ear and put your lines, in order, on the lines it heard sung.');
        else if (q.mode === 'heard-instead') parts.push('<b>The words in box 2 are not the words sung in this recording,</b> so the room went by ear and timed your lyrics to the lines it heard.');
        if (q.mode === 'heard-only') parts.push('<b>The room went by ear</b> and timed your lyrics to the lines it heard.');
        if (q.mode === 'no-listening') parts.push('<b>Some lines may be out of step.</b>');
        if (q.reasons && q.reasons.indexOf('more-singing-than-lyrics') !== -1) parts.push('<b>The room heard more singing than box 2 has lines for</b> (a chorus sung twice, perhaps), so part of the song may show no words.');
        if (q.linesLeftOut) parts.push(q.linesLeftOut + ' of your ' + q.newLines + ' new lines are not shown, because the room ran out of sung lines to put them on.');
        if (q.reasons && q.reasons.indexOf('used-listening-times') !== -1) parts.push('The timing is approximate for this recording.');
        if (parts.length) parts.push('Play it through, and use Fix the timing if a line lights up early or late.');
      }
      if (parts.length) { w.hidden = false; w.innerHTML = parts.join(' '); if (q.level !== 'poor') w.className = 'er-msg on info'; }
    }
    $('#fixIntro').textContent = (d.song.edited ? 'Your team set this timing by tapping. ' : '') + 'If a line lights up too early or too late, fix it by tapping along once. Tap the big button each time a new line should start.';
    $('#fixReset').hidden = !d.canUndo;
    paint(0, true);
  }
  var shown = -2;
  function paint(time, force) {
    var L = S.lines, i = -1;
    for (var k = 0; k < L.length; k++) { if (time >= L[k].start - 0.15) i = k; }
    // During a long break after a line (or after the last line), show a music note instead of a stale line.
    var rest = i >= 0 && time > L[i].end + 2 && (i + 1 >= L.length || L[i + 1].start - time > 2);
    var keyNow = i + (rest ? 0.5 : 0);
    if (keyNow !== shown || force) {
      shown = keyNow;
      $('#kPrev').textContent = i > 0 ? L[i - 1].text : '';
      $('#kNext').textContent = i + 1 < L.length ? L[i + 1].text : '';
      var line = $('#kLine');
      if (i < 0) line.textContent = L.length ? '♪' : 'Press Play to start';
      else if (rest) line.textContent = '♪';
      else if (!rest) line.innerHTML = L[i].words.map(function (w, n) { return '<span class="w" data-n="' + n + '">' + esc(w.t) + '</span>'; }).join(' ');
    }
    if (i >= 0 && !rest) $('#kLine').querySelectorAll('.w').forEach(function (sp, n) { sp.classList.toggle('on', time >= L[i].words[n].s - 0.05); });
  }
  function tick() {
    if (!S.fixing) paint(audio.currentTime);
    if (audio.duration) { $('#seek').max = audio.duration; if (!seeking) $('#seek').value = audio.currentTime; }
    $('#clock').textContent = fmt(audio.currentTime) + (audio.duration ? ' / ' + fmt(audio.duration) : '');
    if (!audio.paused) requestAnimationFrame(tick);
  }
  var seeking = false;
  $('#seek').addEventListener('input', function () { seeking = true; });
  $('#seek').addEventListener('change', function () { audio.currentTime = +this.value; seeking = false; tick(); });
  $('#play').addEventListener('click', function () {
    if (audio.paused) audio.play().then(function () { ER.store.set('karaoke:played', true); dir.update(); }).catch(function () { ER.showMsg($('#playMsg'), 'The music could not start. Tap Play again, or reload the page.'); });
    else audio.pause();
  });
  $('#restart').addEventListener('click', function () { audio.currentTime = 0; tick(); });
  audio.addEventListener('play', function () { $('#play').textContent = 'Pause'; ER.hideMsg($('#playMsg')); requestAnimationFrame(tick); });
  audio.addEventListener('pause', function () { $('#play').textContent = 'Play'; });
  audio.addEventListener('ended', function () { $('#play').textContent = 'Play again'; if (S.fixing) finishFix(); });
  audio.addEventListener('loadedmetadata', function () { if (audio.duration) $('#seek').max = audio.duration; });
  var relinked = 0;
  audio.addEventListener('error', function () {
    if (!audio.getAttribute('src') || !S.current) return;
    // The private link lasts a few hours. Fetch a fresh one once, quietly.
    if (Date.now() - relinked > 60000) { relinked = Date.now(); audio.setAttribute('data-stale', '1'); open(S.current.id, false); return; }
    ER.showMsg($('#playMsg'), 'The music did not load. Check your connection and reload the page.');
  });

  // ── Fix the timing by tapping ──
  function fixShow() {
    var n = S.taps.length, L = S.lines;
    $('#fixLine').textContent = n < L.length ? L[n].text : 'All lines tapped';
    $('#fixCount').textContent = 'Line ' + Math.min(n + 1, L.length) + ' of ' + L.length;
    $('#tap').disabled = n >= L.length;
  }
  function endFix() { S.fixing = false; $('#fixPanel').hidden = true; $('#fixStart').hidden = false; $('#seek').disabled = false; $('#restart').disabled = false; $('#play').disabled = false; }
  function finishFix() {
    if (S.taps.length !== S.lines.length) { endFix(); ER.showMsg($('#playMsg'), 'Not every line was tapped, so the timing was left as it was.', 'info'); return; }
    audio.pause();
    ER.api('/karaoke/' + S.current.id + '/timings', { json: { starts: S.taps } }).then(function (d) {
      S.lines = d.lines; document.dispatchEvent(new CustomEvent('er:karaoke-timing')); endFix(); audio.currentTime = 0; paint(0, true); $('#timingWarn').hidden = true; $('#fixReset').hidden = false; ER.showMsg($('#playMsg'), 'Timing saved. Press Play to hear it. You can go back to the automatic timing at any time.', 'info');
    }).catch(function (e) { endFix(); ER.showMsg($('#playMsg'), e.message); });
  }
  $('#fixStart').addEventListener('click', function () {
    S.fixing = true; S.taps = []; $('#fixPanel').hidden = false; this.hidden = true; ER.hideMsg($('#playMsg'));
    $('#seek').disabled = true; $('#restart').disabled = true; $('#play').disabled = true; // the song must run straight through while tapping
    $('#kPrev').textContent = ''; $('#kNext').textContent = ''; $('#kLine').textContent = 'Listen and tap along';
    audio.currentTime = 0; fixShow(); audio.play().catch(function () {});
  });
  $('#tap').addEventListener('click', function () {
    if (!S.fixing) return;
    if (audio.paused) { audio.play().catch(function () {}); return; } // a tap only counts while the music is playing
    var at = Math.max(0, +(audio.currentTime - 0.12).toFixed(3)); // people tap a touch late
    if (S.taps.length && at < S.taps[S.taps.length - 1] + 0.3) return; // ignore a double tap
    S.taps.push(at);
    fixShow(); if (S.taps.length === S.lines.length) finishFix();
  });
  $('#fixUndo').addEventListener('click', function () {
    if (!S.fixing || !S.taps.length) return;
    var last = S.taps.pop();
    audio.currentTime = Math.max(0, (S.taps.length ? S.taps[S.taps.length - 1] : 0), last - 4); // back up a few seconds to try that line again
    fixShow(); if (audio.paused) audio.play().catch(function () {});
  });
  $('#fixReset').addEventListener('click', function () {
    if (!S.current || !window.confirm('Go back to the timing the room worked out? Your tapped timing will be replaced.')) return;
    ER.api('/karaoke/' + S.current.id + '/timings/reset', { json: {} }).then(function () { open(S.current.id, false); ER.showMsg($('#playMsg'), 'Back to automatic timing.', 'info'); }).catch(function (e) { ER.showMsg($('#playMsg'), e.message); });
  });
  $('#fixCancel').addEventListener('click', function () { audio.pause(); endFix(); paint(audio.currentTime, true); });

  loadList().then(function (d) {
    var live = d.songs.filter(function (s) { return s.status !== 'failed'; })[0];
    if (live) open(live.id, false);
  }).catch(function (e) { if (e.status === 401) location.replace(ER.ROOM + '?next=' + encodeURIComponent(location.pathname)); else ER.showMsg($('#makeMsg'), e.message); });
})();
