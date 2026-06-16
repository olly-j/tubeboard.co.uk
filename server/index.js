import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LiveActivityStore,
  TokenRateLimiter,
  getRolloverDelayMs,
  loadConfig,
  runLiveActivityWorkerCycle,
  validateEndPayload,
  validateTokenPayload
} from './live-activity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const config = loadConfig();
const siteDir = path.resolve(projectRoot, process.env.SITE_DIR || '.');
const dataFile = path.resolve(projectRoot, config.dataFile);
const store = new LiveActivityStore(dataFile);
const rateLimiter = new TokenRateLimiter({
  limit: config.tokenRateLimit,
  windowMs: config.tokenRateWindowMs
});
const port = Number.parseInt(process.env.PORT || '4173', 10);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'POST' && url.pathname === '/api/live-activities/tokens') {
      await handleTokenRegistration(request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/live-activities/end') {
      await handleActivityEnd(request, response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/privacy.html') {
      sendRedirect(response, '/privacy');
      return;
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/privacy/') {
      sendRedirect(response, '/privacy');
      return;
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/support.html') {
      sendRedirect(response, '/support');
      return;
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/support/') {
      sendRedirect(response, '/support');
      return;
    }

    await serveStaticFile(url.pathname, response);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) {
      console.error(`Request failed: ${error.message}`);
    }
    sendJson(response, status, {
      ok: false,
      error: status >= 500 ? 'Internal service error' : error.message
    });
  }
});

server.listen(port, () => {
  console.log(`TubeBoard service listening on http://localhost:${port}`);
  console.log(`Serving static site from ${siteDir}`);
});

if (config.workerEnabled) {
  const rolloverTimers = new Map();

  const runCycle = () => {
    runLiveActivityWorkerCycle({
      store,
      config,
      scheduleRolloverPush: (record, contentState, now, workerIntervalMs) => {
        const delayMs = getRolloverDelayMs(contentState, now, workerIntervalMs);
        const timerKey = `${record.environment}:${record.activityID}`;
        const existingTimer = rolloverTimers.get(timerKey);
        if (existingTimer) {
          clearTimeout(existingTimer);
          rolloverTimers.delete(timerKey);
        }

        if (delayMs === null) {
          return;
        }

        const timer = setTimeout(() => {
          rolloverTimers.delete(timerKey);
          runCycle();
        }, delayMs);

        if (typeof timer.unref === 'function') {
          timer.unref();
        }

        rolloverTimers.set(timerKey, timer);
        console.log(`Live Activity ${record.activityID} rollover refresh scheduled in ${Math.round(delayMs / 1000)}s`);
      }
    }).catch((error) => {
      console.error(`Live Activity worker cycle failed: ${error.message}`);
    });
  };

  setTimeout(runCycle, 2_000);
  setInterval(runCycle, config.workerIntervalMs);
}

async function handleTokenRegistration(request, response) {
  const ipAddress = getClientIp(request);
  const body = await readJsonBody(request);
  const validation = validateTokenPayload(body);

  if (!validation.ok) {
    sendJson(response, 400, { ok: false, errors: validation.errors });
    return;
  }

  const rateKey = `${validation.value.installID}:${ipAddress}`;
  if (!rateLimiter.check(rateKey)) {
    sendJson(response, 429, { ok: false, error: 'Too many token updates' });
    return;
  }

  await store.upsertToken(validation.value);
  sendJson(response, 200, { ok: true });
}

async function handleActivityEnd(request, response) {
  const body = await readJsonBody(request);
  const validation = validateEndPayload(body);

  if (!validation.ok) {
    sendJson(response, 400, { ok: false, errors: validation.errors });
    return;
  }

  await store.endActivity(validation.value);
  sendJson(response, 200, { ok: true });
}

async function readJsonBody(request) {
  const contentType = request.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    const error = new Error('Content-Type must be application/json');
    error.status = 400;
    throw error;
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) {
      const error = new Error('Request body is too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.status = 400;
    throw error;
  }
}

async function serveStaticFile(urlPathname, response) {
  const cleanPath = decodeURIComponent(urlPathname.split('?')[0]);
  const relativePath = getStaticRelativePath(cleanPath);
  const filePath = path.resolve(siteDir, relativePath);
  const relativeToSite = path.relative(siteDir, filePath);

  if (relativeToSite.startsWith('..') || path.isAbsolute(relativeToSite)) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  try {
    const stats = await fs.stat(filePath);
    const finalPath = stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    const file = await fs.readFile(finalPath);
    response.writeHead(200, {
      'content-type': getContentType(finalPath),
      'cache-control': getCacheControl(finalPath)
    });
    response.end(file);
  } catch {
    sendText(response, 404, 'Not found');
  }
}

function getStaticRelativePath(cleanPath) {
  if (cleanPath === '/') {
    return 'index.html';
  }

  if (cleanPath === '/privacy') {
    return 'privacy.html';
  }

  if (cleanPath === '/support') {
    return 'support.html';
  }

  return cleanPath.replace(/^\/+/, '');
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(text);
}

function sendRedirect(response, location) {
  response.writeHead(301, {
    location,
    'cache-control': 'public, max-age=300'
  });
  response.end();
}

function getClientIp(request) {
  const forwardedFor = request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return request.socket.remoteAddress || 'unknown';
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };

  return types[extension] || 'application/octet-stream';
}

function getCacheControl(filePath) {
  return /\.(png|jpg|jpeg|svg|ttf|woff2?)$/i.test(filePath)
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=300';
}
