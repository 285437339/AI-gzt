const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('node:crypto');
const os = require('node:os');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Video sessions stay in memory and never enter workspace backups.
const VIDEO_PASSWORD_HASH = 'e506d36249536d68fdb2271e71a32d2e9762b9f74f85e56237bdab9fb6712c09';
const videoSessions = new Map();
async function unlockVideo(req, res) {
  try {
    const { password } = JSON.parse(await readBody(req));
    const digest = crypto.createHash('sha256').update(typeof password === 'string' ? password : '').digest();
    if (!crypto.timingSafeEqual(digest, Buffer.from(VIDEO_PASSWORD_HASH, 'hex'))) {
      return sendJson(res, 403, { error: '密码不正确，请重新输入。' });
    }
    for (const [token, session] of videoSessions) if (session.expires <= Date.now()) videoSessions.delete(token);
    if (videoSessions.size >= 1024) videoSessions.delete(videoSessions.keys().next().value);
    const token = crypto.randomBytes(32).toString('hex');
    videoSessions.set(token, { expires: Date.now() + 24 * 60 * 60 * 1000 });
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, { token });
  } catch { return sendJson(res, 400, { error: '无法验证密码，请重试。' }); }
}
function getVideoSession(req) {
  const token = req.headers['x-workbench-video-token'];
  const session = videoSessions.get(token);
  if (session?.expires > Date.now()) return session;
  if (session) videoSessions.delete(token);
  return null;
}
function authorizeVideoRequest(req, res, route, body) {
  let model = '';
  try { model = String(JSON.parse(String(body || '{}')).model || ''); } catch {}
  const isVideo = /(?:text|image|reference)-to-video|rhart-video/i.test(route) || /^minimax-h3$/i.test(model);
  if (!isVideo) return true;
  if (getVideoSession(req)) return true;
  sendJson(res, 403, { code: 'VIDEO_LOCKED', error: '请先输入密码解锁视频功能。' });
  return false;
}

const soundViewClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
function requestSoundView({ appKey, appSecret }, route, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const date = Object.fromEntries(soundViewClock.formatToParts(new Date()).map(part => [part.type, part.value]));
  const time = [date.year, date.month, date.day, date.hour, date.minute, date.second].join('');
  const sign = crypto.createHash('md5').update([appSecret, payload, time, appKey, appSecret].join('_')).digest('hex').toUpperCase();
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'soundviewai.com', path: '/antelope-media/openapi/v1/' + route,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', appKey, time, sign,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) }
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) {
          request.destroy(new Error('SIZE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          // The SDK schema permits int64 IDs. Preserve the exact token rather than a rounded Number.
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value, context) =>
            ['id', 'taskId', 'fileId', 's3Id'].includes(key) && typeof value === 'number'
              ? context?.source && /^\d+$/.test(context.source) ? context.source : Number.isSafeInteger(value) ? String(value) : null
              : value);
          if ([10001, 10003, 10004].includes(Number(data?.code))) throw new Error('AUTH');
          if (Number(data?.code) === 10002) throw new Error('CLOCK');
          if ([401, 403].includes(response.statusCode)) throw new Error('AUTH');
          if (response.statusCode !== 200 || Number(data?.code) !== 0) {
            throw Object.assign(new Error('UPSTREAM'), { remoteCode: Number(data?.code) || null });
          }
          resolve(data.result);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(25_000, () => request.destroy(new Error('TIMEOUT')));
    request.on('error', reject);
    request.end(payload || undefined);
  });
}

async function requestSoundViewVoices(config) {
  const rows = await requestSoundView(config, 'common/timbre/list');
  if (!Array.isArray(rows)) throw new Error('UPSTREAM');
  const trimmed = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  return rows.flatMap(row => {
    const id = trimmed(row?.id, 160);
    const name = trimmed(row?.name, 160);
    const lang = trimmed(row?.lang, 16).toLowerCase();
    if (!id || !name || !lang || Number(row.status) === 1) return [];
    const auditionUrl = safeMediaUrl(row.auditionUrl);
    const tags = [row.genderStr, row.accentStr, row.ageRangeStr, row.emotionStr,
      ...(Array.isArray(row.categoryStrList) ? row.categoryStrList.slice(0, 8) : [])];
    return [{ id, name, lang, auditionUrl, note: trimmed(row.remark, 400),
      tags: [...new Set(tags.map(value => trimmed(value, 50)).filter(Boolean))] }];
  });
}

function soundViewCredentials(value) {
  const { appKey, appSecret } = value || {};
  if (typeof appKey !== 'string' || typeof appSecret !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(appKey) ||
      !/^[\x21-\x7e]{1,512}$/.test(appSecret)) return null;
  return { appKey, appSecret };
}

