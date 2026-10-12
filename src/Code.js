/**
 * ════════════════════════════════════════════════════════════════════
 *  🤖 Telegram-бот с нейросетью Gemini на Google Apps Script
 * ════════════════════════════════════════════════════════════════════
 *
 *  Бот бесплатно работает на серверах Google. Telegram присылает каждое
 *  сообщение прямо в этот скрипт (вебхук), скрипт спрашивает нейросеть
 *  Gemini и отправляет ответ. Автозапуски (триггеры) не используются,
 *  поэтому лимит Apps Script «90 минут в день на триггеры» нас не касается —
 *  бот отвечает круглосуточно.
 *
 *  Пошаговая инструкция по запуску — в README.md.
 *
 *  Функции, которые можно запускать вручную из редактора (кнопка «Выполнить»):
 *    setup()   — проверить ключи и подключить бота к Telegram
 *    status()  — показать состояние бота и последние ошибки
 *    stopBot() — отключить бота от Telegram
 *
 *  ⚠️ Токены и ключи НЕ пиши в код! Их место — в «Свойствах скрипта»:
 *     ⚙️ «Настройки проекта» → «Свойства скрипта».
 */

// ═══════════════════════════ НАСТРОЙКИ ═══════════════════════════

/** Характер и правила бота. Можно заменить свойством скрипта SYSTEM_PROMPT. */
const DEFAULT_SYSTEM_PROMPT = [
  'Ты — умный и дружелюбный ИИ-ассистент в Telegram.',
  'Отвечай на языке собеседника (по умолчанию — по-русски).',
  'Пиши понятно и по делу, без воды. Если просят подробнее — объясняй подробно, с примерами.',
  'Если не знаешь ответа или не уверен — честно так и скажи, ничего не выдумывай.',
  'Оформление: Telegram понимает только простой Markdown — **жирный**, *курсив*, `код`, ' +
    'блоки кода ``` и списки. Таблицы не используй.',
].join('\n');

/**
 * Настройки по умолчанию. Любую из них можно переопределить в «Свойствах
 * скрипта» (то же имя) — тогда даже не нужно заново развертывать код.
 */
const DEFAULTS = {
  // Основная модель Gemini и запасные (через запятую) — на случай, если у
  // основной закончился бесплатный лимит или она перегружена.
  GEMINI_MODEL: 'gemini-3.8-flash',
  GEMINI_FALLBACK_MODELS: 'gemini-3.6-flash, gemini-3.5-flash-lite, gemini-2.5-flash, gemini-flash-latest',
  // Насколько глубоко модель «думает» перед ответом: minimal | low | medium | high | default.
  // low — быстрые ответы; high — умнее, но заметно медленнее.
  THINKING_LEVEL: 'low',
  // Пусто = значение модели по умолчанию (для Gemini 3 Google советует его не трогать).
  TEMPERATURE: '',
  // Максимальная длина ответа в токенах (включая «размышления» модели).
  MAX_OUTPUT_TOKENS: '8192',
  // Сколько последних сообщений бот помнит в каждом чате (0 — без памяти).
  HISTORY_MESSAGES: '20',
  // Сколько часов хранится память после последнего сообщения (максимум 6).
  HISTORY_TTL_HOURS: '6',
  // Кому можно пользоваться ботом: ID или @username через запятую. Пусто — всем.
  ALLOWED_USERS: '',
  // Часовой пояс для текущей даты, которую видит бот (например, Europe/Moscow).
  // Пусто — часовой пояс проекта.
  TIMEZONE: '',
  SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
};

/** Команды для меню бота в Telegram. */
const BOT_COMMANDS = [
  { command: 'new', description: 'Начать новый диалог (забыть контекст)' },
  { command: 'help', description: 'Что умеет бот' },
  { command: 'id', description: 'Показать мой Telegram ID' },
];

// Технические константы — трогать не нужно.
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const TELEGRAM_CHUNK = 3800; // длина одного сообщения (лимит Telegram — 4096 символов)
const TELEGRAM_MAX_TEXT = 4096;
const MAX_STORED_CHARS = 6000; // максимум символов одного сообщения в памяти
const MAX_HISTORY_CHARS = 20000; // максимум символов всей истории, которую видит модель
const GEMINI_TIME_BUDGET_MS = 150000; // не перебирать запасные модели дольше 2,5 минут
const CACHE_MAX_TTL = 21600; // 6 часов — ограничение CacheService
const BLOCK_REASONS = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'];

// ═══════════════════════════ ТОЧКИ ВХОДА ═══════════════════════════

/** Сюда Telegram присылает каждое новое сообщение. */
function doPost(e) {
  try {
    handleWebhook_(e);
  } catch (err) {
    console.error('Ошибка при обработке сообщения: ' + errorText_(err));
  }
  // ВАЖНО: отвечаем через HtmlService, а не ContentService. ContentService
  // отдаёт редирект 302 — Telegram считает доставку неудачной и присылает
  // одно и то же сообщение снова и снова.
  return HtmlService.createHtmlOutput('ok');
}

/** Открыть адрес веб-приложения в браузере — быстрая проверка, что всё развернуто. */
function doGet() {
  return HtmlService.createHtmlOutput(
    '<meta charset="utf-8"><h2>🤖 Бот работает</h2><p>Пиши ему в Telegram.</p>'
  );
}

// ═══════════════════════ ОБРАБОТКА СООБЩЕНИЙ ═══════════════════════

