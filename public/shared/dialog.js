(function () {
  let resolver = null;
  let dialogMode = 'confirm';

  function ensureDialog() {
    let overlay = document.getElementById('project-dialog');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'project-dialog';
    overlay.className = 'modal-overlay project-dialog-overlay';
    overlay.innerHTML =
      '<div class="modal project-dialog-box" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">' +
        '<h2 id="project-dialog-title">提示</h2>' +
        '<button type="button" class="modal-close" id="project-dialog-close" aria-label="关闭">&times;</button>' +
        '<p class="project-dialog-message" id="project-dialog-message"></p>' +
        '<input class="project-dialog-input" id="project-dialog-input" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true">' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" id="project-dialog-cancel">取消</button>' +
          '<button type="button" class="btn btn-primary" id="project-dialog-confirm">确定</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#project-dialog-close').addEventListener('click', function () { settle(null); });
    overlay.querySelector('#project-dialog-cancel').addEventListener('click', function () { settle(null); });
    overlay.querySelector('#project-dialog-confirm').addEventListener('click', function () {
      const input = overlay.querySelector('#project-dialog-input');
      settle(dialogMode === 'prompt' ? input.value : true);
    });
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) settle(null);
    });
    document.addEventListener('keydown', function (event) {
      if (!overlay.classList.contains('show')) return;
      if (event.key === 'Escape') settle(null);
      if (event.key === 'Enter' && dialogMode !== 'prompt') settle(true);
    });
    return overlay;
  }

  function settle(value) {
    const overlay = document.getElementById('project-dialog');
    if (overlay) overlay.classList.remove('show');
    const done = resolver;
    resolver = null;
    if (done) done(value);
  }

  function openDialog(mode, message, options) {
    const opts = options || {};
    const overlay = ensureDialog();
    if (resolver) settle(null);
    dialogMode = mode;
    overlay.querySelector('#project-dialog-title').textContent = opts.title || (mode === 'alert' ? '提示' : '请确认');
    overlay.querySelector('#project-dialog-message').textContent = String(message || '');
    const input = overlay.querySelector('#project-dialog-input');
    input.classList.toggle('hidden', mode !== 'prompt');
    input.value = mode === 'prompt' ? String(opts.value || '') : '';
    const cancel = overlay.querySelector('#project-dialog-cancel');
    cancel.classList.toggle('hidden', mode === 'alert');
    const confirm = overlay.querySelector('#project-dialog-confirm');
    confirm.textContent = opts.confirmText || (mode === 'alert' ? '知道了' : '确定');
    confirm.classList.toggle('btn-danger', !!opts.danger);
    confirm.classList.toggle('btn-primary', !opts.danger);
    overlay.classList.add('show');
    setTimeout(function () {
      if (mode === 'prompt') input.select();
      else confirm.focus();
    }, 0);
    return new Promise(function (resolve) { resolver = resolve; });
  }

  window.projectConfirm = function (message, options) {
    return openDialog('confirm', message, options).then(function (value) { return value === true; });
  };
  window.projectAlert = function (message, options) {
    return openDialog('alert', message, options);
  };
  window.projectPrompt = function (message, options) {
    return openDialog('prompt', message, options);
  };
})();
