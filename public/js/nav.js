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
  function session() {
    var token = stored('token'), team = stored('team');
    var here = location.pathname + location.search;
    // The Trove directions are for teams in the game: sign in once, then come straight back.
    if (!token && /^\/pages\/trove-0[123](\/|$)/.test(location.pathname)) { location.replace(SIGN_IN + '?next=' + encodeURIComponent(here)); return; }
    var list = document.querySelector('.nav-links');
    if (!list) return;
    function item(html) { var li = document.createElement('li'); li.innerHTML = html; list.appendChild(li); return li; }
    if (token) {
      item('<a href="' + SIGN_IN + '">Evaluation Room</a>');
      var name = team && team.name ? String(team.name).replace(/[&<>"']/g, '') : 'your team';
      var out = item('<a href="#" title="Signed in as ' + name + '">Sign Out</a>');
      out.querySelector('a').addEventListener('click', function (e) { e.preventDefault(); signOut(); });
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