function handleWebhook_(e) {
  const cfg = getConfig_();
  if (!cfg.telegramToken) {
    console.error('Не задан TELEGRAM_TOKEN в свойствах скрипта.');
    return;
  }
  const params = (e && e.parameter) || {};
  if (!cfg.webhookSecret || params.secret !== cfg.webhookSecret) {
    console.warn('Отклонён запрос с неверным секретом (это не Telegram, либо нужно снова запустить setup()).');
    return;
  }
  const body = e && e.postData && e.postData.contents;
  if (!body) return;

  let update;
  try {
    update = JSON.parse(body);
  } catch (err) {
    console.warn('Пришёл запрос не в формате JSON — пропускаю.');
    return;
  }
  if (!update || update.update_id === undefined) return;
  if (!rememberUpdate_(update.update_id)) {
    console.log('Повторная доставка апдейта ' + update.update_id + ' — пропускаю.');
    return;
  }
  handleUpdate_(update, cfg);
}

function handleUpdate_(update, cfg) {
  const msg = update.message;
  if (!msg || !msg.chat) return;
  // Сообщения других ботов игнорируем (анонимных админов групп — нет).
  if (msg.from && msg.from.is_bot && !msg.sender_chat) return;

  const isPrivate = msg.chat.type === 'private';
  const text = typeof msg.text === 'string' ? msg.text : '';

  // В группах отвечаем, только когда обращаются к боту.
  if (!isPrivate && !isAddressedToBot_(msg, cfg)) return;

  if (!isAllowed_(msg, cfg)) {
    if (isPrivate) {
      sendHtml_(cfg, msg,
        '⛔ Извини, это приватный бот.\nТвой Telegram ID: <code>' + (msg.from ? msg.from.id : '?') +
        '</code> — перешли его владельцу бота, если нужен доступ.');
    }
    return;
  }

  if (!text) {
    if (hasMedia_(msg)) {
      sendHtml_(cfg, msg, '🙂 Пока я понимаю только текст. Напиши свой вопрос словами.');
    }
    return;
  }

  const command = parseCommand_(text);
  if (command) {
    runCommand_(command, msg, cfg);
    return;
  }

  const question = stripMention_(text, cfg.botUsername).trim();
  if (!question) {
    sendHtml_(cfg, msg, 'Слушаю! Напиши свой вопрос 🙂');
    return;
  }
  answerWithAi_(msg, question, cfg);
}

/** В группе: это команда, ответ на сообщение бота или упоминание @бота? */
function isAddressedToBot_(msg, cfg) {
  const text = msg.text || msg.caption || '';
  const username = (cfg.botUsername || '').toLowerCase();
  const reply = msg.reply_to_message;
  if (reply && reply.from && cfg.botId && String(reply.from.id) === String(cfg.botId)) return true;

  const command = parseCommand_(text);
  if (command) return !command.target || command.target === username;

  return !!username && text.toLowerCase().indexOf('@' + username) !== -1;
}

function isAllowed_(msg, cfg) {
  if (!cfg.allowed.length) return true;
  const candidates = [String(msg.chat.id)];
  if (msg.from) {
    candidates.push(String(msg.from.id));
    if (msg.from.username) candidates.push(String(msg.from.username).toLowerCase());
  }
  return candidates.some(function (c) { return cfg.allowed.indexOf(c) !== -1; });
}

function hasMedia_(msg) {
  return ['photo', 'voice', 'audio', 'video', 'video_note', 'document', 'sticker', 'animation',
    'location', 'contact', 'poll'].some(function (k) { return msg[k] !== undefined; });
}

function parseCommand_(text) {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), target: m[2] ? m[2].toLowerCase() : '', args: (m[3] || '').trim() };
}

function runCommand_(command, msg, cfg) {
  const name = escapeHtml_(senderName_(msg) || 'друг');
  const mention = cfg.botUsername ? '@' + escapeHtml_(cfg.botUsername) : 'меня';
  const groupHint = msg.chat.type === 'private'
    ? ''
    : '\n\nВ группе упоминай ' + mention + ' или отвечай на мои сообщения.';

  switch (command.name) {
    case 'start':
      sendHtml_(cfg, msg,
        '👋 Привет, ' + name + '!\n\n' +
        'Я бот с нейросетью <b>Gemini</b>. Просто напиши мне любой вопрос — и я отвечу.\n' +
        'Я помню наш разговор, так что можно задавать уточняющие вопросы.\n\n' +
        '/new — начать новый диалог\n/help — помощь' + groupHint);
      return;

    case 'help':
      sendHtml_(cfg, msg,
        '🤖 <b>Что я умею</b>\n' +
        '• отвечать на вопросы и объяснять сложное простыми словами\n' +
        '• помогать с учёбой, текстами, переводами и кодом\n' +
        '• поддерживать диалог — ' + memoryDescription_(cfg) + '\n\n' +
        '<b>Команды</b>\n' +
        '/new — забыть контекст и начать заново\n' +
        '/id — показать твой Telegram ID\n' +
        '/help — эта справка' + groupHint);
      return;

    case 'new':
    case 'reset':
    case 'clear':
      clearHistory_(historyKey_(msg));
      sendHtml_(cfg, msg, '🧹 Готово! Начинаем новый диалог — прошлый контекст забыт.');
      return;

    case 'id':
      sendHtml_(cfg, msg,
        '🪪 Твой ID: <code>' + (msg.from ? msg.from.id : '?') + '</code>\n' +
        'ID этого чата: <code>' + msg.chat.id + '</code>');
      return;

    default:
      if (msg.chat.type === 'private' || command.target) {
        sendHtml_(cfg, msg, 'Не знаю такой команды 🤔 Список команд — /help');
      }
  }
}

