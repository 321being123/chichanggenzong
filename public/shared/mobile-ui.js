(function (window, document) {
  'use strict';
  var menus = [], dialogs = new Map();
  var navMedia = window.matchMedia('(max-width: 900px)');
  var phoneMedia = window.matchMedia('(max-width: 760px)');
  function focusables(root) {
    return Array.from(root.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')).filter(function (el) {
      return !el.disabled && !el.closest('[hidden], .hidden') && window.getComputedStyle(el).display !== 'none';
    });
  }
  function trap(event, root) {
    if (event.key !== 'Tab') return;
    var items = focusables(root), first = items[0], last = items[items.length - 1];
    if (!first) { event.preventDefault(); root.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  }
  function lockScroll() {
    document.body.classList.toggle('mobile-overlay-open', menus.some(function (m) { return m.open; }) || dialogs.size > 0);
  }
  function createMenu(bar, elements, title, label) {
    if (!bar || !elements.length) return;
    var toggle = document.createElement('button'), panel = document.createElement('div'), backdrop = document.createElement('div');
    toggle.type = 'button'; toggle.className = 'mobile-nav-toggle'; toggle.textContent = label || '菜单';
    panel.className = 'mobile-nav-panel'; panel.id = 'mobile-nav-panel-' + menus.length;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', label || '栏目菜单'); panel.tabIndex = -1;
    toggle.setAttribute('aria-controls', panel.id); toggle.setAttribute('aria-expanded', 'false');
    backdrop.className = 'mobile-nav-backdrop'; backdrop.hidden = true; panel.hidden = true;
    var close = document.createElement('button'); close.type = 'button'; close.className = 'mobile-menu-close'; close.textContent = '关闭菜单';
    panel.appendChild(close); document.body.appendChild(backdrop); document.body.appendChild(panel); bar.appendChild(toggle);
    var places = elements.map(function (el) { var mark = document.createComment('mobile-menu-origin'); el.before(mark); return mark; });
    var menu = { open: false, panel: panel, toggle: toggle, close: function () { setOpen(false); } };
    menus.push(menu);
    function setOpen(value) {
      menu.open = Boolean(value && navMedia.matches);
      panel.hidden = !menu.open; backdrop.hidden = !menu.open;
      toggle.setAttribute('aria-expanded', String(menu.open));
      if (menu.open) { panel.setAttribute('aria-modal', 'true'); close.focus(); }
      else { panel.removeAttribute('aria-modal'); if (panel.contains(document.activeElement)) toggle.focus(); }
      lockScroll();
    }
    function arrange() {
      setOpen(false);
      elements.forEach(function (el, i) { if (navMedia.matches) panel.appendChild(el); else places[i].after(el); });
      syncNavigation();
    }
    toggle.addEventListener('click', function () { setOpen(!menu.open); });
    close.addEventListener('click', menu.close); backdrop.addEventListener('click', menu.close);
    panel.addEventListener('click', function (event) {
      if (event.target.closest('.main-tab, .admin-menu-item, .nav-user-item, a[href]')) menu.close();
    });
    navMedia.addEventListener('change', arrange); arrange();
  }
  function syncNavigation() {
    var active = document.querySelector('.main-tab.active'), title = document.querySelector('.mobile-current-page');
    if (title) title.textContent = active ? active.textContent.trim() : (document.querySelector('.main-page.active h2') || {}).textContent || '存在小站';
    var nav = document.querySelector('.nav');
    if (nav) document.documentElement.style.setProperty('--site-nav-height', nav.getBoundingClientRect().height + 'px');
    if (window.BusinessTable) window.BusinessTable.sync();
    if (window.ChartInteraction) window.ChartInteraction.hide();
  }
  function disclosure(button, target) {
    if (!button || !target) return;
    button.setAttribute('aria-controls', target.id); button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', function () {
      var expanded = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(expanded)); target.classList.toggle('mobile-expanded', expanded);
    });
  }
  function prepareDialog(overlay) {
    var box = overlay.querySelector('.modal');
    if (!box || box.querySelector('.mobile-dialog-header')) return;
    var heading = box.querySelector('h2'), close = box.querySelector('.modal-close');
    var header = document.createElement('div'), content = document.createElement('div');
    header.className = 'mobile-dialog-header'; content.className = 'mobile-dialog-content';
    if (heading) { header.appendChild(heading); if (!heading.id) heading.id = overlay.id + '-title'; box.setAttribute('aria-labelledby', heading.id); }
    if (close) header.appendChild(close);
    Array.from(box.childNodes).forEach(function (node) {
      if (!(node.nodeType === 1 && node.classList.contains('modal-actions'))) content.appendChild(node);
    });
    box.prepend(header, content); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.tabIndex = -1;
  }
  function syncDialogs() {
    document.querySelectorAll('.modal-overlay.show').forEach(function (overlay) {
      if (dialogs.has(overlay)) {
        prepareDialog(overlay);
        if (document.activeElement === document.body) {
          var updatedBox = overlay.querySelector('.modal');
          if (updatedBox) (focusables(updatedBox)[0] || updatedBox).focus();
        }
        return;
      }
      dialogs.set(overlay, overlay.__returnFocus || document.activeElement); overlay.__returnFocus = null;
      menus.forEach(function (menu) { menu.close(); }); prepareDialog(overlay);
      var box = overlay.querySelector('.modal');
      if (box && !box.contains(document.activeElement)) (focusables(box)[0] || box).focus();
    });
    dialogs.forEach(function (trigger, overlay) {
      if (overlay.isConnected && overlay.classList.contains('show')) return;
      dialogs.delete(overlay); if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    });
    lockScroll();
  }
  function init() {
    var bar = document.querySelector('.nav-inner'), nav = document.querySelector('.main-nav');
    if (bar && nav) {
      var title = document.createElement('span'); title.className = 'mobile-current-page'; bar.appendChild(title);
      createMenu(bar, [nav, document.querySelector('.nav-right')].filter(Boolean));
    }
    var adminBar = document.querySelector('.admin-topbar'), sidebar = document.querySelector('.admin-sidebar');
    if (adminBar && sidebar) createMenu(adminBar, [sidebar], null, '管理菜单');
    var account = document.querySelector('.holdings-header .sub-nav-right');
    if (account) {
      var accountMark = document.createComment('account-tools-origin'), accountTools = document.createElement('div');
      account.before(accountMark); accountTools.className = 'mobile-account-tools';
      document.querySelector('.holdings-header').after(accountTools);
      function arrangeAccount() { if (phoneMedia.matches) accountTools.appendChild(account); else accountMark.after(account); syncNavigation(); }
      phoneMedia.addEventListener('change', arrangeAccount); arrangeAccount();
    }
    disclosure(document.getElementById('mobile-knowledge-categories'), document.getElementById('ks-sidebar-content'));
    disclosure(document.getElementById('mobile-knowledge-outline'), document.getElementById('ks-read-outline'));
    var valuationFilters = ['bond-val-safety', 'bond-val-alert', 'bond-val-data'].map(function (id) { return document.getElementById(id); }).filter(Boolean);
    if (valuationFilters.length === 3) {
      var filterButton = document.createElement('button'), filterDetails = document.createElement('div');
      filterButton.type = 'button'; filterButton.className = 'mobile-disclosure mobile-filter-toggle'; filterButton.textContent = '更多筛选';
      filterDetails.className = 'mobile-filter-details'; filterDetails.id = 'mobile-valuation-filters';
      valuationFilters[0].before(filterButton, filterDetails);
      valuationFilters.forEach(function (el) { filterDetails.appendChild(el); }); disclosure(filterButton, filterDetails);
      filterDetails.addEventListener('change', function () {
        var count = valuationFilters.filter(function (el) { return el.value !== ''; }).length;
        filterButton.textContent = count ? '更多筛选（已选 ' + count + ' 项）' : '更多筛选';
      });
    }
    document.addEventListener('focusin', function (event) {
      var overlay = event.target.closest('.modal-overlay.show');
      if (overlay && !dialogs.has(overlay) && event.relatedTarget && !overlay.contains(event.relatedTarget)) overlay.__returnFocus = event.relatedTarget;
    });
    document.addEventListener('keydown', function (event) {
      var layers = Array.from(dialogs.keys()).filter(function (el) { return el.classList.contains('show'); });
      layers.sort(function (a, b) { return Number(window.getComputedStyle(a).zIndex) - Number(window.getComputedStyle(b).zIndex); });
      var layer = layers[layers.length - 1] || (menus.find(function (m) { return m.open; }) || {}).panel;
      if (!layer) return;
      if (event.key === 'Escape') {
        var close = layer.querySelector('.modal-close:not([disabled]), .mobile-menu-close');
        if (close) { event.preventDefault(); close.click(); }
      } else trap(event, layer);
    });
    document.addEventListener('click', function (event) {
      var tab = event.target.closest('.nav-tab, .bond-sub-tab, .mv-sub-tab');
      if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (phoneMedia.matches) {
        var link = event.target.closest('a[target="_blank"][href]');
        if (link) {
          var url = new URL(link.href, window.location.href);
          if (url.origin === window.location.origin && /\/(ipo-report|bond-revision-motive)\.html$/.test(url.pathname)) link.removeAttribute('target');
        }
      }
    }, true);
    new MutationObserver(function (records) {
      if (records.some(function (r) {
        if (r.type === 'attributes') return r.target.matches('.modal-overlay');
        return r.target.closest('.modal-overlay.show') || Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).some(function (n) {
          return n.nodeType === 1 && (n.matches('.modal-overlay') || n.querySelector('.modal-overlay'));
        });
      })) syncDialogs();
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    if (window.visualViewport) {
      function viewportChanged() {
        document.documentElement.style.setProperty('--mobile-viewport-height', window.visualViewport.height + 'px');
        document.documentElement.style.setProperty('--mobile-viewport-top', window.visualViewport.offsetTop + 'px');
      }
      window.visualViewport.addEventListener('resize', viewportChanged); window.visualViewport.addEventListener('scroll', viewportChanged); viewportChanged();
    }
    window.addEventListener('resize', syncNavigation); syncNavigation(); syncDialogs();
  }
  window.MobileUI = { syncNavigation: syncNavigation, closeMenus: function () { menus.forEach(function (m) { m.close(); }); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window, document);
