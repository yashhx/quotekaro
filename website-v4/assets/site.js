/* TrackRakho site v4 - the only three behaviours the site needs.
   Everything else is CSS. No frameworks, no build step. */
(function () {
  "use strict";

  /* ---- 1. trade dropdown (click to open, Esc/outside to close) ---- */
  var dd = document.querySelector(".dd");
  if (dd) {
    var btn = dd.querySelector(".dd-btn");
    var menu = dd.querySelector(".dd-menu");
    var close = function () { menu.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); };
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = menu.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", function (e) { if (!dd.contains(e.target)) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }

  /* ---- 2. mobile nav ---- */
  var tog = document.querySelector(".hdr-toggle");
  var nav = document.querySelector(".nav");
  if (tog && nav) {
    tog.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      tog.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* ---- 3. reveal on scroll (skipped when the OS asks for less motion) ---- */
  var items = [].slice.call(document.querySelectorAll(".reveal"));
  if (!items.length) return;
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still || !("IntersectionObserver" in window)) {
    items.forEach(function (el) { el.classList.add("in"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var el = en.target;
      var delay = Number(el.getAttribute("data-delay") || 0);
      setTimeout(function () { el.classList.add("in"); }, delay);
      io.unobserve(el);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
  items.forEach(function (el) { io.observe(el); });
})();