function memoryDescription_(cfg) {
  if (cfg.historyMessages <= 0) return 'память отключена, каждое сообщение отдельно';
  const hours = Math.round(cfg.historyTtlSec / 360) / 10;
  const n = cfg.historyMessages;
  return 'я помню последние ' + n + ' ' + pluralRu_(n, 'сообщение', 'сообщения', 'сообщений') +
    ' (память живёт ' + String(hours).replace('.', ',') + ' ч после последнего сообщения)';
}

/** Склонение: 1 сообщение, 2 сообщения, 5 сообщений. */
function pluralRu_(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function answerWithAi_(msg, question, cfg) {
  const key = historyKey_(msg);
  sendChatAction_(cfg, msg, 'typing');

  let userTurn = question;
  if (msg.chat.type !== 'private') userTurn = senderName_(msg) + ': ' + userTurn;
  const quoted = quotedText_(msg, cfg);
  if (quoted) userTurn = '(В ответ на сообщение: «' + clip_(quoted, 1500) + '»)\n' + userTurn;

  const history = cfg.historyMessages > 0 ? loadHistory_(key) : [];
  const contents = history.map(function (item) {
    return { role: item.r === 'u' ? 'user' : 'model', parts: [{ text: item.t }] };
  });
  contents.push({ role: 'user', parts: [{ text: userTurn }] });

  let result;
  try {
    result = askGemini_(contents, buildSystemPrompt_(cfg, msg), cfg);
  } catch (err) {
    console.error('Gemini не ответил: [' + (err.kind || 'error') + '] ' + err.message);
    sendHtml_(cfg, msg, escapeHtml_(userMessageForError_(err)));
    return;
  }

  if (cfg.historyMessages > 0) appendHistory_(key, userTurn, result.text, cfg);
  sendMarkdown_(cfg, msg, result.text);
}

/** Текст сообщения, на которое ответил пользователь (кроме сообщений самого бота). */
function quotedText_(msg, cfg) {
  if (msg.quote && msg.quote.text) return msg.quote.text;
  const reply = msg.reply_to_message;
  if (!reply) return '';
  if (reply.from && cfg.botId && String(reply.from.id) === String(cfg.botId)) return '';
  return reply.text || reply.caption || '';
}

function senderName_(msg) {
  if (msg.sender_chat && msg.sender_chat.title) return msg.sender_chat.title;
  const from = msg.from || {};
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return full || from.username || 'Пользователь';
}

function stripMention_(text, botUsername) {
  if (!botUsername) return text;
  const re = new RegExp('@' + botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
  return text.replace(re, ' ').replace(/[ \t]{2,}/g, ' ');
}

function buildSystemPrompt_(cfg, msg) {
  const lines = [cfg.systemPrompt, '', 'Сейчас: ' + nowString_(cfg.timezone) + '.'];
  if (msg && msg.chat) {
    if (msg.chat.type === 'private') {
      lines.push('Собеседника зовут ' + senderName_(msg) + '.');
    } else {
      lines.push('Это групповой чат' + (msg.chat.title ? ' «' + msg.chat.title + '»' : '') +
        '. Перед каждым сообщением пользователя указано его имя.');
    }
  }
  return lines.join('\n');
}

function nowString_(timezone) {
  const now = new Date();
  const days = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  try {
    const dayIndex = Number(Utilities.formatDate(now, timezone, 'u')) - 1;
    return Utilities.formatDate(now, timezone, 'dd.MM.yyyy HH:mm') +
      ' (' + (days[dayIndex] || '') + ', часовой пояс ' + timezone + ')';
  } catch (err) {
    return now.toISOString();
  }
}

function userMessageForError_(err) {
  switch (err && err.kind) {
    case 'quota':
      return '⏳ Нейросеть сейчас занята: закончился бесплатный лимит запросов. Попробуй чуть позже.';
    case 'blocked':
      return '🙈 Не могу ответить на это сообщение: сработал фильтр безопасности нейросети. Попробуй переформулировать.';
    case 'auth':
    case 'config':
    case 'location':
      return '⚙️ Бот настроен неправильно (проблема с ключом Gemini). Владельцу бота: запусти status() ' +
        'в редакторе Apps Script и посмотри журнал.';
    default:
      return '😔 Нейросеть временно недоступна. Попробуй ещё раз через минуту.';
  }
}

// ═══════════════════════════ НЕЙРОСЕТЬ GEMINI ═══════════════════════════

/**
 * Спрашивает Gemini. Если основная модель не ответила (лимит, перегрузка,
 * модель отключена), по очереди пробует запасные.
 * @return {{text: string, model: string}}
 */
function askGemini_(contents, systemText, cfg) {
  if (!cfg.geminiKey) throw aiError_('config', 'Не задан GEMINI_API_KEY в свойствах скрипта');
  const started = Date.now();
  let lastError = aiError_('unavailable', 'Не задано ни одной модели Gemini');

  for (let i = 0; i < cfg.models.length; i++) {
    if (i > 0 && Date.now() - started > GEMINI_TIME_BUDGET_MS) break;
    const model = cfg.models[i];
    let res = callGeminiModel_(model, contents, systemText, cfg, true);
    if (!res.ok && res.retryWithoutThinking) {
      res = callGeminiModel_(model, contents, systemText, cfg, false);
    }
    if (res.ok) {
      if (i > 0) console.log('Ответила запасная модель ' + model);
      return { text: res.text, model: model };
    }
    console.warn('Модель ' + model + ' не ответила: [' + res.kind + '] ' + res.message);
    lastError = aiError_(res.kind, res.message);
    if (!res.tryNext) break;
  }
  throw lastError;
}

function callGeminiModel_(model, contents, systemText, cfg, withThinking) {
  const generationConfig = {};
  if (cfg.maxOutputTokens > 0) generationConfig.maxOutputTokens = cfg.maxOutputTokens;
  if (cfg.temperature !== null) generationConfig.temperature = cfg.temperature;
  const thinking = withThinking ? thinkingConfigFor_(model, cfg.thinkingLevel) : null;
  if (thinking) generationConfig.thinkingConfig = thinking;

  const body = { contents: contents, generationConfig: generationConfig };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  let response;
  try {
    response = UrlFetchApp.fetch(GEMINI_API_BASE + encodeURIComponent(model) + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': cfg.geminiKey },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
  } catch (err) {
    return { ok: false, kind: 'network', tryNext: true, message: String((err && err.message) || err) };
  }

  const status = response.getResponseCode();
  const raw = response.getContentText();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (ignored) {
    data = null;
  }
  if (status === 200) return parseGeminiAnswer_(data);

  const message = (data && data.error && data.error.message) || ('HTTP ' + status + ': ' + String(raw).slice(0, 200));
  if (status === 429) return { ok: false, kind: 'quota', tryNext: true, message: message };
  // 401/403 и ошибки ключа — проблема ключа или проекта, другие модели не помогут.
  if (status === 401 || status === 403 ||
      /API key not valid|API_KEY_INVALID|API key expired|API key was reported|invalid api key/i.test(message)) {
    return { ok: false, kind: 'auth', tryNext: false, message: message };
  }
  if (/location is not supported/i.test(message)) return { ok: false, kind: 'location', tryNext: false, message: message };
  // Модель могла не принять настройки «размышлений» — повторим без них.
  if (status === 400 && thinking) return { ok: false, kind: 'bad_request', retryWithoutThinking: true, message: message };
  if (status === 404) return { ok: false, kind: 'model', tryNext: true, message: message };
  return { ok: false, kind: status >= 500 ? 'unavailable' : 'bad_request', tryNext: true, message: message };
}

function parseGeminiAnswer_(data) {
  const candidate = data && data.candidates && data.candidates[0];
  if (!candidate) {
    const reason = data && data.promptFeedback && data.promptFeedback.blockReason;
    if (reason) return { ok: false, kind: 'blocked', tryNext: false, message: 'Запрос заблокирован: ' + reason };
    return { ok: false, kind: 'empty', tryNext: true, message: 'Пустой ответ модели' };
  }
  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts
    .filter(function (p) { return p && typeof p.text === 'string' && !p.thought; })
    .map(function (p) { return p.text; })
    .join('')
    .trim();
  if (text) {
    return { ok: true, text: candidate.finishReason === 'MAX_TOKENS' ? text + '\n\n…' : text };
  }
  if (BLOCK_REASONS.indexOf(candidate.finishReason) !== -1) {
    return { ok: false, kind: 'blocked', tryNext: false, message: 'Ответ заблокирован: ' + candidate.finishReason };
  }
  return { ok: false, kind: 'empty', tryNext: true, message: 'Пустой ответ модели (finishReason=' + candidate.finishReason + ')' };
}

/** Настройки «размышлений»: у Gemini 2.5 — thinkingBudget, у Gemini 3 и новее — thinkingLevel. */
function thinkingConfigFor_(model, level) {
  const lvl = String(level || '').toLowerCase();
  if (!lvl || lvl === 'default' || lvl === 'auto') return null;
  const name = String(model).toLowerCase();
  if (/gemini-2\.5/.test(name)) {
    if (/pro/.test(name)) return null; // у 2.5 Pro размышления не отключаются
    if (lvl === 'off' || lvl === 'none' || lvl === 'minimal' || lvl === 'low') return { thinkingBudget: 0 };
    if (lvl === 'medium') return { thinkingBudget: 2048 };
    if (lvl === 'high') return { thinkingBudget: -1 };
    return null;
  }
  const mapped = lvl === 'off' || lvl === 'none' ? 'minimal' : lvl;
  return ['minimal', 'low', 'medium', 'high'].indexOf(mapped) !== -1 ? { thinkingLevel: mapped } : null;
}

function aiError_(kind, message) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

// ═══════════════════════════ ПАМЯТЬ ДИАЛОГА ═══════════════════════════
// История хранится в CacheService: быстро, бесплатно и без лишних разрешений.
// Память живёт до 6 часов после последнего сообщения, /new очищает её сразу.

function historyKey_(msg) {
  const thread = msg.is_topic_message && msg.message_thread_id ? ':' + msg.message_thread_id : '';
  return 'h:' + msg.chat.id + thread;
}

function loadHistory_(key) {
  const raw = CacheService.getScriptCache().get(key);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(function (x) { return x && typeof x.t === 'string'; }) : [];
  } catch (err) {
    return [];
  }
}

function appendHistory_(key, userText, modelText, cfg) {
  withScriptLock_(function () {
    const history = loadHistory_(key);
    history.push({ r: 'u', t: clip_(userText, MAX_STORED_CHARS) }, { r: 'm', t: clip_(modelText, MAX_STORED_CHARS) });
    let trimmed = trimHistory_(history, cfg.historyMessages, MAX_HISTORY_CHARS);
    const cache = CacheService.getScriptCache();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        cache.put(key, JSON.stringify(trimmed), cfg.historyTtlSec);
        return;
      } catch (err) {
        // Слишком большое значение для кэша — сохраняем вдвое меньше истории.
        trimmed = trimmed.slice(Math.min(trimmed.length, Math.max(2, Math.floor(trimmed.length / 4) * 2)));
      }
    }
    console.warn('Не удалось сохранить историю диалога');
  });
}

