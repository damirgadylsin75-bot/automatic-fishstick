'use strict';

/**
 * Минимальные заглушки сервисов Google Apps Script, чтобы гонять код бота
 * локально в Node.js: UrlFetchApp, PropertiesService, CacheService,
 * LockService, HtmlService, Utilities, Session.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE_PATH = path.join(__dirname, '..', 'src', 'Code.js');

function jsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    getResponseCode: () => status,
    getContentText: () => text,
  };
}

function geminiText(text, extra) {
  return {
    status: 200,
    body: Object.assign({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    }, extra || {}),
  };
}

function createGas(options) {
  const opts = options || {};
  const properties = Object.assign({}, opts.properties || {});
  const cacheStore = new Map();
  const calls = { telegram: [], gemini: [], logs: [] };
  let uuidCounter = 0;

  const handlers = {
    // (method, payload) => Telegram JSON
    telegram: (method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 999, is_bot: true, username: 'TestAiBot' } };
      if (method === 'getWebhookInfo') return { ok: true, result: { url: '', pending_update_count: 0 } };
      if (method === 'sendMessage') return { ok: true, result: { message_id: 1000 + calls.telegram.length } };
      return { ok: true, result: true };
    },
    // (model, body) => {status, body}
    gemini: () => geminiText('Привет! Я ответ нейросети.'),
  };

  const UrlFetchApp = {
    fetch(url, params) {
      const payload = params && params.payload ? JSON.parse(params.payload) : {};
      let m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
      if (m) {
        calls.telegram.push({ token: m[1], method: m[2], payload });
        const res = handlers.telegram(m[2], payload);
        if (res instanceof Error) throw res;
        return jsonResponse(res.ok === false && res.error_code ? res.error_code : 200, res);
      }
      m = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([^:]+):generateContent$/.exec(url);
      if (m) {
        const model = decodeURIComponent(m[1]);
        calls.gemini.push({ model, body: payload, headers: params.headers || {} });
        const res = handlers.gemini(model, payload);
        if (res instanceof Error) throw res;
        return jsonResponse(res.status, res.body);
      }
      throw new Error('Неожиданный запрос: ' + url);
    },
  };

  const scriptProperties = {
    getProperties: () => Object.assign({}, properties),
    getProperty: (k) => (k in properties ? properties[k] : null),
    setProperty: (k, v) => { properties[k] = String(v); return scriptProperties; },
    setProperties: (obj) => { Object.keys(obj).forEach((k) => { properties[k] = String(obj[k]); }); return scriptProperties; },
    deleteProperty: (k) => { delete properties[k]; return scriptProperties; },
  };

  const scriptCache = {
    get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
    put: (k, v, ttl) => {
      if (Buffer.byteLength(String(v), 'utf8') > 100 * 1024) throw new Error('Argument too large: value');
      if (ttl !== undefined && (ttl < 1 || ttl > 21600)) throw new Error('Bad expiration: ' + ttl);
      cacheStore.set(k, String(v));
    },
    remove: (k) => { cacheStore.delete(k); },
  };

  const lock = { held: false };
  const scriptLock = {
    tryLock: () => { if (lock.held) return false; lock.held = true; return true; },
    waitLock: () => { lock.held = true; },
    releaseLock: () => { lock.held = false; },
    hasLock: () => lock.held,
  };

  const pad = (n) => String(n).padStart(2, '0');
  const Utilities = {
    getUuid: () => {
      uuidCounter += 1;
      return '00000000-0000-4000-8000-' + String(uuidCounter).padStart(12, '0');
    },
    sleep: () => {},
    formatDate(date, tz, pattern) {
      const parts = {};
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
      }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
      const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
      return pattern
        .replace('dd', parts.day).replace('MM', parts.month).replace('yyyy', parts.year)
        .replace('HH', pad(Number(parts.hour) % 24)).replace('mm', parts.minute).replace('ss', parts.second)
        .replace(/^u$/, String(dow));
    },
  };

  const logger = (level) => (...args) => { calls.logs.push({ level, text: args.join(' ') }); };
  const sandbox = {
    UrlFetchApp,
    PropertiesService: { getScriptProperties: () => scriptProperties },
    CacheService: { getScriptCache: () => scriptCache },
    LockService: { getScriptLock: () => scriptLock },
    HtmlService: {
      createHtmlOutput: (html) => ({ kind: 'HtmlOutput', content: String(html || ''), getContent() { return this.content; } }),
    },
    ContentService: {
      createTextOutput: () => { throw new Error('ContentService нельзя использовать для ответа Telegram (будет 302)'); },
    },
    Session: { getScriptTimeZone: () => 'Europe/Moscow' },
    Utilities,
    console: { log: logger('log'), info: logger('info'), warn: logger('warn'), error: logger('error') },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), context, { filename: 'Code.js' });

  return {
    context,
    calls,
    properties,
    cacheStore,
    handlers,
    lock,
    /** Выполнить выражение внутри «скрипта» (доступ к функциям и константам). */
    run: (expression) => vm.runInContext(expression, context),
    fn: (name) => context[name],
    reset() {
      calls.telegram.length = 0;
      calls.gemini.length = 0;
      calls.logs.length = 0;
    },
    sent: (method) => calls.telegram.filter((c) => c.method === (method || 'sendMessage')),
  };
}

module.exports = { createGas, geminiText, CODE_PATH };
