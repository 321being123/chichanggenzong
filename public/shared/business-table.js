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
    var breakAt = -1;
    for (var i = 3; i <= chars.length - 2; i++) {
      if (chars[i] === '(' || chars[i] === '（') { breakAt = i; break; }
    }
    if (breakAt < 0) breakAt = Math.ceil(chars.length / 2);
    target.textContent = chars.slice(0, breakAt).join('');
    target.appendChild(document.createElement('br'));
    target.appendChild(document.createTextNode(chars.slice(breakAt).join('')));
  }

  function normalizeHeaders(container) {
    container = container || document;
    if (container.matches && container.matches('.biz-table')) normalizeHeaderCells(container);
    if (container.querySelectorAll) container.querySelectorAll('.biz-table').forEach(normalizeHeaderCells);
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
    if (currentTable) normalizeHeaderCells(currentTable);
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
    var topEl = resolve(instance.top || (instance.root.closest && instance.root.closest('.admin-main') ? '.admin-topbar' : null));
    var top = topEl ? topEl.getBoundingClientRect().bottom : 0;
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
      instances.forEach(sync);
    });
  }

  function attach(root, options) {
    root = resolve(root);
    if (!root) return null;
    options = options || {};
    normalizeHeaders(root);
    var instance = root.__bizTableInstance;
    if (!instance) {
      instance = {
        root: root,
        page: options.page,
        top: options.top,
        sticky: options.sticky !== false,
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
            if (node.closest && node.closest('.admin-main')) attachAll(node);
          }
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
})(window, document);
