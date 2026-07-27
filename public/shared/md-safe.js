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
    var done = false;
    function fallback() {
      if (done) return el;
      done = true;
      try { el.innerHTML = sanitizedMarkdown(text); }
      catch (e) { el.innerHTML = '<pre>' + escapeHtml(text) + '</pre>'; }
      return el;
    }
    function tryVditor() {
      return new Promise(function (resolve) {
        var finished = false;
        // 影子容器：让 Vditor 渲染到此，避免超时降级后 Vditor 后台完成又覆盖 el
        var shadow = document.createElement('div');
        shadow.style.cssText = 'position:absolute;left:-99999px;top:0;width:720px;visibility:hidden;';
        document.body.appendChild(shadow);
        function cleanup() { try { shadow.remove(); } catch (e) {} }
        var timer = setTimeout(function () {
          if (finished) return;
          finished = true;
          cleanup();
          resolve(fallback());
        }, 2000);
        Promise.resolve(global.Vditor.preview(shadow, text, { mode: 'light', cdn: '/vendor/vditor' }))
          .then(function () {
            if (finished) { cleanup(); return resolve(el); }
            finished = true; clearTimeout(timer);
            el.innerHTML = shadow.innerHTML;
            if (!el.textContent.trim() && !el.querySelector('img, table, pre, blockquote, ul, ol')) el.innerHTML = sanitizedMarkdown(text);
            cleanup();
            resolve(el);
          })
          .catch(function () {
            if (finished) { cleanup(); return resolve(el); }
            finished = true; clearTimeout(timer);
            cleanup();
            resolve(fallback());
          });
      });
    }
    try {
      if (typeof global.Vditor !== 'undefined' && global.Vditor.preview) {
        return tryVditor();
      } else {
        return Promise.resolve(fallback());
      }
    } catch (e) {
      return Promise.resolve(fallback());
    }
  }

  global.renderMarkdownSafe = renderMarkdownSafe;
})(window);
