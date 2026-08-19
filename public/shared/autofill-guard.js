// 非认证输入框统一禁止浏览器密码管理器接管，动态创建的表格/弹窗输入框同样覆盖。
(function () {
  'use strict';

  var CREDENTIAL_IDS = new Set([
    'username', 'password', 'reset-email', 'reset-pwd', 'reset-pwd2',
    'reg-pwd', 'reg-pwd2', 'email', 'pwd-old', 'pwd-new', 'pwd-new2'
  ]);

  function isCredentialField(el) {
    return el.hasAttribute('data-autofill-credential') || CREDENTIAL_IDS.has(el.id);
  }

  function isPasswordField(el) {
    return el.tagName === 'INPUT' && el.type === 'password';
  }

  function protect(el) {
    if (!el || !el.matches || !el.matches('input, textarea, select')) return;
    if (isCredentialField(el) || el.type === 'hidden') return;
    // 普通输入框默认保持普通表单语义；显式忽略标记使用兼容性防护。
    var autocompleteValue = isPasswordField(el) ? 'new-password' : 'off';
    // 部分浏览器会忽略普通搜索框的 autocomplete=off，显式标记的非认证输入框使用
    // new-password 作为防密码管理器识别的兼容策略，但不进入认证字段白名单。
    if (el.hasAttribute('data-autofill-ignore')) autocompleteValue = 'new-password';
    el.setAttribute('autocomplete', autocompleteValue);
    el.setAttribute('data-lpignore', 'true');
    el.setAttribute('data-1p-ignore', 'true');
    el.setAttribute('data-bwignore', 'true');
  }

  function protectTree(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches('input, textarea, select')) protect(root);
    root.querySelectorAll('input, textarea, select').forEach(protect);
  }

  var started = false;

  function init() {
    if (started) return;
    started = true;
    protectTree(document);
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.addedNodes.forEach(protectTree);
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // 立即接管已存在节点；DOMContentLoaded 之前新增的节点由观察器接管。
  init();
})();
