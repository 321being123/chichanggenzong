// ============== 统一分页控件（2026-10-26） ==============
// 交易记录、版本历史等长列表共用；样式复用 shared/style.css 的 .earnings-pager 规范，
// 不再由各页面各自复制一套分页 HTML。
// 用法：
//   UnifiedPager.register('trades', renderFn);                    // 注册翻页后的重渲染函数
//   var pg = UnifiedPager.pageOf('trades', total, 20);            // 取夹紧后的当前页/总页数
//   html += UnifiedPager.buildHtml('trades', { total, pageSize }); // 仅多于一页时输出分页条
window.UnifiedPager = (function () {
  'use strict';

  var states = {};    // name -> { page: 1 }
  var rerenders = {}; // name -> function

  function state(name) {
    if (!states[name]) states[name] = { page: 1 };
    return states[name];
  }

  function register(name, rerender) {
    rerenders[name] = rerender;
  }

  function pageOf(name, total, pageSize) {
    var totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
    var s = state(name);
    if (s.page > totalPages) s.page = totalPages; // 数据变少时夹紧，不越界
    if (s.page < 1) s.page = 1;
    return { page: s.page, totalPages: totalPages };
  }

  function rerender(name) {
    if (typeof rerenders[name] === 'function') rerenders[name]();
  }

  function toPage(name, page) {
    state(name).page = page;
    rerender(name);
  }

  function jump(name) {
    var inp = document.getElementById('pager-jump-' + name);
    if (!inp) return;
    var p = parseInt(inp.value, 10);
    if (isNaN(p)) return;
    state(name).page = p; // 越界由 pageOf 夹紧
    rerender(name);
  }

  function buildHtml(name, opts) {
    var pageSize = opts.pageSize || 20;
    var total = opts.total || 0;
    var pg = pageOf(name, total, pageSize);
    if (pg.totalPages <= 1) return ''; // 单页不显示分页条
    var jumpId = 'pager-jump-' + name;
    return '<div class="earnings-pager">' +
      '<button class="btn btn-sm btn-outline" data-act="UnifiedPager.toPage" data-arg1="' + name + '" data-arg2="1"' + (pg.page <= 1 ? ' disabled' : '') + '>首页</button>' +
      '<button class="btn btn-sm btn-outline" data-act="UnifiedPager.toPage" data-arg1="' + name + '" data-arg2="' + (pg.page - 1) + '"' + (pg.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span class="pager-info">第 ' + pg.page + ' / ' + pg.totalPages + ' 页　共 ' + total + ' 条</span>' +
      '<button class="btn btn-sm btn-outline" data-act="UnifiedPager.toPage" data-arg1="' + name + '" data-arg2="' + (pg.page + 1) + '"' + (pg.page >= pg.totalPages ? ' disabled' : '') + '>下一页</button>' +
      '<button class="btn btn-sm btn-outline" data-act="UnifiedPager.toPage" data-arg1="' + name + '" data-arg2="' + pg.totalPages + '"' + (pg.page >= pg.totalPages ? ' disabled' : '') + '>尾页</button>' +
      '<span class="pager-jump">跳至 <input type="number" id="' + jumpId + '" data-pager-jump="' + name + '" min="1" max="' + pg.totalPages + '" value="' + pg.page + '"> 页 ' +
      '<button class="btn btn-sm btn-outline" data-act="UnifiedPager.jump" data-arg1="' + name + '">跳转</button></span>' +
      '</div>';
  }

  // 跳至输入框回车即跳转（UiActions 只委托 click/change/input/submit，keydown 在此补上）
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !e.target || !e.target.getAttribute) return;
    var name = e.target.getAttribute('data-pager-jump');
    if (name) { e.preventDefault(); jump(name); }
  });

  return { register: register, pageOf: pageOf, buildHtml: buildHtml, toPage: toPage, jump: jump };
})();
