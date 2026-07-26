// ========== 公共 Markdown 安全渲染 ==========
// 主站阅读页与公开分享页共用，避免两份逻辑漂移。
// 渲染策略：优先 Vditor.preview（自带净化）；Vditor 缺失/超时/失败时，
// 用 marked 解析后经 DOMPurify 净化兜底；再不行退化为转义纯文本。
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

  function renderMarkdownSafe(el, md) {
    if (!el) return Promise.resolve();
    var text = md || '';
    el.innerHTML = '';
    function fallback() {
      try { el.innerHTML = sanitizedMarkdown(text); }
      catch (e) { el.innerHTML = '<pre>' + escapeHtml(text) + '</pre>'; }
      return el;
    }
    try {
      if (typeof global.Vditor !== 'undefined' && global.Vditor.preview) {
        return Promise.resolve(global.Vditor.preview(el, text, {
          mode: 'light',
          cdn: '/vendor/vditor'
        })).then(function () {
          if (!el.textContent.trim() && !el.querySelector('img, table, pre, blockquote, ul, ol')) fallback();
          return el;
        }).catch(function () {
          return fallback();
        });
      } else {
        return Promise.resolve(fallback());
      }
    } catch (e) {
      return Promise.resolve(fallback());
    }
  }

  global.renderMarkdownSafe = renderMarkdownSafe;
})(window);
