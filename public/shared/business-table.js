(function (window, document) {
  'use strict';

  var instances = [];
  var framePending = false;

  function resolve(value) {
    if (!value) return null;
    return typeof value === 'string' ? document.querySelector(value) : value;
  }

  function findWithin(root, selector) {
    if (!root || !selector) return null;
    return root.matches && root.matches(selector) ? root : root.querySelector(selector);
  }

  function isVisible(instance) {
    var root = instance.root;
    if (!root || !root.isConnected) return false;
    if (root.hidden) return false;
    if (root.getClientRects && root.getClientRects().length === 0) return false;
    var page = resolve(instance.page);
    if (page && page.classList.contains('main-page') && !page.classList.contains('active')) return false;
    if (page && page.classList.contains('bond-sub-page') && page.hidden) return false;
    return true;
  }

  function normalizeHeaderCells(table) {
    if (!table || !table.querySelectorAll) return;
    table.querySelectorAll('th').forEach(function (cell) {
      var hasLabel = false;
      Array.prototype.forEach.call(cell.children, function (child) {
        if (child.classList && child.classList.contains('biz-table-head-label')) hasLabel = true;
      });
      if (hasLabel) return;
      var labelNodes = [];
      Array.prototype.forEach.call(cell.childNodes, function (node) {
        if (node.nodeType === 1 && node.classList && node.classList.contains('biz-sort-indicator')) return;
        labelNodes.push(node);
      });
      if (!labelNodes.length) return;
      var label = document.createElement('span');
      label.className = 'biz-table-head-label';
      labelNodes.forEach(function (node) { label.appendChild(node); });
      cell.insertBefore(label, cell.firstChild);
      splitLongHeaderLabel(label);
    });
  }

  function splitLongHeaderLabel(label) {
    var target = label;
    while (target.children.length === 1 && target.firstElementChild && target.firstElementChild.classList &&
      !target.firstElementChild.classList.contains('biz-sort-indicator')) target = target.firstElementChild;
    if (target.children.length) return;
    var text = String(target.textContent || '').trim();
    var chars = Array.from(text);
    if (chars.length <= 6) return;
    var midpoint = Math.ceil(chars.length / 2);
    var breakAt = midpoint;
    for (var i = 3; i <= chars.length - 2; i++) {
      if (chars[i] === '(' || chars[i] === '（') {
        if (Math.abs(i - midpoint) <= 1) breakAt = i;
        break;
      }
    }
    target.textContent = chars.slice(0, breakAt).join('');
    target.appendChild(document.createElement('br'));
    target.appendChild(document.createTextNode(chars.slice(breakAt).join('')));
  }

  function normalizeHeaders(container) {
    container = container || document;
    if (container.matches && container.matches('.biz-table')) normalizeHeaderCells(container);
    if (container.querySelectorAll) container.querySelectorAll('.biz-table').forEach(normalizeHeaderCells);
  }

  // 名称列附带代码，原代码列与排序入口完整保留；不改业务字段和列序。
  function prepareIdentity(table) {
    if (table.__mobileIdentity || !table.closest('#bond-list-table, #bond-safety-table, #bond-redemption-table, #bond-revision-table, .position-list-scroll')) return;
    var head = table.tHead;
    if (!head || head.rows.length !== 1) return;
    var cells = Array.from(head.rows[0].cells);
    function label(cell) { var el = cell.querySelector('.biz-table-head-label') || cell; return el.textContent.replace(/\s/g, ''); }
    var nameIndex = cells.findIndex(function (cell) { return /^(转债名称|债券名称|名称)$/.test(label(cell)); });
    var codeIndex = cells.findIndex(function (cell) { return /^(代码|债券代码)$/.test(label(cell)); });
    if (nameIndex < 0 || codeIndex < 0) return;
    cells[nameIndex].classList.add('biz-identity');
    Array.from(table.tBodies).forEach(function (body) { Array.from(body.rows).forEach(function (row) {
      if (row.cells.length !== cells.length) return;
      var cell = row.cells[nameIndex], code = document.createElement('small');
      cell.classList.add('biz-identity'); code.className = 'biz-identity-code'; code.textContent = row.cells[codeIndex].textContent.trim(); cell.appendChild(code);
    }); });
    table.__mobileIdentity = true;
  }

  function stickyTop(instance) {
    var topEl = resolve(instance.top || (instance.root.closest && instance.root.closest('.admin-main') ? '.admin-topbar' : null));
    var top = topEl && topEl.getClientRects().length ? topEl.getBoundingClientRect().bottom : 0;
    document.querySelectorAll('.nav, .main-page.active .holdings-header, .main-page.active > .bond-header, .main-page.active .mv-header, .admin-topbar').forEach(function (el) {
      if (!el.getClientRects().length) return;
      var rect = el.getBoundingClientRect();
      if (rect.top <= top + 1) top = Math.max(top, rect.bottom);
    });
    return Math.max(0, top);
  }

  function ensureHosts(instance) {
    if (!instance.headHost) {
      instance.headHost = document.createElement('div');
      instance.headHost.className = 'biz-table-floating-head';
      instance.headHost.hidden = true;
      document.body.appendChild(instance.headHost);
    }
    if (!instance.scrollHost) {
      instance.scrollHost = document.createElement('div');
      instance.scrollHost.className = 'biz-table-floating-scroll';
      instance.scrollHost.hidden = true;
      instance.scrollHost.innerHTML = '<div class="biz-table-floating-scroll-inner"></div>';
      document.body.appendChild(instance.scrollHost);
      instance.scrollHost.addEventListener('scroll', function () {
        if (instance.scroll && Math.abs(instance.scroll.scrollLeft - instance.scrollHost.scrollLeft) > 1) {
          instance.scroll.scrollLeft = instance.scrollHost.scrollLeft;
        }
      }, { passive: true });
    }
  }

  function rebuild(instance) {
    var table = findWithin(instance.root, instance.tableSelector || '.biz-table');
    var scroll = findWithin(instance.root, instance.scrollSelector || '.biz-table-scroll');
    var head = table && table.querySelector('thead');
    if (!table || !scroll || !head || !instance.sticky) return;
    normalizeHeaderCells(table);
    prepareIdentity(table);
    ensureHosts(instance);
    instance.table = table;
    instance.scroll = scroll;
    instance.headHost.innerHTML = '';
    var floating = table.cloneNode(false);
    floating.className = 'biz-table biz-table-floating-table';
    floating.style.width = table.getBoundingClientRect().width + 'px';
    var floatingHead = head.cloneNode(true);
    var sourceCells = head.querySelectorAll('th');
    floatingHead.querySelectorAll('th').forEach(function (cell, index) {
      cell.removeAttribute('id');
      if (sourceCells[index]) {
        cell.onclick = function () { sourceCells[index].click(); };
        cell.style.width = sourceCells[index].getBoundingClientRect().width + 'px';
        cell.style.minWidth = sourceCells[index].getBoundingClientRect().width + 'px';
      }
    });
    floating.appendChild(floatingHead);
    instance.headHost.appendChild(floating);
    instance.scrollHost.querySelector('.biz-table-floating-scroll-inner').style.width = scroll.scrollWidth + 'px';
    if (!scroll.__bizTableBound) {
      scroll.__bizTableBound = true;
      scroll.addEventListener('scroll', scheduleSync, { passive: true });
    }
    instance.sourceTable = table;
  }

  function syncFloatingWidths(instance, table, head, scroll) {
    var floating = instance.headHost && instance.headHost.firstElementChild;
    if (!floating) return;
    floating.style.width = table.getBoundingClientRect().width + 'px';
    var sourceCells = head.querySelectorAll('th');
    var floatingCells = floating.querySelectorAll('th');
    floatingCells.forEach(function (cell, index) {
      if (!sourceCells[index]) return;
      var width = sourceCells[index].getBoundingClientRect().width + 'px';
      cell.style.width = width;
      cell.style.minWidth = width;
    });
    var inner = instance.scrollHost && instance.scrollHost.querySelector('.biz-table-floating-scroll-inner');
    if (inner) inner.style.width = scroll.scrollWidth + 'px';
  }

  function sync(instance) {
    var currentTable = findWithin(instance.root, instance.tableSelector || '.biz-table');
    if (currentTable) { normalizeHeaderCells(currentTable); prepareIdentity(currentTable); }
    var currentScroll = findWithin(instance.root, instance.scrollSelector || '.biz-table-scroll');
    if (currentScroll && (!instance.hint || !instance.hint.isConnected)) {
      instance.hint = document.createElement('div'); instance.hint.className = 'biz-table-scroll-hint';
      instance.hint.textContent = '左右滑动查看完整数据'; instance.hint.hidden = true; currentScroll.before(instance.hint);
      currentScroll.tabIndex = 0; currentScroll.setAttribute('role', 'region'); currentScroll.setAttribute('aria-label', '数据表格，可左右滑动查看完整数据');
    }
    if (instance.hint) instance.hint.hidden = !isVisible(instance) || !currentScroll || currentScroll.scrollWidth <= currentScroll.clientWidth + 1;
    if (!instance.sticky || !isVisible(instance)) {
      if (instance.headHost) instance.headHost.hidden = true;
      if (instance.scrollHost) instance.scrollHost.hidden = true;
      return;
    }
    var table = findWithin(instance.root, instance.tableSelector || '.biz-table');
    var scroll = findWithin(instance.root, instance.scrollSelector || '.biz-table-scroll');
    var head = table && table.querySelector('thead');
    if (!table || !scroll || !head) {
      if (instance.headHost) instance.headHost.hidden = true;
      if (instance.scrollHost) instance.scrollHost.hidden = true;
      return;
    }
    if (instance.sourceTable !== table || !instance.headHost || !instance.headHost.firstElementChild) rebuild(instance);
    ensureHosts(instance);
    instance.table = table;
    instance.scroll = scroll;
    syncFloatingWidths(instance, table, head, scroll);
    var top = stickyTop(instance);
    var sourceRect = table.getBoundingClientRect();
    var headRect = head.getBoundingClientRect();
    var headRow = head.querySelector('tr');
    var height = Math.max(40, headRow ? headRow.getBoundingClientRect().height : 0, headRect.height || 0);
    var showHead = headRect.top < top && sourceRect.bottom > top + height;
    if (showHead) {
      var rect = scroll.getBoundingClientRect();
      instance.headHost.hidden = false;
      instance.headHost.style.top = top + 'px';
      instance.headHost.style.left = rect.left + 'px';
      instance.headHost.style.width = Math.max(0, Math.min(rect.width, window.innerWidth - rect.left)) + 'px';
      instance.headHost.style.height = height + 'px';
      var floating = instance.headHost.firstElementChild;
      syncFloatingWidths(instance, table, head, scroll);
      floating.style.height = height + 'px';
      floating.style.transform = 'translateX(-' + scroll.scrollLeft + 'px)';
      floating.querySelectorAll('.biz-identity').forEach(function (cell) {
        cell.style.transform = window.innerWidth <= 760 ? 'translateX(' + scroll.scrollLeft + 'px)' : '';
      });
    } else {
      instance.headHost.hidden = true;
    }
    var scrollRect = scroll.getBoundingClientRect();
    var showScroll = scroll.scrollWidth > scroll.clientWidth + 1 && scrollRect.top < window.innerHeight && scrollRect.bottom > window.innerHeight;
    if (showScroll) {
      instance.scrollHost.hidden = false;
      instance.scrollHost.style.left = scrollRect.left + 'px';
      instance.scrollHost.style.width = Math.max(0, Math.min(scrollRect.width, window.innerWidth - scrollRect.left)) + 'px';
      instance.scrollHost.querySelector('.biz-table-floating-scroll-inner').style.width = scroll.scrollWidth + 'px';
      if (Math.abs(instance.scrollHost.scrollLeft - scroll.scrollLeft) > 1) instance.scrollHost.scrollLeft = scroll.scrollLeft;
    } else {
      instance.scrollHost.hidden = true;
    }
  }

  function scheduleSync() {
    if (framePending) return;
    framePending = true;
    window.requestAnimationFrame(function () {
      framePending = false;
      instances = instances.filter(function (instance) {
        if (instance.root.isConnected) return true;
        if (instance.headHost) instance.headHost.remove();
        if (instance.scrollHost) instance.scrollHost.remove();
        if (instance.hint) instance.hint.remove();
        return false;
      });
      instances.forEach(sync);
    });
  }

  function attach(root, options) {
    root = resolve(root);
    if (!root) return null;
    options = options || {};
    if (!options.auto) instances = instances.filter(function (item) {
      if (!item.auto || item.root === root || !root.contains(item.root)) return true;
      if (item.hint) item.hint.remove();
      delete item.root.__bizTableInstance; return false;
    });
    normalizeHeaders(root);
    var instance = root.__bizTableInstance;
    if (!instance) {
      instance = {
        root: root,
        page: options.page,
        top: options.top,
        sticky: options.sticky !== false,
        auto: Boolean(options.auto),
        tableSelector: options.tableSelector,
        scrollSelector: options.scrollSelector
      };
      root.__bizTableInstance = instance;
      instances.push(instance);
    } else {
      Object.keys(options).forEach(function (key) { instance[key] = options[key]; });
    }
    scheduleSync();
    return instance;
  }

  function attachAll(container, options) {
    container = resolve(container) || document;
    normalizeHeaders(container);
    var roots = [];
    if (container.matches && container.matches('.biz-table-scroll')) roots.push(container);
    if (container.querySelectorAll) container.querySelectorAll('.biz-table-scroll').forEach(function (node) { roots.push(node); });
    roots.forEach(function (node) { attach(node, options); });
    scheduleSync();
  }

  normalizeHeaders(document);
  function discover(container) {
    var roots = [];
    if (container.matches && container.matches('.biz-table-scroll')) roots.push(container);
    if (container.querySelectorAll) roots = roots.concat(Array.from(container.querySelectorAll('.biz-table-scroll')));
    roots.forEach(function (node) {
      // 业务入口已挂到父容器时，不重复创建浮动表头与提示。
      if (!node.__bizTableInstance && !instances.some(function (item) { return item.root.contains(node); })) attach(node, { sticky: false, auto: true });
    });
  }
  discover(document);
  window.BusinessTable = { attach: attach, attachAll: attachAll, sync: scheduleSync };
  window.addEventListener('scroll', scheduleSync, { passive: true });
  window.addEventListener('resize', scheduleSync);
  document.addEventListener('scroll', scheduleSync, true);
  if (window.MutationObserver) {
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) {
          if (node.nodeType === 1) {
            normalizeHeaders(node);
            discover(node);
          }
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
})(window, document);