function trimHistory_(history, maxMessages, maxChars) {
  if (maxMessages <= 0) return [];
  let start = Math.max(0, history.length - maxMessages);
  if (start % 2 === 1) start++; // храним пары «вопрос — ответ»
  let out = history.slice(start);
  let total = out.reduce(function (sum, x) { return sum + x.t.length; }, 0);
  while (out.length > 2 && total > maxChars) {
    total -= out[0].t.length + out[1].t.length;
    out = out.slice(2);
  }
  return out;
}

function clearHistory_(key) {
  CacheService.getScriptCache().remove(key);
}

/** Защита от повторной доставки: Telegram может прислать одно сообщение дважды. */
function rememberUpdate_(updateId) {
  const key = 'u:' + updateId;
  return withScriptLock_(function () {
    const cache = CacheService.getScriptCache();
    if (cache.get(key)) return false;
    cache.put(key, '1', CACHE_MAX_TTL);
    return true;
  });
}

function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(10000);
  } catch (err) {
    console.warn('Не удалось взять блокировку: ' + err);
  }
  try {
    return fn();
  } finally {
    if (locked) {
      try {
        lock.releaseLock();
      } catch (ignored) {
        // ничего страшного
      }
    }
  }
}

// ═══════════════════════════ TELEGRAM API ═══════════════════════════

