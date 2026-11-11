/* TopKpop.io — The Evaluation Room: Song Maker extras (karaoke video, song points) */
(function () {
  'use strict';
  if (!window.ER || !ER.token()) return;
  var $ = ER.$, cur = null, sung = null, poll = null, lock = null;

  // ── Karaoke video ──
  var make = $('#vidMake'), save = $('#vidSave'), wait = $('#vidWait'), msg = $('#vidMsg');
  function show(d) {
    clearTimeout(poll);
    make.hidden = d.status === 'ready' || d.status === 'working'; save.hidden = d.status !== 'ready'; wait.hidden = d.status !== 'working';
    make.disabled = false; make.textContent = d.outOfDate ? 'Make the video again' : 'Make the karaoke video';
    if (d.status === 'ready' && !d.download_url) { d = { status: 'failed', error: 'The video is made, but the download link could not be prepared. Reload the page to try again.' }; save.hidden = true; }
    if (d.status === 'ready') { save.href = d.download_url; save.setAttribute('download', d.file_name || 'karaoke.mp4'); ER.hideMsg(msg); }
    if (d.status === 'working') { wait.textContent = 'Making your video… this usually takes under a minute. Keep this page open.'; var id = cur; poll = setTimeout(function () { check(id); }, 4000); }
    if (d.status === 'failed') ER.showMsg(msg, d.error || 'The video could not be made this time. Please try again.');
    if (d.status === 'none' && d.outOfDate) ER.showMsg(msg, 'The timing changed since your last video, so it needs making again.', 'info');
  }
  function check(id) {
    if (id !== cur) return;
    ER.api('/karaoke/' + id + '/video').then(function (d) { if (id === cur) show(d); }).catch(function () { if (id === cur) poll = setTimeout(function () { check(id); }, 6000); });
  }
  document.addEventListener('er:karaoke-open', function (e) {
    var id = e.detail.id; if (id !== cur) { cur = id; ER.hideMsg(msg); ER.hideMsg($('#turnInKMsg')); }
    check(id); points();
  });
  make.addEventListener('click', function () {
    if (!cur) return; var id = cur;
    ER.hideMsg(msg); make.disabled = true; make.textContent = 'Starting…';
    start(id, 0);
  });
  // When the video maker is busy with other teams, wait in line and try again without the team having to tap.
  function start(id, tries) {
    ER.api('/karaoke/' + id + '/video', { method: 'POST', json: {} }).then(function (d) { if (id === cur) show(d); })
      .catch(function (e) {
        if (id !== cur) return;
        if (e.status === 503 && e.data && e.data.busy && tries < 20) {
          wait.hidden = false; wait.textContent = 'The video maker is busy with other teams. Your video is in line and will start by itself. Keep this page open.';
          make.textContent = 'Waiting in line…'; poll = setTimeout(function () { start(id, tries + 1); }, 7000); return;
        }
        wait.hidden = true; make.disabled = false; make.textContent = 'Make the karaoke video'; ER.showMsg(msg, e.message);
      });
  }
  // Fixing or resetting the timing puts the video out of date: look again shortly after.
  document.addEventListener('er:karaoke-timing', function () { if (cur) check(cur); });

  // ── Song points (+10) ──
  function points() {
    return ER.api('/stage').then(function (d) {
      lock = d.locks && d.locks.lyric;
      var open = !!(lock && !lock.song_url);
      $('#turnInK').hidden = !(open && cur); $('#turnInS').hidden = !(open && sung);
    }).catch(function () {});
  }
  function turnIn(kind, id, btn, m) {
    if (!id) return;
    if (!window.confirm('Turn in this song for your team? You can only turn in one song, and it cannot be swapped later.')) return;
    ER.hideMsg(m); btn.disabled = true;
    ER.api('/stage/lyric/room-song', { json: { kind: kind, id: id } }).then(function (d) {
      ER.showMsg(m, 'Song turned in. ' + (d.bonus || 10) + ' points added to your Lyric score.', 'info');
      $('#turnInKBtn').hidden = true; $('#turnInS').hidden = true; lock = d.lock;
    }).catch(function (e) { ER.showMsg(m, e.message); }).then(function () { btn.disabled = false; });
  }
  $('#turnInKBtn').addEventListener('click', function () { turnIn('karaoke', cur, this, $('#turnInKMsg')); });
  $('#turnInS').addEventListener('click', function () { turnIn('sung', sung, this, $('#turnInSMsg')); });
  document.addEventListener('er:sung-open', function (e) { sung = e.detail.id; ER.hideMsg($('#turnInSMsg')); points(); });
})();
