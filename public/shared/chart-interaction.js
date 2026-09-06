(function (window, document) {
  'use strict';
  var active = null, watched = new Map(), pending = false;
  function hide() { if (active) { active.hide(); active = null; } }
  function place(tip, event) {
    tip.style.position = 'fixed'; tip.style.maxWidth = Math.max(160, window.innerWidth - 24) + 'px';
    var rect = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(event.clientX + 12, window.innerWidth - rect.width - 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(event.clientY + 16, window.innerHeight - rect.height - 8)) + 'px';
  }
  function bind(target, tip, show, dismiss) {
    if (!target || !tip) return;
    var start = null;
    function close() { if (dismiss) dismiss(); else { tip.hidden = true; tip.style.display = 'none'; } }
    function open(event) { if (target.closest('.mv-dragging')) return; hide(); tip.hidden = false; show.call(target, event); place(tip, event); active = { target: target, hide: close }; }
    target.addEventListener('mousemove', open);
    target.addEventListener('mouseleave', function () { if (active && active.target === target) hide(); });
    target.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse') start = { x: e.clientX, y: e.clientY }; });
    target.addEventListener('pointerup', function (e) {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10) open(e);
      start = null;
    });
    target.addEventListener('pointercancel', function () { start = null; hide(); });
  }
  function adapt(target, tip) {
    if (!target || !tip || !target.onmousemove) return;
    var show = target.onmousemove, dismiss = target.onmouseleave;
    target.onmousemove = null; target.onmouseleave = null; bind(target, tip, show, dismiss);
  }
  function width(root, desktop) {
    var size = root && root.clientWidth;
    return window.innerWidth <= 760 && size > 0 ? Math.max(240, size) : desktop;
  }
  function refresh() {
    if (pending) return; pending = true;
    window.requestAnimationFrame(function () {
      pending = false; hide();
      watched.forEach(function (item, root) {
        if (!root.isConnected) { watched.delete(root); if (observer) observer.unobserve(root); return; }
        if (!root.clientWidth) return;
        var key = root.clientWidth + ':' + (window.innerWidth <= 760);
        if (key !== item.key) {
          var inputs = Array.from(root.querySelectorAll('input[id],select[id],textarea[id]')).map(function (el) { return { id: el.id, value: el.value, checked: el.checked }; });
          var focused = root.contains(document.activeElement) ? document.activeElement.id : null;
          item.key = key; item.render();
          inputs.forEach(function (input) { var el = document.getElementById(input.id); if (el && root.contains(el)) { el.value = input.value; el.checked = input.checked; } });
          if (focused) { var next = document.getElementById(focused); if (next) next.focus({ preventScroll: true }); }
        }
      });
    });
  }
  var observer = window.ResizeObserver ? new ResizeObserver(refresh) : null;
  function watch(root, render) {
    if (!root) return;
    if (!watched.has(root) && observer) observer.observe(root);
    watched.set(root, { key: root.clientWidth + ':' + (window.innerWidth <= 760), render: render });
  }
  document.addEventListener('pointerdown', function (e) { if (active && !active.target.contains(e.target)) hide(); });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', refresh);
  window.ChartInteraction = { bind: bind, adapt: adapt, place: place, width: width, watch: watch, hide: hide };
})(window, document);
