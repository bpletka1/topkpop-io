/* ============================================================
   TopKpop.io — Navigation & Shared UI
   ============================================================ */

(function () {
  'use strict';

  function init() {
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
