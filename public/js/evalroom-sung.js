/* TopKpop.io — The Evaluation Room: Hear it sung */
(function () {
  'use strict';
  if (!window.ER || !ER.token()) return;
  var $ = ER.$, esc = ER.esc, poll = null, styles = [], blips = 0, busy = false, sending = false, watching = null;
  var sel = $('#sungStyle'), btn = $('#sungMake'), msg = $('#sungMsg'), wait = $('#sungWait');
  if (!sel) return;

  function hint() { var s = styles.filter(function (x) { return x.key === sel.value; })[0]; $('#sungHint').textContent = s ? s.hint : ''; }
  sel.addEventListener('change', function () { hint(); ER.store.set('sung:style', sel.value); });

  function load() {
    return ER.api('/sung').then(function (d) {
      if (!styles.length) {
        styles = d.styles;
        sel.innerHTML = styles.map(function (s) { return '<option value="' + esc(s.key) + '">' + esc(s.label) + '</option>'; }).join('');
        var keep = ER.store.get('sung:style'); if (keep && styles.some(function (s) { return s.key === keep; })) sel.value = keep;
        hint();
      }
      var today = d.songs.filter(function (s) { return s.status !== 'failed' && Date.now() - new Date(s.created_at).getTime() < 864e5; }).length;
      $('#sungLeft').textContent = Math.max(0, d.perDay - today) + ' of ' + d.perDay + ' left today';
      busy = d.songs.some(function (s) { return s.status === 'queued' || s.status === 'singing'; });
      if (!d.ready) { ER.showMsg(msg, 'Hear it sung is not switched on yet.', 'info'); btn.disabled = true; }
      else if (!sending) { btn.disabled = busy; btn.textContent = busy ? 'Singing… please wait' : 'Sing my lyrics'; }
      $('#sungList').innerHTML = d.songs.map(function (s) {
        var when = new Date(s.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        var state = s.status === 'ready' ? '<button class="er-linkbtn" data-open="' + esc(s.id) + '">Play</button> <button class="er-linkbtn" data-del="' + esc(s.id) + '">Delete</button>' : s.status === 'failed' ? '<span style="color:#ff9dc4">' + esc(s.error || 'Did not work') + '</span> <button class="er-linkbtn" data-del="' + esc(s.id) + '">Remove</button>' : '<button class="er-linkbtn" data-open="' + esc(s.id) + '">In progress…</button>';
        return '<li><span><b>' + esc(s.title || 'Our song') + '</b> · ' + esc(s.styleLabel) + ' · ' + esc(when) + '</span><span>' + state + '</span></li>';
      }).join('');
      return d;
    });
  }

  function open(id, scroll) {
    if (!watching || watching === id) clearTimeout(poll);
    ER.api('/sung/' + id).then(function (d) {
      blips = 0;
      var s = d.song;
      if (s.status === 'ready') {
        if (watching === id) { watching = null; wait.hidden = true; }
        $('#sungPlayer').hidden = false; $('#sungName').textContent = (s.title || 'Our song') + ' · ' + s.styleLabel;
        $('#sungAudio').src = d.audio_url; $('#sungSave').href = d.download_url || d.audio_url;
        document.dispatchEvent(new CustomEvent('er:sung-open', { detail: { id: s.id } }));
        if (scroll) $('#sungPlayer').scrollIntoView({ behavior: 'smooth', block: 'center' });
        load(); return;
      }
      if (s.status === 'failed') { watching = null; wait.hidden = true; ER.showMsg(msg, s.error || 'The song could not be sung this time. Please try again.'); load(); return; }
      wait.hidden = false; wait.textContent = (s.note || 'Working on it') + '… This usually takes two to five minutes. Keep this page open; it updates by itself.';
      watching = id; poll = setTimeout(function () { open(id, true); }, 5000);
    }).catch(function (e) {
      if (++blips < 6) { poll = setTimeout(function () { open(id, scroll); }, 6000); return; }
      wait.hidden = true; ER.showMsg(msg, e.message);
    });
  }

  btn.addEventListener('click', function () {
    var file = $('#song').files && $('#song').files[0], lyrics = $('#neu').value;
    ER.hideMsg(msg);
    if (!file) { ER.showMsg(msg, 'Choose the original song file in box 1 above.'); return; }
    if (/\.(m4a|mp4|aac|ogg|flac)$/i.test(file.name)) { ER.showMsg(msg, 'The singer can only learn from MP3 or WAV files. This one is a different kind. Ask a grown-up to save the song as MP3, then choose it again.'); return; }
    if (lyrics.split('\n').filter(function (l) { return l.trim(); }).length < 2) { ER.showMsg(msg, 'Paste your new lyrics in box 3 above, one line per line.'); return; }
    if (!$('#rights').checked) { ER.showMsg(msg, 'Tick the box above to confirm your team bought this song or has the right to use it.'); return; }
    var fd = new FormData();
    fd.append('song', file); fd.append('title', $('#title').value); fd.append('lyrics', lyrics); fd.append('style', sel.value); fd.append('rights', 'true');
    sending = true; btn.disabled = true; btn.textContent = 'Uploading…';
    ER.api('/sung', { form: fd }).then(function (d) {
      if (d.lyricNote) ER.showMsg(msg, d.lyricNote, 'info');
      $('#sungPlayer').hidden = true;
      return load().then(function () { open(d.song.id, true); });
    }).catch(function (e) { ER.showMsg(msg, e.message); })
      .then(function () { sending = false; btn.disabled = busy; btn.textContent = busy ? 'Singing… please wait' : 'Sing my lyrics'; });
  });

  $('#sungList').addEventListener('click', function (e) {
    var o = e.target.getAttribute('data-open'), del = e.target.getAttribute('data-del');
    if (o) open(o, true);
    if (del && window.confirm('Remove this recording? This cannot be undone.')) {
      ER.api('/sung/' + del + '/delete', { method: 'POST' }).then(function () { var a = $('#sungAudio'); a.pause(); a.removeAttribute('src'); a.load(); $('#sungPlayer').hidden = true; return load(); }).catch(function (e2) { ER.showMsg(msg, e2.message); });
    }
  });

  load().then(function (d) { var busy = d.songs.filter(function (s) { return s.status === 'queued' || s.status === 'singing'; })[0]; if (busy) open(busy.id, false); }).catch(function () {});
})();
