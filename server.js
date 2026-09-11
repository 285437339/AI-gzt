const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.AI_WORKBENCH_PORT || 4173);
const UPSTREAM_HOST = process.env.GRSAI_API_HOST || 'grsai.dakka.com.cn';
const SERVICE_VERSION = '2026-09-01-portable-v5';
const ALLOWED_UPSTREAM_HOSTS = new Set(['grsai.dakka.com.cn', 'grsaiapi.com']);
const RUNNINGHUB_HOST = 'www.runninghub.cn';
const RUNNINGHUB_LLM_HOST = 'llm.runninghub.cn';
const RUNNINGHUB_API_BASE = '/openapi/v2';
const UPSTREAM_LOG_FILE = path.join(__dirname, 'upstream-error.log');
const SETTINGS_DIR = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'XieMengxiongWorkbench');
const WORKBENCH_SETTINGS_FILE = path.join(SETTINGS_DIR, 'workbench-settings.json');
const WORKBENCH_STATE_FILE = path.join(SETTINGS_DIR, 'workbench-state.json');
const INSPIRATION_DIR = path.join(SETTINGS_DIR, 'inspirations');

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
  return { version: 1, updatedAt: Number(source.updatedAt) || Date.now(), storage: output };
}

async function handleWorkbenchState(req, res) {
  try {
    if (req.method === 'GET') {
      try {
        const state = sanitizeWorkbenchState(JSON.parse(await fs.promises.readFile(WORKBENCH_STATE_FILE, 'utf8')));
        return sendJson(res, 200, { ok: true, state });
      } catch (error) {
        if (error?.code === 'ENOENT') return sendJson(res, 200, { ok: true, state: null });
        throw error;
      }
    }
    if (req.method !== 'PUT') return sendJson(res, 405, { ok: false, error: '仅支持 GET 或 PUT' });
    const state = sanitizeWorkbenchState(JSON.parse(await readBody(req))?.state);
    await fs.promises.mkdir(SETTINGS_DIR, { recursive: true });
    const temporary = `${WORKBENCH_STATE_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8');
    await fs.promises.rename(temporary, WORKBENCH_STATE_FILE);
    sendJson(res, 200, { ok: true, updatedAt: state.updatedAt });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `工作台状态读写失败: ${error.message || error}` });
  }
}

const SETTINGS_KEYS = new Set([
  'version', 'platform', 'apiUrl', 'apiKey', 'runninghubKey', 'saveDir',
  'filenameTemplate', 'startupView', 'keepRefs', 'skin', 'normalChannel',
  'datePicker', 'clearHistory', 'clearBoard', 'photoshopPath', 'assetDir',
  'psdResources', 'cacheLimit', 'updatedAt'
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

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function proxyToHost(req, res, hostname, route, body, contentType = 'application/json') {
  const payload = body || '';
  const headers = {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload),
    'Accept': 'application/json',
    'User-Agent': 'AI-Workbench/1.0'
  };
  forwardHeader(req, headers, 'authorization', 'Authorization');
  for (const name of ['rh-token', 'rh-comfy-auth', 'rh-identify', 'x-team-id', 'user-language', 'client', 'x-trace-id', 'trace-id', 'x-request-id', 'request-id', 'traceparent']) {
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
        logUpstreamError(hostname === RUNNINGHUB_LLM_HOST ? 'runninghub-llm' : 'runninghub', hostname, route, upstreamRes.statusCode, response);
      }
      res.end(response);
    });
  });
  upstream.setTimeout(600000, () => upstream.destroy(new Error('RunningHub 请求超时')));
  upstream.on('error', error => {
    logUpstreamError(hostname === RUNNINGHUB_LLM_HOST ? 'runninghub-llm-connection' : 'runninghub-connection', hostname, route, 502, '', error.message);
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
    proxyToHost(req, res, RUNNINGHUB_HOST, `${RUNNINGHUB_API_BASE}/media/upload/binary`, Buffer.concat([head, binary, tail]), `multipart/form-data; boundary=${boundary}`);
  } catch (error) {
    sendJson(res, 400, { error: `上传图片失败: ${error.message}` });
  }
}

function downloadToFile(source, target, redirects = 0) {
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
    req.on('end', () => proxyToHost(req, res, RUNNINGHUB_HOST, `${RUNNINGHUB_API_BASE}/${req.url.slice('/rh-api/'.length)}`, Buffer.concat(chunks)));
    return;
  }

  if (req.url.startsWith('/rh-llm/')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => proxyToHost(req, res, RUNNINGHUB_LLM_HOST, `/${req.url.slice('/rh-llm/'.length)}`, Buffer.concat(chunks)));
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

server.listen(PORT, () => console.log(`AI workbench: http://localhost:${PORT}`));
