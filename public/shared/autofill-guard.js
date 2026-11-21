// 非认证输入框统一禁止浏览器密码管理器接管，动态创建的表格/弹窗输入框同样覆盖。
// 分类策略：
// A 类：真实登录/注册/改密字段（data-autofill-credential 或 CREDENTIAL_IDS）-> 保留语义
// B 类：API Key / Token / 重置口令等非认证敏感字段（data-autofill-secret）-> autocomplete="off" + .ui-secret-input 掩码
// C 类：一次性验证码（one-time-code）-> 保留 autocomplete="one-time-code" + 密码管理器忽略标记
// D 类：其余业务输入/搜索/筛选/配置框 -> autocomplete="off" + 密码管理器忽略标记
(function () {
  'use strict';

  var CREDENTIAL_IDS = new Set([
    'username', 'password', 'reset-email', 'reset-pwd', 'reset-pwd2',
    'reg-pwd', 'reg-pwd2', 'email', 'pwd-old', 'pwd-new', 'pwd-new2'
  ]);

  var FEEDBACK_FIELD_IDS = new Set(['fb-form-title-input', 'fb-form-page']);
  var OTP_FIELD_IDS = new Set(['reset-email-code', 'email-code']);
  var SKIP_TYPES = new Set(['hidden', 'file', 'checkbox', 'radio', 'button', 'submit', 'reset']);

  function isCredentialField(el) {
    return el.hasAttribute('data-autofill-credential') || CREDENTIAL_IDS.has(el.id);
  }

  function isSecretField(el) {
    return el.hasAttribute('data-autofill-secret');
  }

  function isOtpField(el) {
    return el.getAttribute('autocomplete') === 'one-time-code' || OTP_FIELD_IDS.has(el.id);
  }

  function isPasswordField(el) {
    return el.tagName === 'INPUT' && el.type === 'password';
  }

  function applyIgnoreAttributes(el) {
    el.setAttribute('data-lpignore', 'true');
    el.setAttribute('data-1p-ignore', 'true');
    el.setAttribute('data-bwignore', 'true');
    el.setAttribute('data-form-type', 'other');
  }

  function protect(el) {
    if (!el || !el.matches || !el.matches('input, textarea, select')) return;
    if (isCredentialField(el) || SKIP_TYPES.has(el.type)) return;

    if (isOtpField(el)) {
      el.setAttribute('autocomplete', 'one-time-code');
      applyIgnoreAttributes(el);
      return;
    }

    if (isSecretField(el)) {
      el.setAttribute('autocomplete', 'off');
      el.setAttribute('spellcheck', 'false');
      el.setAttribute('autocapitalize', 'off');
      el.setAttribute('autocorrect', 'off');
      applyIgnoreAttributes(el);
      return;
    }

    var autocompleteValue = isPasswordField(el) ? 'new-password' : 'off';
    // data-autofill-ignore 不能改成 new-password，否则搜索框会被识别为账号/密码字段。
    if (el.hasAttribute('data-autofill-ignore') && !isPasswordField(el)) autocompleteValue = 'off';
    // 反馈表单是「两个文本框 + 提交按钮」，Chrome 会当成登录表单并弹保存密码；
    // off 拦不住这种判定，这里明确声明不是已有账号（反馈 #25）。
    if (FEEDBACK_FIELD_IDS.has(el.id)) autocompleteValue = 'new-password';
    el.setAttribute('autocomplete', autocompleteValue);
    applyIgnoreAttributes(el);
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
