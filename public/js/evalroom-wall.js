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
    return '<article class="wall-item">' + media + '<div class="wall-meta"><b>' + esc(it.team || 'A team') + '</b><span>' +
      (it.kind === 'pictures' ? 'Avatar and poster' : esc(it.title || 'Karaoke video')) + ' · ' + esc(when) + '</span>' +
      (it.mine ? '<div class="er-row" style="margin-top:8px"><button class="er-linkbtn" data-remove="' + esc(it.id) + '">Take ours down</button></div>' : '') + '</div></article>';
  }

  function load() {
    return ER.api('/wall').then(function (d) {
      $('#bonusN').textContent = d.bonus;
      $('#grid').innerHTML = d.items.map(card).join(''); $('#empty').hidden = d.items.length > 0;
      var p = d.can.pictures, k = d.can.karaoke;
      $('#picsForm').hidden = !(p.locked && !p.shared);
      $('#picsState').innerHTML = p.shared ? 'Your team\'s avatar and poster are on the wall.' : p.locked ? 'Your team locked its avatar and poster. Ready to share.' : 'First take the stage with your avatar and poster in the <a href="/pages/evaluation-room/judge/?j=visual">Visual Judge</a>. Then you can share them here.';
      var canSong = k.locked && !k.shared && d.videoReady && k.songs.length > 0;
      $('#songForm').hidden = !canSong;
      $('#songPick').innerHTML = k.songs.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.title || 'Our song') + '</option>'; }).join('');
      $('#songState').innerHTML = k.shared ? 'Your team\'s karaoke video is on the wall.' : !k.locked ? 'First take the stage with your lyrics in the <a href="/pages/evaluation-room/judge/?j=lyric">Lyric Judge</a>.' : !d.videoReady ? 'Sharing videos is not switched on yet.' : !k.songs.length ? 'Make a karaoke song and its video in the <a href="/pages/evaluation-room/karaoke/">Song Maker</a> first.' : 'Choose your song. It needs its karaoke video made in the Song Maker first.';
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
      return load().then(function () { ER.showMsg(msg, 'Shared. ' + d.bonus + ' points were added to your team\'s score for this Trove.', 'info'); });
    }).catch(function (e) { ER.showMsg(msg, e.message); }).then(function () { busy = false; btn.disabled = false; btn.textContent = label; });
  }
  $('#picsBtn').addEventListener('click', function () { share('pictures', this, $('#picsOk'), $('#picsPublic'), $('#picsMsg')); });
  $('#songBtn').addEventListener('click', function () { share('karaoke', this, $('#songOk'), $('#songPublic'), $('#songMsg'), { id: $('#songPick').value }); });
  $('#refresh').addEventListener('click', function () { load().catch(function (e) { ER.showMsg($('#wallMsg'), e.message); }); });
  $('#grid').addEventListener('click', function (ev) {
    var id = ev.target.getAttribute('data-remove'); if (!id) return;
    if (!window.confirm('Take your team\'s work off the wall? The sharing points for this Trove will come off too.')) return;
    ER.api('/wall/' + id + '/remove', { method: 'POST', json: {} }).then(load).catch(function (e) { ER.showMsg($('#wallMsg'), e.message); });
  });
  load().catch(function (e) { ER.showMsg($('#wallMsg'), e.message); });
})();
