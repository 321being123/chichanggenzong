// 公开分享页初始化：只读取当前证券的公开分析，不初始化账户、持仓、自选或后台配置。
// 复用主站同一套分析渲染脚本（stock-analysis.js / bond-analysis.js），不复制业务模板与计算。
(function () {
  'use strict';

  // 分析脚本引用同作用域的全局 username；分享页不加载 session.js，这里显式声明为未登录。
  // （bond-analysis.js 在"无快照"分支会读取它来区分文案，不能缺。）
  if (typeof window.username === 'undefined') window.username = null;

  // 分享页是只读公开页：丢弃"请点击刷新数据""登录后刷新"这类需要写操作或登录的提示，
  // 其余消息照常显示，避免把内部运维状态暴露给访客。
  if (typeof window.showToast !== 'function') {
    window.showToast = function (msg) {
      var text = String(msg == null ? '' : msg);
      if (/刷新数据|刷新行情|登录后|补采/.test(text)) return;
      var el = document.getElementById('toast');
      if (!el) return;
      el.textContent = text;
      el.classList.add('show');
      setTimeout(function () { el.classList.remove('show'); }, 3200);
    };
  }

  // 主站的分析分派逻辑在个别分支会切换栏目；分享页没有栏目导航，提供空实现兜底。
  if (typeof window.switchMain !== 'function') {
    window.switchMain = function () { return Promise.resolve(); };
  }

  function fail(title, message) {
    var messageEl = document.getElementById('stock-analysis-message');
    if (messageEl) {
      messageEl.textContent = message;
      messageEl.classList.add('stock-analysis-message-error');
    }
    var heading = document.getElementById('share-security-title');
    if (heading && title) heading.textContent = title;
  }

  function init() {
    var body = document.body;
    var kind = String(body.dataset.shareKind || '').trim();
    var canonical = String(body.dataset.shareCode || '').trim();
    var digits = canonical.replace(/\D/g, '').slice(0, 6);

    if (!kind || digits.length !== 6) {
      return fail('证券分析', '分享地址不完整，无法读取该证券的分析数据。');
    }

    // 类型必须与页面登记一致，避免用错误类型渲染别的品种。
    if (typeof window.securityAnalysisKind === 'function' && window.securityAnalysisKind(digits) !== kind) {
      return fail('证券分析', '分享地址的证券类型不一致，无法展示分析内容。');
    }

    if (typeof window.securityAnalysisSelect !== 'function') {
      return fail('证券分析', '页面脚本未就绪，请刷新后重试。');
    }

    window.securityAnalysisSelect(digits, kind);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
