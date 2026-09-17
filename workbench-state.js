// Disk snapshots are the durable store. localStorage is a fast per-origin copy,
// but may be too small for task references and changes when the server port does.
(() => {
  if (!/^https?:$/.test(location.protocol)) return;
  const supported = key => /^(aiWorkbench|refSlots$|reverseRefSlots$|grsaiKey$|grsaiUrl$|runninghubKey$|canvas)/.test(key);
  const nativeGet = Storage.prototype.getItem;
  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;
  const overflow = new Map();
  const flushers = [];
  let timer = 0, collecting = false, active = null, bootstrapError = null;
  let revision = Number(nativeGet.call(localStorage, 'aiWorkbenchStateChangedAt')) || 0;
  let savedRevision = -1;

  function putLocal(key, value) {
    try { nativeSet.call(localStorage, key, value); overflow.delete(key); }
    catch (error) {
      if (error.name !== 'QuotaExceededError') throw error;
      // Keep the complete value for the disk snapshot, including reference images.
      // Never leave an older native value masquerading as a newer local copy.
      nativeRemove.call(localStorage, key);
      overflow.set(key, value);
    }
  }
  try {
    const request = new XMLHttpRequest();
    request.open('GET', '/api/workbench-state', false);
    request.send();
    if (request.status !== 200) throw new Error('读取本机历史记录失败');
    const state = JSON.parse(request.responseText)?.state;
    if (state?.storage) {
      const preferDisk = !revision || state.updatedAt >= revision;
      const storage = {...state.storage};
      // One-time migration of the old format; subsequent snapshots honor deletions.
      if (state.version !== 2) {
        for (const key of ['aiWorkbenchTasksV3', 'aiWorkbenchAssetsV1']) {
          try {
            const disk = JSON.parse(storage[key] || '[]');
            const local = JSON.parse(nativeGet.call(localStorage, key) || '[]');
            const items = preferDisk ? [...local, ...disk] : [...disk, ...local];
            storage[key] = JSON.stringify([...new Map(items.filter(item => item?.key).map(item => [item.key, item])).values()]);
          } catch {}
        }
      }
      if (preferDisk) {
        for (const key of Object.keys(localStorage)) {
          if (supported(key) && !(key in storage)) nativeRemove.call(localStorage, key);
        }
      }
      for (const [key, value] of Object.entries(storage)) {
        if (supported(key) && (preferDisk || nativeGet.call(localStorage, key) === null || (state.version !== 2 && /^(aiWorkbenchTasksV3|aiWorkbenchAssetsV1)$/.test(key)))) putLocal(key, value);
      }
      revision = Math.max(revision, state.updatedAt || 0);
    }
  } catch (error) { bootstrapError = error; }

  function showError(error) {
    if (!document.body) return;
    let status = document.getElementById('workbenchPersistenceError');
    if (!status) {
      status = document.createElement('div'); status.id = 'workbenchPersistenceError';
      status.setAttribute('role', 'alert');
      status.style.cssText = 'position:fixed;bottom:12px;left:20px;right:20px;z-index:100000;padding:12px;background:#702525;color:white;border-radius:8px';
      document.body.append(status);
    }
    status.textContent = `历史记录尚未保存到磁盘，请暂勿退出：${error.message || error}`;
  }
  function schedule() {
    if (!timer && !collecting) timer = setTimeout(() => {
      timer = 0;
      flush().catch(error => { showError(error); timer = setTimeout(() => {timer = 0; schedule();}, 3000); });
    }, 250);
  }
  function changed() {
    revision = Math.max(Date.now(), revision + 1);
    putLocal('aiWorkbenchStateChangedAt', String(revision));
    schedule();
  }
  Storage.prototype.getItem = function(key) {
    key = String(key);
    return this === localStorage && overflow.has(key) ? overflow.get(key) : nativeGet.call(this, key);
  };
  Storage.prototype.setItem = function(key, value) {
    key = String(key); value = String(value);
    if (this !== localStorage || !supported(key)) return nativeSet.call(this, key, value);
    if (this.getItem(key) === value) return;
    putLocal(key, value); changed();
  };
  Storage.prototype.removeItem = function(key) {
    key = String(key);
    if (this !== localStorage || !supported(key)) return nativeRemove.call(this, key);
    const existed = this.getItem(key) !== null;
    nativeRemove.call(this, key); overflow.delete(key);
    if (existed) changed();
  };
  function collect() {
    collecting = true;
    try { for (const flusher of flushers) flusher(); }
    finally { collecting = false; }
    const storage = {};
    for (const key of new Set([...Object.keys(localStorage), ...overflow.keys()])) {
      if (supported(key)) storage[key] = localStorage.getItem(key);
    }
    return {version:2, updatedAt:revision, storage};
  }
  async function flush() {
    if (bootstrapError) throw bootstrapError;
    clearTimeout(timer); timer = 0;
    if (active) { await active; return flush(); }
    const state = collect();
    if (savedRevision === state.updatedAt) return true;
    active = (async () => {
      // keepalive fetch has a ~64 KiB body limit, unsuitable for task history.
      const response = await fetch('/api/workbench-state', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({state}), signal:AbortSignal.timeout(15000)});
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '磁盘保存失败');
      savedRevision = state.updatedAt;
      document.getElementById('workbenchPersistenceError')?.remove();
    })();
    try { await active; }
    finally { active = null; }
    if (revision !== savedRevision) return flush();
    return true;
  }
  window.workbenchState = {flush, registerFlusher: callback => flushers.push(callback)};
  // Flush in-memory data to localStorage before browser navigation. Desktop
  // close additionally awaits flush() while the renderer and server are alive.
  addEventListener('beforeunload', () => {collect();});
  addEventListener('pagehide', () => {collect();});
  document.addEventListener('visibilitychange', () => {if(document.hidden) flush().catch(showError);});
  addEventListener('DOMContentLoaded', () => {if(bootstrapError) showError(bootstrapError);else schedule();}, {once:true});
})();
