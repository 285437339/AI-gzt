(() => {
  'use strict';

  const video = ['video', '原始视频', 'video/*'];
  const tools = {
    'video-face-swap': {
      title: '视频换脸', icon: '◉',
      output: 'video',
      inputs: [video, ['img', '目标人脸照片', 'image/png,image/jpeg,image/webp']],
      note: '仅使用你本人或已明确授权的人脸素材。'
    },
    'voice-clone': {
      title: '声音克隆', icon: '♬',
      output: 'audio',
      note: '独立声音克隆目前仅支持准备样本。仅使用你本人或已明确授权的声音。'
    },
    'video-translation': {
      title: '视频翻译', icon: '译',
      output: 'video',
      inputs: [video]
    },
    'text-dubbing': {
      title: '文本配音', icon: '音', output: 'audio'
    }
  };

  const nav = document.querySelector('.nav');
  function makeNavGroup(id, title, icon, views, expanded = false) {
    const entries = views.map(view => nav.querySelector('button[data-view="' + view + '"]'));
    const group = document.createElement('section');
    group.className = 'workbench-nav-group';
    group.setAttribute('aria-labelledby', id + 'Title');
    group.innerHTML = `
      <button type="button" id="${id}Title" aria-expanded="${expanded}" aria-controls="${id}Items">
        <span class="nav-icon" aria-hidden="true">${icon}</span><span>${title}</span><span class="workbench-nav-chevron" aria-hidden="true"></span>
      </button>
      <div id="${id}Items" class="workbench-nav-items"></div>`;
    const toggle = group.querySelector('button');
    const items = group.querySelector('.workbench-nav-items');
    items.hidden = !expanded;
    toggle.onclick = () => {
      items.hidden = !items.hidden;
      toggle.setAttribute('aria-expanded', String(!items.hidden));
    };
    entries[0].before(group);
    items.append(...entries);
    return items;
  }

  makeNavGroup('creationToolsNav', '图片创作工具', '▦', ['workspace', 'reverse', 'inspiration', 'assets', 'assistant'], true);
  const mediaNavItems = makeNavGroup('mediaToolsNav', '音视频工具', '♫', ['video']);

  const section = document.createElement('section');
  section.className = 'workspace media-tools-view';
  section.id = 'mediaToolsView';
  section.hidden = true;
  document.querySelector('.main').append(section);

  const pages = new Map();
  const buttons = new Map();
  // SoundView OpenAPI §4.4.2 lists different source and target language sets.
  const translationSourceLanguages = [
    ['cn', '中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['ru', '俄语'],
    ['de', '德语'], ['fr', '法语'], ['ar', '阿拉伯语'], ['es', '西班牙语'],
    ['it', '意大利语'], ['pt', '葡萄牙语'], ['ms', '马来语'], ['th', '泰语']
  ];
  const translationTargetLanguages = [
    ...translationSourceLanguages,
    ['tl', '菲律宾语'], ['nl', '荷兰语'], ['vi', '越南语'], ['id', '印尼语'],
    ['no', '挪威语'], ['ca', '加泰罗尼亚语'], ['bn', '孟加拉语']
  ];
  const dubbingLanguages = [
    ['cn', '中文'], ['en', '英语'], ['ko', '韩语'], ['tl', '菲律宾语'],
    ['th', '泰语'], ['ms', '马来语'], ['id', '印尼语']
  ];
  const mediaFormats = {
    video: { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo' },
    audio: { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm' }
  };
  const imageMaterialFormats = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
  const materialTargets = new WeakMap();
  const selectedMaterials = new WeakMap();
  let hoveredMaterial = null;
  let resultsDb;
  let cancelVoiceCapture;
  let voiceLibrary;

  async function soundViewRequest(path, options) {
    const response = await fetch('/api/soundview/' + path, options).catch(error => {
      if (error.name === 'AbortError' || error.message === '视频功能尚未解锁。') throw error;
      throw new Error('无法连接本机音色服务，请重试。');
    });
    const data = await response.json().catch(() => null);
    if (response.status === 404 || response.status === 405 || (response.ok && !data)) {
      throw new Error('此工作台未提供音色接口，请打开新版工作台。');
    }
    if (!response.ok) {
      // A running preview may still return the old provider-branded errors.
      const message = typeof data?.error === 'string' ? data.error.replace(/\s*\bSoundView\b\s*/gi, '') : '';
      throw Object.assign(new Error(message || '音色服务请求失败，请重试。'), { code: data?.code });
    }
    return data;
  }

  const soundViewSettings = (() => {
    const form = document.querySelector('#settingsSoundView');
    const fields = form.querySelector('fieldset');
    const appKey = form.querySelector('#settingsSoundViewKey');
    const appSecret = form.querySelector('#settingsSoundViewSecret');
    const clear = form.querySelector('#settingsSoundViewClear');
    const status = form.querySelector('[role="status"]');
    let pending = false;
    let available = false;
    let configured = false;
    function show(message, kind = '') {
      status.textContent = message;
      status.className = ['settings-status', kind].filter(Boolean).join(' ');
    }
    async function update(method, credentials) {
      if (pending) return;
      pending = fields.disabled = true;
      show(method === 'PUT' ? '正在验证凭据…' : method === 'DELETE' ? '正在移除凭据…' : '正在读取配置…', 'busy');
      try {
        const options = credentials
          ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) }
          : { method };
        const data = await soundViewRequest('settings', options);
        if (typeof data.configured !== 'boolean') throw new Error('无法读取音色服务配置。');
        available = true;
        configured = data.configured;
        if (method !== 'GET') {
          form.reset();
          voiceLibrary?.invalidate();
        }
        show(configured ? (method === 'PUT' ? '已验证并保存。' : '已配置。') : '未配置。', configured ? 'ok' : '');
      } catch (error) {
        if (method === 'GET') available = false;
        show(error.message, 'fail');
      } finally {
        pending = false;
        fields.disabled = !available;
        clear.disabled = !configured;
      }
    }
    form.onsubmit = event => {
      event.preventDefault();
      if (pending || !available) return;
      const credentials = { appKey: appKey.value.trim(), appSecret: appSecret.value.trim() };
      if (!credentials.appKey || !credentials.appSecret) {
        show('请填写 AppKey 和 AppSecret。', 'fail');
        return;
      }
      appSecret.value = '';
      void update('PUT', credentials);
    };
    clear.onclick = () => { if (configured && available) void update('DELETE'); };
    return {
      refresh: () => void update('GET'),
      open() {
        nav.querySelector('[data-view="settings"]').click();
        form.scrollIntoView({ block: 'nearest' });
      },
      leave() { form.reset(); }
    };
  })();

  function makeVoiceLibrary() {
    const dialog = document.createElement('dialog');
    dialog.className = 'media-voice-dialog';
    dialog.setAttribute('aria-labelledby', 'mediaVoiceTitle');
    dialog.innerHTML = `
      <header><h2 id="mediaVoiceTitle">音色库</h2>
        <button type="button" data-close aria-label="关闭音色设置" title="关闭">×</button></header>
      <div class="media-voice-body">
        <div class="media-voice-tools" hidden>
          <strong></strong><input type="search" aria-label="搜索音色" placeholder="搜索名称、口音或标签">
          <button type="button" data-reload>刷新</button>
        </div>
        <p class="media-tools-status" role="status"></p>
        <button type="button" data-settings hidden>打开音色设置</button>
        <div class="media-voice-grid" role="group" aria-label="可用音色"></div>
      </div>
      <footer><button type="button" data-clear>清除音色</button><button type="button" data-close>取消</button>
        <button type="button" data-confirm disabled>确定</button></footer>`;
    document.body.append(dialog);
    const tools = dialog.querySelector('.media-voice-tools');
    const search = tools.querySelector('input');
    const grid = dialog.querySelector('.media-voice-grid');
    const status = dialog.querySelector('[role="status"]');
    const confirm = dialog.querySelector('[data-confirm]');
    const clear = dialog.querySelector('[data-clear]');
    const reload = dialog.querySelector('[data-reload]');
    const settings = dialog.querySelector('[data-settings]');
    const audio = new Audio();
    let catalog;
    let context;
    let picked;
    let playback;
    let pending;
    function stopAudio() {
      if (!playback) return;
      playback.button.textContent = '▶';
      playback.button.setAttribute('aria-label', '试听 ' + playback.name);
      playback = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    audio.onended = stopAudio;
    audio.onerror = () => {
      if (!playback) return;
      stopAudio();
      status.textContent = '试听暂不可用，请重试。';
    };
    function render() {
      stopAudio();
      const query = search.value.trim().toLowerCase();
      const voices = catalog.filter(voice => voice.lang === context.lang);
      const matches = voices.filter(voice => [voice.name, ...voice.tags].some(value => value.toLowerCase().includes(query)));
      grid.replaceChildren();
      status.textContent = !voices.length ? '当前语种没有可用音色。' : !matches.length ? '没有匹配的音色。' : '';
      for (const voice of matches) {
        const item = document.createElement('div');
        item.className = 'media-voice-item';
        const label = document.createElement('label');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'soundViewVoice';
        radio.value = voice.id;
        radio.checked = picked?.id === voice.id;
        radio.onchange = () => { picked = voice; confirm.disabled = false; };
        const name = document.createElement('strong');
        name.textContent = voice.name;
        label.append(radio, name);
        const play = document.createElement('button');
        play.type = 'button';
        play.textContent = '▶';
        play.disabled = !voice.auditionUrl;
        play.title = voice.auditionUrl ? '试听' : '没有试听音频';
        play.setAttribute('aria-label', '试听 ' + voice.name);
        play.onclick = async () => {
          if (playback?.button === play) return stopAudio();
          stopAudio();
          const attempt = playback = { button: play, name: voice.name };
          play.textContent = 'Ⅱ';
          play.setAttribute('aria-label', '停止试听 ' + voice.name);
          status.textContent = '';
          audio.src = voice.auditionUrl;
          audio.playbackRate = context.audition?.rate ?? 1;
          audio.volume = context.audition?.volume ?? 1;
          try { await audio.play(); }
          catch {
            if (playback !== attempt) return;
            stopAudio();
            status.textContent = '试听暂不可用，请重试。';
          }
        };
        item.append(label, play);
        for (const value of [voice.note, voice.tags.join(' · ')].filter(Boolean)) {
          const line = document.createElement('p');
          line.textContent = value;
          item.append(line);
        }
        grid.append(item);
      }
    }
    async function load() {
      if (pending) return;
      const request = pending = new AbortController();
      reload.disabled = confirm.disabled = true;
      settings.hidden = true;
      stopAudio();
      status.textContent = '正在加载音色…';
      try {
        const data = await soundViewRequest('voices', { signal: request.signal });
        if (pending !== request) return;
        if (!Array.isArray(data.voices)) throw new Error('无法读取音色列表。');
        catalog = data.voices;
        picked = catalog.find(voice => voice.lang === context.lang && voice.id === (picked || context.selected)?.id);
        render();
      } catch (error) {
        if (pending === request) {
          if (error.code === 'SOUNDVIEW_SETUP') {
            catalog = picked = null;
            grid.replaceChildren();
            settings.hidden = false;
          }
          status.textContent = error.message;
        }
      } finally {
        if (pending === request) {
          pending = null;
          reload.disabled = false;
          confirm.disabled = !picked || !catalog;
          tools.hidden = !catalog;
        }
      }
    }
    settings.onclick = () => { dialog.close(); soundViewSettings.open(); };
    search.oninput = () => { if (catalog && !pending) render(); };
    reload.onclick = () => void load();
    dialog.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => dialog.close(); });
    function resetActivity() {
      pending?.abort();
      pending = null;
      stopAudio();
      reload.disabled = false;
    }
    dialog.onclose = () => { if (!dialog.open) resetActivity(); };
    confirm.onclick = () => {
      if (!catalog || !picked || pending) return;
      context.apply({ id: picked.id, name: picked.name, lang: picked.lang });
      dialog.close();
    };
    clear.onclick = () => { context.apply(null); dialog.close(); };
    return {
      open(next) {
        resetActivity();
        context = next;
        tools.querySelector('strong').textContent = next.languageName;
        search.value = '';
        picked = catalog?.find(voice => voice.lang === next.lang && voice.id === next.selected?.id);
        clear.hidden = !next.selected;
        settings.hidden = true;
        tools.hidden = !catalog;
        confirm.disabled = !picked;
        status.textContent = '';
        grid.replaceChildren();
        dialog.showModal();
        if (catalog) render();
        else void load();
      },
      close() { if (dialog.open) dialog.close(); },
      invalidate() {
        resetActivity();
        catalog = picked = null;
        if (dialog.open) {
          tools.hidden = true;
          grid.replaceChildren();
          void load();
        }
      }
    };
  }

  function openVoiceLibrary(language, selected, apply, audition) {
    (voiceLibrary ||= makeVoiceLibrary()).open({
      lang: language.value, languageName: language.selectedOptions[0].textContent, selected, apply, audition
    });
  }

  function catalogVoice(value) {
    return value && ['id', 'name', 'lang'].every(key => typeof value[key] === 'string' && value[key])
      ? { id: value.id.slice(0, 160), name: value.name.slice(0, 160), lang: value.lang.slice(0, 16) } : null;
  }

  function withResults(mode, perform) {
    resultsDb ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('workbench-media-results', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('results', { keyPath: 'id' });
        store.createIndex('tool', 'tool');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    }).catch(error => { resultsDb = null; throw error; });
    return resultsDb.then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction('results', mode);
      const request = perform(transaction.objectStore('results'));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onabort = () => reject(transaction.error || new Error('本地结果保存已中断。'));
    }));
  }

  function outputMime(file, kind) {
    if (file.type.startsWith(kind + '/')) return file.type;
    const extension = file.name.split('.').pop().toLowerCase();
    if (!file.type || file.type === 'application/octet-stream' ||
      (kind === 'audio' && file.type === 'video/mp4' && extension === 'm4a') ||
      (kind === 'audio' && file.type === 'application/ogg')) {
      const formats = mediaFormats[kind];
      return Object.hasOwn(formats, extension) ? formats[extension] : '';
    }
    return '';
  }

  function makeResults(key, kind) {
    const panel = document.createElement('aside');
    panel.className = 'tasks media-tools-results';
    panel.setAttribute('aria-labelledby', key + '-results-title');
    panel.innerHTML = `
      <div class="media-tools-results-head">
        <h2 id="${key}-results-title">任务结果</h2>
        <button class="media-tools-import" type="button" disabled>导入本地结果</button>
        <input type="file" multiple hidden>
      </div>
      <p class="media-tools-status media-tools-results-status" role="status"></p>
      <div class="media-tools-results-empty empty">正在加载结果…</div>
      <div class="media-tools-result-list" role="list"></div>`;
    const button = panel.querySelector('.media-tools-import');
    const input = panel.querySelector('input');
    const status = panel.querySelector('[role="status"]');
    const list = panel.querySelector('[role="list"]');
    const empty = panel.querySelector('.media-tools-results-empty');
    input.accept = [kind + '/*', ...Object.keys(mediaFormats[kind]).map(ext => '.' + ext)].join(',');

    function updateEmpty() {
      empty.hidden = Boolean(list.childElementCount);
      empty.textContent = '暂无结果';
    }

    function addResult(result, prepend = false) {
      if (result.taskId) return addOnlineResult(result, prepend);
      const item = document.createElement('article');
      item.className = 'task media-tools-result';
      item.setAttribute('role', 'listitem');
      item.innerHTML = `<div class="media-tools-result-head"><strong></strong><span>已导入</span></div>
        <div class="meta"></div>
        <div class="actions"><a class="media-tools-download">下载</a><button type="button">移除</button></div>`;
      item.querySelector('strong').textContent = result.name;
      item.querySelector('.meta').textContent = new Date(result.createdAt).toLocaleString('zh-CN', { hour12: false });
      const url = URL.createObjectURL(result.file);
      const media = document.createElement(kind);
      media.className = 'media-tools-preview';
      media.controls = true;
      media.preload = 'none';
      media.setAttribute('aria-label', '预览 ' + result.name);
      media.addEventListener('error', () => {
        const note = document.createElement('p');
        note.className = 'media-tools-note';
        note.textContent = '无法预览此格式，仍可下载文件。';
        media.replaceWith(note);
      }, { once: true });
      const actions = item.querySelector('.actions');
      item.insertBefore(media, actions);
      media.src = url;
      const download = actions.querySelector('a');
      download.href = url;
      download.download = result.name;
      download.setAttribute('aria-label', '下载 ' + result.name);
      const remove = actions.querySelector('button');
      remove.setAttribute('aria-label', '移除 ' + result.name);
      remove.onclick = async () => {
        remove.disabled = true;
        status.textContent = '';
        try {
          await withResults('readwrite', store => store.delete(result.id));
          media.pause();
          URL.revokeObjectURL(url);
          item.remove();
          updateEmpty();
          button.focus();
        } catch {
          remove.disabled = false;
          status.textContent = '移除失败，请重试。';
        }
      };
      if (prepend) list.prepend(item);
      else list.append(item);
    }

    function addOnlineResult(result, prepend = true) {
      const item = document.createElement('article');
      item.className = 'task media-tools-result';
      item.setAttribute('role', 'listitem');
      item.innerHTML = `<div class="media-tools-result-head"><strong></strong><span role="status"></span></div>
        <div class="meta"></div><div class="media-online-output"></div>
        <p class="media-tools-status media-online-message"></p>
        <div class="actions"><button type="button">刷新结果</button><button type="button">移除</button></div>`;
      item.querySelector('strong').textContent = result.name;
      item.querySelector('.meta').textContent = '任务 ' + result.taskId;
      const state = item.querySelector('[role="status"]');
      const output = item.querySelector('.media-online-output');
      const message = item.querySelector('.media-online-message');
      const [refresh, remove] = item.querySelectorAll('button');
      let disposed = false;
      let renderedOutput;
      function render() {
        state.textContent = result.status === 'completed' ? '已完成' : result.status === 'failed' ? '失败'
          : result.status === 'paused' ? '待查询' : result.progress == null ? '处理中' : `处理中 ${result.progress}%`;
        const actions = item.querySelector('.actions');
        message.textContent = result.error || '';
        const outputKey = result.status === 'completed' ? JSON.stringify([result.url, result.subtitles]) : '';
        if (outputKey === renderedOutput) return;
        renderedOutput = outputKey;
        actions.querySelectorAll('.media-online-download').forEach(button => button.remove());
        output.replaceChildren();
        if (result.status === 'completed') {
          const media = document.createElement(kind);
          media.className = 'media-tools-preview';
          media.controls = true;
          media.preload = 'none';
          media.src = result.url;
          media.setAttribute('aria-label', '预览 ' + result.name);
          output.append(media);
          const links = [[result.url, kind === 'audio' ? '下载音频' : '下载视频'], [result.subtitles, '下载字幕']];
          for (const [url, label] of links) {
            if (!url) continue;
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'media-online-download';
            link.textContent = label;
            link.onclick = async () => {
              link.disabled = true;
              message.textContent = '';
              try {
                if (window.workbenchDesktop?.downloadMedia) await window.workbenchDesktop.downloadMedia(url);
                else {
                  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
                  if (!response.ok) throw new Error();
                  const blob = URL.createObjectURL(await response.blob());
                  const anchor = document.createElement('a');
                  anchor.href = blob;
                  anchor.download = new URL(url).pathname.split('/').at(-1) || '任务结果-' + result.taskId;
                  anchor.click();
                  setTimeout(() => URL.revokeObjectURL(blob), 30_000);
                }
              } catch { message.textContent = '无法下载，请刷新结果后重试。'; }
              finally { link.disabled = false; }
            };
            actions.insertBefore(link, refresh);
          }
        }
      }
      async function poll(auto = false) {
        if (refresh.disabled || disposed) return;
        refresh.disabled = true;
        const started = Date.now();
        try {
          do {
            const data = await soundViewRequest('media/status', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ kind: key, id: result.taskId })
            });
            if (disposed) return;
            if (result.status === 'completed' && data.status !== 'completed') {
              result.error = data.error || '未取到新的结果链接。';
              break;
            }
            Object.assign(result, data, { error: data.error || '' });
            render();
            if (!auto || result.status !== 'processing') break;
            await new Promise(resolve => setTimeout(resolve, 4500));
          } while (!disposed && Date.now() - started < 6 * 60_000);
          if (auto && !disposed && result.status === 'processing') {
            result.status = 'paused';
            result.error = '任务仍可继续处理，可稍后刷新结果。';
          }
        } catch (error) {
          if (!['completed', 'failed'].includes(result.status)) result.status = 'paused';
          result.error = error.message;
        } finally {
          refresh.disabled = false;
          if (!disposed) {
            render();
            await withResults('readwrite', store => store.put(result)).catch(() => {});
          }
        }
      }
      refresh.onclick = () => void poll(true);
      remove.onclick = async () => {
        remove.disabled = true;
        disposed = true;
        try {
          await withResults('readwrite', store => store.delete(result.id));
          item.remove();
          updateEmpty();
          button.focus();
        } catch {
          disposed = false;
          remove.disabled = false;
          status.textContent = '移除失败，请重试。';
        }
      };
      if (prepend) list.prepend(item);
      else list.append(item);
      render();
      if (prepend || result.status === 'processing') void poll(true);
    }

    panel.addOnlineTask = async (taskId, name) => {
      const task = { id: crypto.randomUUID(), tool: key, taskId, name, createdAt: Date.now(), status: 'processing' };
      try { await withResults('readwrite', store => store.add(task)); }
      catch { status.textContent = '任务已提交，但无法在本机保存记录。'; }
      addOnlineResult(task);
      updateEmpty();
      panel.scrollTop = 0;
    };

    button.onclick = () => input.click();
    input.onchange = async () => {
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;
      const results = files.flatMap(file => {
        const mime = outputMime(file, kind);
        return mime && file.size ? [{
          id: crypto.randomUUID(), tool: key, name: file.name, createdAt: Date.now(),
          file: file.type === mime ? file : file.slice(0, file.size, mime)
        }] : [];
      });
      if (!results.length) {
        status.textContent = kind === 'video' ? '请选择有效的视频文件。' : '请选择有效的音频文件。';
        return;
      }
      button.disabled = true;
      status.textContent = '正在导入…';
      try {
        await withResults('readwrite', store => { for (const result of results) store.add(result); });
        for (const result of results) addResult(result, true);
        updateEmpty();
        panel.scrollTop = 0;
        status.textContent = results.length === files.length ? '' : '已跳过不支持的文件。';
      } catch (error) {
        status.textContent = error?.name === 'QuotaExceededError'
          ? '本地存储空间不足，请移除不再需要的结果后重试。'
          : '无法保存本地结果，请重试。';
      } finally { button.disabled = false; }
    };

    void withResults('readonly', store => store.index('tool').getAll(key)).then(results => {
      results.sort((a, b) => b.createdAt - a.createdAt);
      for (const result of results) addResult(result);
      updateEmpty();
    }).catch(() => {
      empty.hidden = true;
      status.textContent = '无法加载本地结果。';
    }).finally(() => { button.disabled = false; });
    return panel;
  }

  function materialFiles(transfer) {
    const files = Array.from(transfer?.files || []);
    return files.length ? files : Array.from(transfer?.items || [])
      .filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  }

  function materialMime(file, tag, accept) {
    if (tag !== 'img') return outputMime(file, tag);
    if (accept.split(',').includes(file.type)) return file.type;
    if (file.type && file.type !== 'application/octet-stream') return '';
    const extension = file.name.split('.').pop().toLowerCase();
    return Object.hasOwn(imageMaterialFormats, extension) ? imageMaterialFormats[extension] : '';
  }

  document.addEventListener('paste', event => {
    if (section.hidden || event.defaultPrevented ||
      event.target.closest?.('input:not([type="file"]), textarea, [contenteditable]:not([contenteditable="false"])')) return;
    const active = target => target && section.contains(target) && !target.closest('[hidden]');
    const focused = event.target.closest?.('.media-tools-dropzone');
    const target = active(hoveredMaterial) ? hoveredMaterial : active(focused) ? focused : null;
    const files = target ? materialFiles(event.clipboardData) : [];
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    materialTargets.get(target)(files);
  }, true);

  function makePreview(id, [tag, title, accept], recordable = false) {
    const field = document.createElement('div');
    field.className = 'media-tools-field';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = title;
    const input = document.createElement('input');
    input.type = 'file';
    input.id = id;
    input.accept = [accept, ...Object.keys(tag === 'img' ? imageMaterialFormats : tag === 'video' ? mediaFormats.video : {})
      .map(extension => '.' + extension)].join(',');
    input.hidden = true;
    const zone = document.createElement('div');
    zone.className = 'media-tools-dropzone';
    zone.setAttribute('role', 'group');
    label.id = id + '-label';
    zone.setAttribute('aria-labelledby', label.id);
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.textContent = '选择文件';
    choose.setAttribute('aria-label', '选择' + title);
    zone.title = '拖入或粘贴素材';
    choose.setAttribute('aria-description', zone.title);
    zone.append(choose, input);
    const preview = document.createElement(tag);
    preview.className = 'media-tools-preview';
    preview.hidden = true;
    if (tag === 'img') preview.alt = title;
    else { preview.controls = true; preview.preload = 'metadata'; }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移除';
    remove.setAttribute('aria-label', '移除' + title);
    remove.hidden = true;
    const status = document.createElement('p');
    status.className = 'media-tools-status';
    status.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'media-tools-sample-actions';
    actions.append(remove);
    field.append(label, zone, status, preview, actions);

    let url = '';
    let download;
    function clear() {
      selectedMaterials.delete(field);
      preview.hidden = remove.hidden = true;
      if (download) {
        download.hidden = true;
        download.removeAttribute('href');
      }
      preview.removeAttribute('src');
      if (tag !== 'img') preview.load();
      if (url) URL.revokeObjectURL(url);
      url = '';
      status.textContent = '';
    }
    function show(file) {
      url = URL.createObjectURL(file);
      preview.src = url;
      preview.hidden = remove.hidden = false;
    }
    function selectMaterial(files) {
      const candidate = files.map(file => ({ file, mime: materialMime(file, tag, accept) }))
        .find(({ file, mime }) => mime && file.size);
      if (!candidate) {
        status.textContent = '请选择支持的素材格式。';
        return;
      }
      if (recordable) cancelVoiceCapture?.();
      clear();
      const { file, mime } = candidate;
      selectedMaterials.set(field, file);
      show(file.type === mime ? file : file.slice(0, file.size, mime));
      status.textContent = '已添加：' + file.name;
    }
    materialTargets.set(zone, selectMaterial);
    choose.addEventListener('click', () => input.click());
    zone.addEventListener('click', event => { if (event.target !== input && !choose.contains(event.target)) choose.click(); });
    input.addEventListener('change', () => {
      const files = materialFiles(input);
      input.value = '';
      if (files.length) selectMaterial(files);
    });
    zone.addEventListener('pointermove', () => { hoveredMaterial = zone; });
    zone.addEventListener('pointerleave', () => { if (hoveredMaterial === zone) hoveredMaterial = null; });
    zone.addEventListener('dragover', event => {
      const transfer = event.dataTransfer;
      if (!Array.from(transfer?.types || []).includes('Files') &&
        !Array.from(transfer?.items || []).some(item => item.kind === 'file')) return;
      event.preventDefault();
      transfer.dropEffect = 'copy';
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', event => {
      if (!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', event => {
      zone.classList.remove('drag-over');
      const files = materialFiles(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      selectMaterial(files);
    });
    preview.addEventListener('error', () => {
      if (!url) return;
      preview.hidden = true;
      status.textContent = '无法在本地预览此文件。';
    });
    remove.addEventListener('click', () => {
      if (recordable) cancelVoiceCapture?.();
      clear(); choose.focus();
    });
    if (recordable) {
      download = document.createElement('a');
      download.className = 'media-tools-download';
      download.textContent = '下载录音';
      download.hidden = true;
      actions.append(download);
      const record = document.createElement('button');
      record.type = 'button';
      record.textContent = '开始录音';
      actions.prepend(record);
      cancelVoiceCapture = bindRecording(record, status, blob => {
        input.value = '';
        clear();
        show(blob);
        const extension = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
        download.download = '声音样本.' + extension;
        download.href = url;
        download.hidden = false;
        status.textContent = '录音已就绪，仅保存在当前页面。';
      });
    }
    return field;
  }

  function bindRecording(button, status, onRecording) {
    let active;
    const release = session => {
      clearTimeout(session.timeout);
      session.stream?.getTracks().forEach(track => track.stop());
    };
    function finish(session, message) {
      if (active !== session) return false;
      active = null;
      release(session);
      button.disabled = false;
      button.textContent = '开始录音';
      status.textContent = message;
      return true;
    }
    function stop(session) {
      clearTimeout(session.timeout);
      button.disabled = true;
      button.textContent = '正在结束…';
      if (session.recorder.state !== 'inactive') session.recorder.stop();
    }
    button.onclick = async () => {
      if (active?.recorder) {
        stop(active);
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') {
        status.textContent = '当前环境不支持录音，请选择本地音频。';
        return;
      }
      const session = active = {};
      button.disabled = true;
      status.textContent = '正在请求麦克风权限…';
      try {
        session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (active !== session) {
          release(session);
          return;
        }
        const chunks = [];
        const recorder = session.recorder = new MediaRecorder(session.stream);
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = () => finish(session, '录音失败，请重试或选择本地音频。');
        recorder.onstop = () => {
          if (!finish(session, '未录到音频，请重试。')) return;
          const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type });
          if (blob.size) onRecording(blob);
        };
        recorder.start();
        session.timeout = setTimeout(() => stop(session), 120_000);
        button.textContent = '停止录音';
        button.disabled = false;
        status.textContent = '正在录音，最长 2 分钟。';
      } catch (error) {
        finish(session, error?.name === 'NotAllowedError'
          ? '麦克风权限未开启，可改为选择本地音频。'
          : '无法录音，请检查麦克风或选择本地音频。');
      }
    };
    return () => {
      const session = active;
      if (!session) return;
      if (session.recorder?.state === 'recording') session.recorder.stop();
      finish(session, '录音已取消。');
    };
  }

  function makeModes(label, modes, onSwitch) {
    const wrapper = document.createElement('div');
    const controls = document.createElement('div');
    controls.className = 'media-tools-modes';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', label);
    let current = 0;
    const options = modes.map(([name, panel], index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.setAttribute('aria-controls', panel.id);
      button.setAttribute('aria-pressed', String(index === current));
      panel.hidden = index !== current;
      button.onclick = () => {
        if (current === index) return;
        options[current].setAttribute('aria-pressed', 'false');
        modes[current][1].hidden = true;
        current = index;
        button.setAttribute('aria-pressed', 'true');
        panel.hidden = false;
        onSwitch?.();
      };
      controls.append(button);
      return button;
    });
    wrapper.append(controls, ...modes.map(([, panel]) => panel));
    return wrapper;
  }

  function makeVoiceClone() {
    const audioTypes = ['audio/*', ...Object.keys(mediaFormats.audio).map(ext => '.' + ext)].join(',');
    const quick = makePreview('voice-clone-material-0', ['audio', '声音样本', audioTypes], true);
    quick.id = 'voiceCloneQuick';
    const pro = makePreview('voice-clone-professional-audio', ['audio', '高质量人声录音', audioTypes]);
    pro.id = 'voiceCloneProfessional';
    return makeModes('声音模仿模式', [['快速声音模仿', quick], ['专业声音模仿', pro]], () => {
      hoveredMaterial = null;
      cancelVoiceCapture?.();
      for (const field of [quick, pro]) field.querySelector('audio').pause();
    });
  }

  function makeDubbingSlider(id, label, low, high) {
    const control = document.createElement('div');
    control.className = 'media-dubbing-slider';
    control.innerHTML = `
      <label for="${id}">${label}</label>
      <input id="${id}" type="range" min="0" max="100" value="50">
      <output for="${id}" aria-live="off">50</output>
      <div class="media-dubbing-scale" aria-hidden="true"><span>${low}</span><span>${high}</span></div>`;
    const input = control.querySelector('input');
    const output = control.querySelector('output');
    input.oninput = () => { output.value = input.value; };
    return { control, input };
  }

  function makeDraft() {
    const field = document.createElement('div');
    field.className = 'media-tools-field media-tools-dubbing';
    const direct = document.createElement('div');
    direct.className = 'media-tools-draft-editor';
    direct.id = 'dubbingDirect';
    direct.innerHTML = `<div class="media-tools-setting"><label for="dubbingLanguage">配音语言</label>
        <select id="dubbingLanguage"></select></div>
      <label for="mediaToolsDraft">配音稿</label>
      <textarea id="mediaToolsDraft" rows="7" placeholder="请输入需要配音的文稿"></textarea>`;
    const translated = document.createElement('div');
    translated.id = 'dubbingTranslated';
    translated.innerHTML = `<div class="media-tools-draft-grid">
        <div class="media-tools-draft-editor">
          <div class="media-tools-setting"><span>原稿语言</span><strong class="media-tools-fixed-language">中文</strong></div>
          <label for="dubbingChineseDraft">中文原稿</label>
          <textarea id="dubbingChineseDraft" rows="7" placeholder="输入或粘贴中文原稿"></textarea>
        </div>
        <div class="media-tools-draft-editor">
          <div class="media-tools-setting"><label for="dubbingTargetLanguage">目标配音语言</label>
            <select id="dubbingTargetLanguage"></select></div>
          <label for="dubbingTranslatedDraft">译稿</label>
          <textarea id="dubbingTranslatedDraft" rows="7" placeholder="手动输入或粘贴译稿"></textarea>
        </div>
      </div>`;
    field.innerHTML = `<div class="media-tools-sample-actions"><button type="button" disabled>复制配音稿</button></div>
      <p class="media-tools-status" role="status"></p>`;
    const settings = document.createElement('section');
    settings.className = 'panel media-dubbing-settings';
    settings.setAttribute('aria-labelledby', 'dubbingVoiceTitle');
    settings.innerHTML = `<h2 id="dubbingVoiceTitle">配音音色</h2>
      <button type="button" class="media-voice-open" aria-haspopup="dialog">
        <span aria-hidden="true">♫</span> 选择音色
      </button><p class="media-voice-picked" aria-live="polite"></p>`;
    const rate = makeDubbingSlider('dubbingSpeed', '语速快慢', '更慢', '更快');
    const volume = makeDubbingSlider('dubbingVolume', '音量大小', '更小', '更大');
    settings.append(rate.control, volume.control);
    const draft = direct.querySelector('textarea');
    const translation = translated.querySelector('#dubbingTranslatedDraft');
    const copy = field.querySelector('button');
    const status = field.querySelector('[role="status"]');
    const directLanguage = direct.querySelector('select');
    const translatedLanguage = translated.querySelector('select');
    fillLanguage(directLanguage, dubbingLanguages, 'cn', 'cn');
    fillLanguage(translatedLanguage, dubbingLanguages.filter(([code]) => code !== 'cn'), 'en', 'en');
    const activeLanguage = () => direct.hidden ? translatedLanguage : directLanguage;
    const selectedVoices = [new Map(), new Map()];
    const activeVoices = () => selectedVoices[Number(direct.hidden)];
    const selectedVoice = settings.querySelector('.media-voice-picked');
    const updateVoice = () => { selectedVoice.textContent = activeVoices().get(activeLanguage().value)?.name || ''; };
    for (const selector of [directLanguage, translatedLanguage]) selector.addEventListener('change', updateVoice);
    settings.querySelector('.media-voice-open').onclick = () => {
      const language = activeLanguage();
      const choices = activeVoices();
      const key = language.value;
      openVoiceLibrary(language, choices.get(key), voice => {
        if (voice) choices.set(key, voice);
        else choices.delete(key);
        updateVoice();
      }, { rate: 0.5 + rate.input.valueAsNumber / 100, volume: volume.input.valueAsNumber / 100 });
    };
    const activeDraft = () => direct.hidden ? translation : draft;
    function updateCopy() {
      copy.disabled = !activeDraft().value.trim();
      status.textContent = '';
    }
    const modes = makeModes('文本配音模式', [['直接配音', direct], ['翻译后配音', translated]], () => { updateCopy(); updateVoice(); });
    field.prepend(modes);
    draft.oninput = translation.oninput = updateCopy;
    copy.onclick = async () => {
      const current = activeDraft();
      try {
        await navigator.clipboard.writeText(current.value);
        if (activeDraft() === current) status.textContent = '已复制配音稿。';
      } catch {
        if (activeDraft() !== current) return;
        current.focus();
        current.select();
        status.textContent = '无法自动复制，已为你选中文字。';
      }
    };
    return { editor: field, settings, request: () => {
      const text = activeDraft().value.trim();
      if (!text) throw new Error('请输入配音稿。');
      const lang = activeLanguage().value;
      const voice = activeVoices().get(lang)?.id;
      if (!voice) throw new Error('请选择配音音色。');
      return {
        name: text.replace(/\s+/g, ' ').slice(0, 36),
        options: {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, lang, voice, rate: Math.max(1, rate.input.valueAsNumber), volume: Math.max(1, volume.input.valueAsNumber) })
        }
      };
    } };
  }

  function fillLanguage(select, options, value, fallback) {
    select.replaceChildren(...options.map(([code, name]) => new Option(name, code)));
    select.value = options.some(([code]) => code === value) ? value : fallback;
  }

  function makeTranslationSettings() {
    const prefsKey = 'mediaToolsTranslationPrefsV1';
    const settings = document.createElement('fieldset');
    settings.className = 'media-tools-translation';
    settings.innerHTML = `
      <legend>翻译设置</legend>
      <div class="media-tools-language-row">
        <div class="media-tools-setting">
          <label for="translationSource">原始语言</label>
          <select id="translationSource" aria-describedby="translationLanguageStatus"></select>
        </div>
        <div class="media-tools-setting">
          <label for="translationTarget">翻译语言</label>
          <select id="translationTarget" aria-describedby="translationLanguageStatus"></select>
        </div>
      </div>
      <p class="media-tools-status media-tools-language-status" id="translationLanguageStatus" role="status"></p>
      <div class="media-tools-setting">
        <label for="translationVoice">选择音色</label>
        <select id="translationVoice">
          <option value="">请选择音色</option>
          <option value="x5_clone">使用原视频声音（克隆原声）</option>
          <option value="custom">填写音色 ID</option>
        </select>
        <div class="media-tools-sample-actions"><button type="button" class="media-voice-open" aria-haspopup="dialog">选择音色</button></div>
      </div>
      <div class="media-tools-setting" id="translationVoiceIdField" hidden>
        <label for="translationVoiceId">音色 ID</label>
        <input id="translationVoiceId" type="text" maxlength="120" autocomplete="off">
      </div>
      <label class="media-tools-check"><input type="checkbox" id="translationKeepBackground">保留原视频背景音</label>
      <label class="media-tools-check"><input type="checkbox" id="translationErase">智能擦除（字幕和水印）</label>`;
    const source = settings.querySelector('#translationSource');
    const target = settings.querySelector('#translationTarget');
    const voice = settings.querySelector('#translationVoice');
    const voiceId = settings.querySelector('#translationVoiceId');
    const voiceIdField = settings.querySelector('#translationVoiceIdField');
    const keepBackground = settings.querySelector('#translationKeepBackground');
    const erase = settings.querySelector('#translationErase');
    const languageStatus = settings.querySelector('#translationLanguageStatus');

    let saved;
    try { saved = JSON.parse(localStorage.getItem(prefsKey)); } catch {}
    fillLanguage(source, translationSourceLanguages, saved?.originalLang, 'cn');
    fillLanguage(target, translationTargetLanguages, saved?.destLang, 'en');
    voice.value = ['x5_clone', 'custom'].includes(saved?.voice) ? saved.voice : '';
    let picked = catalogVoice(saved?.catalogVoice);
    const catalogOption = new Option('', 'catalog');
    function setCatalogVoice(selection) {
      picked = selection;
      if (selection) {
        catalogOption.textContent = selection.name;
        voice.append(catalogOption);
        voice.value = 'catalog';
      } else {
        if (voice.value === 'catalog') voice.value = '';
        catalogOption.remove();
      }
    }
    if (saved?.voice === 'catalog' && picked?.lang === target.value) setCatalogVoice(picked);
    else picked = null;
    settings.querySelector('.media-voice-open').onclick = () => openVoiceLibrary(target,
      voice.value === 'catalog' ? picked : null, selection => { setCatalogVoice(selection); save(); });
    voiceId.value = typeof saved?.voiceId === 'string' ? saved.voiceId.slice(0, 120) : '';
    keepBackground.checked = saved?.keepBackground === true;
    erase.checked = saved?.erase === true;

    function updateFields() {
      voiceIdField.hidden = voice.value !== 'custom';
      voiceId.disabled = voiceIdField.hidden;
      const sameLanguage = source.value === target.value;
      if (sameLanguage) target.setAttribute('aria-invalid', 'true');
      else target.removeAttribute('aria-invalid');
      languageStatus.textContent = sameLanguage ? '原始语言和翻译语言相同。' : '';
    }
    function save() {
      if (picked && (voice.value !== 'catalog' || picked.lang !== target.value)) setCatalogVoice(null);
      updateFields();
      try {
        localStorage.setItem(prefsKey, JSON.stringify({
          originalLang: source.value, destLang: target.value, voice: voice.value,
          voiceId: voiceId.value.trim(), catalogVoice: picked, keepBackground: keepBackground.checked, erase: erase.checked
        }));
      } catch {}
    }
    settings.addEventListener('change', save);
    voiceId.addEventListener('input', save);
    updateFields();
    return { settings, request: field => {
      const file = selectedMaterials.get(field);
      if (!file) throw new Error('请选择原始视频。');
      if (file.size > 512 * 1024 * 1024) throw new Error('视频不能超过 512 MB。');
      if (source.value === target.value) throw new Error('原始语言和翻译语言不能相同。');
      const timbre = voice.value === 'catalog' ? picked?.id
        : voice.value === 'custom' ? voiceId.value.trim() : voice.value;
      if (!timbre) throw new Error('请选择翻译音色。');
      if (erase.checked) throw new Error('智能擦除是独立任务；请暂时关闭后提交翻译。');
      return {
        name: file.name,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Options': encodeURIComponent(JSON.stringify({
            fileName: file.name, originalLang: source.value, destLang: target.value, timbre, keepBackground: keepBackground.checked
          })) },
          body: file
        }
      };
    } };
  }

  function appendSubmit(prep, results, key, prepare) {
    const box = document.createElement('div');
    box.className = 'media-tools-submit';
    box.innerHTML = '<button type="button" class="primary">提交任务</button>';
    const submit = box.querySelector('button');
    const status = prep.querySelector('.media-tools-submit-status');
    submit.onclick = async () => {
      submit.disabled = true;
      status.textContent = '';
      try {
        const { name, options } = prepare();
        submit.textContent = key.startsWith('video-') ? '正在上传并提交…' : '正在提交…';
        const { id } = await soundViewRequest('media/' + key, options);
        if (!id) throw new Error('服务未返回任务编号。');
        await results.addOnlineTask(id, name);
        status.textContent = '任务已提交。';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        submit.textContent = '提交任务';
        submit.disabled = false;
      }
    };
    prep.querySelector('.media-tools-prep-head').append(box);
  }

  function makeFaceSwapSettings() {
    const settings = document.createElement('div');
    settings.className = 'media-tools-field';
    settings.innerHTML = '<label for="faceSwapImageUrl">人脸图片直链（HTTPS）</label><input id="faceSwapImageUrl" type="url" maxlength="4096" placeholder="https://…" autocomplete="off" spellcheck="false"><p class="media-tools-note">本地照片仅供预览，提交使用此直链。</p>';
    const image = settings.querySelector('input');
    return { settings, request: field => {
      const file = selectedMaterials.get(field);
      if (!file) throw new Error('请选择原始视频。');
      if (file.size > 512 * 1024 * 1024) throw new Error('视频不能超过 512 MB。');
      let url;
      try { url = new URL(image.value.trim()); } catch {}
      if (url?.protocol !== 'https:' || url.username || url.password || url.href.length > 4096) {
        throw new Error('提交换脸需要可公开访问的 HTTPS 人脸图片直链。');
      }
      return { name: file.name, options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Options': encodeURIComponent(JSON.stringify({
          fileName: file.name, imageUrl: url.href
        })) },
        body: file
      } };
    } };
  }

  function makePage(key, tool) {
    const page = document.createElement('div');
    page.className = 'media-tools-page';
    page.dataset.tool = key;
    page.innerHTML = `
      <h1 class="title"></h1>
      <div class="media-tools-layout">
        <div class="panel media-tools-prep"><div class="media-tools-prep-head"><h2></h2></div></div>
      </div>`;
    page.querySelector('h1').textContent = tool.title;
    const layout = page.querySelector('.media-tools-layout');
    const prep = page.querySelector('.media-tools-prep');
    const results = makeResults(key, tool.output);
    let sidebar;
    let prepare;
    prep.querySelector('h2').textContent = key === 'voice-clone' ? '声音样本' : tool.inputs ? '本地素材预览' : '配音稿草稿';
    if (key === 'voice-clone') {
      prep.append(makeVoiceClone());
    } else if (tool.inputs) {
      for (const [index, input] of tool.inputs.entries()) prep.append(makePreview(`${key}-material-${index}`, input));
    } else {
      const dubbing = makeDraft();
      prepare = dubbing.request;
      prep.append(dubbing.editor);
      sidebar = document.createElement('div');
      sidebar.className = 'media-dubbing-sidebar';
      sidebar.append(dubbing.settings);
      layout.append(sidebar);
    }
    if (tool.note) {
      const note = document.createElement('p');
      note.className = 'media-tools-note';
      note.textContent = tool.note;
      prep.append(note);
    }
    if (key === 'video-translation') {
      const translation = makeTranslationSettings();
      prep.append(translation.settings);
      prepare = () => translation.request(prep.querySelector('.media-tools-field'));
    } else if (key === 'video-face-swap') {
      const faceSwap = makeFaceSwapSettings();
      prep.append(faceSwap.settings);
      prepare = () => faceSwap.request(prep.querySelector('.media-tools-field'));
    }
    if (prepare) {
      const status = document.createElement('p');
      status.className = 'media-tools-status media-tools-submit-status';
      status.setAttribute('role', 'status');
      prep.querySelector('.media-tools-prep-head').after(status);
      appendSubmit(prep, results, key, prepare);
    }
    (sidebar || layout).append(results);
    return page;
  }

  function pausePreviews() {
    hoveredMaterial = null;
    voiceLibrary?.close();
    cancelVoiceCapture?.();
    section.querySelectorAll('audio, video').forEach(media => media.pause());
  }

  const previousActivate = activateView;
  let navigation = 0;
  activateView = function (view) {
    const request = ++navigation;
    if (!Object.hasOwn(tools, view)) {
      pausePreviews();
      section.hidden = true;
      buttons.forEach(button => button.removeAttribute('aria-current'));
      previousActivate(view);
      if (view === 'settings') soundViewSettings.refresh();
      else soundViewSettings.leave();
      return;
    }
    if (!window.workbenchVideoAccess.isUnlocked()) {
      void window.workbenchVideoAccess.ensure().then(unlocked => {
        if (unlocked && request === navigation) activateView(view);
      });
      return;
    }

    const tool = tools[view];
    previousActivate(view);
    soundViewSettings.leave();
    buttons.forEach((button, key) => {
      if (key === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.querySelector('.top span b').textContent = tool.title;
    if (!pages.has(view)) pages.set(view, makePage(view, tool));
    if (section.firstElementChild !== pages.get(view)) {
      pausePreviews();
      section.replaceChildren(pages.get(view));
      section.scrollTop = 0;
    }
    section.hidden = false;
  };

  for (const [key, tool] of Object.entries(tools)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.view = key;
    button.innerHTML = '<span class="nav-icon" aria-hidden="true"></span><span></span>';
    button.firstElementChild.textContent = tool.icon;
    button.lastElementChild.textContent = tool.title;
    button.onclick = () => activateView(key);
    buttons.set(key, button);
    mediaNavItems.append(button);
  }
  if (!document.querySelector('#settingsView').hidden) soundViewSettings.refresh();
})();
