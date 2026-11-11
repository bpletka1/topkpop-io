/* ============================================================
   TopKpop.io — Navigation & Shared UI
   ============================================================ */

(function () {
  'use strict';

  // ── One sign-in for the whole site (the same one The Evaluation Room uses) ──
  var SIGN_IN = '/pages/evaluation-room/';
  function stored(k) { try { var v = localStorage.getItem('er:' + k); return v === null ? null : JSON.parse(v); } catch (e) { return null; } }
  function signOut() {
    try { var ks = []; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('er:') === 0) ks.push(k); } ks.forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
    location.href = '/';
  }
  function storageWorks() { try { localStorage.setItem('er:probe', '1'); localStorage.removeItem('er:probe'); return true; } catch (e) { return false; } }
  function session() {
    var token = stored('token'), team = stored('team');
    var here = location.pathname + location.search;
    // The Trove directions are for teams in the game: sign in once, then come straight back.
    // (A browser that will not keep a sign-in is let through, so it can never go round in circles.)
    if (!token && storageWorks() && /^\/pages\/(trove-0[123]|final-accusation)(\/|$)/.test(location.pathname)) { location.replace(SIGN_IN + '?next=' + encodeURIComponent(here)); return; }
    if (/^\/pages\/(admin|emails)(\/|$)/.test(location.pathname)) return;
    if (/^\/pages\/leaderboard(\/|$)/.test(location.pathname)) {
      fetch('/api/evalroom/schedule', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (g) {
        var nav = document.querySelector('nav');
        if (g.reveal && g.reveal.open && nav) nav.insertAdjacentHTML('afterend', '<p style="margin:0;padding:14px 20px;text-align:center;background:rgba(230,0,92,.18);font-size:.95rem;"><a href="/pages/final-reveal" style="color:#fff;font-weight:700;">The saboteur has been revealed. Watch the Final Reveal &rarr;</a></p>');
      }).catch(function () {});
    }
    var list = document.querySelector('.nav-links');
    if (!list) return;
    var asList = list.tagName === 'UL' || list.tagName === 'OL';
    function item(html) { var holder = document.createElement(asList ? 'li' : 'span'); holder.innerHTML = html; var node = asList ? holder : holder.firstChild; list.appendChild(node); return asList ? holder.querySelector('a') : node; }
    if (token) {
      item('<a href="' + SIGN_IN + '">Evaluation Room</a>');
      var name = team && team.name ? String(team.name).replace(/[&<>"']/g, '') : 'your team';
      item('<a href="/?signout=1" title="Signed in as ' + name + '">Sign Out</a>').addEventListener('click', function (e) { e.preventDefault(); signOut(); });
      var hero = document.querySelector('.hero-buttons a[href*="evaluation-room/?next="]');
      if (hero) { hero.textContent = 'Continue to Missions'; hero.setAttribute('href', '/pages/missions'); }
    } else {
      item('<a href="' + SIGN_IN + '?next=' + encodeURIComponent('/pages/missions') + '">Team Sign In</a>');
    }
  }

  function init() {
    session();
    // ── Hamburger menu toggle (mobile) ──
    var hamburger = document.querySelector('.nav-hamburger');
    var navLinks  = document.querySelector('.nav-links');

    if (hamburger && navLinks) {
      hamburger.addEventListener('click', function (e) {
        e.stopPropagation();
        navLinks.classList.toggle('open');
      });

      // Close menu when a nav link is tapped
      navLinks.addEventListener('click', function (e) {
        if (e.target.tagName === 'A') {
          navLinks.classList.remove('open');
        }
      });

      // Close menu when tapping outside the nav
      document.addEventListener('click', function (e) {
        if (!hamburger.contains(e.target) && !navLinks.contains(e.target)) {
          navLinks.classList.remove('open');
        }
      });
    }

    // ── Highlight active nav link based on current page ──
    var currentPath = window.location.pathname.replace(/\/$/, '') || '/';
    document.querySelectorAll('.nav-links a').forEach(function (link) {
      var href = link.getAttribute('href').replace(/\/$/, '');
      if (href === currentPath || (currentPath === '/' && href === '/index.html')) {
        link.classList.add('active');
      }
    });

    // ── Scroll-based nav shadow ──
    var nav = document.querySelector('nav') || document.querySelector('.nav');
    if (nav) {
      window.addEventListener('scroll', function () {
        nav.style.boxShadow = window.scrollY > 20
          ? '0 4px 40px rgba(0,0,0,0.6)'
          : 'none';
      });
    }

    // ── Smooth scroll for anchor links ──
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
      anchor.addEventListener('click', function (e) {
        var target = document.querySelector(anchor.getAttribute('href'));
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          if (navLinks) navLinks.classList.remove('open');
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