async function readSoundViewCredentials() {
  try {
    return soundViewCredentials(JSON.parse(await fs.promises.readFile(SOUNDVIEW_CREDENTIALS_FILE, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function saveSoundViewCredentials(credentials) {
  await fs.promises.mkdir(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  const temporary = SOUNDVIEW_CREDENTIALS_FILE + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(credentials), { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, SOUNDVIEW_CREDENTIALS_FILE);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

function isLocalSoundViewRequest(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  try {
    const host = new URL('http://' + req.headers.host);
    return host.host === req.headers.host && ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) &&
      (!req.headers.origin || req.headers.origin === host.origin);
  } catch { return false; }
}

const videoUploadFormats = new Set(['mp4', 'mov', 'mkv', 'avi', 'm4v', 'webm']);
const soundViewSourceLanguages = new Set('cn en ja ko ru de fr ar es it pt ms th'.split(' '));
const soundViewTargetLanguages = new Set([...soundViewSourceLanguages, ...'tl nl vi id no ca bn'.split(' ')]);
const soundViewDubbingLanguages = new Set('cn en ko tl th ms id'.split(' '));
const maxVideoUpload = 512 * 1024 * 1024;
let activeSoundViewUploads = 0;

function soundViewLong(value) {
  const id = String(value ?? '');
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw new Error('INVALID_ID');
  return JSON.rawJSON(id);
}

function safeMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {}
  return '';
}

async function uploadSoundViewObject(privilege, file) {
  const temp = privilege.temporaryAccessKey;
  const endpoint = new URL('https://' + String(privilege.endPoint || temp?.endPoint || '').replace(/^https:\/\//i, ''));
  const bucket = privilege.bucketName || temp?.bucketName;
  if (!/^obs(?:\.[a-z0-9-]+)?\.myhuaweicloud\.com$/.test(endpoint.hostname) ||
    endpoint.href !== endpoint.origin + '/' || endpoint.port || endpoint.username || endpoint.password ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    !temp?.access || !temp.secret || !temp.securitytoken || !privilege.randomName) throw new Error('UPLOAD');
  const ObsClient = require('esdk-obs-nodejs');
  const client = new ObsClient({
    server: endpoint.origin, access_key_id: temp.access, secret_access_key: temp.secret,
    security_token: temp.securitytoken, timeout: 120, max_retry_count: 0
  });
  try {
    const prefix = privilege.dirPath ? privilege.dirPath.replace(/\/+$/, '') + '/' : '';
    const result = await client.putObject({ Bucket: bucket, Key: prefix + privilege.randomName, SourceFile: file });
    if (!(result?.CommonMsg?.Status >= 200 && result.CommonMsg.Status < 300)) throw new Error('UPLOAD');
  } finally { client.close(); }
}

async function serveSoundViewMedia(req, res, operation) {
  const send = (status, data) => sendJson(res, status, data, false);
  if (!isLocalSoundViewRequest(req)) return send(403, { error: '请在本机工作台使用音视频工具。' });
  if (req.method !== 'POST') return send(405, { error: '不支持此操作。' });
  if (!getVideoSession(req)) return send(403, { code: 'VIDEO_LOCKED', error: '请先解锁音视频工具。' });
  let folder;
  let uploading = false;
  try {
    const config = await readSoundViewCredentials();
    if (!config) return send(409, { code: 'SOUNDVIEW_SETUP', error: '请先在设置中配置音色服务。' });
    const call = (route, body) => requestSoundView(config, route, body);
    if (operation === 'video-translation' || operation === 'video-face-swap') {
      const faceSwap = operation === 'video-face-swap';
      const size = Number(req.headers['content-length']);
      let options;
      try { options = JSON.parse(decodeURIComponent(req.headers['x-media-options'] || '')); } catch {}
      const { fileName, originalLang, destLang, timbre, keepBackground } = options || {};
      const format = typeof fileName === 'string' && path.extname(fileName).slice(1).toLowerCase();
      if (!videoUploadFormats.has(format) || fileName.length > 255 || /[\\/\x00-\x1f]/.test(fileName) ||
        !Number.isSafeInteger(size) || size < 1 || size > maxVideoUpload) {
        return send(400, { error: '请检查视频格式和大小（不超过 512 MB）。' });
      }
      const imageUrl = faceSwap ? safeMediaUrl(options.imageUrl) : '';
      if (faceSwap ? !imageUrl || imageUrl.length > 4096 :
        !soundViewSourceLanguages.has(originalLang) || !soundViewTargetLanguages.has(destLang) || originalLang === destLang ||
        typeof timbre !== 'string' || !/^(?:[1-9]\d{0,18}|x5_clone)$/.test(timbre)) {
        return send(400, { error: faceSwap ? '请输入有效的 HTTPS 人脸图片直链。' : '请检查原始语言、翻译语言和音色。' });
      }
      if (activeSoundViewUploads >= 2) return send(429, { error: '正在上传其他视频，请稍后再试。' });
      activeSoundViewUploads++;
      uploading = true;
      folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'workbench-media-'));
      const file = path.join(folder, 'source.' + format);
      const hash = crypto.createHash('md5');
      let bytes = 0;
      await pipeline(req, new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        }
      }), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      if (bytes !== size || res.destroyed) return;
      const privilege = await call('file/upload/privilege', { fileName, fileMd5: hash.digest('hex'), fileSize: size });
      const fileId = soundViewLong(privilege?.fileId);
      if (privilege.temporaryAccessKey) await uploadSoundViewObject(privilege, file);
      else if (!(privilege.uploadComplete === true || privilege.temporaryAccessKey === null)) throw new Error('UPLOAD');
      const completed = await call('file/upload/complete', { fileId });
      if (res.destroyed) return;
      const s3Id = soundViewLong(completed?.s3Id || privilege.fileId);
      const result = await call(faceSwap ? 'video/face-swap' : 'video/translate', faceSwap ? {
        originalFileS3Id: s3Id.rawJSON, imageUrl, videoName: fileName, format
      } : {
        originalFileS3Id: s3Id, originalLang, destLang, timbre, videoName: fileName, format,
        keepBackgroundAudio: keepBackground === true ? 1 : 0
      });
      return send(200, { id: soundViewLong(result?.taskId).rawJSON });
    }

    let body;
    try { body = JSON.parse(await readBody(req, 128 * 1024)); } catch {
      return send(400, { error: '请求内容无效或过长。' });
    }
    if (operation === 'text-dubbing') {
      const { text, lang, voice, rate, volume } = body || {};
      if (typeof text !== 'string' || !text.trim() || text.length > 20_000 ||
        !soundViewDubbingLanguages.has(lang) || ![rate, volume].every(value => Number.isInteger(value) && value >= 1 && value <= 100)) {
        return send(400, { error: '请检查配音稿、语言、语速和音量。' });
      }
      const result = await call('tts/create', {
        destLang: lang, timbre: soundViewLong(voice), translateText: text.trim(),
        ttsConfig: JSON.stringify({ rate, volume })
      });
      return send(200, { id: soundViewLong(result?.taskId).rawJSON });
    }
    const kind = body?.kind;
    if (!['text-dubbing', 'video-translation', 'video-face-swap'].includes(kind)) return send(400, { error: '无效的任务类别。' });
    const result = await call(kind === 'text-dubbing' ? 'tts/get' : 'video/get', { id: soundViewLong(body.id) });
    const url = safeMediaUrl(result?.destFileTmpUrl);
    const subtitles = safeMediaUrl(result?.destStrTmpUrl);
    const state = result?.status;
    if (kind === 'text-dubbing' ? url : Number(state) === 1 && url) {
      return send(200, { status: 'completed', url, subtitles });
    }
    if (kind === 'text-dubbing' || state == null || [0, 3].includes(Number(state))) {
      const progress = Number(result?.process);
      return send(200, { status: 'processing', progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : null });
    }
    return send(200, { status: 'failed', error: Number(state) === 1
      ? '任务已完成，但未返回有效的成片。' : `视频处理失败（状态 ${Number(state) || '未知'}）。` });
  } catch (error) {
    if (res.destroyed) return;
    if (error.message === 'AUTH') return send(401, { code: 'SOUNDVIEW_SETUP', error: '音色服务认证失败，请检查设置。' });
    if (error.message === 'CLOCK') return send(502, { error: '请求时间无效，请检查电脑的日期和时间。' });
    if (error.message === 'INVALID_ID') return send(400, { error: '音色或任务编号无效。' });
    if (error.remoteCode === 10014) return send(422, { error: '服务无法解析该视频，请确认视频可以正常播放。' });
    if (error.remoteCode === 10015) return send(422, { error: '视频有效人声太短，无法克隆原声。' });
    return send(502, { error: error.remoteCode ? `生成服务未接受请求（错误码 ${error.remoteCode}）。`
      : error.message === 'UPLOAD' ? '无法上传视频，请检查网络后重试。' : '任务服务暂未响应，请稍后查询或重试。' });
  } finally {
    if (uploading) activeSoundViewUploads--;
    if (folder) await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

async function serveSoundView(req, res, settings) {
  const send = (status, data) => sendJson(res, status, data, false);
  if (!isLocalSoundViewRequest(req)) return send(403, { error: '请在本机工作台使用音色服务。' });
  const method = req.method;
  if (!(settings ? ['GET', 'PUT', 'DELETE'] : ['GET']).includes(method)) {
    return send(405, { error: '不支持此操作。' });
  }
  if ((!settings || method !== 'GET') && !getVideoSession(req)) {
    return send(403, { code: 'VIDEO_LOCKED', error: '请先输入密码解锁音视频工具。' });
  }
  let config;
  if (method === 'PUT') {
    try { config = soundViewCredentials(JSON.parse(await readBody(req, 4096))); } catch {}
    if (!config) return send(400, { error: '请填写有效的 AppKey 和 AppSecret。' });
  }
  try {
    if (method === 'DELETE') {
      await fs.promises.rm(SOUNDVIEW_CREDENTIALS_FILE, { force: true });
      return send(200, { configured: false });
    }
    if (method === 'GET') config = await readSoundViewCredentials();
    if (settings && method === 'GET') return send(200, { configured: Boolean(config) });
    if (!config) return send(409, { code: 'SOUNDVIEW_SETUP', error: '尚未配置音色服务凭据。' });
    const voices = await requestSoundViewVoices(config);
    if (!settings) return send(200, { voices });
    await saveSoundViewCredentials(config);
    return send(200, { configured: true });
  } catch (error) {
    if (error.message === 'AUTH') {
      return send(401, { code: 'SOUNDVIEW_SETUP', error: '音色服务认证失败，请检查 AppKey 和 AppSecret。' });
    }
    if (error.syscall && ['open', 'read', 'mkdir', 'rename', 'unlink', 'lstat', 'write'].includes(error.syscall)) {
      return send(500, { error: '无法读写本机音色服务配置。' });
    }
    return send(502, { error: error.message === 'CLOCK'
      ? '音色服务拒绝了请求时间，请检查电脑的日期和时间。'
      : '暂时无法加载音色库，请稍后重试。' });
  }
}

const PORT = Number(process.env.AI_WORKBENCH_PORT || 4173);
const UPSTREAM_HOST = process.env.GRSAI_API_HOST || 'grsai.dakka.com.cn';
const SERVICE_VERSION = '2026-09-01-portable-v5';
const ALLOWED_UPSTREAM_HOSTS = new Set(['grsai.dakka.com.cn', 'grsaiapi.com']);
const RUNNINGHUB_HOST = 'www.runninghub.cn';
const RUNNINGHUB_GLOBAL_HOST = 'www.runninghub.ai';
const RUNNINGHUB_LLM_HOST = 'llm.runninghub.cn';
const RUNNINGHUB_GLOBAL_LLM_HOST = 'llm.runninghub.ai';
const RUNNINGHUB_API_BASE = '/openapi/v2';
const RUNNINGHUB_LLM_HOSTS = new Set([RUNNINGHUB_LLM_HOST, RUNNINGHUB_GLOBAL_LLM_HOST]);
const UPSTREAM_LOG_FILE = path.join(__dirname, 'upstream-error.log');
const SETTINGS_DIR = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'XieMengxiongWorkbench');
const WORKBENCH_SETTINGS_FILE = path.join(SETTINGS_DIR, 'workbench-settings.json');
const WORKBENCH_STATE_FILE = path.join(SETTINGS_DIR, 'workbench-state.json');
const SOUNDVIEW_CREDENTIALS_FILE = path.join(SETTINGS_DIR, 'soundview-credentials.json');
const INSPIRATION_DIR = path.join(SETTINGS_DIR, 'inspirations');
const DEFAULT_MEDIA_CACHE_DIR = path.join(SETTINGS_DIR, 'media-cache');
const GENERATED_MEDIA_DIR = path.join(SETTINGS_DIR, 'generated-images');

function sanitizeWorkbenchState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const storage = source.storage && typeof source.storage === 'object' ? source.storage : {};
  const output = {};
  let total = 0;
  for (const [key, raw] of Object.entries(storage)) {
    if (!/^(aiWorkbench|refSlots$|reverseRefSlots$|grsaiKey$|grsaiUrl$|runninghubKey$|canvas)/.test(key)) continue;
    const text = String(raw ?? '');
    total += Buffer.byteLength(text);
    if (total > 50 * 1024 * 1024) throw new Error('工作台状态超过 50MB，请减少缓存图片后重试');
    output[String(key).slice(0, 160)] = text;
  }
  return { version: source.version === 2 ? 2 : 1, updatedAt: Number(source.updatedAt) || Date.now(), storage: output };
}

let stateWriteQueue = Promise.resolve();
async function readWorkbenchState() {
  try { return sanitizeWorkbenchState(JSON.parse(await fs.promises.readFile(WORKBENCH_STATE_FILE, 'utf8'))); }
  catch (error) {
    try { return sanitizeWorkbenchState(JSON.parse(await fs.promises.readFile(`${WORKBENCH_STATE_FILE}.bak`, 'utf8'))); }
    catch (backupError) { if (error.code === 'ENOENT' && backupError.code === 'ENOENT') return null; throw error.code === 'ENOENT' ? backupError : error; }
  }
}

async function handleWorkbenchState(req, res) {
  try {
    if (req.method === 'GET') {
      try {
        await stateWriteQueue.catch(() => {});
        const state = await readWorkbenchState();
        return sendJson(res, 200, { ok: true, state });
      } catch (error) {
        if (error?.code === 'ENOENT') return sendJson(res, 200, { ok: true, state: null });
        throw error;
      }
    }
    if (req.method !== 'PUT') return sendJson(res, 405, { ok: false, error: '仅支持 GET 或 PUT' });
    const state = sanitizeWorkbenchState(JSON.parse(await readBody(req))?.state);
    // Serialize writers: overlapping requests previously used the same temp file.
    const write = stateWriteQueue.catch(() => {}).then(async () => {
      const previous = await readWorkbenchState();
      if (previous && previous.updatedAt > state.updatedAt) throw new Error('检测到更新的历史记录，请重新打开工作台后再试');
      await fs.promises.mkdir(SETTINGS_DIR, { recursive: true });
      const temporary = `${WORKBENCH_STATE_FILE}.${process.pid}.tmp`;
      const file = await fs.promises.open(temporary, 'w');
      try { await file.writeFile(`${JSON.stringify(state)}\n`, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      if (previous) {
        const backup = `${WORKBENCH_STATE_FILE}.bak.tmp`;
        await fs.promises.writeFile(backup, `${JSON.stringify(previous)}\n`, 'utf8');
        await fs.promises.rename(backup, `${WORKBENCH_STATE_FILE}.bak`);
      }
      await fs.promises.rename(temporary, WORKBENCH_STATE_FILE);
    });
    stateWriteQueue = write;
    await write;
    sendJson(res, 200, { ok: true, updatedAt: state.updatedAt });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `工作台状态读写失败: ${error.message || error}` });
  }
}

const SETTINGS_KEYS = new Set([
  'version', 'platform', 'apiUrl', 'apiKey', 'runninghubKey', 'saveDir',
  'filenameTemplate', 'startupView', 'keepRefs', 'skin', 'normalChannel',
  'datePicker', 'clearHistory', 'clearBoard', 'photoshopPath', 'assetDir',
  'psdResources', 'cacheLimit', 'cacheDir', 'updatedAt'
]);
const BOOLEAN_SETTINGS_KEYS = new Set(['keepRefs', 'normalChannel', 'datePicker', 'clearHistory', 'clearBoard', 'psdResources']);
const ALLOWED_SKINS = new Set(['dark', 'soft', 'warm', 'light']);

function sanitizeWorkbenchSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const allowedViews = new Set(['workspace', 'reverse', 'inspiration', 'assistant', 'assets', 'settings']);
  const output = {};
  for (const key of SETTINGS_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    if (BOOLEAN_SETTINGS_KEYS.has(key)) output[key] = source[key] === true;
    else if (key === 'startupView') output[key] = allowedViews.has(String(source[key])) ? String(source[key]) : 'workspace';
    else if (key === 'skin') output[key] = ALLOWED_SKINS.has(String(source[key])) ? String(source[key]) : 'dark';
    else if (key === 'cacheLimit') output[key] = Math.min(100, Math.max(1, Number(source[key]) || 5));
    else if (key === 'updatedAt') output[key] = Number(source[key]) || Date.now();
    else output[key] = String(source[key]).slice(0, 200000);
  }
  output.version = String(source.version || '1');
  output.updatedAt = Number(output.updatedAt) || Date.now();
  return output;
}

async function readWorkbenchSettingsFile() {
  try {
    const text = await fs.promises.readFile(WORKBENCH_SETTINGS_FILE, 'utf8');
    return sanitizeWorkbenchSettings(JSON.parse(text));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return sanitizeWorkbenchSettings({});
  }
}

async function handleWorkbenchSettings(req, res) {
  try {
    if (req.method === 'GET') {
      const settings = await readWorkbenchSettingsFile();
      sendJson(res, 200, { ok: true, settings, path: WORKBENCH_SETTINGS_FILE });
      return;
    }
    if (req.method !== 'PUT') {
      sendJson(res, 405, { ok: false, error: '仅支持 GET 或 PUT' });
      return;
    }
    const body = JSON.parse(await readBody(req));
    const settings = sanitizeWorkbenchSettings(body?.settings || body);
    await fs.promises.mkdir(SETTINGS_DIR, { recursive: true });
    await fs.promises.writeFile(WORKBENCH_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    sendJson(res, 200, { ok: true, settings, path: WORKBENCH_SETTINGS_FILE });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `工作台设置读写失败: ${error.message || error}` });
  }
}

function cacheDirectoryFromSettings(settings) {
  const requested = cleanDirectory(settings?.cacheDir);
  return requested ? path.resolve(requested) : DEFAULT_MEDIA_CACHE_DIR;
}

async function ensureMediaCacheDirectory() {
  await fs.promises.mkdir(path.join(DEFAULT_MEDIA_CACHE_DIR, 'assets'), { recursive: true });
  await fs.promises.mkdir(path.join(DEFAULT_MEDIA_CACHE_DIR, 'references'), { recursive: true });
}

function safeCacheFile(root, relative) {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('缓存路径无效');
  return target;
}

async function storeCacheMedia(req, res) {
  try {
    const data = JSON.parse(await readBody(req));
    const sources = (Array.isArray(data.sources) ? data.sources : [data.source]).map(value => String(value || '').trim()).filter(Boolean).slice(0, 12);
    if (!sources.length) return sendJson(res, 400, { error: '缺少需要缓存的图片' });
    const settings = await readWorkbenchSettingsFile();
    const root = cacheDirectoryFromSettings(settings);
    const kind = data.kind === 'assets' ? 'assets' : 'references';
    await fs.promises.mkdir(path.join(root, kind), { recursive: true });
    const urls = [];
    const originalUrls = [];
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      const dataMatch = source.match(/^data:image\/(png|jpeg|jpg|webp);base64,/i);
      const extension = kind === 'assets' ? 'webp' : (dataMatch?.[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
      const filename = `${kind}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
      const target = safeCacheFile(root, path.join(kind, filename));
      if (kind === 'assets') {
        const temporary = `${target}.source`;
        try {
          await downloadToFile(source, temporary);
          await sharp(temporary).resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(target);
          if (data.preserveOriginal === true) {
            await fs.promises.mkdir(GENERATED_MEDIA_DIR, { recursive: true });
            const metadata = await sharp(temporary).metadata();
            const originalName = filename.replace(/\.webp$/, '.' + (metadata.format === 'jpeg' ? 'jpg' : metadata.format || 'png'));
            await fs.promises.copyFile(temporary, safeCacheFile(GENERATED_MEDIA_DIR, originalName));
            originalUrls.push('/generated-media/' + encodeURIComponent(originalName));
          }
        } finally {
          await fs.promises.rm(temporary, { force: true }).catch(() => {});
        }
      } else {
        await downloadToFile(source, target);
      }
      urls.push(`/cache-media/${encodeURIComponent(kind)}/${encodeURIComponent(filename)}`);
    }
    sendJson(res, 200, { ok: true, urls, originalUrls, directory: root });
  } catch (error) {
    sendJson(res, 500, { error: `缓存图片失败: ${error.message || error}` });
  }
}

async function handleVersion(req, res) {
  sendJson(res, 200, { ok: true, version: require('./package.json').version });
}

async function serveCacheMedia(req, res) {
  try {
    const parts = req.url.split('?')[0].split('/').filter(Boolean).slice(1);
    if (parts.length !== 2 || !['assets', 'references'].includes(parts[0])) throw new Error('缓存资源不存在');
    const settings = await readWorkbenchSettingsFile();
    const file = safeCacheFile(cacheDirectoryFromSettings(settings), path.join(parts[0], decodeURIComponent(parts[1])));
    const body = await fs.promises.readFile(file);
    const extension = path.extname(file).toLowerCase();
    const type = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: '缓存图片不存在' });
  }
}

function redactLogText(value) {
  return String(value || '')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:"?(?:api[_-]?key|apikey|token|x-goog-api-key|x-api-key)"?\s*[:=]\s*"))[^"\r\n]+/gi, '$1[REDACTED]')
    .slice(0, 2000);
}

function logUpstreamError(kind, host, route, status, responseText, errorMessage = '') {
  const record = {
    time: new Date().toISOString(),
    kind,
    host,
    route,
    status: status || 0,
    error: redactLogText(errorMessage),
    response: redactLogText(responseText)
  };
  try {
    fs.appendFileSync(UPSTREAM_LOG_FILE, `${JSON.stringify(record, null, 2)}\r\n`, 'utf8');
  } catch {
    // A diagnostic log must never make an API request fail.
  }
}

function shouldLogUpstreamResponse(status, responseText) {
  if (Number(status || 0) >= 400) return true;
  try {
    const value = JSON.parse(responseText || '{}');
    const codeValue = value?.code ?? value?.errorCode ?? value?.error_code;
    const code = Number(codeValue);
    return value?.success === false || value?.ok === false || (codeValue !== undefined && codeValue !== null && String(codeValue) !== '' && Number.isFinite(code) && code !== 0 && code !== 200);
  } catch {
    return false;
  }
}

function forwardHeader(source, target, sourceName, targetName = sourceName) {
  const value = source.headers[sourceName];
  if (value) target[targetName] = value;
}

function proxyRequest(req, res, route, body) {
  if (!authorizeVideoRequest(req, res, route, body)) return;
  const payload = body || '';
  const requestedHost = String(req.headers['x-grsai-host'] || '').toLowerCase();
  const upstreamHost = ALLOWED_UPSTREAM_HOSTS.has(requestedHost) ? requestedHost : UPSTREAM_HOST;
  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Accept': 'application/json',
    'User-Agent': 'AI-Workbench/1.0'
  };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers['x-api-key']) headers['x-api-key'] = req.headers['x-api-key'];
  if (req.headers['x-goog-api-key']) headers['x-goog-api-key'] = req.headers['x-goog-api-key'];

  const upstream = https.request({
    hostname: upstreamHost,
    path: route,
    method: req.method,
    headers,
    timeout: 600000
  }, upstreamRes => {
    let response = '';
    upstreamRes.setEncoding('utf8');
    upstreamRes.on('data', chunk => { response += chunk; });
    upstreamRes.on('end', () => {
      res.writeHead(upstreamRes.statusCode || 502, {
        'Content-Type': upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      if (shouldLogUpstreamResponse(upstreamRes.statusCode, response)) {
        logUpstreamError('grsai', upstreamHost, route, upstreamRes.statusCode, response);
      }
      res.end(response);
    });
  });

  upstream.setTimeout(600000, () => {
    upstream.destroy(new Error('上游 API 请求超时'));
  });
  upstream.on('error', error => {
    logUpstreamError('grsai-connection', upstreamHost, route, 502, '', error.message);
    if (res.headersSent) return;
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ error: `上游 API 连接失败: ${error.message}` }));
  });
  upstream.end(payload);
}

function sendJson(res, status, value, cors = true) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(value));
}

function readBody(req, maxSize = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) reject(new Error('Request body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => { if (size <= maxSize) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function proxyToHost(req, res, hostname, route, body, contentType = 'application/json') {
  if (!authorizeVideoRequest(req, res, route, body)) return;
  const payload = body || '';
  const headers = {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload),
    'Accept': 'application/json',
    'User-Agent': 'AI-Workbench/1.0'
  };
  forwardHeader(req, headers, 'authorization', 'Authorization');
  for (const name of ['x-runninghub-region', 'rh-token', 'rh-comfy-auth', 'rh-identify', 'x-team-id', 'user-language', 'client', 'x-trace-id', 'trace-id', 'x-request-id', 'request-id', 'traceparent']) {
    forwardHeader(req, headers, name);
  }
  const upstream = https.request({ hostname, path: route, method: req.method, headers, timeout: 600000 }, upstreamRes => {
    const chunks = [];
    upstreamRes.on('data', chunk => chunks.push(chunk));
    upstreamRes.on('end', () => {
      res.writeHead(upstreamRes.statusCode || 502, {
        'Content-Type': upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      const response = Buffer.concat(chunks).toString('utf8');
      if (shouldLogUpstreamResponse(upstreamRes.statusCode, response)) {
        logUpstreamError(RUNNINGHUB_LLM_HOSTS.has(hostname) ? 'runninghub-llm' : 'runninghub', hostname, route, upstreamRes.statusCode, response);
      }
      res.end(response);
    });
  });
  upstream.setTimeout(600000, () => upstream.destroy(new Error('RunningHub 请求超时')));
  upstream.on('error', error => {
    logUpstreamError(RUNNINGHUB_LLM_HOSTS.has(hostname) ? 'runninghub-llm-connection' : 'runninghub-connection', hostname, route, 502, '', error.message);
    if (res.headersSent) return;
    sendJson(res, 502, { error: `RunningHub 连接失败: ${error.message}` });
  });
  upstream.end(payload);
}

async function uploadRunningHubImage(req, res) {
  try {
    const data = JSON.parse(await readBody(req));
    const match = String(data.dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/s);
    if (!match) return sendJson(res, 400, { error: '参考图片数据格式无效' });
    const binary = Buffer.from(match[2], 'base64');
    const extension = match[1].split('/')[1].replace('jpeg', 'jpg');
    const filename = String(data.name || `reference-${Date.now()}.${extension}`).replace(/[^a-z0-9._-]/gi, '_');
    const boundary = `----AIWorkbench${Date.now().toString(16)}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${match[1]}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    proxyToHost(req, res, req.headers['x-runninghub-region'] === 'global' ? RUNNINGHUB_GLOBAL_HOST : RUNNINGHUB_HOST, `${RUNNINGHUB_API_BASE}/media/upload/binary`, Buffer.concat([head, binary, tail]), `multipart/form-data; boundary=${boundary}`);
  } catch (error) {
    sendJson(res, 400, { error: `上传图片失败: ${error.message}` });
  }
}

function downloadToFile(source, target, redirects = 0) {
  if (/^\/(cache-media|generated-media)\//.test(source)) source = `http://127.0.0.1:${PORT}${source}`;
  return new Promise((resolve, reject) => {
    if (source.startsWith('data:image/')) {
      const match = source.match(/^data:image\/[^;]+;base64,(.+)$/s);
      if (!match) return reject(new Error('图片数据格式无效'));
      return fs.writeFile(target, Buffer.from(match[1], 'base64'), error => error ? reject(error) : resolve());
    }
    let parsed;
    try { parsed = new URL(source); } catch { return reject(new Error('图片地址无效')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('只支持 HTTP/HTTPS 图片地址'));
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(parsed, { headers: { 'User-Agent': 'AI-Workbench/1.0' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 3) {
        response.resume();
        return downloadToFile(new URL(response.headers.location, source).href, target, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`图片下载失败（HTTP ${response.statusCode}）`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => fs.writeFile(target, Buffer.concat(chunks), error => error ? reject(error) : resolve()));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

function cleanDirectory(value) {
  return String(value || '').trim().replace(/^(["'])(.*)\1$/s, '$2').trim();
}

function saveDirectoryError(error) {
  const code = error?.code ? `（${error.code}）` : '';
  if (['EPERM', 'EACCES', 'EROFS'].includes(error?.code)) {
    return `目录不可写${code}，请确认当前用户对该文件夹有写入权限；映射盘请改用本机路径或 UNC 路径`;
  }
  return `目录检查失败${code}: ${error?.message || error}`;
}

async function checkSaveDirectory(req, res) {
  let probe = '';
  try {
    const data = JSON.parse(await readBody(req));
    const dir = cleanDirectory(data.dir);
    if (!dir) return sendJson(res, 400, { error: '请先填写图片保存地址' });
    const absoluteDir = path.resolve(dir);
    await fs.promises.mkdir(absoluteDir, { recursive: true });
    probe = path.join(absoluteDir, `.ai-workbench-write-test-${process.pid}-${Date.now()}`);
    await fs.promises.writeFile(probe, '');
    await fs.promises.unlink(probe);
    sendJson(res, 200, { ok: true, path: absoluteDir });
  } catch (error) {
    if (probe) await fs.promises.unlink(probe).catch(() => {});
    sendJson(res, 200, { ok: false, code: error?.code || '', error: saveDirectoryError(error) });
  }
}

async function saveImage(req, res) {
  try {
    const data = JSON.parse(await readBody(req));
    const source = String(data.url || '').trim();
    const dir = cleanDirectory(data.dir);
    let name = String(data.name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    if (!source || !dir) return sendJson(res, 400, { error: '缺少图片地址或保存目录' });
    if (!name) name = `generated-${Date.now()}.png`;
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += '.png';
    const absoluteDir = path.resolve(dir);
    try {
      await fs.promises.mkdir(absoluteDir, { recursive: true });
      const target = path.join(absoluteDir, name);
      await downloadToFile(source, target);
      sendJson(res, 200, { path: target, name });
    } catch (error) {
      // Mapped drives and protected folders can be unavailable to a background Node process.
      // Keep the generated image and report the fallback path instead of marking the task failed.
      if (!['EPERM', 'EACCES', 'EROFS'].includes(error?.code)) throw error;
      const fallbackDir = path.join(__dirname, 'generated');
      await fs.promises.mkdir(fallbackDir, { recursive: true });
      const fallbackTarget = path.join(fallbackDir, name);
      await downloadToFile(source, fallbackTarget);
      sendJson(res, 200, {
        path: fallbackTarget,
        name,
        fallback: true,
        requestedDir: dir,
        warning: '设置的保存目录不可写，已保存到工作台 generated 文件夹'
      });
    }
  } catch (error) {
    sendJson(res, 500, { error: `保存图片失败: ${error.message}` });
  }
}

async function storeInspirationMedia(req, res) {
  try {
    const data = JSON.parse(await readBody(req));
    const sources = Array.isArray(data.sources) ? data.sources : [data.url || data.dataUrl];
    const valid = sources.map(value => String(value || '').trim()).filter(Boolean).slice(0, 12);
    if (!valid.length) return sendJson(res, 400, { error: '缺少需要保存的图片' });
    await fs.promises.mkdir(INSPIRATION_DIR, { recursive: true });
    const urls = [];
    for (let index = 0; index < valid.length; index++) {
      const source = valid[index];
      const dataMatch = source.match(/^data:image\/(png|jpeg|jpg|webp);base64,/i);
      let extension = dataMatch ? dataMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
      try {
        if (!dataMatch) {
          const parsed = new URL(source);
          const candidate = path.extname(parsed.pathname).slice(1).toLowerCase();
          if (['png', 'jpg', 'jpeg', 'webp'].includes(candidate)) extension = candidate.replace('jpeg', 'jpg');
        }
      } catch {}
      const filename = `inspiration-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
      await downloadToFile(source, path.join(INSPIRATION_DIR, filename));
      urls.push(`/inspiration-media/${filename}`);
    }
    sendJson(res, 200, { ok: true, urls, directory: INSPIRATION_DIR });
  } catch (error) {
    sendJson(res, 500, { error: `保存灵感图片失败: ${error.message || error}` });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/video-unlock') {
    void unlockVideo(req, res);
    return;
  }
  if (req.url === '/api/soundview/voices' || req.url === '/api/soundview/settings') {
    void serveSoundView(req, res, req.url === '/api/soundview/settings');
    return;
  }
  if (/^\/api\/soundview\/media\/(text-dubbing|video-translation|video-face-swap|status)$/.test(req.url)) {
    void serveSoundViewMedia(req, res, req.url.split('/').at(-1));
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Goog-Api-Key, X-Grsai-Host, RH-TOKEN, Rh-Comfy-Auth, Rh-Identify, X-Team-Id, User-Language, client, X-Trace-Id, Trace-Id, X-Request-Id, Request-Id, traceparent',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/save-image') {
    saveImage(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/inspiration-store') {
    storeInspirationMedia(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/cache-media') {
    storeCacheMedia(req, res);
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/cache-media/')) {
    serveCacheMedia(req, res);
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/generated-media/')) {
    try {
      const filename = decodeURIComponent(req.url.split('?')[0].slice('/generated-media/'.length));
      const target = safeCacheFile(GENERATED_MEDIA_DIR, filename);
      fs.readFile(target, (error, body) => {
        if (error) return sendJson(res, 404, {error:'原图文件不存在'});
        const ext=path.extname(target).toLowerCase();
        res.writeHead(200, {'Content-Type': ext === '.webp' ? 'image/webp' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png', 'Cache-Control':'public, max-age=31536000, immutable'});
        res.end(body);
      });
    } catch { sendJson(res, 400, {error:'图片路径无效'}); }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/version') {
    handleVersion(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/check-save-dir') {
    checkSaveDirectory(req, res);
    return;
  }

  if ((req.method === 'GET' || req.method === 'PUT') && req.url.split('?')[0] === '/api/workbench-settings') {
    handleWorkbenchSettings(req, res);
    return;
  }

  if ((req.method === 'GET' || req.method === 'PUT') && req.url.split('?')[0] === '/api/workbench-state') {
    handleWorkbenchState(req, res);
    return;
  }

  if (req.method === 'GET' && req.url.split('?')[0] === '/api/storage-bridge') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><title>Storage bridge</title>');
    return;
  }

  if (req.method === 'POST' && req.url === '/api/runninghub-upload') {
    uploadRunningHubImage(req, res);
    return;
  }

  if (req.url.startsWith('/rh-api/')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => proxyToHost(req, res, req.headers['x-runninghub-region'] === 'global' ? RUNNINGHUB_GLOBAL_HOST : RUNNINGHUB_HOST, `${RUNNINGHUB_API_BASE}/${req.url.slice('/rh-api/'.length)}`, Buffer.concat(chunks)));
    return;
  }

  if (req.url.startsWith('/rh-llm/')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => proxyToHost(req, res, req.headers['x-runninghub-region'] === 'global' ? RUNNINGHUB_GLOBAL_LLM_HOST : RUNNINGHUB_LLM_HOST, `/${req.url.slice('/rh-llm/'.length)}`, Buffer.concat(chunks)));
    return;
  }

  if (req.method === 'GET' && req.url.split('?')[0] === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'ai-workbench', version: SERVICE_VERSION });
    return;
  }

  if (req.url.startsWith('/v1/')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => proxyRequest(req, res, req.url, Buffer.concat(chunks)));
    return;
  }

  if (req.url.startsWith('/v1beta/')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => proxyRequest(req, res, req.url, Buffer.concat(chunks)));
    return;
  }

  const requestedPath = req.url.split('?')[0];
  if (req.method === 'GET' && requestedPath.startsWith('/inspiration-media/')) {
    const filename = path.basename(decodeURIComponent(requestedPath.slice('/inspiration-media/'.length)));
    const mediaFile = path.join(INSPIRATION_DIR, filename);
    if (!filename || mediaFile !== path.join(INSPIRATION_DIR, filename)) return sendJson(res, 404, { error: 'Not found' });
    fs.stat(mediaFile, (error, stats) => {
      if (error || !stats.isFile()) return sendJson(res, 404, { error: 'Not found' });
      const contentTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
      res.writeHead(200, { 'Content-Type': contentTypes[path.extname(mediaFile).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
      fs.createReadStream(mediaFile).pipe(res);
    });
    return;
  }
  const requested = requestedPath === '/' ? '/index.html' : requestedPath;
  const root = path.resolve(__dirname);
  const file = path.resolve(root, `.${requested}`);
  if (!(file === root || file.startsWith(`${root}${path.sep}`))) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  fs.stat(file, (error, stats) => {
    if (error || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    const stream = fs.createReadStream(file);
    stream.on('error', streamError => {
      if (!res.headersSent) res.writeHead(500);
      res.end(`File read error: ${streamError.message}`);
    });
    stream.pipe(res);
  });
});

server.listen({ port: PORT, host: process.env.AI_WORKBENCH_HOST }, () => {
  ensureMediaCacheDirectory().catch(error => console.warn(`创建媒体缓存目录失败: ${error.message || error}`));
  console.log(`AI workbench: http://localhost:${PORT}`);
});
