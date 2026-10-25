// ============== 全局悬浮「提交反馈」入口（2026-10-25） ==============
// 页面最左侧中央的竖排标签，主站任何页面常驻；点击展开悬浮提交面板。
// 表单本体在 js/feedback.js（懒加载复用，不复制提交/压缩逻辑）。
(function () {
  'use strict';

  function toast(msg) {
    if (typeof showToast === 'function') { showToast(msg); return; }
    if (window.projectAlert) window.projectAlert(msg);
  }

  // 与 feedback.js 的 currentUser 同款兼容：登录名是经典脚本顶层变量
  function loggedIn() {
    if (typeof username === 'string' && username) return true;
    if (window.username) return true;
    return false;
  }

  function ensureFeedback() {
    if (window.openFeedbackForm) return Promise.resolve();
    if (window.LazySections && window.LazySections.ensureSection) {
      return window.LazySections.ensureSection('feedback');
    }
    return Promise.reject(new Error('lazy sections unavailable'));
  }

  function onFabClick() {
    // 面板已开：走「取消」按钮的同一收口（含预览 URL 清理），点击即收起
    var closeBtn = document.querySelector('#fb-form-overlay [data-fb-act="close-form"]');
    if (closeBtn) { closeBtn.click(); return; }
    if (!loggedIn()) { toast('请先登录后再提交反馈'); return; }
    ensureFeedback().then(function () {
      if (window.openFeedbackForm) window.openFeedbackForm({ source: 'fab' });
      else toast('反馈组件加载失败，请刷新页面重试');
    }).catch(function () {
      toast('反馈组件加载失败，请刷新页面重试');
    });
  }

  function init() {
    if (document.getElementById('fb-fab')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'fb-fab';
    btn.className = 'fb-fab';
    // 带 data-fb-act，避免 feedback.js 的“点面板外收起”误关刚打开的面板
    btn.setAttribute('data-fb-act', 'fab');
    btn.setAttribute('aria-label', '提交反馈');
    btn.textContent = '提交反馈';
    btn.addEventListener('click', onFabClick);
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
