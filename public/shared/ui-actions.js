// ============== U-15 内联样式/内联事件统一处理（2026-10-21） ==============
// data-style="..." → MutationObserver 自动经 CSSOM 赋值（CSP style-src-attr 可收紧）
// data-act="funcName" + data-arg / data-args / data-use-value / data-use-event / data-click-target
//   → document 级事件委托（CSP script-src-attr 可收紧）
window.UiActions = (function () {
  'use strict';

  // ---- data-style → CSSOM ----
  function applyStyleAttr(el) {
    var css = el.getAttribute('data-style');
    if (css != null) {
      el.style.cssText = css;      // CSSOM，不受 CSP style-src-attr 约束
      el.removeAttribute('data-style');
    }
  }
  function processNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute && node.hasAttribute('data-style')) applyStyleAttr(node);
    if (node.querySelectorAll) {
      var els = node.querySelectorAll('[data-style]');
      for (var i = 0; i < els.length; i++) applyStyleAttr(els[i]);
    }
  }
  if (typeof MutationObserver !== 'undefined') {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var nodes = muts[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) processNode(nodes[j]);
      }
    });
    if (document.documentElement) {
      mo.observe(document.documentElement, { childList: true, subtree: true });
      processNode(document.documentElement); // 初始已有节点
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        mo.observe(document.documentElement, { childList: true, subtree: true });
        processNode(document.documentElement);
      });
    }
  }

  // ---- data-act 事件委托 ----
  function resolveFn(path) {
    var parts = String(path).split('.');
    var fn = window;
    for (var i = 0; i < parts.length; i++) {
      if (fn == null) return null;
      fn = fn[parts[i]];
    }
    return typeof fn === 'function' ? fn : null;
  }
  function handleAction(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (!act) return;
    // 隐藏控件代理点击（file input 等）
    if (act === '__click') {
      var target = document.getElementById(el.getAttribute('data-target') || '');
      if (target) target.click();
      return;
    }
    var fn = resolveFn(act);
    if (!fn) return;
    if (el.hasAttribute('data-prevent')) e.preventDefault();
    // 始终以触发元素为 this（与原生内联事件语义一致）
    if (el.hasAttribute('data-use-value')) fn.call(el, el.value);
    else if (el.hasAttribute('data-use-event')) fn.call(el, e);
    else if (el.hasAttribute('data-args')) fn.apply(el, JSON.parse(el.getAttribute('data-args')));
    else if (el.hasAttribute('data-arg')) {
      var raw = el.getAttribute('data-arg');
      var val;
      try { val = JSON.parse(raw); } catch (err) { val = raw; } // true/123 还原类型，普通串原样
      fn.call(el, val);
    } else {
      var args = [];
      for (var i = 1; ; i++) {
        var v = el.getAttribute('data-arg' + i);
        if (v == null) break;
        if (v === '__THIS__') { args.push(el); continue; } // 原内联 this 参数
        try { args.push(JSON.parse(v)); } catch (err) { args.push(v); }
      }
      if (args.length) fn.apply(el, args);
      else fn.call(el, e);
    }
  }
  ['click', 'change', 'input', 'submit'].forEach(function (ev) {
    document.addEventListener(ev, handleAction, true);
  });

  return { applyStyleAttr: applyStyleAttr, processNode: processNode };
})();
