// ============== 反馈中心（2026-10-23） ==============
// 一级栏目「反馈」的四个子页：全部反馈 / 我的反馈 / 反馈排名 / 版本更新。
// 契约见 docs/意见反馈与版本发布闭环研发方案_20261023.md 第三、六节。
// 约定：CSP 已关闭内联脚本属性，所有交互走 data-fb-act 事件委托；
// 图片在浏览器内先压缩为 WebP（长边≤2048、每张≤1MiB），失败明确提示，不静默上传原图。
(function () {
  'use strict';

  var SUBS = ['all', 'mine', 'ranking', 'versions'];
  var TYPE_LABELS = { bug: '错误', improvement: '改进', feature: '需求' };
  var STATUS_LABELS = {
    new: '未处理', needs_info: '待补充', accepted: '已采纳', in_progress: '进行中',
    implemented: '已实施', duplicate: '重复', declined: '不采纳'
  };
  var STATUS_ORDER = ['new', 'needs_info', 'accepted', 'in_progress', 'implemented', 'duplicate', 'declined'];
  var MAX_IMAGES = 3;
  var MAX_RAW_BYTES = 20 * 1024 * 1024;
  var MAX_RAW_PIXELS = 20000000;
  var MAX_EDGE = 2048;
  var TARGET_BYTES = 1024 * 1024;

  var state = {
    sub: 'all',
    detailId: null,
    seq: 0,
    list: { page: 1, pageSize: 20, q: '', type: '', status: '', from: '', to: '', sort: 'created' },
    mine: { page: 1, pageSize: 20, status: '' },
    rank: { page: 1, pageSize: 20 },
    form: null,
    loaded: {}
  };

  function esc(v) { return escapeHtml(String(v == null ? '' : v)); }
  // 登录名是经典脚本的顶层变量；window 属性与直接引用都做兼容，避免取不到已登录状态
  function currentUser() {
    if (typeof username === 'string' && username) return username;
    if (window.username) return window.username;
    return null;
  }
  function byId(id) { return document.getElementById(id); }

  function fmtTime(iso) {
    if (!iso) return '';
    if (window.CoreDate && CoreDate.dateTimeInZone) {
      var t = CoreDate.dateTimeInZone(iso, 'Asia/Shanghai');
      if (t) return t;
    }
    return String(iso).replace('T', ' ').slice(0, 16);
  }

  function toast(msg) {
    if (typeof showToast === 'function') { showToast(msg); return; }
    if (window.projectAlert) window.projectAlert(msg);
  }

  function typeBadge(type) {
    return '<span class="fb-badge fb-badge--' + esc(type) + '">' + esc(TYPE_LABELS[type] || type) + '</span>';
  }
  function statusBadge(status) {
    return '<span class="fb-badge fb-badge--' + esc(status) + '">' + esc(STATUS_LABELS[status] || status) + '</span>';
  }

  // ---------- 地址栏 ----------
  function syncUrl(push) {
    var params = new URLSearchParams(window.location.search);
    params.set('main', 'feedback');
    params.set('sub', state.sub);
    if (state.detailId) params.set('feedback', state.detailId);
    else params.delete('feedback');
    var url = '/?' + params.toString();
    if (!push) return;
    if (window.location.pathname + window.location.search !== url) history.pushState(null, '', url);
  }

  function readUrl() {
    var params = new URLSearchParams(window.location.search);
    var sub = params.get('sub');
    state.sub = SUBS.indexOf(sub) >= 0 ? sub : 'all';
    state.detailId = params.get('feedback') || null;
  }

  // ---------- 请求 ----------
  async function requestJson(url, options) {
    var r = await fetch(api(url), options);
    var payload = null;
    try { payload = await r.json(); } catch (e) { payload = null; }
    if (!r.ok) {
      var msg = (payload && payload.error) || ('请求失败（' + r.status + '）');
      var err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return payload || {};
  }

  function buildQuery(base) {
    var params = [];
    Object.keys(base).forEach(function (k) {
      var v = base[k];
      if (v === '' || v == null) return;
      params.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return params.length ? '?' + params.join('&') : '';
  }

  // ---------- 骨架 ----------
  function ensureShell() {
    var host = byId('fb-body');
    return host;
  }

  function renderError(host, err) {
    host.innerHTML = '<div class="fb-error">加载失败：' + esc(err.message || err) + '</div>';
  }

  // ---------- 列表（全部 / 我的） ----------
  function renderListShell(host) {
    var isMine = state.sub === 'mine';
    var st = isMine ? state.mine : state.list;
    var html = '';
    if (!isMine) {
      html += '<div class="fb-toolbar">'
        + '<input type="text" id="fb-q" placeholder="搜索标题或内容" value="' + esc(st.q) + '" maxlength="60">'
        + '<select id="fb-type"><option value="">全部类型</option>'
        + Object.keys(TYPE_LABELS).map(function (k) {
          return '<option value="' + esc(k) + '"' + (st.type === k ? ' selected' : '') + '>' + esc(TYPE_LABELS[k]) + '</option>';
        }).join('') + '</select>'
        + '<label>从 <input type="date" id="fb-from" value="' + esc(st.from) + '"></label>'
        + '<label>到 <input type="date" id="fb-to" value="' + esc(st.to) + '"></label>'
        + '<select id="fb-sort"><option value="created"' + (st.sort === 'created' ? ' selected' : '') + '>最新提交</option>'
        + '<option value="updated"' + (st.sort === 'updated' ? ' selected' : '') + '>最近更新</option></select>'
        + '<button type="button" class="btn btn-primary" data-fb-act="open-form">提交反馈</button>'
        + '</div>';
    } else {
      html += '<div class="fb-toolbar"><span class="fb-upload-tip">这里显示你提交的全部反馈，包括私密、被隐藏和已撤回的记录。</span>'
        + '<button type="button" class="btn btn-primary" data-fb-act="open-form">提交反馈</button></div>';
    }
    html += '<div class="fb-chips" id="fb-chips"></div><div id="fb-list"><p class="fb-empty">加载中…</p></div>';
    host.innerHTML = html;
  }

  function renderChips(counts) {
    var host = byId('fb-chips');
    if (!host) return;
    var st = state.sub === 'mine' ? state.mine : state.list;
    var html = '<button type="button" class="fb-chip' + (st.status === '' ? ' active' : '') + '" data-fb-act="status" data-status="">'
      + '全部 <span class="fb-chip-count">' + (counts.total || 0) + '</span></button>';
    STATUS_ORDER.forEach(function (s) {
      html += '<button type="button" class="fb-chip' + (st.status === s ? ' active' : '') + '" data-fb-act="status" data-status="' + esc(s) + '">'
        + esc(STATUS_LABELS[s]) + ' <span class="fb-chip-count">' + ((counts.byStatus && counts.byStatus[s]) || 0) + '</span></button>';
    });
    host.innerHTML = html;
  }

  function cardHtml(item) {
    var badges = typeBadge(item.type) + statusBadge(item.status);
    if (item.visibility === 'private') badges += '<span class="fb-badge fb-badge--private">私密</span>';
    if (item.moderation === 'hidden') badges += '<span class="fb-badge fb-badge--withdrawn">已隐藏</span>';
    if (item.withdrawnAt) badges += '<span class="fb-badge fb-badge--withdrawn">已撤回</span>';
    var version = item.status === 'implemented' && item.implementedVersion
      ? '<span>版本 <a href="#" data-fb-act="go-version" data-version="' + esc(item.implementedVersion) + '">' + esc(item.implementedVersion) + '</a></span>'
      : '';
    return '<article class="fb-card" data-fb-act="open" data-id="' + esc(item.id) + '" tabindex="0">'
      + '<div class="fb-card-head"><span class="fb-card-no">#' + esc(item.id) + '</span>' + badges
      + '<span class="fb-card-title">' + esc(item.title) + '</span></div>'
      + '<p class="fb-card-summary">' + esc(item.description) + '</p>'
      + '<div class="fb-card-meta"><span>' + esc(item.nickname || '匿名用户') + '</span>'
      + '<span>' + esc(fmtTime(item.createdAt)) + '</span>'
      + '<span>回复 ' + (item.commentCount || 0) + '</span>' + version + '</div>'
      + (item.latestSummary ? '<div class="fb-card-note">处理说明：' + esc(item.latestSummary) + '</div>' : '')
      + '</article>';
  }

  async function loadList() {
    var host = ensureShell();
    if (!host) return;
    var isMine = state.sub === 'mine';
    if (isMine && !currentUser()) {
      host.innerHTML = '<div class="fb-panel"><p class="fb-empty">登录后可以查看你提交的全部反馈</p>'
        + '<div class="u-mb-12" data-style="text-align:center">'
        + '<a class="btn btn-primary" href="' + esc(api('/login.html?redirect=' + encodeURIComponent('/?main=feedback&sub=mine'))) + '">去登录</a>'
        + '</div></div>';
      return;
    }
    renderListShell(host);
    var st = isMine ? state.mine : state.list;
    var seq = ++state.seq;
    try {
      var filter = isMine
        ? { status: st.status, page: st.page, pageSize: st.pageSize }
        : {
          q: st.q, type: st.type, status: st.status, from: st.from, to: st.to,
          sort: st.sort, page: st.page, pageSize: st.pageSize
        };
      var countFilter = Object.assign({}, filter);
      delete countFilter.page; delete countFilter.pageSize; delete countFilter.status;
      var results = await Promise.all([
        requestJson('/api/feedback' + (isMine ? '/mine' : '') + buildQuery(filter)),
        requestJson('/api/feedback/counts' + buildQuery(Object.assign({ scope: isMine ? 'mine' : 'public' }, countFilter))),
      ]);
      if (seq !== state.seq) return; // 乱序响应不覆盖当前子页
      renderChips(results[1]);
      var data = results[0];
      var listHost = byId('fb-list');
      if (!data.items || !data.items.length) {
        listHost.innerHTML = '<p class="fb-empty">还没有符合条件的反馈</p>';
        return;
      }
      listHost.innerHTML = '<div class="fb-list">' + data.items.map(cardHtml).join('') + '</div>';
      var pageCount = Math.max(1, Math.ceil((data.total || 0) / st.pageSize));
      if (pageCount > 1) {
        listHost.innerHTML += '<div class="fb-pager">'
          + '<button type="button" class="btn btn-outline btn-sm" data-fb-act="page" data-page="' + (st.page - 1) + '"'
          + (st.page <= 1 ? ' disabled' : '') + '>上一页</button>'
          + '<span>第 ' + st.page + ' / ' + pageCount + ' 页（共 ' + data.total + ' 条）</span>'
          + '<button type="button" class="btn btn-outline btn-sm" data-fb-act="page" data-page="' + (st.page + 1) + '"'
          + (st.page >= pageCount ? ' disabled' : '') + '>下一页</button></div>';
      }
    } catch (err) {
      if (seq !== state.seq) return;
      renderError(byId('fb-list') || host, err);
    }
  }

  // ---------- 详情 ----------
  async function loadDetail() {
    var host = ensureShell();
    if (!host) return;
    var seq = ++state.seq;
    host.innerHTML = '<div class="fb-panel"><p class="fb-empty">加载中…</p></div>';
    try {
      var data = await requestJson('/api/feedback/' + encodeURIComponent(state.detailId));
      if (seq !== state.seq) return;
      renderDetail(host, data);
    } catch (err) {
      if (seq !== state.seq) return;
      host.innerHTML = '<div class="fb-panel"><div class="fb-empty">该反馈不存在或无权访问</div>'
        + '<div class="u-mb-12" data-style="text-align:center"><button type="button" class="btn btn-outline" data-fb-act="back">返回列表</button></div></div>';
    }
  }

  function renderDetail(host, data) {
    var fb = data.feedback;
    var perms = data.permissions || {};
    var badges = typeBadge(fb.type) + statusBadge(fb.status);
    if (fb.visibility === 'private') badges += '<span class="fb-badge fb-badge--private">私密</span>';
    if (fb.moderation === 'hidden') badges += '<span class="fb-badge fb-badge--withdrawn">已隐藏</span>';
    if (fb.withdrawnAt) badges += '<span class="fb-badge fb-badge--withdrawn">已撤回</span>';

    var html = '<div class="fb-panel"><div class="fb-detail-back">'
      + '<button type="button" class="btn btn-outline btn-sm" data-fb-act="back">← 返回列表</button></div>'
      + '<div class="fb-card-head"><span class="fb-card-no">#' + esc(fb.id) + '</span>' + badges + '</div>'
      + '<h3 class="fb-detail-title">' + esc(fb.title) + '</h3>'
      + '<div class="fb-detail-body">' + esc(fb.description) + '</div>';

    if (fb.pagePath) html += '<div class="fb-card-meta"><span>问题页面：' + esc(fb.pagePath) + '</span></div>';
    html += '<div class="fb-card-meta"><span>' + esc(fb.nickname) + '</span><span>' + esc(fmtTime(fb.createdAt)) + '</span>'
      + (fb.submittedVersion ? '<span>提交版本 ' + esc(fb.submittedVersion) + '</span>' : '')
      + (fb.status === 'implemented' && fb.implementedVersion
        ? '<span>已随 <a href="#" data-fb-act="go-version" data-version="' + esc(fb.implementedVersion) + '">' + esc(fb.implementedVersion) + '</a> 发布</span>' : '')
      + '</div>';

    if (data.duplicateOf) {
      html += '<div class="fb-card-note">已关联同类反馈：'
        + (data.duplicateOf.id ? '#' + esc(data.duplicateOf.id) + ' ' + esc(data.duplicateOf.title) : esc(data.duplicateOf.title))
        + '</div>';
    }

    var shotList = fb.attachments || [];
    if (shotList.length) {
      html += '<div class="fb-detail-shots">' + shotList.map(function (a) {
        var shot = '<a href="' + esc(api('/api/feedback/attachments/' + a.id)) + '" target="_blank" rel="noopener">'
          + '<img src="' + esc(api('/api/feedback/attachments/' + a.id)) + '" alt="反馈截图" loading="lazy"></a>';
        if (perms.edit) {
          shot += '<button type="button" class="fb-shot-remove" data-fb-act="del-shot" data-aid="' + esc(a.id)
            + '" aria-label="移除截图">&times;</button>';
        }
        return '<div class="fb-shot">' + shot + '</div>';
      }).join('') + '</div>';
    }
    // A-06：作者在可编辑阶段可以从详情直接追加/移除截图
    if (perms.edit) {
      html += '<div class="fb-toolbar u-mb-12" data-style="margin-top:12px">'
        + '<input type="file" id="fb-detail-files" accept="image/png,image/jpeg,image/webp" multiple>'
        + '<button type="button" class="btn btn-primary btn-sm" data-fb-act="add-shots">追加截图</button>'
        + '<span class="fb-upload-tip">最多共 3 张，选择后自动压缩为 WebP</span></div>';
    }

    // 作者操作区
    var actions = [];
    if (perms.edit) actions.push('<button type="button" class="btn btn-outline btn-sm" data-fb-act="edit">编辑</button>');
    if (perms.completeInfo) actions.push('<button type="button" class="btn btn-success btn-sm" data-fb-act="complete-info">补充完成，转回未处理</button>');
    if (perms.visibility) {
      actions.push('<button type="button" class="btn btn-outline btn-sm" data-fb-act="visibility" data-to="'
        + (fb.visibility === 'public' ? 'private' : 'public') + '">'
        + (fb.visibility === 'public' ? '收为私密' : '设为公开') + '</button>');
    }
    if (perms.withdraw) actions.push('<button type="button" class="btn btn-danger btn-sm" data-fb-act="withdraw">撤回反馈</button>');
    if (actions.length) html += '<div class="fb-toolbar u-mb-12" data-style="margin-top:14px">' + actions.join('') + '</div>';

    // 回复
    html += '<div class="fb-section-title">回复（' + (data.comments || []).length + '）</div>';
    if (!data.comments || !data.comments.length) html += '<p class="fb-empty" data-style="padding:16px 0">还没有回复</p>';
    (data.comments || []).forEach(function (c) {
      var hidden = c.deleted || c.hidden;
      html += '<div class="fb-reply' + (hidden ? ' is-hidden' : '') + '">'
        + '<div class="fb-reply-head"><span class="fb-reply-author">' + esc(c.nickname) + '</span>'
        + (c.isOfficial ? '<span class="fb-badge fb-badge--accepted">管理员</span>' : '')
        + '<span>' + esc(fmtTime(c.createdAt)) + '</span>'
        + (c.deleted ? '<span>已删除</span>' : (c.hidden ? '<span>已隐藏</span>' : ''))
        + (!hidden && perms.comment && c.canDelete
          ? '<button type="button" class="btn btn-outline btn-sm" data-fb-act="del-comment" data-cid="' + esc(c.id) + '">删除</button>' : '')
        + '</div>'
        + (hidden ? '' : '<div class="fb-reply-body">' + esc(c.content) + '</div>')
        + '</div>';
    });

    if (perms.comment) {
      html += '<div class="fb-field" data-style="margin-top:14px"><span>发表回复</span>'
        + '<textarea id="fb-reply-input" maxlength="2000" placeholder="补充信息或说明（1—2000 字）"></textarea>'
        + '<div class="fb-form-actions"><button type="button" class="btn btn-primary" data-fb-act="reply">发表回复</button></div></div>';
    } else if (fb.withdrawnAt) {
      html += '<p class="fb-empty" data-style="padding:10px 0">该反馈已撤回，不能再回复</p>';
    } else if (!currentUser()) {
      html += '<p class="fb-empty" data-style="padding:10px 0">登录后可以回复</p>';
    }

    // 处理时间线
    if (data.events && data.events.length) {
      html += '<div class="fb-section-title">处理记录</div><ul class="fb-timeline">'
        + data.events.map(function (e) {
          return '<li><time>' + esc(fmtTime(e.createdAt)) + '</time>' + esc(e.summary || e.eventType)
            + (e.note ? '：' + esc(e.note) : '') + '</li>';
        }).join('') + '</ul>';
    }
    html += '</div>';
    host.innerHTML = html;
  }

  // ---------- 排名 ----------
  async function loadRanking() {
    var host = ensureShell();
    if (!host) return;
    host.innerHTML = '<div class="fb-panel"><p class="fb-empty">加载中…</p></div>';
    var seq = ++state.seq;
    try {
      var data = await requestJson('/api/feedback/ranking' + buildQuery(state.rank));
      if (seq !== state.seq) return;
      var html = '<div class="fb-panel"><h3 class="fb-section-title" data-style="margin-top:0">公开反馈数排名</h3>'
        + '<p class="fb-upload-tip u-mb-12">按公开有效反馈数量排序：私密、已隐藏和已撤回的不计入；重复与不采纳仍算正常提交。</p>';
      if (!data.items || !data.items.length) {
        html += '<p class="fb-empty">暂无排名记录</p>';
      } else {
        html += '<div class="fb-rank-list">' + data.items.map(function (r) {
          return '<div class="fb-rank-row">'
            + '<span class="fb-rank-no">' + r.rank + '</span>'
            + '<span class="fb-rank-avatar">' + (r.avatar ? '<img src="' + esc(r.avatar) + '" alt="">' : esc(String(r.nickname || '?').charAt(0))) + '</span>'
            + '<span class="fb-rank-name">' + esc(r.nickname) + '</span>'
            + '<span class="fb-rank-count">' + r.count + ' 条</span></div>';
        }).join('') + '</div>';
      }
      var pageCount = Math.max(1, Math.ceil((data.total || 0) / state.rank.pageSize));
      if (pageCount > 1) {
        html += '<div class="fb-pager">'
          + '<button type="button" class="btn btn-outline btn-sm" data-fb-act="rank-page" data-page="' + (state.rank.page - 1) + '"' + (state.rank.page <= 1 ? ' disabled' : '') + '>上一页</button>'
          + '<span>第 ' + state.rank.page + ' / ' + pageCount + ' 页</span>'
          + '<button type="button" class="btn btn-outline btn-sm" data-fb-act="rank-page" data-page="' + (state.rank.page + 1) + '"' + (state.rank.page >= pageCount ? ' disabled' : '') + '>下一页</button></div>';
      }
      html += '<div class="fb-my-rank">我的公开排名：' + (data.mine
        ? '第 ' + data.mine.rank + ' 名，' + data.mine.count + ' 条公开反馈'
        : '暂无排名') + '</div></div>';
      host.innerHTML = html;
    } catch (err) {
      if (seq !== state.seq) return;
      renderError(host, err);
    }
  }

  // ---------- 版本更新 ----------
  async function loadVersions() {
    var host = ensureShell();
    if (!host) return;
    host.innerHTML = '<div class="fb-panel"><p class="fb-empty">加载中…</p></div>';
    var seq = ++state.seq;
    var merged = [];
    var loadError = null;
    try {
      var r = await fetch('/changelog.json');
      if (!r.ok) throw new Error('版本记录读取失败');
      merged = mergeChangelogByDate(await r.json());
    } catch (err) { loadError = err; }
    // 版本关联映射失败时不影响版本正文展示
    var linkMap = {};
    var linkNote = '';
    try {
      var versions = merged.map(function (d) { return d.version; }).filter(Boolean).slice(0, 50);
      if (versions.length) {
        var res = await requestJson('/api/feedback/version-links?versions=' + encodeURIComponent(versions.join(',')));
        linkMap = res.map || {};
      }
    } catch (e) {
      linkNote = '<p class="fb-upload-tip u-mb-12">关联反馈暂不可用，版本内容仍可正常查看。</p>';
    }
    if (seq !== state.seq) return;
    if (loadError) { renderError(host, loadError); return; }
    var html = '<div class="fb-panel">' + linkNote;
    if (!merged.length) html += '<p class="fb-empty">暂无记录</p>';
    merged.forEach(function (day) {
      var title = (day.date || '') + (day.version ? '（' + day.version + '）' : '');
      html += '<div class="fb-version-item"><div class="fb-version-head"><span class="fb-version-title">' + esc(title) + '</span></div>';
      html += '<ul class="fb-timeline">' + (day.items || []).map(function (it) {
        return '<li>' + esc(it) + '</li>';
      }).join('') + '</ul>';
      var links = day.version && linkMap[day.version];
      if (links && links.length) {
        html += '<div class="fb-version-links">' + links.map(function (l) {
          return '<span class="fb-version-link" data-fb-act="open" data-id="' + esc(l.id) + '">#' + esc(l.id) + ' ' + esc(l.title) + '</span>';
        }).join('') + '</div>';
      }
      html += '</div>';
    });
    html += '</div>';
    host.innerHTML = html;
  }

  // ---------- 图片压缩 ----------
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      if (window.createImageBitmap) {
        createImageBitmap(file, { imageOrientation: 'from-image' })
          .then(resolve)
          .catch(function () {
            // 老浏览器不支持 imageOrientation 选项时退回默认方向
            createImageBitmap(file).then(resolve).catch(function () { reject(new Error('图片无法读取')); });
          });
        return;
      }
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片无法读取')); };
      img.src = url;
    });
  }

  function canvasToWebp(canvas, quality) {
    return new Promise(function (resolve) {
      if (!canvas.toBlob) { resolve(null); return; }
      canvas.toBlob(function (blob) { resolve(blob); }, 'image/webp', quality);
    });
  }

  async function compressImage(file) {
    if (file.size > MAX_RAW_BYTES) throw new Error('单张图片不能超过 20MB，请先裁剪');
    if (['image/png', 'image/jpeg', 'image/webp'].indexOf(file.type) < 0) {
      throw new Error('只支持 PNG/JPEG/WebP 图片');
    }
    var source = await loadImage(file);
    var sw = source.width || source.naturalWidth;
    var sh = source.height || source.naturalHeight;
    if (sw * sh > MAX_RAW_PIXELS) {
      if (source.close) source.close();
      throw new Error('图片像素过大，请先裁剪到 2000 万像素以内');
    }
    var edges = [Math.min(MAX_EDGE, Math.max(sw, sh))];
    if (edges[0] > 1600) edges.push(1600);
    if (edges[0] > 1280) edges.push(1280);
    var qualities = [0.86, 0.78, 0.7, 0.6];
    for (var i = 0; i < edges.length; i++) {
      var edge = edges[i];
      var scale = Math.min(1, edge / Math.max(sw, sh));
      var w = Math.max(1, Math.round(sw * scale));
      var h = Math.max(1, Math.round(sh * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(source, 0, 0, w, h);
      for (var j = 0; j < qualities.length; j++) {
        var blob = await canvasToWebp(canvas, qualities[j]);
        if (!blob) { if (source.close) source.close(); throw new Error('当前浏览器不支持 WebP 压缩，请更换浏览器或不上传截图'); }
        if (blob.type !== 'image/webp') { if (source.close) source.close(); throw new Error('当前浏览器不支持 WebP 压缩，请更换浏览器或不上传截图'); }
        if (blob.size <= TARGET_BYTES) {
          if (source.close) source.close();
          return new File([blob], 'screenshot-' + Date.now() + '.webp', { type: 'image/webp' });
        }
      }
    }
    if (source.close) source.close();
    throw new Error('图片压缩后仍超过 1MB，请裁剪后再试');
  }

  // ---------- 提交 / 编辑表单 ----------
  function closeForm() {
    var overlay = byId('fb-form-overlay');
    if (overlay) overlay.remove();
    if (state.form) {
      (state.form.previews || []).forEach(function (p) { URL.revokeObjectURL(p); });
    }
    state.form = null;
  }

  function openForm(mode, data, opts) {
    bindEvents();
    closeForm();
    var editing = mode === 'edit';
    var fb = (data && data.feedback) || null;
    state.form = {
      mode: mode,
      source: (opts && opts.source) || 'page',
      id: fb ? fb.id : null,
      revision: fb ? fb.revision : null,
      files: [],
      previews: [],
      requestId: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('fb-' + Date.now() + '-' + Math.random().toString(16).slice(2)),
      submitting: false,
    };
    var type = fb ? fb.type : 'bug';
    var typeBtns = [{ v: 'bug', t: '错误' }, { v: 'improvement', t: '改进' }, { v: 'feature', t: '需求' }].map(function (o) {
      return '<button type="button" class="fb-type-btn' + (type === o.v ? ' active' : '') + '" data-fb-act="pick-type" data-type="' + o.v + '">' + o.t + '</button>';
    }).join('');
    var html = '<div class="fb-float" id="fb-form-overlay">'
      + '<div class="fb-float-panel" role="dialog" aria-modal="true" aria-labelledby="fb-form-title">'
      + '<div class="fb-float-head">'
      + '<h2 id="fb-form-title">' + (editing ? '编辑反馈' : '提交反馈') + '</h2>'
      + '<button type="button" class="fb-float-close" data-fb-act="close-form" aria-label="关闭">&times;</button>'
      + '</div>'
      + '<div class="fb-form">'
      + '<div class="fb-field fb-field--row"><span class="fb-label">种类<i>*</i></span>'
      + '<div class="fb-type-group" id="fb-form-type-group" role="group" aria-label="种类">' + typeBtns + '</div>'
      + '<input type="hidden" id="fb-form-type" value="' + esc(type) + '"></div>'
      + '<div class="fb-field fb-field--row"><span class="fb-label">标题<i>*</i></span>'
      + '<input type="text" id="fb-form-title-input" maxlength="100" value="' + esc(fb ? fb.title : '') + '" placeholder="例如：xxx数据有问题"></div>'
      + '<div class="fb-field fb-field--row"><span class="fb-label">地址</span>'
      + '<input type="text" id="fb-form-page" maxlength="1000" value="' + esc(fb ? fb.pagePath : currentPagePath()) + '"></div>'
      + '<div class="fb-field fb-field--row"><span class="fb-label">描述<i>*</i></span>'
      + '<textarea id="fb-form-desc" maxlength="5000" placeholder="请您提供详细的问题描述或需求，这对我们的理解会有很大帮助。">' + esc(fb ? fb.description : '') + '</textarea></div>'
      + (!editing
        ? '<div class="fb-field fb-field--row"><span class="fb-label">图片</span><div class="fb-img-actions">'
        + '<button type="button" class="fb-img-btn" data-fb-act="pick-images">点击这里直接上传图片</button>'
        + '<button type="button" class="fb-img-btn" data-fb-act="paste-hint">点击这里聚焦，然后粘贴上传图片</button>'
        + '<span class="fb-img-limit">（最多3张图片）</span></div>'
        + '<input type="file" id="fb-form-files" accept="image/png,image/jpeg,image/webp" multiple hidden>'
        + '<div class="fb-thumbs" id="fb-form-thumbs"></div></div>'
        + '<div class="fb-field fb-field--row"><span class="fb-label">可见范围</span><div class="fb-radio-row">'
        + '<label><input type="radio" name="fb-visibility" value="public" checked>公开</label>'
        + '<label><input type="radio" name="fb-visibility" value="private">仅本人和管理员</label></div></div>'
        : '')
      + '<div class="fb-form-actions">'
      + '<button type="button" class="btn btn-outline" data-fb-act="close-form">取消</button>'
      + '<button type="button" class="btn btn-primary" id="fb-form-submit" data-fb-act="submit-form">' + (editing ? '保存' : '提交') + '</button>'
      + '</div></div></div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
    var fileInput = byId('fb-form-files');
    if (fileInput) fileInput.addEventListener('change', onPickFiles);
    var first = byId('fb-form-title-input');
    if (first) first.focus();
  }

  function currentPagePath() {
    var params = new URLSearchParams(window.location.search);
    var keep = ['main', 'sub', 'case', 'code', 'metric', 'kind'];
    var out = new URLSearchParams();
    keep.forEach(function (k) {
      var v = params.get(k);
      if (v) out.set(k, v);
    });
    var qs = out.toString();
    return '/' + (qs ? '?' + qs : '');
  }

  function renderThumbs() {
    var host = byId('fb-form-thumbs');
    if (!host || !state.form) return;
    host.innerHTML = state.form.files.map(function (f, i) {
      return '<div class="fb-thumb"><img src="' + esc(state.form.previews[i]) + '" alt="">'
        + '<button type="button" data-fb-act="remove-image" data-index="' + i + '" aria-label="移除">&times;</button></div>';
    }).join('');
  }

  async function addFiles(picked) {
    if (!state.form || !picked.length) return;
    var remain = MAX_IMAGES - state.form.files.length;
    if (remain <= 0) { toast('最多 3 张截图'); return; }
    if (picked.length > remain) { toast('最多 3 张截图，已只处理前 ' + remain + ' 张'); picked = picked.slice(0, remain); }
    for (var i = 0; i < picked.length; i++) {
      try {
        var compressed = await compressImage(picked[i]);
        state.form.files.push(compressed);
        state.form.previews.push(URL.createObjectURL(compressed));
      } catch (err) {
        toast(err.message || '图片处理失败');
      }
    }
    renderThumbs();
  }

  async function onPickFiles(e) {
    if (!state.form) return;
    var picked = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    await addFiles(picked);
  }

  async function submitForm() {
    if (!state.form || state.form.submitting) return;
    var form = state.form;
    var title = (byId('fb-form-title-input') || {}).value || '';
    var description = (byId('fb-form-desc') || {}).value || '';
    var type = (byId('fb-form-type') || {}).value || 'bug';
    var pagePath = (byId('fb-form-page') || {}).value || '';
    if (!title.trim()) { toast('请填写标题'); return; }
    if (!description.trim()) { toast('请填写描述'); return; }
    var btn = byId('fb-form-submit');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    form.submitting = true;
    try {
      if (form.mode === 'edit') {
        var result = await requestJson('/api/feedback/' + encodeURIComponent(form.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title, description: description, type: type, pagePath: pagePath, expectedRevision: form.revision }),
        });
        closeForm();
        toast('已保存');
        state.detailId = String(form.id);
        await refreshCurrent();
        return;
      }
      var visibilityEl = document.querySelector('input[name="fb-visibility"]:checked');
      var body = new FormData();
      body.append('type', type);
      body.append('title', title);
      body.append('description', description);
      body.append('pagePath', pagePath);
      body.append('visibility', visibilityEl ? visibilityEl.value : 'public');
      body.append('clientRequestId', form.requestId);
      form.files.forEach(function (f) { body.append('images', f); });
      var created = await requestJson('/api/feedback', { method: 'POST', body: body });
      var fromFab = form.source === 'fab';
      closeForm();
      toast('已提交，感谢反馈');
      // 全局悬浮入口提交后停留当前页；反馈栏目内提交则落到「全部反馈」并打开新记录
      if (fromFab) return;
      // 不走 switchFeedbackSub（那里会清空 detailId）
      state.sub = 'all';
      state.detailId = String(created.id);
      renderSubTabs();
      syncUrl(true);
      await loadDetail();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = form.mode === 'edit' ? '保存' : '提交'; }
      form.submitting = false;
      toast(err.message || '提交失败，请重试');
    }
  }

  // ---------- 子页切换 ----------
  async function switchFeedbackSub(sub, noPush) {
    closeForm();
    state.sub = SUBS.indexOf(sub) >= 0 ? sub : 'all';
    state.detailId = null;
    if (!noPush) syncUrl(true);
    renderSubTabs();
    await refreshCurrent();
  }

  function renderSubTabs() {
    document.querySelectorAll('#main-feedback .fb-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-fb-sub') === state.sub);
    });
  }

  async function refreshCurrent() {
    if (state.detailId) return loadDetail();
    if (state.sub === 'all') return loadList();
    if (state.sub === 'mine') return loadList();
    if (state.sub === 'ranking') return loadRanking();
    if (state.sub === 'versions') return loadVersions();
    return null;
  }

  // ---------- 详情动作 ----------
  async function detailAction(action, el) {
    var id = state.detailId;
    if (!id) return;
    var data = await requestJson('/api/feedback/' + encodeURIComponent(id));
    var revision = data.feedback.revision;
    if (action === 'withdraw') {
      if (!window.projectConfirm) return;
      if (!await window.projectConfirm('撤回后不再出现在公开列表和排名中，确定撤回？')) return;
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/withdraw', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      toast('已撤回');
      await loadDetail();
      return;
    }
    if (action === 'visibility') {
      var to = el.getAttribute('data-to');
      if (to === 'public' && window.projectConfirm && !await window.projectConfirm('改为公开后所有人可见，确认？')) return;
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/visibility', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: to, expectedRevision: revision }),
      });
      toast(to === 'public' ? '已设为公开' : '已收为私密');
      await loadDetail();
      return;
    }
    if (action === 'complete-info') {
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/complete-info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      toast('已提交补充，状态回到未处理');
      await loadDetail();
      return;
    }
    if (action === 'edit') {
      openForm('edit', data);
      return;
    }
    if (action === 'reply') {
      var input = byId('fb-reply-input');
      var content = input ? input.value : '';
      if (!content.trim()) { toast('请填写回复内容'); return; }
      var requestId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('c-' + Date.now());
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/comments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content, clientRequestId: requestId }),
      });
      toast('已回复');
      await loadDetail();
      return;
    }
    if (action === 'del-comment') {
      var cid = el.getAttribute('data-cid');
      if (window.projectConfirm && !await window.projectConfirm('删除后该回复正文不再展示，确认删除？')) return;
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/comments/' + encodeURIComponent(cid), { method: 'DELETE' });
      toast('已删除');
      await loadDetail();
      return;
    }
    if (action === 'del-shot') {
      var aid = el.getAttribute('data-aid');
      if (window.projectConfirm && !await window.projectConfirm('移除这张截图？移除后只有你和管理员还能看到。')) return;
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/attachments/' + encodeURIComponent(aid)
        + '?expectedRevision=' + encodeURIComponent(revision), { method: 'DELETE' });
      toast('截图已移除');
      await loadDetail();
      return;
    }
    if (action === 'add-shots') {
      var pick = byId('fb-detail-files');
      var chosen = pick ? Array.prototype.slice.call(pick.files || []) : [];
      if (!chosen.length) { toast('请先选择图片'); return; }
      if (pick) pick.value = '';
      var form = new FormData();
      form.append('expectedRevision', revision);
      form.append('clientRequestId', (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID() : ('att-' + Date.now() + '-' + Math.random().toString(16).slice(2)));
      for (var i = 0; i < chosen.length; i++) {
        try {
          form.append('images', await compressImage(chosen[i]));
        } catch (err) {
          toast(err.message || '图片处理失败，未上传任何图片');
          return;
        }
      }
      await requestJson('/api/feedback/' + encodeURIComponent(id) + '/attachments', { method: 'POST', body: form });
      toast('截图已追加');
      await loadDetail();
    }
  }

  // ---------- 事件委托 ----------
  function bindEvents() {
    if (window.__feedbackEventsReady) return;
    window.__feedbackEventsReady = true;

    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-fb-act]');
      // 悬浮面板打开时点击面板外空白处收起（FAB 按钮带 data-fb-act，不误关）
      if (!el && byId('fb-form-overlay') && !e.target.closest('#fb-form-overlay') && !e.target.closest('#fb-fab')) {
        closeForm();
      }
      if (!el) return;
      // 卡片内的版本链接不触发卡片本身的打开动作
      var act = el.getAttribute('data-fb-act');
      if (act !== 'open' && act !== 'go-version') e.stopPropagation();
      if (act === 'open') {
        state.detailId = el.getAttribute('data-id');
        syncUrl(true);
        loadDetail();
        return;
      }
      if (act === 'back') {
        state.detailId = null;
        syncUrl(true);
        refreshCurrent();
        return;
      }
      if (act === 'sub') { switchFeedbackSub(el.getAttribute('data-sub')); return; }
      if (act === 'status') {
        var st = state.sub === 'mine' ? state.mine : state.list;
        st.status = el.getAttribute('data-status') || '';
        st.page = 1;
        loadList();
        return;
      }
      if (act === 'page') {
        var pageSt = state.sub === 'mine' ? state.mine : state.list;
        pageSt.page = Math.max(1, parseInt(el.getAttribute('data-page'), 10) || 1);
        loadList();
        return;
      }
      if (act === 'rank-page') {
        state.rank.page = Math.max(1, parseInt(el.getAttribute('data-page'), 10) || 1);
        loadRanking();
        return;
      }
      if (act === 'open-form') { openForm('create'); return; }
      if (act === 'close-form') { e.preventDefault(); closeForm(); return; }
      if (act === 'pick-type') {
        var group = el.parentNode;
        if (group && group.querySelectorAll) {
          Array.prototype.forEach.call(group.querySelectorAll('.fb-type-btn'), function (b) {
            b.classList.toggle('active', b === el);
          });
        }
        var typeInput = byId('fb-form-type');
        if (typeInput) typeInput.value = el.getAttribute('data-type') || 'bug';
        return;
      }
      if (act === 'pick-images') {
        var fileInput = byId('fb-form-files');
        if (fileInput) fileInput.click();
        return;
      }
      if (act === 'paste-hint') {
        el.focus();
        toast('已聚焦，请按 Ctrl+V 粘贴图片');
        return;
      }
      if (act === 'remove-image') {
        var idx = parseInt(el.getAttribute('data-index'), 10) || 0;
        if (state.form) {
          state.form.files.splice(idx, 1);
          URL.revokeObjectURL(state.form.previews[idx]);
          state.form.previews.splice(idx, 1);
          renderThumbs();
        }
        return;
      }
      if (act === 'submit-form') { if (e.target.closest('#fb-form-overlay')) e.preventDefault(); submitForm(); return; }
      if (act === 'go-version') {
        e.preventDefault();
        switchFeedbackSub('versions');
        return;
      }
      if (['withdraw', 'visibility', 'complete-info', 'edit', 'reply', 'del-comment', 'del-shot', 'add-shots'].indexOf(act) >= 0) {
        detailAction(act, el).catch(function (err) { toast(err.message || '操作失败'); });
      }
    });

    // 粘贴上传：表单打开时 Ctrl+V 的图片进同一压缩链路
    document.addEventListener('paste', function (e) {
      if (!state.form || state.form.mode === 'edit') return;
      var files = e.clipboardData && e.clipboardData.files;
      if (!files || !files.length) return;
      var imgs = Array.prototype.slice.call(files).filter(function (f) {
        return /^image\//.test(f.type);
      });
      if (!imgs.length) return;
      e.preventDefault();
      addFiles(imgs);
    });

    // 列表筛选：回车搜索 / 下拉即筛选
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var t = e.target;
      if (t && t.id === 'fb-q') { applyFilters(); }
      if (t && t.id === 'fb-reply-input') {
        var btn = document.querySelector('[data-fb-act="reply"]');
        if (btn) btn.click();
      }
    });
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.id) return;
      if (['fb-type', 'fb-from', 'fb-to', 'fb-sort'].indexOf(t.id) >= 0) applyFilters();
    });
  }

  function applyFilters() {
    state.list.q = (byId('fb-q') || {}).value || '';
    state.list.type = (byId('fb-type') || {}).value || '';
    state.list.from = (byId('fb-from') || {}).value || '';
    state.list.to = (byId('fb-to') || {}).value || '';
    state.list.sort = (byId('fb-sort') || {}).value || 'created';
    state.list.page = 1;
    loadList();
  }

  // ---------- 对外入口 ----------
  // navigation.js 在栏目懒加载完成后调用
  function initFeedbackSub() {
    readUrl();
    renderSubTabs();
    if (state.detailId) return loadDetail();
    return refreshCurrent();
  }

  function loadFeedbackPage() {
    bindEvents();
    return initFeedbackSub();
  }

  window.loadFeedbackPage = loadFeedbackPage;
  window.initFeedbackSub = initFeedbackSub;
  window.switchFeedbackSub = switchFeedbackSub;
  window.openFeedbackForm = function (opts) { openForm('create', null, opts); };
  window.FeedbackPage = { reload: refreshCurrent, sub: function () { return state.sub; } };
})();
