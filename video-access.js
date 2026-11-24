(() => {
  let token = '';
  let pending = null;
  const originalFetch = window.fetch.bind(window);
  const dialog = document.createElement('dialog');
  dialog.id = 'videoUnlockDialog';
  dialog.setAttribute('aria-labelledby', 'videoUnlockTitle');
  dialog.innerHTML = `<form id="videoUnlockForm">
    <h2 id="videoUnlockTitle">解锁视频功能</h2>
    <p>请输入视频使用密码。本次打开期间有效，重新打开后需再次输入。</p>
    <label for="videoUnlockPassword">密码</label>
    <input id="videoUnlockPassword" type="password" autocomplete="off" required>
    <p id="videoUnlockError" role="alert"></p>
    <div class="video-unlock-actions"><button type="button" id="videoUnlockCancel">取消</button><button type="submit" id="videoUnlockConfirm">解锁</button></div>
  </form>`;
  const style = document.createElement('style');
  style.textContent = `#videoUnlockDialog{width:min(420px,90vw);box-sizing:border-box;padding:24px;border:1px solid #424754;border-radius:12px;background:#20232b;color:#eceef3}#videoUnlockDialog::backdrop{background:#0009}#videoUnlockDialog h2{margin:0 0 12px}#videoUnlockDialog p{font-size:13px;line-height:1.6}#videoUnlockPassword{box-sizing:border-box;width:100%;margin:8px 0;padding:10px;background:#15171d;color:#fff;border:1px solid #555b69;border-radius:6px}#videoUnlockError{color:#ff9999;min-height:21px}.video-unlock-actions{display:flex;justify-content:flex-end;gap:10px}.video-unlock-actions button{padding:9px 18px;border-radius:6px;cursor:pointer}`;
  document.head.append(style);
  document.body.append(dialog);
  const input = dialog.querySelector('input');
  const error = dialog.querySelector('[role="alert"]');
  const confirm = dialog.querySelector('[type="submit"]');
  let finish = null;
  const close = success => {
    input.value = '';
    dialog.close();
    const resolve = finish;
    finish = null;
    pending = null;
    resolve?.(success);
  };
  dialog.querySelector('#videoUnlockCancel').onclick = () => close(false);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(false); });
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    if (confirm.disabled) return;
    const attempt = finish;
    confirm.disabled = true;
    error.textContent = '';
    try {
      const response = await originalFetch('/api/video-unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.value }) });
      const result = await response.json();
      if (finish !== attempt) return;
      if (!response.ok || !result.token) throw new Error(result.error || '解锁失败，请重试。');
      token = result.token;
      close(true);
    } catch (failure) {
      if (finish === attempt) { error.textContent = failure.message || '无法连接本地服务，请重试。'; input.value = ''; input.focus(); }
    } finally { confirm.disabled = false; }
  };
  const ensure = () => {
    if (token) return Promise.resolve(true);
    if (pending) return pending;
    pending = new Promise(resolve => { finish = resolve; });
    error.textContent = '';
    input.value = '';
    dialog.showModal();
    input.focus();
    return pending;
  };
  window.workbenchVideoAccess = { ensure, isUnlocked: () => Boolean(token) };
  // Canvas video requests use the same password gate as the video page.
  window.fetch = async (resource, options = {}) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource), location.href);
    if (url.origin !== location.origin || !/^\/(rh-api|v1)\//.test(url.pathname)) return originalFetch(resource, options);
    let model = '';
    try { model = JSON.parse(options.body || '{}').model || ''; } catch {}
    if (!/(?:text|image|reference)-to-video|rhart-video/i.test(url.pathname) && !/^minimax-h3$/i.test(model)) return originalFetch(resource, options);
    if (!await ensure()) throw new Error('视频功能尚未解锁。');
    const headers = new Headers(options.headers || (resource instanceof Request ? resource.headers : undefined));
    headers.set('X-Workbench-Video-Token', token);
    const response = await originalFetch(resource, { ...options, headers });
    if (response.status === 403) {
      const result = await response.clone().json().catch(() => null);
      if (result?.code === 'VIDEO_LOCKED') token = '';
    }
    return response;
  };
})();
