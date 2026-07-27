// ========== 公共 Markdown 安全渲染 ==========
// 主站阅读页与公开分享页共用，避免两份逻辑漂移。
// 渲染策略（快显优先）：先用 marked+DOMPurify 立即渲染出内容；
// 若 Vditor 可用则在后台影子容器渲染，完成后无缝替换为更精细的排版。
// marked/DOMPurify 缺失时退化为转义纯文本。
(function (global) {
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // marked + DOMPurify 兜底净化；两者缺一则退化为转义纯文本
  function sanitizedMarkdown(md) {
    var text = md || '';
    if (global.marked && global.DOMPurify) {
      return global.DOMPurify.sanitize(global.marked.parse(text), { USE_PROFILES: { html: true } });
    }
    return '<pre>' + escapeHtml(text) + '</pre>';
  }

  // 渲染序号：同一容器再次渲染新内容时，作废上一次的后台 Vditor 替换
  var renderSeq = 0;

  // opts.onUpdate(el)：每次内容落到容器后调用（备用快显一次；Vditor 后台替换完成再一次），
  // 供调用方在替换后重建依赖正文 DOM 的内容（如大纲）。
  function renderMarkdownSafe(el, md, opts) {
    if (!el) return Promise.resolve();
    var text = md || '';
    var onUpdate = opts && typeof opts.onUpdate === 'function' ? opts.onUpdate : null;
    var seq = ++renderSeq;
    el.dataset.mdSeq = String(seq);

    // 第一步：备用方式立即渲染，内容马上可见
    try { el.innerHTML = sanitizedMarkdown(text); }
    catch (e) { el.innerHTML = '<pre>' + escapeHtml(text) + '</pre>'; }
    if (onUpdate) { try { onUpdate(el); } catch (e) {} }

    // 第二步：Vditor 可用则后台渲染，完成后替换（容器已渲染新内容则放弃）
    try {
      if (typeof global.Vditor !== 'undefined' && global.Vditor.preview) {
        var shadow = document.createElement('div');
        shadow.style.cssText = 'position:absolute;left:-99999px;top:0;width:720px;visibility:hidden;';
        document.body.appendChild(shadow);
        var cleanup = function () { try { shadow.remove(); } catch (e) {} };
        Promise.resolve(global.Vditor.preview(shadow, text, { mode: 'light', cdn: '/vendor/vditor' }))
          .then(function () {
            var stale = el.dataset.mdSeq !== String(seq) || !document.body.contains(el);
            var empty = !shadow.textContent.trim() && !shadow.querySelector('img, table, pre, blockquote, ul, ol');
            if (!stale && !empty) {
              el.innerHTML = shadow.innerHTML;
              if (onUpdate) { try { onUpdate(el); } catch (e) {} }
            }
            cleanup();
          })
          .catch(cleanup);
      }
    } catch (e) { /* 后台升级失败不影响已显示的备用渲染 */ }

    return Promise.resolve(el);
  }

  global.renderMarkdownSafe = renderMarkdownSafe;
})(window);
