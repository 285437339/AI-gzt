const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const videoPassword = process.env.WORKBENCH_VIDEO_PASSWORD;
assert.ok(videoPassword, 'Set WORKBENCH_VIDEO_PASSWORD to run video tests');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-video-lock-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
(async () => {
  const app = await electron.launch({ executablePath: process.env.WORKBENCH_TEST_EXE || require('electron'), args: [
    ...(process.env.WORKBENCH_TEST_EXE ? [] : [root]), '--user-data-dir=' + path.join(profile, 'electron'),
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'
  ], env });
  try {
    // Mock upstream in the main process, so real local authorization is exercised.
    await app.evaluate(() => {
      const { EventEmitter } = process.getBuiltinModule('events');
      global.videoTestUpstreamCalls = [];
      global.mediaTestStatusCounts = {};
      global.mediaTestUploads = [];
      global.mediaTestDownloads = [];
      const Module = process.getBuiltinModule('module');
      const load = Module._load;
      Module._load = function (name, ...args) {
        if (name !== 'esdk-obs-nodejs') return load.call(this, name, ...args);
        return class {
          constructor(config) { this.server = config.server; }
          async putObject({ Bucket, Key, SourceFile }) {
            const body = process.getBuiltinModule('fs').readFileSync(SourceFile).toString();
            global.mediaTestUploads.push({ server: this.server, Bucket, Key, body });
            return { CommonMsg: { Status: 200 } };
          }
          close() {}
        };
      };
      process.getBuiltinModule('https').request = (options, callback) => {
        const call = { ...options };
        global.videoTestUpstreamCalls.push(call);
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.end = payload => {
          if (payload) call.payload = String(payload);
          const response = new EventEmitter();
          response.statusCode = 200;
          response.headers = {};
          response.setEncoding = () => {};
          callback(response);
          const voiceRequest = options.path === '/antelope-media/openapi/v1/common/timbre/list';
          const voiceData = '{"code":0,"result":[{"id":1234567890123456789,"name":"知性女声","lang":"en","genderStr":"女性","accentStr":"美式英语","auditionUrl":"https://soundviewai.com/mock-voice.wav"},{"id":"tts-other","name":"旁白","lang":"cn"},{"id":"tts-off","name":"下架音色","lang":"en","status":1}]}';
          let result = '{"ok":true}';
          const route = options.path.replace('/antelope-media/openapi/v1/', '');
          if (voiceRequest) result = options.headers.appKey === 'bad-soundview-key' ? '{"code":10004}' : voiceData;
          if (route === 'tts/create') result = '{"code":0,"result":{"taskId":1234567890123456781}}';
          if (route === 'tts/get') result = global.mediaTestStatusError ? '{"code":10002}'
            : '{"code":0,"result":{"destFileTmpUrl":"https://example.invalid/out.wav","destStrTmpUrl":"https://example.invalid/out.srt"}}';
          if (route === 'file/upload/privilege') {
            result = JSON.parse(payload).fileName === 'translated.mp4'
              ? '{"code":0,"result":{"fileId":1234567890123456782,"temporaryAccessKey":null}}'
              : '{"code":0,"result":{"fileId":"1234567890123456782","endPoint":"obs.cn-north-4.myhuaweicloud.com","bucketName":"mock-files","dirPath":"mock","randomName":"face.mp4","temporaryAccessKey":{"access":"mock","secret":"mock","securitytoken":"mock"}}}';
          }
          if (route === 'file/upload/complete') result = '{"code":0,"result":{"s3Id":1234567890123456783}}';
          if (route === 'video/translate') result = '{"code":0,"result":{"taskId":"1234567890123456784"}}';
          if (route === 'video/face-swap') result = '{"code":0,"result":{"taskId":"1234567890123456785"}}';
          if (route === 'video/get') {
            const key = call.payload;
            global.mediaTestStatusCounts[key] = (global.mediaTestStatusCounts[key] || 0) + 1;
            result = key.includes('1234567890123456785') ? '{"code":0,"result":{"status":2}}'
              : global.mediaTestStatusCounts[key] === 1 ? '{"code":0,"result":{"status":0,"process":42}}'
              : '{"code":0,"result":{"status":1,"destFileTmpUrl":"https://example.invalid/out.mp4"}}';
          }
          response.emit('data', Buffer.from(result));
          response.emit('end');
        };
        return request;
      };
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('#customTemplateSelect');
    const origin = new URL(page.url()).origin;
    const routes = [
      ['/v1/api/generate', { model: 'minimax-h3' }],
      ['/rh-api/rhart-video/sparkvideo-2.0/text-to-video', {}],
      ['/rh-api/seedance-v1.5-pro/image-to-video-fast', {}],
      ['/rh-api/rhart-video-g-official/text-to-video-v1.5', {}]
    ];
    for (const [route, data] of routes) {
      for (const headers of [{}, { 'X-Workbench-Video-Token': 'forged-token' }]) {
        const response = await page.request.post(origin + route, { data, headers });
        assert.equal(response.status(), 403);
        assert.equal((await response.json()).code, 'VIDEO_LOCKED');
      }
    }
    assert.equal(await app.evaluate(() => global.videoTestUpstreamCalls.length), 0);
    for (const operation of ['text-dubbing', 'video-translation', 'video-face-swap', 'status']) {
      const response = await page.request.post(origin + '/api/soundview/media/' + operation, { data: {} });
      assert.equal(response.status(), 403);
      assert.equal((await response.json()).code, 'VIDEO_LOCKED');
    }
    assert.equal(await app.evaluate(() => global.videoTestUpstreamCalls.length), 0);
    assert.equal((await page.request.get(origin + '/api/soundview/voices')).status(), 403);
    const soundViewSettingsUrl = origin + '/api/soundview/settings';
    const initialSoundView = await page.request.get(soundViewSettingsUrl);
    assert.deepEqual(await initialSoundView.json(), { configured: false });
    assert.equal(initialSoundView.headers()['access-control-allow-origin'], undefined);
    assert.equal((await page.request.put(soundViewSettingsUrl, { data: {} })).status(), 403);
    assert.equal((await page.request.get(soundViewSettingsUrl, { headers: { Origin: 'https://example.invalid' } })).status(), 403);
    const image = await page.request.post(origin + '/v1/api/generate', { data: { model: 'nano-banana-2' } });
    assert.equal(image.status(), 200, '图片功能无需视频密码');

    const nav = page.locator('.nav [data-view="video"]');
    const toolsView = page.locator('#mediaToolsView');
    const mediaTools = [
      ['video-face-swap', '视频换脸'],
      ['voice-clone', '声音克隆'],
      ['video-translation', '视频翻译'],
      ['text-dubbing', '文本配音']
    ];
    const firstTool = page.locator(`.nav [data-view="${mediaTools[0][0]}"]`);
    const mediaMenu = page.getByRole('button', { name: '音视频工具', exact: true });
    const creationMenu = page.getByRole('button', { name: '图片创作工具', exact: true });
    const creationLinks = page.locator('#creationToolsNavItems button[data-view]');
    assert.deepEqual(await creationLinks.evaluateAll(buttons => buttons.map(button => button.dataset.view)),
      ['workspace', 'reverse', 'inspiration', 'assets', 'assistant']);
    assert.equal(await creationMenu.getAttribute('aria-expanded'), 'true');
    await creationMenu.click();
    assert.equal(await creationMenu.getAttribute('aria-expanded'), 'false');
    assert.equal(await creationLinks.first().isVisible(), false);
    assert.equal(await page.locator('#workspaceView').isVisible(), true, '收起创作分类保留当前页面');
    assert.equal(await mediaMenu.getAttribute('aria-expanded'), 'false', '两个分类独立展开');
    await creationMenu.press('Enter');
    assert.equal(await creationLinks.first().isVisible(), true);
    assert.equal(await mediaMenu.getAttribute('aria-expanded'), 'false');
    assert.equal(await firstTool.isVisible(), false);
    assert.equal(await nav.isVisible(), false, '视频生成跟随分类收起');
    await mediaMenu.press('Enter');
    assert.equal(await mediaMenu.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await page.locator('#mediaToolsNavItems button[data-view]').evaluateAll(buttons =>
      buttons.map(button => button.dataset.view)), ['video', ...mediaTools.map(([view]) => view)]);
    assert.equal(await nav.isVisible(), true);
    assert.equal(await page.locator('#videoUnlockDialog').isVisible(), false, '展开分类无需密码');
    await firstTool.click();
    await page.waitForSelector('#videoUnlockDialog[open]');
    assert.equal(await toolsView.isVisible(), false, '新工具也必须解锁');
    await page.locator('#videoUnlockCancel').click();
    assert.equal(await page.locator('.nav [data-view="workspace"]').evaluate(button => button.classList.contains('on')), true);
    await nav.click();
    assert.equal(await page.locator('#videoView').isVisible(), false);
    assert.equal(await page.locator('#videoUnlockPassword').getAttribute('type'), 'password');
    await page.locator('#videoUnlockPassword').fill('wrong-password');
    await page.locator('#videoUnlockConfirm').click();
    await page.waitForFunction(() => document.querySelector('#videoUnlockError').textContent.includes('不正确'));
    assert.equal(await page.locator('#videoView').isVisible(), false);
    await page.locator('#videoUnlockCancel').click();
    assert.equal(await page.locator('#workspaceView').isVisible(), true);
    await nav.click();
    await page.locator('#videoUnlockPassword').fill(videoPassword);
    await page.locator('#videoUnlockPassword').press('Enter');
    await page.waitForSelector('#videoView:not([hidden])');
    assert.equal(await page.locator('#videoUnlockPassword').inputValue(), '');
    for (const [route, data] of routes) {
      const status = await page.evaluate(async ({ route, data }) => (await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).status, { route, data });
      assert.equal(status, 200, '已解锁视频请求通过真实本地服务');
    }
    assert.equal(await app.evaluate(() => global.videoTestUpstreamCalls.some(call => Object.keys(call.headers).some(key => key.toLowerCase() === 'x-workbench-video-token'))), false, '解锁凭证不得传给第三方');
    await page.locator('.nav [data-view="workspace"]').click();
    await nav.click();
    assert.equal(await page.locator('#videoUnlockDialog').isVisible(), false, '同次打开无需重复输入');

    for (const [view, title] of mediaTools) {
      const toolNav = page.locator(`.nav [data-view="${view}"]`);
      await toolNav.click();
      assert.equal(await toolNav.getAttribute('aria-current'), 'page');
      assert.equal(await toolsView.locator('h1').innerText(), title);
      assert.equal(await page.locator('.top span b').innerText(), title);
      assert.equal(await page.locator('#videoView').isVisible(), false);
      assert.equal(await page.locator('#videoUnlockDialog').isVisible(), false, '音视频工具复用本次解锁');
      assert.equal(await toolsView.locator('a[href^="http"]').count(), 0, '工具内没有官网跳转');
      assert.doesNotMatch(await toolsView.innerText(), /SoundView|在线生成尚未接入|接口未接入/i);
    }
    await mediaMenu.click();
    assert.equal(await mediaMenu.getAttribute('aria-expanded'), 'false');
    assert.equal(await firstTool.isVisible(), false);
    assert.equal(await toolsView.locator('h1').innerText(), '文本配音', '收起菜单保留当前工具');
    assert.equal(await page.locator('#mediaToolsNavItems .on').getAttribute('data-view'), 'text-dubbing');
    await mediaMenu.click();

    const translationNav = page.locator('.nav [data-view="video-translation"]');
    await translationNav.click();
    const voiceButton = toolsView.getByRole('button', { name: '选择音色', exact: true });
    const voiceDialog = page.getByRole('dialog', { name: '音色库', exact: true });
    const voiceSearch = voiceDialog.getByLabel('搜索音色');
    const commitVoice = voiceDialog.getByRole('button', { name: '确定' });
    const legacyResponse = status => route => route.fulfill({ status, contentType: 'text/html', body: '<h1>Old workbench</h1>' });
    for (const [respond, message] of [
      [legacyResponse(404), /未提供音色接口/],
      [legacyResponse(200), /未提供音色接口/],
      [route => route.abort('connectionrefused'), /无法连接本机音色服务/]
    ]) {
      const voiceEndpoint = '**/api/soundview/voices';
      await page.route(voiceEndpoint, respond);
      await voiceButton.click();
      await voiceDialog.getByRole('status').filter({ hasText: message }).waitFor();
      assert.equal(await voiceSearch.isVisible(), false, '尚未加载音色时不显示搜索');
      await voiceDialog.getByRole('button', { name: '取消', exact: true }).click();
      await page.unroute(voiceEndpoint, respond);
    }
    await voiceButton.click();
    const openSoundViewSettings = voiceDialog.getByRole('button', { name: '打开音色设置' });
    await openSoundViewSettings.waitFor();
    assert.doesNotMatch(await voiceDialog.innerText(), /SoundView/i);
    assert.equal(await voiceDialog.getByLabel('AppSecret', { exact: true }).count(), 0);
    await openSoundViewSettings.click();
    const soundViewForm = page.locator('#settingsSoundView');
    assert.equal(await soundViewForm.getByRole('heading', { name: '音色服务' }).isVisible(), true);
    assert.doesNotMatch(await soundViewForm.innerText(), /SoundView/i);
    const appKeyInput = soundViewForm.getByLabel('AppKey', { exact: true });
    const appSecretInput = soundViewForm.getByLabel('AppSecret', { exact: true });
    const soundViewStatus = soundViewForm.getByRole('status');
    const validateSoundView = soundViewForm.getByRole('button', { name: '验证并保存' });
    const fakeKey = 'soundview-test-key';
    const fakeSecret = 'soundview-test-secret';
    await soundViewStatus.filter({ hasText: '未配置。' }).waitFor();
    assert.equal(await appSecretInput.getAttribute('type'), 'password');
    assert.equal(await soundViewForm.evaluate(form => form.closest('.settings-card').querySelector('h2').textContent), '接口配置');
    await appKeyInput.fill(fakeKey);
    await appSecretInput.fill(fakeSecret);
    await validateSoundView.click();
    await soundViewStatus.filter({ hasText: '已验证并保存。' }).waitFor();
    assert.equal(await appKeyInput.inputValue(), '');
    assert.equal(await appSecretInput.inputValue(), '');
    assert.deepEqual(await (await page.request.get(soundViewSettingsUrl)).json(), { configured: true });
    assert.equal(await page.evaluate(secret => JSON.stringify(localStorage).includes(secret), fakeSecret), false);
    assert.ok(!(await (await page.request.get(origin + '/api/workbench-settings')).text()).includes(fakeSecret));
    await appKeyInput.fill('bad-soundview-key');
    await appSecretInput.fill('bad-soundview-secret');
    await validateSoundView.click();
    await soundViewStatus.filter({ hasText: /认证失败/ }).waitFor();
    await translationNav.click();
    await voiceButton.click();
    const cardVoice = voiceDialog.getByRole('radio', { name: '知性女声' });
    await cardVoice.waitFor();
    assert.equal(await appSecretInput.isVisible(), false);
    assert.equal(await cardVoice.inputValue(), '1234567890123456789', 'int64 音色 ID 精度不可丢');
    assert.equal(await voiceDialog.getByRole('radio', { name: '旁白' }).count(), 0, '音色按目标语言筛选');
    assert.equal(await voiceDialog.getByRole('radio', { name: '下架音色' }).count(), 0);
    await voiceSearch.fill('不存在');
    assert.equal(await voiceDialog.getByText('没有匹配的音色。').isVisible(), true);
    await voiceSearch.fill('美式英语');
    await page.evaluate(() => {
      window.voiceAuditions = [];
      window.voiceAuditionSettings = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this.src === 'https://soundviewai.com/mock-voice.wav') {
          window.voiceAuditions.push(this.src);
          window.voiceAuditionSettings.push([this.playbackRate, this.volume]);
          return Promise.resolve();
        }
        return play.call(this);
      };
    });
    const wav = Buffer.alloc(16044);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    await page.route('https://soundviewai.com/mock-voice.wav', route => route.fulfill({ contentType: 'audio/wav', body: wav }));
    await voiceDialog.getByRole('button', { name: '试听 知性女声' }).click();
    assert.equal(await voiceDialog.getByRole('button', { name: '停止试听 知性女声' }).isVisible(), true);
    await cardVoice.check();
    await commitVoice.click();
    assert.equal(await voiceDialog.isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.voiceAuditions), ['https://soundviewai.com/mock-voice.wav']);
    assert.deepEqual(await page.evaluate(() => window.voiceAuditionSettings), [[1, 1]]);
    const signed = await app.evaluate(() => global.videoTestUpstreamCalls.find(call => call.path.includes('/timbre/list')));
    assert.equal(signed.hostname, 'soundviewai.com');
    assert.equal(signed.method, 'GET');
    assert.equal(signed.headers.appKey, fakeKey);
    assert.match(signed.headers.time, /^\d{14}$/);
    assert.equal(signed.headers.sign, crypto.createHash('md5').update([fakeSecret, '', signed.headers.time, fakeKey, fakeSecret].join('_')).digest('hex').toUpperCase());
    assert.ok(!JSON.stringify(signed).includes(fakeSecret));
    const sourceLanguage = toolsView.getByLabel('原始语言');
    const targetLanguage = toolsView.getByLabel('翻译语言');
    const translationVoice = toolsView.getByLabel('选择音色');
    const voiceId = toolsView.getByLabel('音色 ID', { exact: true });
    const background = toolsView.getByRole('checkbox', { name: '保留原视频背景音' });
    const erase = toolsView.getByRole('checkbox', { name: '智能擦除（字幕和水印）' });
    const optionValues = selector => selector.locator('option').evaluateAll(items => items.map(item => item.value));
    assert.equal(await sourceLanguage.inputValue(), 'cn');
    assert.equal(await targetLanguage.inputValue(), 'en');
    assert.equal(await translationVoice.inputValue(), 'catalog');
    const savedCatalog = await page.evaluate(() => JSON.parse(localStorage.getItem('mediaToolsTranslationPrefsV1')));
    assert.deepEqual(savedCatalog.catalogVoice, { id: '1234567890123456789', name: '知性女声', lang: 'en' });
    assert.ok(!JSON.stringify(savedCatalog).includes(fakeSecret));
    assert.deepEqual(await optionValues(sourceLanguage), ['cn', 'en', 'ja', 'ko', 'ru', 'de', 'fr', 'ar', 'es', 'it', 'pt', 'ms', 'th']);
    assert.deepEqual((await optionValues(targetLanguage)).slice(13), ['tl', 'nl', 'vi', 'id', 'no', 'ca', 'bn']);
    await targetLanguage.selectOption('cn');
    assert.equal(await translationVoice.inputValue(), '', '切换语种清空不匹配的音色');
    assert.equal(await targetLanguage.getAttribute('aria-invalid'), 'true');
    await sourceLanguage.selectOption('ja');
    await targetLanguage.selectOption('vi');
    assert.equal(await targetLanguage.getAttribute('aria-invalid'), null);
    assert.equal(await voiceId.isVisible(), false);
    await translationVoice.selectOption('x5_clone');
    assert.equal(await voiceId.isVisible(), false);
    await translationVoice.selectOption('custom');
    await voiceId.fill('test-timbre-42');
    await background.check();
    await erase.check();
    assert.equal(await toolsView.getByRole('heading', { name: '任务结果' }).isVisible(), true);
    await page.locator('.nav [data-view="text-dubbing"]').click();
    assert.equal(await sourceLanguage.count(), 0, '翻译参数只在视频翻译工具显示');

    await page.evaluate(() => {
      navigator.clipboard.writeText = async text => { window.mediaToolsCopiedText = text; };
    });
    const draft = toolsView.getByLabel('配音稿');
    const copy = toolsView.getByRole('button', { name: '复制配音稿' });
    const directMode = toolsView.getByRole('button', { name: '直接配音' });
    const translatedMode = toolsView.getByRole('button', { name: '翻译后配音' });
    const dubbingLanguage = toolsView.getByLabel('配音语言', { exact: true });
    const targetDubbingLanguage = toolsView.getByLabel('目标配音语言');
    const chineseDraft = toolsView.getByLabel('中文原稿');
    const translatedDraft = toolsView.getByLabel('译稿', { exact: true });
    const speed = toolsView.getByRole('slider', { name: '语速快慢' });
    const volume = toolsView.getByRole('slider', { name: '音量大小' });
    assert.equal(await speed.inputValue(), '50');
    assert.equal(await volume.inputValue(), '50');
    await speed.press('End');
    await volume.press('ArrowLeft');
    assert.equal(await toolsView.locator('output[for="dubbingSpeed"]').textContent(), '100');
    assert.equal(await toolsView.locator('output[for="dubbingVolume"]').textContent(), '49');
    assert.equal(await directMode.getAttribute('aria-pressed'), 'true');
    assert.equal(await dubbingLanguage.inputValue(), 'cn');
    await voiceButton.click();
    assert.equal(await voiceDialog.getByRole('radio', { name: '旁白' }).isVisible(), true);
    await voiceDialog.getByRole('radio', { name: '旁白' }).check();
    await commitVoice.click();
    assert.equal(await toolsView.locator('.media-voice-picked').innerText(), '旁白');
    assert.deepEqual(await dubbingLanguage.locator('option').allTextContents(), ['中文', '英语', '韩语', '菲律宾语', '泰语', '马来语', '印尼语']);
    await dubbingLanguage.selectOption('ko');
    assert.equal(await toolsView.locator('.media-voice-picked').innerText(), '');
    assert.equal(await copy.isDisabled(), true);
    await draft.fill('这是测试配音稿。');
    assert.equal(await copy.isEnabled(), true);
    await copy.click();
    await toolsView.getByRole('status').filter({ hasText: /已复制/ }).waitFor();
    assert.equal(await page.evaluate(() => window.mediaToolsCopiedText), '这是测试配音稿。');
    await translatedMode.click();
    assert.equal(await translatedMode.getAttribute('aria-pressed'), 'true');
    assert.equal(await draft.isVisible(), false);
    assert.equal(await chineseDraft.isVisible(), true);
    assert.equal(await targetDubbingLanguage.inputValue(), 'en');
    await voiceButton.click();
    assert.equal(await cardVoice.isVisible(), true);
    await voiceDialog.getByRole('button', { name: '试听 知性女声' }).click();
    assert.deepEqual(await page.evaluate(() => window.voiceAuditionSettings.at(-1)), [1.5, 0.49]);
    await voiceDialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await toolsView.locator('.media-voice-picked').innerText(), '');
    await targetDubbingLanguage.selectOption('th');
    await chineseDraft.fill('这是中文原稿。');
    assert.equal(await copy.isDisabled(), true, '只有译稿才是翻译模式的配音正文');
    await translatedDraft.fill('ทดสอบ');
    await copy.click();
    await page.waitForFunction(() => window.mediaToolsCopiedText === 'ทดสอบ');
    assert.equal(await toolsView.getByRole('heading', { name: '任务结果' }).isVisible(), true);
    await directMode.click();
    assert.equal(await dubbingLanguage.inputValue(), 'ko');
    assert.equal(await draft.inputValue(), '这是测试配音稿。');
    assert.equal(await speed.inputValue(), '100', '切换配音模式保留语速');
    assert.equal(await volume.inputValue(), '49', '切换配音模式保留音量');
    await translatedMode.click();
    assert.equal(await targetDubbingLanguage.inputValue(), 'th');
    assert.equal(await chineseDraft.inputValue(), '这是中文原稿。');
    assert.equal(await translatedDraft.inputValue(), 'ทดสอบ');
    await directMode.click();

    const transferMaterial = (target, eventName, { name, mimeType, buffer }, text = '') => target.evaluate(
      (el, { eventName, name, mimeType, bytes, text }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(bytes)], name, { type: mimeType }));
        if (text) transfer.setData('text/plain', text);
        const event = eventName === 'paste'
          ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
          : new DragEvent(eventName, { bubbles: true, cancelable: true, dataTransfer: transfer });
        return !el.dispatchEvent(event);
      }, { eventName, name, mimeType, bytes: [...buffer], text }
    );
    const faceFile = {
      name: 'test.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64')
    };
    const invalidMaterial = { name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('bad file type') };

    await firstTool.click();
    const photoPreview = toolsView.locator('img');
    const photoZone = toolsView.getByRole('group', { name: '目标人脸照片' });
    const photo = photoZone.locator('input[type="file"]');
    const photoPicker = photoZone.getByRole('button', { name: '选择目标人脸照片' });
    await photo.setInputFiles(invalidMaterial);
    assert.equal(await toolsView.getByText('请选择支持的素材格式。').isVisible(), true);
    const [picker] = await Promise.all([page.waitForEvent('filechooser'), photoPicker.click()]);
    await picker.setFiles(faceFile);
    assert.match(await photoPreview.getAttribute('src'), /^blob:/);
    await page.waitForFunction(() => document.querySelector('#mediaToolsView img').naturalWidth === 1);
    const selectedPhoto = await photoPreview.getAttribute('src');
    await photo.setInputFiles(invalidMaterial);
    assert.equal(await photoPreview.getAttribute('src'), selectedPhoto, '选错格式时保留已有照片');

    await page.evaluate(() => {
      window.testVideoDropHook = window.__workbenchVideoDrop;
      window.__workbenchVideoDrop = () => { window.testRestoreTriggered = true; return true; };
    });
    assert.equal(await transferMaterial(photoZone, 'dragover', faceFile), true);
    assert.match(await photoZone.getAttribute('class'), /drag-over/);
    assert.equal(await transferMaterial(photoZone, 'drop', { ...faceFile, name: '拖入.png' }), true);
    assert.doesNotMatch(await photoZone.getAttribute('class'), /drag-over/);
    assert.equal(await page.evaluate(() => !!window.testRestoreTriggered), false, '素材框拖放不触发全局工作流恢复');
    await page.evaluate(() => { window.__workbenchVideoDrop = window.testVideoDropHook; });
    await toolsView.getByText('已添加：拖入.png', { exact: true }).waitFor();
    const droppedPhoto = await photoPreview.getAttribute('src');
    assert.notEqual(droppedPhoto, selectedPhoto);
    assert.equal(await transferMaterial(photoZone, 'drop', invalidMaterial), true);
    assert.equal(await photoPreview.getAttribute('src'), droppedPhoto, '拖入错误格式时保留已有照片');
    await photoZone.hover();
    await photoPicker.blur();
    assert.equal(await transferMaterial(page.locator('body'), 'paste', { ...faceFile, name: '粘贴.png' }), true);
    await toolsView.getByText('已添加：粘贴.png', { exact: true }).waitFor();
    const textOnlyPaste = await photoZone.evaluate(el => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', '不是文件');
      return el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    assert.equal(textOnlyPaste, true, '纯文字粘贴不被素材框拦截');
    await toolsView.getByRole('button', { name: '移除目标人脸照片' }).click();
    assert.equal(await photoPreview.isVisible(), false);
    assert.equal(await photoPreview.getAttribute('src'), null);
    assert.equal(await photoPicker.evaluate(el => document.activeElement === el), true);
    assert.equal(await transferMaterial(photoPicker, 'paste', faceFile), true, '聚焦素材按钮后可用键盘粘贴');
    await photoZone.hover();
    await page.locator('.nav [data-view="text-dubbing"]').evaluate(button => button.click());
    assert.equal(await transferMaterial(page.locator('body'), 'paste', faceFile), false, '离开工具后不接收文件粘贴');
    assert.equal(await transferMaterial(draft, 'paste', faceFile, '可编辑文字'), false, '不拦截编辑框的粘贴');
    await firstTool.click();
    assert.equal(await photoPreview.isVisible(), true, '切回工具保留素材');
    const sampleVideo = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 48;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(20);
      try {
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];
        const finished = new Promise((resolve, reject) => {
          recorder.ondataavailable = event => chunks.push(event.data);
          recorder.onstop = () => resolve(new Blob(chunks));
          recorder.onerror = reject;
        });
        recorder.start();
        for (const color of ['#f00', '#0f0', '#00f']) {
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 48, 48);
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        recorder.stop();
        return [...new Uint8Array(await (await finished).arrayBuffer())];
      } finally {
        stream.getTracks().forEach(track => track.stop());
      }
    });
    const videoZone = toolsView.getByRole('group', { name: '原始视频' });
    assert.equal(await transferMaterial(videoZone, 'drop', {
      name: '原片.webm', mimeType: '', buffer: sampleVideo
    }), true);
    await toolsView.getByText('已添加：原片.webm', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#mediaToolsView .media-tools-preview:is(video)').videoWidth === 48);
    await toolsView.getByRole('button', { name: '移除目标人脸照片' }).click();
    await page.locator('.nav [data-view="text-dubbing"]').click();
    assert.equal(await draft.inputValue(), '这是测试配音稿。', '切换工具不清空当前会话的草稿');
    const results = toolsView.locator('.media-tools-results');
    const importInput = results.locator('input[type="file"]');
    await results.locator('.media-tools-import:enabled').waitFor();
    assert.equal(await results.getByText('暂无结果').isVisible(), true);
    await importInput.setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('Not audio') });
    assert.equal(await results.getByText('请选择有效的音频文件。').isVisible(), true);
    await importInput.setInputFiles({ name: '配音结果.wav', mimeType: 'audio/wav', buffer: wav });
    const download = results.getByRole('link', { name: '下载 配音结果.wav' });
    await download.waitFor();
    assert.equal(await download.getAttribute('download'), '配音结果.wav');
    assert.equal(await download.evaluate(async link => (await (await fetch(link.href)).blob()).size), wav.length);
    await results.locator('audio').evaluate(audio => { audio.muted = true; return audio.play(); });
    assert.equal(await results.locator('audio').evaluate(audio => audio.duration), 1);
    const columns = await toolsView.evaluate(view => [
      view.querySelector('.media-tools-prep').getBoundingClientRect(),
      view.querySelector('.media-dubbing-settings').getBoundingClientRect(),
      view.querySelector('.media-tools-results').getBoundingClientRect()
    ].map(({ top, left, right, bottom }) => ({ top, left, right, bottom })));
    assert.equal(columns[0].top, columns[1].top, '配音设置与左侧文稿顶部对齐');
    assert.ok(columns[1].left > columns[0].right, '配音设置位于页面右侧');
    assert.equal(columns[2].left, columns[1].left, '任务栏保留在右侧');
    assert.ok(columns[2].top > columns[1].bottom, '任务结果位于设置下方');
    const cloneNav = page.locator('.nav [data-view="voice-clone"]');
    await cloneNav.click();
    await results.locator('.media-tools-import:enabled').waitFor();
    assert.equal(await results.getByText('暂无结果').isVisible(), true, '工具之间的本地结果互不混用');
    const startRecording = toolsView.getByRole('button', { name: '开始录音' });
    const stopRecording = toolsView.getByRole('button', { name: '停止录音' });
    const quickMode = toolsView.getByRole('button', { name: '快速声音模仿' });
    const proMode = toolsView.getByRole('button', { name: '专业声音模仿' });
    const quickSample = toolsView.locator('#voiceCloneQuick');
    const proSample = toolsView.locator('#voiceCloneProfessional');
    assert.equal(await quickMode.getAttribute('aria-pressed'), 'true');
    assert.equal(await proSample.isVisible(), false);
    await quickSample.locator('input[type="file"]').setInputFiles({ name: 'quick.wav', mimeType: 'audio/wav', buffer: wav });
    assert.match(await quickSample.locator('audio').getAttribute('src'), /^blob:/);
    const oldQuick = await quickSample.locator('audio').getAttribute('src');
    await quickSample.locator('.media-tools-dropzone').hover();
    await proMode.evaluate(button => button.click());
    const proAudio = { name: 'pro.wav', mimeType: 'audio/wav', buffer: wav };
    assert.equal(await transferMaterial(page.locator('body'), 'paste', proAudio), false, '隐藏的声音模式不接收粘贴');
    assert.equal(await quickSample.locator('audio').getAttribute('src'), oldQuick);
    assert.equal(await quickSample.isVisible(), false);
    assert.equal(await startRecording.isVisible(), false);
    const proPicker = proSample.getByRole('button', { name: '选择高质量人声录音' });
    await proPicker.focus();
    assert.equal(await transferMaterial(proPicker, 'paste', { ...proAudio, mimeType: '' }), true);
    assert.match(await proSample.locator('audio').getAttribute('src'), /^blob:/);
    await quickMode.click();
    assert.equal(await quickSample.locator('audio').isVisible(), true, '两个模式分别保留自己的样本');
    await page.evaluate(() => {
      const devices = navigator.mediaDevices;
      const getUserMedia = devices.getUserMedia.bind(devices);
      devices.getUserMedia = async constraints => {
        if (!window.testMicrophoneAllowed) throw new DOMException('Denied', 'NotAllowedError');
        const stream = await getUserMedia(constraints);
        window.testMicrophoneTrack = stream.getAudioTracks()[0];
        return stream;
      };
    });
    await startRecording.click();
    await quickSample.getByText(/麦克风权限未开启/).waitFor();
    assert.equal(await quickSample.locator('audio').isVisible(), true, '拒绝麦克风权限不清空已有样本');
    await page.evaluate(() => { window.testMicrophoneAllowed = true; });
    await startRecording.click();
    await stopRecording.waitFor();
    // Allow the fake input to produce samples before asking the recorder to flush.
    await new Promise(resolve => setTimeout(resolve, 350));
    await stopRecording.click();
    const recordingDownload = quickSample.getByRole('link', { name: '下载录音' });
    await recordingDownload.waitFor();
    assert.ok(await recordingDownload.evaluate(async link => (await (await fetch(link.href)).blob()).size > 0));
    assert.equal(await page.evaluate(() => window.testMicrophoneTrack.readyState), 'ended');
    await startRecording.click();
    await stopRecording.waitFor();
    await proMode.click();
    assert.equal(await page.evaluate(() => window.testMicrophoneTrack.readyState), 'ended', '切换模式立即释放麦克风');
    assert.equal(await proSample.locator('audio').isVisible(), true);
    await quickMode.click();
    assert.equal(await recordingDownload.isVisible(), true, '取消新录音不清空已录样本');
    await startRecording.click();
    await stopRecording.waitFor();
    await page.locator('.nav [data-view="text-dubbing"]').click();
    assert.equal(await page.evaluate(() => window.testMicrophoneTrack.readyState), 'ended', '离开页面立即释放麦克风');
    assert.equal(await download.isVisible(), true);
    const layout = toolsView.locator('.media-tools-layout');
    await translatedMode.click();
    const draftGrid = toolsView.locator('.media-tools-draft-grid');
    assert.equal(await draftGrid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2, '宽窗口原稿和译稿并排');
    await page.setViewportSize({ width: 980, height: 680 });
    assert.equal(await layout.evaluate(el => el.scrollWidth <= el.clientWidth), true, '最小桌面窗口不横向溢出');
    assert.equal(await draftGrid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1, '左栏空间不足时堆叠原稿和译稿');
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(await layout.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1, '窄窗口使用单栏');
    const settings = page.locator('.nav [data-view="settings"]');
    await settings.scrollIntoViewIfNeeded();
    assert.equal(await settings.evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), true, '新增工具后仍可滚动到设置');
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.locator('.nav [data-view="workspace"]').click();
    assert.equal(await toolsView.isVisible(), false);

    await page.evaluate(() => {
      workbenchSettings.startupView = 'video';
      localStorage.setItem('aiWorkbenchSettingsV1', JSON.stringify(workbenchSettings));
      localStorage.setItem('aiWorkbenchVideoTasksV1', JSON.stringify([{ key: 'saved-video-lock-test', platform: 'grsai', model: 'minimax-h3', prompt: '拖入恢复测试', url: 'https://example.invalid/saved-video.mp4', refs: [], status: 'succeeded' }]));
    });
    await page.reload();
    await page.waitForSelector('#customTemplateSelect');
    assert.equal(await page.evaluate(() => window.workbenchVideoAccess.isUnlocked()), false);
    // A saved startup preference must not bypass the lock.
    await page.waitForSelector('#videoUnlockDialog[open]');
    assert.equal(await page.locator('#videoView').isVisible(), false);
    await page.locator('#videoUnlockPassword').press('Escape');

    const before = await app.evaluate(() => global.videoTestUpstreamCalls.length);
    // Canvas submits through fetchJson without opening the video page.
    await page.evaluate(() => { window.canvasLockResult = null; void fetchJson('/rh-api/seedance-v1.5-pro/text-to-video', { method: 'POST', body: '{}' }).then(() => { window.canvasLockResult = 'sent'; }, () => { window.canvasLockResult = 'cancelled'; }); });
    await page.waitForSelector('#videoUnlockDialog[open]');
    await page.locator('#videoUnlockCancel').click();
    await page.waitForFunction(() => window.canvasLockResult === 'cancelled');
    assert.equal(await app.evaluate(() => global.videoTestUpstreamCalls.length), before);
    const workspaceCount = await page.evaluate(() => window.__videoWorkspaceTabs.list().length);
    assert.equal(await page.evaluate(() => window.__workbenchVideoDropUrl('https://example.invalid/saved-video.mp4')), true);
    await page.waitForSelector('#videoUnlockDialog[open]');
    await page.locator('#videoUnlockCancel').click();
    assert.equal(await page.evaluate(() => window.__videoWorkspaceTabs.list().length), workspaceCount, '取消拖入解锁不能创建工作区');
    await page.evaluate(() => window.__workbenchVideoDropUrl('https://example.invalid/saved-video.mp4'));
    await page.locator('#videoUnlockPassword').fill(videoPassword);
    await page.locator('#videoUnlockConfirm').click();
    await page.waitForSelector('#videoView:not([hidden])');
    assert.equal(await page.locator('#videoPrompt').inputValue(), '拖入恢复测试');
    await mediaMenu.click();
    await page.locator('.nav [data-view="text-dubbing"]').click();
    await voiceButton.click();
    await voiceDialog.getByRole('radio', { name: '旁白' }).waitFor();
    assert.equal(await openSoundViewSettings.isVisible(), false, '刷新重新解锁后自动读取已保存凭据');
    await voiceDialog.getByRole('button', { name: '取消', exact: true }).click();
    await download.waitFor();
    assert.equal(await download.evaluate(async link => (await (await fetch(link.href)).blob()).size), wav.length, '刷新后仍能读取导入的数据');
    await results.getByRole('button', { name: '移除 配音结果.wav' }).click();
    await results.getByText('暂无结果').waitFor();
    assert.equal(await download.count(), 0);
    await translationNav.click();
    assert.equal(await sourceLanguage.inputValue(), 'ja');
    assert.equal(await targetLanguage.inputValue(), 'vi');
    assert.equal(await translationVoice.inputValue(), 'custom');
    assert.equal(await voiceId.inputValue(), 'test-timbre-42');
    assert.equal(await background.isChecked(), true);
    assert.equal(await erase.isChecked(), true);
    await settings.click();
    await soundViewStatus.filter({ hasText: '已配置。' }).waitFor();
    await soundViewForm.getByRole('button', { name: '移除凭据' }).click();
    await soundViewStatus.filter({ hasText: '未配置。' }).waitFor();
    assert.deepEqual(await (await page.request.get(soundViewSettingsUrl)).json(), { configured: false });
    await translationNav.click();
    await voiceButton.click();
    await openSoundViewSettings.waitFor();
    assert.equal(await voiceSearch.isVisible(), false, '移除凭据后不会继续使用缓存音色');
    await voiceDialog.getByRole('button', { name: '取消', exact: true }).click();
    const beforeNoConfig = await app.evaluate(() => global.videoTestUpstreamCalls.length);
    const configure = async (method, payload, route = 'settings') => page.evaluate(async ({ method, payload, route }) => {
      const response = await fetch('/api/soundview/' + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, data: await response.json() };
    }, { method, payload, route });
    assert.equal((await configure('POST', {}, 'media/text-dubbing')).data.code, 'SOUNDVIEW_SETUP');
    assert.equal(await app.evaluate(() => global.videoTestUpstreamCalls.length), beforeNoConfig);
    assert.equal((await configure('PUT', { appKey: fakeKey, appSecret: fakeSecret })).status, 200);

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.downloadURL = url => global.mediaTestDownloads.push(url);
    });
    await page.locator('.nav [data-view="text-dubbing"]').click();
    await directMode.click();
    await dubbingLanguage.selectOption('en');
    await voiceButton.click();
    await cardVoice.check();
    await commitVoice.click();
    await draft.fill('精确编号测试');
    const submit = toolsView.getByRole('button', { name: '提交任务', exact: true });
    await submit.click();
    const audioTask = results.getByRole('listitem').filter({ hasText: '任务 1234567890123456781' });
    await audioTask.getByText('已完成').waitFor();
    await audioTask.getByRole('button', { name: '下载音频' }).click();
    await audioTask.getByRole('button', { name: '下载字幕' }).click();
    assert.deepEqual(await app.evaluate(() => global.mediaTestDownloads), ['https://example.invalid/out.wav', 'https://example.invalid/out.srt']);
    await app.evaluate(() => { global.mediaTestStatusError = true; });
    await audioTask.getByRole('button', { name: '刷新结果' }).click();
    await audioTask.getByText(/请求时间无效/).waitFor();
    await audioTask.getByText('已完成').waitFor();
    assert.equal(await audioTask.locator('audio').getAttribute('src'), 'https://example.invalid/out.wav');

    await translationNav.click();
    await erase.uncheck();
    await translationVoice.selectOption('x5_clone');
    const videoFile = { name: 'translated.mp4', mimeType: 'video/mp4', buffer: Buffer.from('mock-translation-video') };
    await page.locator('#video-translation-material-0').setInputFiles(videoFile);
    await submit.click();
    const translationTask = toolsView.getByRole('listitem').filter({ hasText: '任务 1234567890123456784' });
    await translationTask.getByText('处理中 42%').waitFor();
    await translationTask.getByText('已完成').waitFor();
    assert.equal(await translationTask.locator('video').getAttribute('src'), 'https://example.invalid/out.mp4');

    await firstTool.click();
    await page.locator('#video-face-swap-material-0').setInputFiles({
      name: 'face.mp4', mimeType: 'video/mp4', buffer: Buffer.from('mock-face-video')
    });
    await submit.click();
    await toolsView.getByText('提交换脸需要可公开访问的 HTTPS 人脸图片直链。').waitFor();
    await toolsView.getByLabel('人脸图片直链（HTTPS）').fill('https://example.invalid/authorized-face.jpg');
    await submit.click();
    const faceTask = toolsView.getByRole('listitem').filter({ hasText: '任务 1234567890123456785' });
    await faceTask.getByText('视频处理失败（状态 2）。').waitFor();

    const writes = await app.evaluate(() => global.videoTestUpstreamCalls.filter(c => c.payload && c.hostname === 'soundviewai.com'));
    const payloadFor = route => writes.find(c => c.path.endsWith('/' + route)).payload;
    assert.match(payloadFor('tts/create'), /"timbre":1234567890123456789[,}]/);
    assert.equal(JSON.parse(payloadFor('tts/create')).translateText, '精确编号测试');
    assert.equal(payloadFor('tts/get'), '{"id":1234567890123456781}');
    assert.equal(payloadFor('file/upload/complete'), '{"fileId":1234567890123456782}');
    assert.match(payloadFor('video/translate'), /"originalFileS3Id":1234567890123456783[,}]/);
    assert.deepEqual(JSON.parse(payloadFor('file/upload/privilege')), {
      fileName: videoFile.name, fileMd5: crypto.createHash('md5').update(videoFile.buffer).digest('hex'), fileSize: videoFile.buffer.length
    });
    assert.deepEqual(JSON.parse(payloadFor('video/face-swap')), {
      originalFileS3Id: '1234567890123456783', imageUrl: 'https://example.invalid/authorized-face.jpg', videoName: 'face.mp4', format: 'mp4'
    });
    for (const { headers, payload } of writes) {
      assert.equal(headers['Content-Length'], Buffer.byteLength(payload));
      assert.equal(headers.sign, crypto.createHash('md5').update([fakeSecret, payload, headers.time, fakeKey, fakeSecret].join('_')).digest('hex').toUpperCase());
    }
    assert.deepEqual(await app.evaluate(() => global.mediaTestUploads), [{
      server: 'https://obs.cn-north-4.myhuaweicloud.com', Bucket: 'mock-files', Key: 'mock/face.mp4', body: 'mock-face-video'
    }]);
    await page.reload();
    await page.locator('#videoUnlockPassword').press('Escape');
    await mediaMenu.click();
    await translationNav.click();
    await page.locator('#videoUnlockPassword').fill(videoPassword);
    await page.locator('#videoUnlockConfirm').click();
    await translationTask.getByText('已完成').waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: 视频密码锁、素材输入、音色库、配音/翻译/换脸提交、右栏状态、下载与恢复；未调用真实服务');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