/** Вызов метода Telegram Bot API. При флуд-лимите (429) один раз ждёт и повторяет. */
function tg_(cfg, method, payload) {
  let data = tgRequest_(cfg, method, payload);
  if (!data.ok && data.error_code === 429) {
    const wait = Number(data.parameters && data.parameters.retry_after) || 1;
    if (wait <= 10) {
      Utilities.sleep(wait * 1000);
      data = tgRequest_(cfg, method, payload);
    }
  }
  if (!data.ok) console.warn('Telegram ' + method + ': ' + data.error_code + ' ' + data.description);
  return data;
}

function tgRequest_(cfg, method, payload) {
  let response;
  try {
    response = UrlFetchApp.fetch(TELEGRAM_API_BASE + cfg.telegramToken + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true,
    });
  } catch (err) {
    // Текст ошибки без адреса запроса — в адресе есть токен.
    return { ok: false, description: 'сетевая ошибка: ' + String((err && err.message) || err).replace(/bot\d+:[\w-]+/g, 'bot***') };
  }
  try {
    return JSON.parse(response.getContentText());
  } catch (err) {
    return { ok: false, error_code: response.getResponseCode(), description: 'HTTP ' + response.getResponseCode() };
  }
}

/** Куда отвечать: тот же чат, та же тема форума; в группах — ответом на сообщение. */
function replyTarget_(msg, quote) {
  const target = { chat_id: msg.chat.id };
  if (msg.is_topic_message && msg.message_thread_id) target.message_thread_id = msg.message_thread_id;
  if (quote && msg.chat.type !== 'private' && msg.message_id) {
    target.reply_parameters = { message_id: msg.message_id, allow_sending_without_reply: true };
  }
  return target;
}

function sendChatAction_(cfg, msg, action) {
  const payload = { chat_id: msg.chat.id, action: action };
  if (msg.is_topic_message && msg.message_thread_id) payload.message_thread_id = msg.message_thread_id;
  tg_(cfg, 'sendChatAction', payload);
}

/** Отправить готовый HTML (для служебных сообщений бота). */
function sendHtml_(cfg, msg, html) {
  return tg_(cfg, 'sendMessage', Object.assign(replyTarget_(msg, true), {
    text: html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  }));
}

/** Отправить ответ нейросети: Markdown → HTML Telegram, длинные ответы — частями. */
function sendMarkdown_(cfg, msg, markdown) {
  const chunks = splitForTelegram_(markdown, TELEGRAM_CHUNK);
  for (let i = 0; i < chunks.length; i++) {
    const target = replyTarget_(msg, i === 0);
    const plain = stripMarkdown_(chunks[i]) || '…';
    let html = markdownToTelegramHtml_(chunks[i]);
    if (!html || !isValidTelegramHtml_(html) || visibleLength_(html) > TELEGRAM_MAX_TEXT) {
      html = escapeHtml_(plain);
    }
    const res = tg_(cfg, 'sendMessage', Object.assign({}, target, {
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }));
    if (!res.ok && res.error_code === 400) {
      // Telegram не понял разметку — отправляем обычным текстом.
      tg_(cfg, 'sendMessage', Object.assign({}, target, {
        text: plain.slice(0, TELEGRAM_MAX_TEXT),
        link_preview_options: { is_disabled: true },
      }));
    }
  }
}

// ═══════════════════ ФОРМАТИРОВАНИЕ (Markdown → HTML) ═══════════════════

