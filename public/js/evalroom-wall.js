/* TopKpop.io — The Evaluation Room: The Wall */
(function () {
  'use strict';
  var $ = ER.$, esc = ER.esc;
  ER.chrome();
  if (!ER.requireSignIn()) return;
  ER.config().catch(function () {});
  var busy = false;

  function card(it) {
    var when = new Date(it.when).toLocaleDateString([], { month: 'short', day: 'numeric' });
    var media = '';
    if (it.kind === 'pictures' && it.images) {
      media = '<div class="wall-pics">' + ['avatar', 'poster'].map(function (s) {
        var im = it.images[s]; if (!im || !im.small) return '';
        return '<a href="' + esc(im.full || im.small) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + esc(im.small) + '" alt="' + esc(it.team) + ' ' + s + '" /></a>';
      }).join('') + '</div>';
    } else if (it.kind === 'karaoke' && it.embed && /^https:\/\/player\.vimeo\.com\//.test(it.embed)) {
      media = '<div class="wall-video"><iframe loading="lazy" src="' + esc(it.embed) + '" title="' + esc(it.team) + ' karaoke video" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>';
    }
    if (!media && it.audio) media = '<div class="wall-audio"><audio controls preload="none" src="' + esc(it.audio) + '"></audio></div>';
    if (!media && it.link && /^https:\/\//.test(it.link)) media = '<div class="wall-link"><a class="er-btn ghost small" href="' + esc(it.link) + '" target="_blank" rel="noopener">' + (it.kind === 'dance' ? 'Watch the dance video' : 'Listen to the song') + '</a></div>';
    return '<article class="wall-item">' + media + '<div class="wall-meta"><b>' + esc(it.team || 'A team') + '</b><span>' +
      (it.kind === 'pictures' ? 'Avatar and poster' : it.kind === 'dance' ? 'Dance video' : esc(it.title || 'Our song')) + ' · ' + esc(when) + '</span>' +
      (it.mine ? '<div class="er-row" style="margin-top:8px"><button class="er-linkbtn" data-remove="' + esc(it.id) + '">Take ours down</button></div>' : '') + '</div></article>';
  }

  function load() {
    return ER.api('/wall').then(function (d) {
      $('#bonusN').textContent = d.bonus;
      $('#grid').innerHTML = d.items.map(card).join(''); $('#empty').hidden = d.items.length > 0;
      var p = d.can.pictures, k = d.can.karaoke;
      $('#picsForm').hidden = !(p.locked && !p.shared);
      $('#picsState').innerHTML = p.shared === 'processing' ? 'Your team\'s avatar and poster are being put on the wall. Press Refresh in a minute.' : p.shared ? 'Your team\'s avatar and poster are on the wall.' : p.locked ? 'Your team locked its avatar and poster. Ready to share.' : 'First take the stage with your avatar and poster in the <a href="/pages/evaluation-room/judge/?j=visual">Visual Judge</a>. Then you can share them here.';
      var withVideo = k.songs.filter(function (s) { return s.hasVideo; });
      var t = k.turnedIn, opts = withVideo.map(function (s) { return '<option value="k:' + esc(s.id) + '">Karaoke video: ' + esc(s.title || 'Our song') + '</option>'; });
      // The song the team turned in can be shared as it is, unless it is a karaoke song (those are in the list above).
      if (t && !t.karaokeId) opts.unshift('<option value="song">The song we turned in: ' + esc(t.title) + '</option>');
      var canSong = k.locked && !k.shared && opts.length > 0 && (d.videoReady || (t && !t.karaokeId));
      $('#songForm').hidden = !canSong;
      $('#songPick').innerHTML = opts.join('');
      $('#songState').innerHTML = k.shared === 'processing' ? 'Your team\'s song is being put on the wall. Press Refresh in a minute.' : k.shared ? 'Your team\'s song is on the wall. A new video can take a few minutes before it plays.' : !k.locked ? 'First take the stage with your lyrics in the <a href="/pages/evaluation-room/judge/?j=lyric">Lyric Judge</a>.' : opts.length ? 'Choose what to share. Karaoke songs are listed once their video is made in the Song Maker.' : k.songs.length ? 'Your karaoke song still needs its video. Open it in the <a href="/pages/evaluation-room/karaoke/">Song Maker</a>, press Make the karaoke video, then come back.' : 'Turn in your song in the <a href="/pages/evaluation-room/judge/?j=lyric">Lyric Judge</a>, or make a karaoke video in the <a href="/pages/evaluation-room/karaoke/">Song Maker</a>. Then share it here.';
      var c = d.can.dance;
      $('#danceForm').hidden = !(c.locked && !c.shared && c.hasVideo);
      $('#danceState').innerHTML = c.shared ? 'Your team\'s dance video is on the wall.' : !c.locked ? 'First take the stage with your lesson plan in the <a href="/pages/evaluation-room/judge/?j=lesson">Lesson Judge</a>, and add your dance video link there.' : !c.hasVideo ? 'Your team did not add a dance video link when it took the stage, so there is no video to share.' : 'Your team locked its lesson plan with a dance video. Ready to share.';
      return d;
    });
  }

  function share(kind, btn, okBox, pubBox, msg, extra) {
    if (busy) return;
    ER.hideMsg(msg);
    if (!okBox.checked) { ER.showMsg(msg, 'Tick the first box to say your team agrees to share this with the other teams.'); return; }
    if (pubBox.checked && !window.confirm('You ticked the public Instagram box. That means anyone, not only teams in the game, may see this. Is your whole team happy with that?')) return;
    var label = btn.textContent; busy = true; btn.disabled = true; btn.textContent = kind === 'karaoke' ? 'Sharing… this can take a minute' : 'Sharing…';
    ER.api('/wall/share', { json: Object.assign({ kind: kind, confirm: 'true', public_ok: pubBox.checked ? 'true' : 'false' }, extra || {}) }).then(function (d) {
      okBox.checked = false; pubBox.checked = false;
      return load().then(function () { ER.showMsg(msg, 'Shared. ' + d.bonus + ' points were added to your team\'s score for this Trove.', 'info'); });
    }).catch(function (e) { ER.showMsg(msg, e.message); }).then(function () { busy = false; btn.disabled = false; btn.textContent = label; });
  }
  $('#picsBtn').addEventListener('click', function () { share('pictures', this, $('#picsOk'), $('#picsPublic'), $('#picsMsg')); });
  $('#songBtn').addEventListener('click', function () { var v = $('#songPick').value; if (v === 'song') share('song', this, $('#songOk'), $('#songPublic'), $('#songMsg')); else share('karaoke', this, $('#songOk'), $('#songPublic'), $('#songMsg'), { id: v.replace(/^k:/, '') }); });
  $('#danceBtn').addEventListener('click', function () { share('dance', this, $('#danceOk'), $('#dancePublic'), $('#danceMsg')); });
  $('#refresh').addEventListener('click', function () { load().catch(function (e) { ER.showMsg($('#wallMsg'), e.message); }); });
  $('#grid').addEventListener('click', function (ev) {
    var id = ev.target.getAttribute('data-remove'); if (!id) return;
    if (busy || !window.confirm('Take your team\'s work off the wall? The sharing points for this Trove will come off too.')) return;
    busy = true; ev.target.disabled = true;
    ER.api('/wall/' + id + '/remove', { method: 'POST', json: {} }).then(load).catch(function (e) { ER.showMsg($('#wallMsg'), e.message); }).then(function () { busy = false; });
  });
  load().catch(function (e) { ER.showMsg($('#wallMsg'), e.message); });
})();
