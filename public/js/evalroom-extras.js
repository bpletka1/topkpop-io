/* TopKpop.io — The Evaluation Room: extra tasks turned in after Take the Stage */
(function () {
  'use strict';
  var $ = ER.$;
  var key = new URLSearchParams(location.search).get('j');
  if (key !== 'visual' && key !== 'lyric') return;
  var locked = false, busy = false;

  function show(d) {
    document.querySelectorAll('.xMax').forEach(function (n) { n.textContent = d.maxMb; });
    var any = false;
    if (key === 'visual') {
      var l = d.lore; any = l.locked;
      $('#xLore').hidden = !l.locked; $('#xLoreForm').hidden = !!l.item;
      $('#xLoreState').textContent = l.item ? 'Your team name story is turned in. ' + l.item.bonus + ' points were added.' : 'Tell the story behind your team name for ' + l.bonus + ' more points. They are added as soon as you turn it in.';
    } else {
      var k = d.karaokeVideo, p = d.avatarPerformance; any = k.locked;
      $('#xKara').hidden = !k.locked || (k.hasSong && !k.item); $('#xKaraForm').hidden = !!k.item || k.hasSong;
      $('#xKaraState').textContent = k.item ? 'Your karaoke video is turned in as your team’s song. ' + k.item.bonus + ' points were added.' : 'If your karaoke video was made outside this room (for example in MyKaraoke.Video), turn it in here as your team’s song for ' + k.bonus + ' points. A team turns in one song, and it cannot be changed.';
      $('#xPerf').hidden = !p.locked; $('#xPerfForm').hidden = !!p.item;
      $('#xPerfState').textContent = p.item ? 'Your avatar performance is turned in. ' + p.item.bonus + ' points were added.' : 'Have your Trove 01 avatar perform your song. Turn in the video for ' + p.bonus + ' more points. They are added as soon as you turn it in.';
    }
    $('#extraCard').hidden = !any;
  }
  function load() { if (!locked) { $('#extraCard').hidden = true; return Promise.resolve(); } return ER.api('/extras').then(show).catch(function () {}); }
  document.addEventListener('er:stage', function (ev) { if (ev.detail.key !== key) return; locked = ev.detail.locked; load(); });

  function send(btn, msg, label, waiting, opts, sure) {
    if (busy) return;
    if (sure && !window.confirm(sure)) return;
    busy = true; btn.disabled = true; btn.textContent = waiting; ER.hideMsg(msg);
    ER.api(opts.path, opts.body).then(function (d) {
      return load().then(function () { ER.showMsg(msg, 'Turned in. ' + d.bonus + ' points were added to your team’s score for this Trove.', 'info'); document.dispatchEvent(new CustomEvent('er:extras-changed')); });
    }).catch(function (e) { ER.showMsg(msg, e.message); }).then(function () { busy = false; btn.disabled = false; btn.textContent = label; });
  }
  function video(kind, fileEl, linkEl, btn, msg, label, sure) {
    var f = fileEl.files && fileEl.files[0], link = linkEl.value.trim();
    if (!f && !link) { ER.showMsg(msg, 'Choose your video file, or paste a link to it.'); return; }
    if (f && link) { ER.showMsg(msg, 'Give the video file or the link, not both.'); return; }
    var fd = new FormData(); fd.append('kind', kind); if (f) fd.append('file', f); else fd.append('link', link);
    send(btn, msg, label, f ? 'Uploading… keep this page open' : 'Turning in…', { path: '/extras/video', body: { form: fd } }, sure);
  }
  $('#xLoreBtn').addEventListener('click', function () {
    var t = $('#xLoreText').value.trim();
    if (t.length < 40) { ER.showMsg($('#xLoreMsg'), 'Write 2 to 4 sentences telling the story behind your team name.'); return; }
    send(this, $('#xLoreMsg'), 'Turn in our story', 'Turning in…', { path: '/extras/lore', body: { json: { text: t } } }, 'Turn in this story? It can be turned in once.');
  });
  $('#xKaraBtn').addEventListener('click', function () { video('karaoke-video', $('#xKaraFile'), $('#xKaraLink'), this, $('#xKaraMsg'), 'Turn in our karaoke video', 'Turn in this karaoke video as your team’s song? A team can turn in one song, and it cannot be changed.'); });
  $('#xPerfBtn').addEventListener('click', function () { video('avatar-performance', $('#xPerfFile'), $('#xPerfLink'), this, $('#xPerfMsg'), 'Turn in our avatar performance', 'Turn in this video? It can be turned in once.'); });
})();