/** Переводит Markdown из ответа нейросети в HTML, который понимает Telegram. */
function markdownToTelegramHtml_(markdown) {
  const stash = [];
  const keep = function (html) { return '\uE000' + (stash.push(html) - 1) + '\uE001'; };
  let s = String(markdown).replace(/\r\n?/g, '\n').replace(/[\uE000\uE001]/g, '');

  // 1. Блоки кода ```lang … ``` (включая незакрытый блок в конце).
  s = s.replace(/^[ \t]*```([^\n`]*)\n([\s\S]*?)\n?^[ \t]*```[ \t]*$/gm, function (_, info, code) {
    return keep(codeBlockHtml_(code, info));
  });
  s = s.replace(/^[ \t]*```([^\n`]*)\n([\s\S]*)$/m, function (_, info, code) {
    return keep(codeBlockHtml_(code, info));
  });
  s = s.replace(/```([^`\n]+)```/g, function (_, code) { return keep('<code>' + escapeHtml_(code) + '</code>'); });

  // 2. Таблицы → моноширинный блок (Telegram не умеет таблицы).
  s = convertTables_(s, keep);

  // 3. Встроенный код, ссылки и голые URL — их содержимое не форматируем.
  s = s.replace(/`([^`\n]+)`/g, function (_, code) { return keep('<code>' + escapeHtml_(code) + '</code>'); });
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
    return keep('<a href="' + escapeAttr_(url) + '">' + escapeHtml_(label) + '</a>');
  });
  s = s.replace(/https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g, function (url) { return keep(escapeHtml_(url)); });

  // 4. Экранируем всё остальное.
  s = escapeHtml_(s);

  // 5. Блочная разметка: заголовки, разделители, списки, цитаты.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t#]*$/gm, '<b>$1</b>');
  s = s.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '──────────');
  s = s.replace(/^([ \t]*)[*+-][ \t]+/gm, '$1• ');
  s = s.replace(/(?:^&gt;[^\n]*(?:\n|$))+/gm, function (block) {
    const inner = block.replace(/\n$/, '').replace(/^&gt;[ \t]?/gm, '');
    return '<blockquote>' + inner + '</blockquote>' + (/\n$/.test(block) ? '\n' : '');
  });

  // 6. Строчная разметка: жирный, курсив, зачёркнутый, спойлер.
  //    (__текст__ намеренно не трогаем — иначе ломаются имена вроде __init__.py)
  s = s.replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, '<b><i>$1</i></b>');
  s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|(?=\S)([^\n]*?\S)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
  s = s.replace(/(^|[^\p{L}\p{N}*\\])\*(?![\s*])([^*\n]*?[^\s*\\])\*(?![\p{L}\p{N}*])/gmu, '$1<i>$2</i>');
  s = s.replace(/(^|[^\p{L}\p{N}_\\])_(?![\s_])([^_\n]*?[^\s_\\])_(?![\p{L}\p{N}_])/gmu, '$1<i>$2</i>');
  // Экранированные символы Markdown (\* \_ \# …) показываем без обратной косой черты.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, '$1');

  // 7. Возвращаем спрятанные куски.
  s = s.replace(/\uE000(\d+)\uE001/g, function (_, i) { return stash[Number(i)]; });
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function codeBlockHtml_(code, info) {
  const lang = String(info || '').trim().split(/\s+/)[0].replace(/[^\w#+.-]/g, '');
  const body = escapeHtml_(String(code).replace(/\n+$/, ''));
  return lang
    ? '<pre><code class="language-' + lang + '">' + body + '</code></pre>'
    : '<pre>' + body + '</pre>';
}

function convertTables_(s, keep) {
  const lines = s.split('\n');
  const out = [];
  const isRow = function (line) { return /^\s*\|?.*\|.*\|?\s*$/.test(line) && line.indexOf('|') !== -1; };
  const isSeparator = function (line) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line); };
  for (let i = 0; i < lines.length;) {
    if (isRow(lines[i]) && !isSeparator(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const rows = [splitTableRow_(lines[i])];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j]) && !isSeparator(lines[j])) {
        rows.push(splitTableRow_(lines[j]));
        j++;
      }
      out.push(keep('<pre>' + escapeHtml_(renderTable_(rows)) + '</pre>'));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}

function splitTableRow_(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) {
    return cell.trim().replace(/\*\*|__|`/g, '').replace(/<br\s*\/?>/gi, ' ');
  });
}

function renderTable_(rows) {
  const columns = Math.max.apply(null, rows.map(function (r) { return r.length; }));
  const widths = [];
  for (let c = 0; c < columns; c++) {
    widths.push(Math.max.apply(null, rows.map(function (r) { return Array.from(r[c] || '').length; })));
  }
  const pad = function (text, width) { return text + new Array(Math.max(0, width - Array.from(text).length) + 1).join(' '); };
  const render = function (r) {
    return widths.map(function (w, c) { return pad(r[c] || '', w); }).join(' │ ').replace(/\s+$/, '');
  };
  const lines = [render(rows[0]), widths.map(function (w) { return new Array(w + 1).join('─'); }).join('─┼─')];
  for (let i = 1; i < rows.length; i++) lines.push(render(rows[i]));
  return lines.join('\n');
}

/** Делит длинный текст на части для Telegram, не ломая блоки кода. */
function splitForTelegram_(text, limit) {
  limit = limit || TELEGRAM_CHUNK;
  const pieces = [];
  let rest = String(text);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    let skip = 2;
    if (cut < limit / 2) { cut = rest.lastIndexOf('\n', limit); skip = 1; }
    if (cut < limit / 2) { cut = rest.lastIndexOf(' ', limit); skip = 1; }
    if (cut < limit / 2) {
      cut = limit;
      skip = 0;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xD800 && code <= 0xDBFF) cut--; // не разрезаем эмодзи пополам
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  if (rest.trim()) pieces.push(rest);

  // Если блок кода разрезан — закрываем его в конце части и открываем в следующей.
  const result = [];
  let openFence = null;
  pieces.forEach(function (piece) {
    let p = openFence !== null ? '```' + openFence + '\n' + piece : piece;
    let inside = null;
    const fence = /^[ \t]*```([^\n`]*)$/gm;
    let m;
    while ((m = fence.exec(p)) !== null) {
      inside = inside === null ? (m[1] || '').trim().split(/\s+/)[0] : null;
    }
    if (inside !== null) p += '\n```';
    openFence = inside;
    result.push(p);
  });
  return result.length ? result : [''];
}

