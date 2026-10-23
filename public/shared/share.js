// 通用分享控件：内容描述 + 渠道适配 + 复制与降级。
// 边界（见 docs/证券分析与通用分享开发方案_20261022.md）：
// - 只接受登记过的内容类型；不接受任意网页地址作为分享目标。
// - 标题与地址一律用服务端返回的权威值，前端不自行拼接公开链接。
// - 提示语必须对应真实动作：打开系统面板、调起 QQ、设置卡片都不等于已发送。
// - 微信内浏览器的分享卡片受客户端页面级缓存限制，开关面板只保证链接与标题同步。
(function (window, document) {
  'use strict';

  var CONTENT_LABELS = { 'security-analysis': '证券分析' };
  var infoCache = {};
  var overlay = null;
  var current = null;
  var lastFocus = null;

  // 站点标识：与 favicon 同一套 K 线语言，用于预览行左侧。
  var SITE_MARK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<path d="M4 18V9M10 18V5M16 18v-7M20 18v-3" stroke="#ef5350" stroke-width="2.4" stroke-linecap="round"/></svg>';

  // 渠道图标。底色由 CSS 给（品牌色），这里只画图形，图形一律白色。
  var CHANNEL_ICONS = {
    'wechat-friend': '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">'
      + '<circle cx="9.2" cy="9.5" r="5.4" fill="#fff"/><circle cx="16.4" cy="13.6" r="3.9" fill="#fff"/>'
      + '<circle cx="7.5" cy="9.9" r="0.95" fill="#07C160"/><circle cx="11" cy="9.9" r="0.95" fill="#07C160"/>'
      + '<circle cx="15.4" cy="13.4" r="0.8" fill="#07C160"/><circle cx="17.9" cy="13.4" r="0.8" fill="#07C160"/></svg>',
    'wechat-timeline': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="7.6" stroke="#fff" stroke-width="1.9"/><circle cx="12" cy="12" r="2.7" fill="#fff"/></svg>',
    'qq': '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M12 3.6c4.9 0 8.4 3.3 8.4 7.5 0 1.3-.4 2.5-1 3.6l.9 3.6-3.5-1.4c-1.3.9-3 1.5-4.8 1.5-4.9 0-8.4-3.3-8.4-7.3S7.1 3.6 12 3.6z" fill="#fff"/>'
      + '<circle cx="9" cy="10.4" r="1" fill="#12B7F5"/><circle cx="15" cy="10.4" r="1" fill="#12B7F5"/></svg>',
    'copy': '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
      + '<rect x="8.5" y="3.5" width="11.5" height="11.5" rx="2.6" stroke="#4A5058" stroke-width="1.7"/>'
      + '<path d="M15 15.5v3.2a2.6 2.6 0 0 1-2.6 2.6H6.1a2.6 2.6 0 0 1-2.6-2.6v-6.3a2.6 2.6 0 0 1 2.6-2.6H10" stroke="#4A5058" stroke-width="1.7" stroke-linecap="round"/></svg>',
  };

  var CHANNEL_ORDER = ['wechat-friend', 'wechat-timeline', 'qq', 'copy'];
  var CHANNEL_LABELS = { 'wechat-friend': '微信', 'wechat-timeline': '朋友圈', 'qq': 'QQ', 'copy': '复制' };

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isWeChat() { return /MicroMessenger/i.test(navigator.userAgent || ''); }
  function isPhone() { return window.matchMedia('(max-width: 760px)').matches; }

  function currentScrollHost() { return document.documentElement; }

  // 定位当前分享对象：优先读分享页 body 上的登记信息，其次读主站当前证券状态。
  function resolveCurrent(contentType) {
    var body = document.body;
    var kind = body && body.dataset ? body.dataset.shareKind : '';
    var code = body && body.dataset ? body.dataset.shareCode : '';
    var path = body && body.dataset ? body.dataset.sharePath : '';
    if (kind && code) return { contentType: contentType, kind: kind, code: code, path: path };

    var state = window.securityAnalysisState;
    if (state && state.code) {
      return {
        contentType: contentType,
        kind: state.type === 'bond' ? 'bond' : 'stock',
        code: String(state.code),
        path: '',
      };
    }
    return null;
  }

  // 服务端权威地址与标题。同一次页面会话内按证券缓存，重复打开面板不再请求。
  async function fetchShareInfo(target) {
    var key = target.kind + ':' + target.code;
    if (infoCache[key]) return infoCache[key];
    var query = 'contentType=' + encodeURIComponent(target.contentType)
      + '&resourceKind=' + encodeURIComponent(target.kind)
      + '&resourceKey=' + encodeURIComponent(target.code);
    var response = await fetch((window.BASE_URL || '') + '/api/share/qrcode?' + query, { headers: { Accept: 'application/json' } });
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(payload.error || '分享信息暂时不可用');
    if (!payload.url) throw new Error('分享地址未配置');
    infoCache[key] = payload;
    return payload;
  }

  function hostOf(url) {
    try { return new URL(String(url || '')).hostname; } catch (_) { return '存在小站'; }
  }

  function channelButton(channel) {
    return '<button type="button" class="share-channel" data-share-channel="' + channel + '">'
      + '<span class="share-channel-icon share-channel-icon--' + channel + '" aria-hidden="true">' + CHANNEL_ICONS[channel] + '</span>'
      + '<span class="share-channel-label">' + CHANNEL_LABELS[channel] + '</span>'
      + '</button>';
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'share-overlay';
    overlay.className = 'modal-overlay share-overlay';
    overlay.innerHTML =
      '<div class="modal share-modal" role="dialog" aria-modal="true" aria-label="分享">' +
        '<div class="share-preview">' +
          '<span class="share-preview-icon" aria-hidden="true">' + SITE_MARK + '</span>' +
          '<span class="share-preview-text">' +
            '<span class="share-preview-title" id="share-preview-title"></span>' +
            '<span class="share-preview-sub" id="share-preview-sub"></span>' +
          '</span>' +
        '</div>' +
        '<div class="share-channels" id="share-channels">' + CHANNEL_ORDER.map(channelButton).join('') + '</div>' +
        '<div class="share-detail" id="share-detail"></div>' +
        '<div class="share-manual js-hidden" id="share-manual">' +
          '<p class="share-manual-hint" id="share-manual-hint"></p>' +
          '<textarea class="share-manual-text" id="share-manual-text" readonly rows="4" aria-label="待复制的分享内容"></textarea>' +
        '</div>' +
        '<button type="button" class="share-cancel" id="share-cancel">取消</button>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector('#share-cancel').addEventListener('click', close);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) close();
    });
    Array.prototype.forEach.call(overlay.querySelectorAll('[data-share-channel]'), function (button) {
      button.addEventListener('click', function () { chooseChannel(button.getAttribute('data-share-channel')); });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && overlay && overlay.classList.contains('show')) close();
    });
    return overlay;
  }

  // 预览行：主标题取权威标题的首段（去掉「｜证券分析｜存在小站」后缀），副标题给内容类型与站点域名。
  function setPreview(title, sub) {
    if (!overlay) return;
    var titleEl = overlay.querySelector('#share-preview-title');
    var subEl = overlay.querySelector('#share-preview-sub');
    if (titleEl) titleEl.textContent = title || '';
    if (subEl) subEl.textContent = sub || '';
  }

  function setDetail(html) {
    var detail = overlay.querySelector('#share-detail');
    if (!detail) return;
    detail.innerHTML = html || '';
  }

  function hideManual() {
    var box = overlay.querySelector('#share-manual');
    if (box) box.classList.add('js-hidden');
  }

  // 复制不可用或被拒绝时，展示可选中文本，并说明需要手动复制。
  function showManual(hint, text) {
    var box = overlay.querySelector('#share-manual');
    var hintEl = overlay.querySelector('#share-manual-hint');
    var textEl = overlay.querySelector('#share-manual-text');
    if (!box || !hintEl || !textEl) return;
    hintEl.textContent = hint;
    textEl.value = text;
    box.classList.remove('js-hidden');
    textEl.focus();
    textEl.select();
  }

  function showToast(msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  function shareText(info) { return info.title + '\n' + info.url; }

  function showQr(hint) {
    var html = '<p class="share-hint">' + escapeText(hint) + '</p>';
    if (current && current.qr) {
      html += '<img class="share-qr" src="' + current.qr + '" width="200" height="200" alt="用微信扫码打开该证券公开分析页">';
    }
    setDetail(html);
  }

  function showStep(hint) {
    setDetail('<p class="share-hint">' + escapeText(hint) + '</p>');
  }

  async function doCopy() {
    if (!current) return;
    var text = shareText(current);
    var ok = await copyText(text);
    if (ok) {
      showToast('已复制，可直接粘贴发送');
      setDetail('<p class="share-hint">标题和链接已复制到剪贴板。</p>');
      hideManual();
      return;
    }
    setDetail('');
    showManual('当前浏览器不允许自动复制，请长按下面的文字全选后复制。', text);
  }

  function qqShareUrl(info) {
    return 'https://connect.qq.com/widget/shareqq/index.html'
      + '?url=' + encodeURIComponent(info.url)
      + '&title=' + encodeURIComponent(info.title)
      + '&summary=' + encodeURIComponent(info.title)
      + '&source=' + encodeURIComponent('存在小站');
  }

  async function chooseChannel(channel) {
    if (!current) return;
    hideManual();
    var info = current;

    if (channel === 'copy') return doCopy();

    if (channel === 'wechat-friend') {
      if (isWeChat()) {
        return showStep('点击右上角「···」→「发送给朋友」，选择要发送的聊天。');
      }
      if (isPhone()) {
        if (navigator.share) {
          try {
            await navigator.share({ title: info.title, text: info.title, url: info.url });
            return;
          } catch (error) {
            // 用户主动取消时保持原页面，不自动复制、不连续拉起其他应用。
            if (error && error.name === 'AbortError') return;
          }
        }
        setDetail('');
        return showManual('当前浏览器无法直接唤起微信，请复制后到微信粘贴发送。', shareText(info));
      }
      return showQr('用微信扫码打开，再点右上角「···」发送给朋友。');
    }

    if (channel === 'wechat-timeline') {
      if (isWeChat()) {
        return showStep('点击右上角「···」→「分享到朋友圈」。');
      }
      if (isPhone()) {
        setDetail('');
        return showManual('朋友圈需要先在微信内打开：把下面的内容发给自己，在微信里打开后再点右上角分享到朋友圈。', shareText(info));
      }
      return showQr('用微信扫码打开，再点右上角「···」分享到朋友圈。');
    }

    if (channel === 'qq') {
      if (isPhone()) {
        // 官方入口是电脑版扫码页，手机直接复制更快，也不受微信内拦截影响。
        setDetail('');
        return showManual('请复制下面的内容，到 QQ 中粘贴发送。', shareText(info));
      }
      var opened = window.open(qqShareUrl(info), '_blank', 'noopener,noreferrer');
      if (!opened) {
        setDetail('');
        return showManual('浏览器拦住了 QQ 分享页，请复制下面的内容到 QQ 发送。', shareText(info));
      }
      return showStep('已打开 QQ 分享页，按页面提示选择好友。');
    }
  }

  async function open(contentType) {
    var type = String(contentType || 'security-analysis');
    var target = resolveCurrent(type);
    if (!target) {
      showToast('没有可分享的证券，请先打开一只股票或可转债的分析结果');
      return;
    }

    var box = ensureOverlay();
    hideManual();
    setDetail('');
    setPreview('正在准备分享信息…', '');

    lastFocus = document.activeElement;
    box.classList.add('show');
    box.__returnFocus = lastFocus;

    try {
      var info = await fetchShareInfo(target);
      current = {
        contentType: type,
        kind: target.kind,
        code: target.code,
        title: info.title,
        url: info.url,
        qr: info.qr,
      };
      setPreview(String(info.title || '').split('｜')[0], (CONTENT_LABELS[type] || '分享') + ' · ' + hostOf(info.url));
      setDetail('');
    } catch (error) {
      setPreview('无法生成分享链接', '');
      setDetail('<p class="share-hint share-hint-error">' + escapeText(error && error.message ? error.message : '分享信息暂时不可用') + '</p>');
    }
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('show');
    current = null;
    hideManual();
    setDetail('');
    setPreview('', '');
    if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }

  window.Share = {
    open: open,
    close: close,
    // 供测试与调试：清空按证券缓存的分享信息
    resetCache: function () { infoCache = {}; },
  };
})(window, document);