/** Проверяет, что все HTML-теги правильно вложены (иначе Telegram отклонит сообщение). */
function isValidTelegramHtml_(html) {
  const stack = [];
  const re = /<(\/?)([a-z][a-z-]*)(?:\s[^>]*)?>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[2].toLowerCase();
    if (!m[1]) stack.push(tag);
    else if (stack.pop() !== tag) return false;
  }
  return stack.length === 0;
}

function visibleLength_(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt|quot);/g, '_').length;
}

/** Убирает Markdown — запасной вариант, если разметка не получилась. */
function stripMarkdown_(markdown) {
  return String(markdown)
    .replace(/^[ \t]*```[^\n]*$/gm, '')
    .replace(/\*\*\*|\*\*|~~/g, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^([ \t]*)[*+-][ \t]+/gm, '$1• ')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr_(text) {
  return escapeHtml_(text).replace(/"/g, '&quot;');
}

// ═══════════════════════════ НАСТРОЙКИ И УТИЛИТЫ ═══════════════════════════

function getConfig_() {
  const props = PropertiesService.getScriptProperties().getProperties() || {};
  const read = function (key) {
    const value = props[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    return DEFAULTS[key] !== undefined ? String(DEFAULTS[key]) : '';
  };
  const number = function (key, min, max) {
    const parsed = Number(read(key).replace(',', '.'));
    const value = isFinite(parsed) ? parsed : Number(DEFAULTS[key]);
    return Math.min(max, Math.max(min, value));
  };
  const temperatureRaw = read('TEMPERATURE').replace(',', '.');
  const models = [];
  [read('GEMINI_MODEL')].concat(splitList_(read('GEMINI_FALLBACK_MODELS'))).forEach(function (m) {
    const name = m.replace(/^models\//, '');
    if (name && models.indexOf(name) === -1) models.push(name);
  });
  let timezone = read('TIMEZONE');
  if (!timezone) {
    try {
      timezone = Session.getScriptTimeZone();
    } catch (err) {
      timezone = '';
    }
  }

  return {
    telegramToken: (props.TELEGRAM_TOKEN || '').trim(),
    geminiKey: (props.GEMINI_API_KEY || '').trim(),
    webappUrl: (props.WEBAPP_URL || '').trim().replace(/\/+$/, ''),
    webhookSecret: (props.WEBHOOK_SECRET || '').trim(),
    botUsername: (props.BOT_USERNAME || '').trim().replace(/^@/, ''),
    botId: (props.BOT_ID || '').trim(),
    models: models,
    thinkingLevel: read('THINKING_LEVEL').toLowerCase(),
    temperature: temperatureRaw !== '' && isFinite(Number(temperatureRaw)) ? Number(temperatureRaw) : null,
    maxOutputTokens: Math.round(number('MAX_OUTPUT_TOKENS', 0, 65536)),
    historyMessages: Math.round(number('HISTORY_MESSAGES', 0, 200)),
    historyTtlSec: Math.round(number('HISTORY_TTL_HOURS', 0.02, 6) * 3600),
    allowed: splitList_(read('ALLOWED_USERS')).map(function (x) { return x.replace(/^@/, '').toLowerCase(); }),
    timezone: timezone || 'Etc/GMT',
    systemPrompt: read('SYSTEM_PROMPT').replace(/\\n/g, '\n'),
  };
}

function splitList_(value) {
  return String(value || '').split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
}

function clip_(text, max) {
  text = String(text);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function errorText_(err) {
  return (err && err.stack) || String(err);
}

function maskSecret_(url) {
  return String(url).replace(/secret=[^&]+/, 'secret=***');
}

// ═══════════════════ ЗАПУСК ВРУЧНУЮ ИЗ РЕДАКТОРА ═══════════════════

/**
 * Проверяет ключи и подключает бота к Telegram.
 * Запускай после первого развертывания и каждый раз, когда меняется WEBAPP_URL.
 */
function setup() {
  const cfg = getConfig_();
  const props = PropertiesService.getScriptProperties();
  const missing = [];
  if (!cfg.telegramToken) missing.push('TELEGRAM_TOKEN');
  if (!cfg.geminiKey) missing.push('GEMINI_API_KEY');
  if (missing.length) {
    throw new Error('Не заданы свойства скрипта: ' + missing.join(', ') +
      '. Открой ⚙️ «Настройки проекта» → «Свойства скрипта» и добавь их (шаг 4 в README).');
  }

  console.log('1/4 Проверяю токен Telegram…');
  const me = tg_(cfg, 'getMe', {});
  if (!me.ok) {
    throw new Error('Telegram не принял токен (' + me.description + '). Проверь TELEGRAM_TOKEN — его выдаёт @BotFather.');
  }
  props.setProperties({ BOT_USERNAME: me.result.username || '', BOT_ID: String(me.result.id) });
  console.log('   ✅ Бот найден: @' + me.result.username);

  console.log('2/4 Проверяю нейросеть Gemini…');
  try {
    const answer = askGemini_([{ role: 'user', parts: [{ text: 'Скажи «привет» одним словом.' }] }], '', cfg);
    console.log('   ✅ Gemini отвечает (модель ' + answer.model + '): ' + clip_(answer.text, 80));
  } catch (err) {
    if (err.kind === 'auth' || err.kind === 'config' || err.kind === 'location') {
      throw new Error('Gemini не принял ключ: ' + err.message +
        '. Проверь GEMINI_API_KEY (создаётся на https://aistudio.google.com/apikey).');
    }
    console.warn('   ⚠️ Gemini сейчас не ответил (' + err.message + '). Бота всё равно подключаю — попробуй написать ему чуть позже.');
  }

  console.log('3/4 Подключаю бота к Telegram (вебхук)…');
  if (!cfg.webappUrl) {
    throw new Error('Ключи в порядке, но не задан WEBAPP_URL. Разверни проект как веб-приложение (шаг 5 в README), ' +
      'скопируй его адрес (заканчивается на /exec) в свойство скрипта WEBAPP_URL и снова запусти setup().');
  }
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(cfg.webappUrl)) {
    throw new Error('WEBAPP_URL выглядит неправильно: «' + cfg.webappUrl + '». Нужен адрес веб-приложения вида ' +
      'https://script.google.com/macros/s/…/exec (из окна «Развертывание», а не адрес редактора и не …/dev).');
  }
  let secret = cfg.webhookSecret;
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('WEBHOOK_SECRET', secret);
  }
  const hook = tg_(cfg, 'setWebhook', {
    url: cfg.webappUrl + '?secret=' + secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
    max_connections: 20,
  });
  if (!hook.ok) throw new Error('Telegram не принял вебхук: ' + hook.description);
  console.log('   ✅ Вебхук установлен');

  console.log('4/4 Настраиваю меню команд…');
  tg_(cfg, 'setMyCommands', { commands: BOT_COMMANDS });
  console.log('   ✅ Готово');

  console.log('🎉 Бот запущен! Напиши ему: https://t.me/' + me.result.username);
}

/** Показывает состояние бота: настройки, вебхук и последние ошибки доставки. */
function status() {
  const cfg = getConfig_();
  console.log('Модели: ' + cfg.models.join(' → '));
  console.log('Размышления: ' + cfg.thinkingLevel + '; память: ' + memoryDescription_(cfg));
  console.log('Доступ: ' + (cfg.allowed.length ? 'только ' + cfg.allowed.join(', ') : 'для всех'));
  console.log('Ключ Gemini: ' + (cfg.geminiKey ? 'задан' : '❌ НЕ задан'));
  if (!cfg.telegramToken) {
    console.warn('❌ TELEGRAM_TOKEN не задан — добавь его в свойства скрипта.');
    return;
  }
  const info = tg_(cfg, 'getWebhookInfo', {});
  if (!info.ok) {
    console.error('Telegram ответил ошибкой: ' + info.description + ' (проверь TELEGRAM_TOKEN)');
    return;
  }
  const hook = info.result || {};
  if (!hook.url) {
    console.warn('⚠️ Вебхук не установлен — бот не получает сообщения. Запусти setup().');
    return;
  }
  console.log('Вебхук: ' + maskSecret_(hook.url));
  console.log('Сообщений в очереди: ' + (hook.pending_update_count || 0));
  if (cfg.webappUrl && hook.url.indexOf(cfg.webappUrl) !== 0) {
    console.warn('⚠️ Вебхук указывает не на WEBAPP_URL. Запусти setup() ещё раз.');
  }
  if (hook.url.indexOf('secret=') === -1) {
    console.warn('⚠️ В адресе вебхука нет секрета — бот будет игнорировать сообщения. Запусти setup().');
  }
  if (hook.last_error_date) {
    const when = Utilities.formatDate(new Date(hook.last_error_date * 1000), cfg.timezone, 'dd.MM.yyyy HH:mm:ss');
    console.warn('Последняя ошибка доставки (' + when + '): ' + hook.last_error_message);
    console.warn('Подсказка: ' + webhookErrorHint_(hook.last_error_message));
  } else {
    console.log('✅ Ошибок доставки нет');
  }
}

/** Отключает бота от Telegram (сообщения перестанут приходить в скрипт). */
function stopBot() {
  const cfg = getConfig_();
  if (!cfg.telegramToken) throw new Error('TELEGRAM_TOKEN не задан');
  const res = tg_(cfg, 'deleteWebhook', { drop_pending_updates: true });
  if (!res.ok) throw new Error('Не получилось отключить бота: ' + res.description);
  console.log('⏹ Бот отключён от Telegram. Чтобы запустить снова — выполни setup().');
}

function webhookErrorHint_(message) {
  const m = String(message || '');
  if (/302/.test(m)) {
    return 'Похоже, развернута старая версия кода. «Развертывание» → «Управление развертываниями» → ✏️ → ' +
      'Версия: «Новая версия» → «Развернуть».';
  }
  if (/40[13]/.test(m)) return 'Доступ к веб-приложению закрыт. В настройках развертывания нужно «У кого есть доступ: Все».';
  if (/404/.test(m)) {
    return 'Адрес веб-приложения не найден. Проверь WEBAPP_URL (он меняется при создании НОВОГО развертывания) и запусти setup().';
  }
  if (/5\d\d/.test(m)) return 'Ошибка внутри скрипта. Открой слева «Выполнения» и посмотри текст ошибки.';
  if (/timeout|timed out/i.test(m)) {
    return 'Скрипт отвечал слишком долго. Поставь THINKING_LEVEL=low или более быструю модель.';
  }
  return 'Открой слева «Выполнения» в редакторе Apps Script и посмотри ошибки.';
}
