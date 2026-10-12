'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGas, geminiText } = require('./gas-mocks');

const BASE_PROPS = {
  TELEGRAM_TOKEN: '123:ABC',
  GEMINI_API_KEY: 'AIzaTEST',
  WEBHOOK_SECRET: 'SECRET',
  BOT_USERNAME: 'TestAiBot',
  BOT_ID: '999',
  WEBAPP_URL: 'https://script.google.com/macros/s/AKfyTEST/exec',
};

let nextUpdateId = 1;

function privateMessage(text, extra) {
  const id = nextUpdateId++;
  return {
    update_id: id,
    message: Object.assign({
      message_id: id * 10,
      from: { id: 111, is_bot: false, first_name: 'Дамир', username: 'damir' },
      chat: { id: 111, type: 'private', first_name: 'Дамир' },
      date: 1760000000,
      text,
    }, extra || {}),
  };
}

function groupMessage(text, extra) {
  const id = nextUpdateId++;
  return {
    update_id: id,
    message: Object.assign({
      message_id: id * 10,
      from: { id: 222, is_bot: false, first_name: 'Аня' },
      chat: { id: -100555, type: 'supergroup', title: 'Друзья' },
      date: 1760000000,
      text,
    }, extra || {}),
  };
}

function post(gas, update, secret) {
  return gas.fn('doPost')({
    parameter: { secret: secret === undefined ? 'SECRET' : secret },
    postData: { contents: JSON.stringify(update), type: 'application/json' },
  });
}

function setup(props) {
  return createGas({ properties: Object.assign({}, BASE_PROPS, props || {}) });
}

const html = (gas, md) => gas.fn('markdownToTelegramHtml_')(md);
// Объекты из vm-контекста имеют «чужой» прототип — приводим к обычным для сравнения.
const plain = (value) => JSON.parse(JSON.stringify(value));

// ─────────────────────────── Форматирование ───────────────────────────

test('экранирует спецсимволы HTML', () => {
  const gas = setup();
  assert.equal(html(gas, 'a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

test('жирный, курсив, зачёркнутый, код и спойлер', () => {
  const gas = setup();
  assert.equal(
    html(gas, '**жирный** и *курсив* и ~~зачёркнутый~~ и `код <x>` и ||тайна||'),
    '<b>жирный</b> и <i>курсив</i> и <s>зачёркнутый</s> и <code>код &lt;x&gt;</code> и <tg-spoiler>тайна</tg-spoiler>'
  );
  assert.equal(html(gas, '***оба***'), '<b><i>оба</i></b>');
  assert.equal(html(gas, '_курсив_ и **жирный**'), '<i>курсив</i> и <b>жирный</b>');
});

test('блоки кода с языком и без, внутри ничего не форматируется', () => {
  const gas = setup();
  assert.equal(
    html(gas, "Пример:\n```python\nprint('<hi>')  # **не жирный**\n```\nГотово"),
    'Пример:\n<pre><code class="language-python">print(\'&lt;hi&gt;\')  # **не жирный**</code></pre>\nГотово'
  );
  assert.equal(html(gas, '```\na_b_c * d *\n```'), '<pre>a_b_c * d *</pre>');
  // незакрытый блок (ответ оборвался)
  assert.equal(html(gas, 'Код:\n```js\nconst a = 1;'), 'Код:\n<pre><code class="language-js">const a = 1;</code></pre>');
});

test('заголовки, списки, цитаты, разделители и ссылки', () => {
  const gas = setup();
  const out = html(gas, [
    '## Заголовок',
    '* пункт один',
    '- пункт **два**',
    '  + вложенный',
    '1. нумерованный',
    '---',
    '> цитата',
    '> вторая строка',
    'Ссылка: [Google](https://google.com/?a=1&b=2)',
  ].join('\n'));
  assert.equal(out, [
    '<b>Заголовок</b>',
    '• пункт один',
    '• пункт <b>два</b>',
    '  • вложенный',
    '1. нумерованный',
    '──────────',
    '<blockquote>цитата\nвторая строка</blockquote>',
    'Ссылка: <a href="https://google.com/?a=1&amp;b=2">Google</a>',
  ].join('\n'));
});

test('не ломает snake_case, URL, @username и математику', () => {
  const gas = setup();
  assert.equal(html(gas, 'переменная my_var_name'), 'переменная my_var_name');
  assert.equal(html(gas, 'см. https://example.com/a_b_c/*x*'), 'см. https://example.com/a_b_c/*x*');
  assert.equal(html(gas, 'пиши @some_user_name'), 'пиши @some_user_name');
  assert.equal(html(gas, 'файлы __init__.py и file_name_here.txt'), 'файлы __init__.py и file_name_here.txt');
  assert.equal(html(gas, '2 \\* 3 = 6, \\_не курсив\\_ и \\*\\*не жирный\\*\\*'), '2 * 3 = 6, _не курсив_ и **не жирный**');
  assert.equal(html(gas, 'код `a\\*b` не трогаем'), 'код <code>a\\*b</code> не трогаем');
  assert.equal(html(gas, '2 * 3 * 4 = 24, a*b*c'), '2 * 3 * 4 = 24, a*b*c');
});

test('таблицы превращаются в моноширинный блок', () => {
  const gas = setup();
  const out = html(gas, 'Сравнение:\n| Модель | Скорость |\n|---|:---:|\n| **Flash** | быстро |\n| Pro | медленно |');
  assert.equal(out, [
    'Сравнение:',
    '<pre>Модель │ Скорость',
    '───────┼─────────',
    'Flash  │ быстро',
    'Pro    │ медленно</pre>',
  ].join('\n'));
});

test('проверка вложенности HTML-тегов', () => {
  const gas = setup();
  const valid = gas.fn('isValidTelegramHtml_');
  assert.equal(valid('<b>a <i>b</i></b>'), true);
  assert.equal(valid('<b>a <i>b</b></i>'), false);
  assert.equal(valid('<b>a'), false);
  assert.equal(valid('<pre><code class="language-js">x</code></pre>'), true);
});

test('короткий текст не делится, длинный — делится по абзацам', () => {
  const gas = setup();
  const split = gas.fn('splitForTelegram_');
  assert.deepEqual(plain(split('привет', 100)), ['привет']);

  const paragraphs = Array.from({ length: 30 }, (_, i) => 'Абзац ' + i + ' ' + 'текст '.repeat(30).trim());
  const text = paragraphs.join('\n\n');
  const chunks = Array.from(split(text, 1000));
  assert.ok(chunks.length > 1);
  chunks.forEach((c) => assert.ok(c.length <= 1000, 'кусок длиннее лимита: ' + c.length));
  assert.equal(chunks.join('\n\n'), text);
});

test('разрезанный блок кода закрывается и открывается заново', () => {
  const gas = setup();
  const split = gas.fn('splitForTelegram_');
  const code = Array.from({ length: 200 }, (_, i) => '    print(' + i + ')').join('\n');
  const chunks = Array.from(split('Вот код:\n```python\n' + code + '\n```\nКонец', 1000));
  assert.ok(chunks.length > 2);
  chunks.forEach((c, i) => {
    const fences = (c.match(/^[ \t]*```/gm) || []).length;
    assert.equal(fences % 2, 0, 'в куске ' + i + ' непарные ```');
    if (i > 0 && i < chunks.length - 1) assert.ok(c.startsWith('```python\n'), 'кусок ' + i + ' должен открывать блок');
    assert.ok(gas.fn('isValidTelegramHtml_')(html(gas, c)));
  });
});

// ─────────────────────────── Вебхук и команды ───────────────────────────

test('doPost отвечает через HtmlService и игнорирует чужие запросы', () => {
  const gas = setup();
  const res = post(gas, privateMessage('привет'), 'WRONG');
  assert.equal(res.kind, 'HtmlOutput');
  assert.equal(gas.calls.telegram.length, 0);
  assert.equal(gas.calls.gemini.length, 0);

  const noSecretGas = setup({ WEBHOOK_SECRET: '' });
  post(noSecretGas, privateMessage('привет'), '');
  assert.equal(noSecretGas.calls.telegram.length, 0);

  // мусор вместо JSON не роняет скрипт
  const garbage = gas.fn('doPost')({ parameter: { secret: 'SECRET' }, postData: { contents: 'not json' } });
  assert.equal(garbage.kind, 'HtmlOutput');
  assert.equal(gas.fn('doGet')().kind, 'HtmlOutput');
});

test('/start приветствует по имени', () => {
  const gas = setup();
  post(gas, privateMessage('/start'));
  const [msg] = gas.sent();
  assert.equal(msg.payload.chat_id, 111);
  assert.equal(msg.payload.parse_mode, 'HTML');
  assert.match(msg.payload.text, /Привет, Дамир!/);
  assert.equal(msg.payload.reply_parameters, undefined, 'в личке не нужно отвечать цитатой');
  assert.equal(gas.calls.gemini.length, 0);
});

test('/help, /id и неизвестная команда', () => {
  const gas = setup();
  post(gas, privateMessage('/help'));
  post(gas, privateMessage('/id'));
  post(gas, privateMessage('/unknown'));
  const texts = gas.sent().map((m) => m.payload.text);
  assert.match(texts[0], /Что я умею/);
  assert.match(texts[0], /20 сообщений/);
  assert.match(texts[1], /<code>111<\/code>/);
  assert.match(texts[2], /Не знаю такой команды/);
});

test('склонение числа сообщений в /help', () => {
  const plural = (n) => {
    const gas = setup({ HISTORY_MESSAGES: String(n) });
    post(gas, privateMessage('/help'));
    return /последние (\d+ \S+)/.exec(gas.sent()[0].payload.text)[1];
  };
  assert.equal(plural(21), '21 сообщение');
  assert.equal(plural(2), '2 сообщения');
  assert.equal(plural(12), '12 сообщений');
  assert.equal(plural(20), '20 сообщений');
});

test('обычное сообщение: «печатает», запрос к Gemini, ответ в HTML', () => {
  const gas = setup();
  gas.handlers.gemini = () => geminiText('**Столица** Франции — `Париж`.');
  post(gas, privateMessage('Какая столица Франции?'));

  const actions = gas.sent('sendChatAction');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].payload.action, 'typing');

  assert.equal(gas.calls.gemini.length, 1);
  const req = gas.calls.gemini[0];
  assert.equal(req.model, 'gemini-3.8-flash');
  assert.equal(req.headers['x-goog-api-key'], 'AIzaTEST');
  assert.deepEqual(req.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(req.body.generationConfig.maxOutputTokens, 8192);
  assert.equal(req.body.generationConfig.temperature, undefined);
  assert.deepEqual(req.body.contents, [{ role: 'user', parts: [{ text: 'Какая столица Франции?' }] }]);
  const system = req.body.systemInstruction.parts[0].text;
  assert.match(system, /ИИ-ассистент в Telegram/);
  assert.match(system, /Сейчас: \d\d\.\d\d\.\d{4} \d\d:\d\d/);
  assert.match(system, /Собеседника зовут Дамир/);

  const [answer] = gas.sent();
  assert.equal(answer.payload.text, '<b>Столица</b> Франции — <code>Париж</code>.');
  assert.equal(answer.payload.parse_mode, 'HTML');
  assert.deepEqual(answer.payload.link_preview_options, { is_disabled: true });
});

test('бот помнит контекст, а /new его очищает', () => {
  const gas = setup();
  let n = 0;
  gas.handlers.gemini = () => geminiText('Ответ ' + (++n));
  post(gas, privateMessage('Меня зовут Дамир'));
  post(gas, privateMessage('Как меня зовут?'));

  const second = gas.calls.gemini[1].body.contents;
  assert.deepEqual(second.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(second[0].parts[0].text, 'Меня зовут Дамир');
  assert.equal(second[1].parts[0].text, 'Ответ 1');
  assert.equal(second[2].parts[0].text, 'Как меня зовут?');

  post(gas, privateMessage('/new'));
  assert.match(gas.sent().pop().payload.text, /новый диалог/);
  post(gas, privateMessage('А теперь?'));
  assert.equal(gas.calls.gemini[2].body.contents.length, 1);
});

test('история обрезается до HISTORY_MESSAGES, 0 — без памяти', () => {
  const gas = setup({ HISTORY_MESSAGES: '4' });
  for (let i = 1; i <= 4; i++) post(gas, privateMessage('вопрос ' + i));
  const last = gas.calls.gemini[3].body.contents;
  assert.deepEqual(last.map((c) => c.parts[0].text), ['вопрос 2', 'Привет! Я ответ нейросети.', 'вопрос 3', 'Привет! Я ответ нейросети.', 'вопрос 4']);
  const stored = JSON.parse(gas.cacheStore.get('h:111'));
  assert.equal(stored.length, 4);

  const noMemory = setup({ HISTORY_MESSAGES: '0' });
  post(noMemory, privateMessage('раз'));
  post(noMemory, privateMessage('два'));
  assert.equal(noMemory.calls.gemini[1].body.contents.length, 1);
  assert.equal(noMemory.cacheStore.has('h:111'), false);
});

test('повторная доставка того же апдейта обрабатывается один раз', () => {
  const gas = setup();
  const update = privateMessage('привет');
  post(gas, update);
  post(gas, update);
  assert.equal(gas.calls.gemini.length, 1);
  assert.equal(gas.sent().length, 1);
  assert.equal(gas.lock.held, false, 'блокировка должна освобождаться');
});

test('в группе отвечает только на упоминание, ответ боту или команду', () => {
  const gas = setup();
  post(gas, groupMessage('просто болтаем'));
  assert.equal(gas.calls.telegram.length, 0);

  post(gas, groupMessage('@TestAiBot сколько будет 2+2?'));
  assert.equal(gas.calls.gemini.length, 1);
  const contents = gas.calls.gemini[0].body.contents;
  assert.equal(contents[0].parts[0].text, 'Аня: сколько будет 2+2?');
  assert.match(gas.calls.gemini[0].body.systemInstruction.parts[0].text, /групповой чат «Друзья»/);
  const answer = gas.sent().pop();
  assert.equal(answer.payload.chat_id, -100555);
  assert.equal(answer.payload.reply_parameters.allow_sending_without_reply, true);

  post(gas, groupMessage('а почему?', { reply_to_message: { message_id: 5, from: { id: 999, is_bot: true }, text: 'Четыре' } }));
  assert.equal(gas.calls.gemini.length, 2);
  assert.equal(gas.calls.gemini[1].body.contents.length, 3, 'история группы общая');

  post(gas, groupMessage('/help@OtherBot'));
  post(gas, groupMessage('/weather'));
  assert.equal(gas.sent().length, 2, 'чужие и неизвестные команды в группе игнорируются');
  post(gas, groupMessage('/help@TestAiBot'));
  assert.match(gas.sent().pop().payload.text, /Что я умею/);
});

test('цитата из чужого сообщения передаётся нейросети', () => {
  const gas = setup();
  post(gas, privateMessage('переведи на английский', {
    reply_to_message: { message_id: 1, from: { id: 5, is_bot: false, first_name: 'Петя' }, text: 'Доброе утро' },
  }));
  assert.equal(
    gas.calls.gemini[0].body.contents[0].parts[0].text,
    '(В ответ на сообщение: «Доброе утро»)\nпереведи на английский'
  );
});

test('сообщения в теме форума отвечаются в ту же тему', () => {
  const gas = setup();
  post(gas, groupMessage('@TestAiBot привет', { is_topic_message: true, message_thread_id: 77 }));
  assert.equal(gas.sent('sendChatAction')[0].payload.message_thread_id, 77);
  assert.equal(gas.sent()[0].payload.message_thread_id, 77);
  assert.ok(gas.cacheStore.has('h:-100555:77'));
});

test('ALLOWED_USERS ограничивает доступ', () => {
  const gas = setup({ ALLOWED_USERS: '@friend, 333' });
  post(gas, privateMessage('привет'));
  assert.equal(gas.calls.gemini.length, 0);
  assert.match(gas.sent()[0].payload.text, /приватный бот[\s\S]*<code>111<\/code>/);

  post(gas, privateMessage('привет', { from: { id: 444, first_name: 'Друг', username: 'Friend' }, chat: { id: 444, type: 'private' } }));
  post(gas, privateMessage('привет', { from: { id: 333, first_name: 'Вася' }, chat: { id: 333, type: 'private' } }));
  assert.equal(gas.calls.gemini.length, 2);
});

test('медиа без текста — вежливый отказ, служебные сообщения и боты — игнор', () => {
  const gas = setup();
  post(gas, privateMessage(undefined, { photo: [{ file_id: 'x' }], caption: 'что на фото?' }));
  assert.match(gas.sent()[0].payload.text, /понимаю только текст/);
  post(gas, privateMessage(undefined, { pinned_message: { message_id: 1 } }));
  post(gas, privateMessage('привет', { from: { id: 5, is_bot: true, first_name: 'Bot' } }));
  assert.equal(gas.sent().length, 1);
  assert.equal(gas.calls.gemini.length, 0);
});

// ─────────────────────────── Gemini: ошибки и запасные модели ───────────────────────────

test('при исчерпании лимита переключается на запасную модель', () => {
  const gas = setup();
  gas.handlers.gemini = (model) => (model === 'gemini-3.8-flash'
    ? { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } } }
    : geminiText('Ответ от ' + model));
  post(gas, privateMessage('привет'));
  assert.deepEqual(gas.calls.gemini.map((c) => c.model), ['gemini-3.8-flash', 'gemini-3.6-flash']);
  assert.equal(gas.sent()[0].payload.text, 'Ответ от gemini-3.6-flash');
});

test('если все модели недоступны — понятное сообщение пользователю', () => {
  const gas = setup();
  gas.handlers.gemini = () => ({ status: 429, body: { error: { code: 429, message: 'Quota exceeded' } } });
  post(gas, privateMessage('привет'));
  assert.deepEqual(gas.calls.gemini.map((c) => c.model), [
    'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest',
  ]);
  assert.match(gas.sent()[0].payload.text, /бесплатный лимит/);
  assert.equal(gas.cacheStore.has('h:111'), false, 'неудачный обмен не сохраняется в память');

  const down = setup();
  down.handlers.gemini = () => { throw new Error('Timeout'); };
  post(down, privateMessage('привет'));
  assert.match(down.sent()[0].payload.text, /временно недоступна/);
});

test('если модель не приняла thinkingConfig — повтор без него', () => {
  const gas = setup();
  gas.handlers.gemini = (model, body) => (body.generationConfig.thinkingConfig
    ? { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Thinking level is not supported for this model.' } } }
    : geminiText('ок'));
  post(gas, privateMessage('привет'));
  assert.equal(gas.calls.gemini.length, 2);
  assert.equal(gas.calls.gemini[1].model, 'gemini-3.8-flash');
  assert.equal(gas.calls.gemini[1].body.generationConfig.thinkingConfig, undefined);
  assert.equal(gas.sent()[0].payload.text, 'ок');
});

test('неверный ключ — без перебора моделей, сообщение о настройке', () => {
  const gas = setup();
  gas.handlers.gemini = () => ({
    status: 400,
    body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } },
  });
  post(gas, privateMessage('привет'));
  assert.equal(gas.calls.gemini.length, 1);
  assert.match(gas.sent()[0].payload.text, /настроен неправильно/);
});

test('403 (ключ утёк или API отключён) — тоже без перебора моделей', () => {
  const gas = setup();
  gas.handlers.gemini = () => ({
    status: 403,
    body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Your API key was reported as leaked. Please use another API key.' } },
  });
  post(gas, privateMessage('привет'));
  assert.equal(gas.calls.gemini.length, 1);
  assert.match(gas.sent()[0].payload.text, /настроен неправильно/);
});

test('заблокированный запрос — сообщение про фильтр, без перебора моделей', () => {
  const gas = setup();
  gas.handlers.gemini = () => ({ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } });
  post(gas, privateMessage('что-то плохое'));
  assert.equal(gas.calls.gemini.length, 1);
  assert.match(gas.sent()[0].payload.text, /фильтр безопасности/);
});

test('мысли модели отфильтровываются, обрезанный ответ помечается', () => {
  const gas = setup();
  gas.handlers.gemini = () => ({
    status: 200,
    body: {
      candidates: [{
        content: { role: 'model', parts: [{ text: 'секретные мысли', thought: true }, { text: 'Итоговый ответ', thoughtSignature: 'abc' }] },
        finishReason: 'MAX_TOKENS',
      }],
    },
  });
  post(gas, privateMessage('привет'));
  assert.equal(gas.sent()[0].payload.text, 'Итоговый ответ\n\n…');
});

test('настройки размышлений для разных поколений моделей', () => {
  const gas = setup();
  const cfgFor = (model, level) => plain(gas.fn('thinkingConfigFor_')(model, level));
  assert.deepEqual(cfgFor('gemini-3.8-flash', 'low'), { thinkingLevel: 'low' });
  assert.deepEqual(cfgFor('gemini-flash-latest', 'high'), { thinkingLevel: 'high' });
  assert.deepEqual(cfgFor('gemini-3.5-flash-lite', 'off'), { thinkingLevel: 'minimal' });
  assert.deepEqual(cfgFor('gemini-2.5-flash', 'low'), { thinkingBudget: 0 });
  assert.deepEqual(cfgFor('gemini-2.5-flash', 'high'), { thinkingBudget: -1 });
  assert.equal(cfgFor('gemini-2.5-pro', 'low'), null);
  assert.equal(cfgFor('gemini-3.8-flash', 'default'), null);
});

test('свои настройки из свойств скрипта', () => {
  const gas = setup({
    GEMINI_MODEL: 'models/gemini-3.6-flash',
    GEMINI_FALLBACK_MODELS: 'gemini-3.6-flash; gemini-2.5-flash',
    THINKING_LEVEL: 'HIGH',
    TEMPERATURE: '0,7',
    SYSTEM_PROMPT: 'Ты пират.\\nГовори «Арр!»',
  });
  post(gas, privateMessage('привет'));
  const req = gas.calls.gemini[0];
  assert.equal(req.model, 'gemini-3.6-flash');
  assert.deepEqual(plain(gas.run('getConfig_().models')), ['gemini-3.6-flash', 'gemini-2.5-flash']);
  assert.deepEqual(req.body.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
  assert.equal(req.body.generationConfig.temperature, 0.7);
  assert.match(req.body.systemInstruction.parts[0].text, /^Ты пират\.\nГовори «Арр!»/);
});

// ─────────────────────────── Отправка в Telegram ───────────────────────────

test('если Telegram не принял HTML — отправляет обычным текстом', () => {
  const gas = setup();
  gas.handlers.gemini = () => geminiText('**Жирный** ответ');
  const original = gas.handlers.telegram;
  gas.handlers.telegram = (method, payload) => (method === 'sendMessage' && payload.parse_mode
    ? { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }
    : original(method, payload));
  post(gas, privateMessage('привет'));
  const sends = gas.sent();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].payload.parse_mode, undefined);
  assert.equal(sends[1].payload.text, 'Жирный ответ');
});

test('флуд-лимит Telegram (429): ждём retry_after и повторяем один раз', () => {
  const gas = setup();
  const original = gas.handlers.telegram;
  let failures = 0;
  gas.handlers.telegram = (method, payload) => {
    if (method === 'sendMessage' && failures === 0) {
      failures++;
      return { ok: false, error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } };
    }
    return original(method, payload);
  };
  const slept = [];
  gas.context.Utilities.sleep = (ms) => slept.push(ms);
  post(gas, privateMessage('/start'));
  assert.equal(gas.sent().length, 2);
  assert.deepEqual(slept, [2000]);
});

test('длинный ответ уходит несколькими сообщениями до 4096 символов', () => {
  const gas = setup();
  const long = Array.from({ length: 60 }, (_, i) => '**Пункт ' + i + '.** ' + 'Очень длинное объяснение. '.repeat(12)).join('\n\n');
  gas.handlers.gemini = () => geminiText(long);
  post(gas, privateMessage('расскажи подробно'));
  const sends = gas.sent();
  assert.ok(sends.length >= 3, 'ожидалось несколько сообщений, получено ' + sends.length);
  sends.forEach((s) => {
    assert.ok(gas.fn('visibleLength_')(s.payload.text) <= 4096);
    assert.ok(gas.fn('isValidTelegramHtml_')(s.payload.text));
  });
});

// ─────────────────────────── setup / status / stopBot ───────────────────────────

test('setup() проверяет ключи, ставит вебхук с секретом и меню команд', () => {
  const gas = setup({ WEBHOOK_SECRET: '', BOT_USERNAME: '', BOT_ID: '' });
  gas.fn('setup')();
  assert.equal(gas.properties.BOT_USERNAME, 'TestAiBot');
  assert.equal(gas.properties.BOT_ID, '999');
  assert.match(gas.properties.WEBHOOK_SECRET, /^[0-9a-f]{32}$/);

  const hook = gas.sent('setWebhook')[0].payload;
  assert.equal(hook.url, BASE_PROPS.WEBAPP_URL + '?secret=' + gas.properties.WEBHOOK_SECRET);
  assert.deepEqual(hook.allowed_updates, ['message']);
  assert.equal(hook.drop_pending_updates, true);
  assert.deepEqual(gas.sent('setMyCommands')[0].payload.commands.map((c) => c.command), ['new', 'help', 'id']);
  assert.equal(gas.calls.gemini.length, 1);
  assert.ok(gas.calls.logs.some((l) => /Бот запущен/.test(l.text)));

  // повторный запуск не меняет секрет
  const secret = gas.properties.WEBHOOK_SECRET;
  gas.fn('setup')();
  assert.equal(gas.properties.WEBHOOK_SECRET, secret);
});

test('setup() подсказывает, чего не хватает', () => {
  const noKeys = createGas({ properties: {} });
  assert.throws(() => noKeys.fn('setup')(), /TELEGRAM_TOKEN, GEMINI_API_KEY/);

  const noUrl = setup({ WEBAPP_URL: '' });
  assert.throws(() => noUrl.fn('setup')(), /не задан WEBAPP_URL/);
  assert.equal(noUrl.sent('getMe').length, 1, 'ключи проверяются до ошибки про WEBAPP_URL');

  const devUrl = setup({ WEBAPP_URL: 'https://script.google.com/macros/s/AKfyTEST/dev' });
  assert.throws(() => devUrl.fn('setup')(), /WEBAPP_URL выглядит неправильно/);

  const badToken = setup();
  badToken.handlers.telegram = () => ({ ok: false, error_code: 401, description: 'Unauthorized' });
  assert.throws(() => badToken.fn('setup')(), /Telegram не принял токен/);

  const badKey = setup();
  badKey.handlers.gemini = () => ({ status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } });
  assert.throws(() => badKey.fn('setup')(), /Gemini не принял ключ/);

  // временная перегрузка Gemini не мешает подключить бота
  const busy = setup();
  busy.handlers.gemini = () => ({ status: 503, body: { error: { message: 'The model is overloaded' } } });
  busy.fn('setup')();
  assert.equal(busy.sent('setWebhook').length, 1);
});

test('status() и stopBot() работают и дают подсказки', () => {
  const gas = setup();
  const original = gas.handlers.telegram;
  gas.handlers.telegram = (method, payload) => (method === 'getWebhookInfo'
    ? {
      ok: true,
      result: {
        url: BASE_PROPS.WEBAPP_URL + '?secret=SECRET',
        pending_update_count: 3,
        last_error_date: 1760000000,
        last_error_message: 'Wrong response from the webhook: 302 Moved Temporarily',
      },
    }
    : original(method, payload));
  gas.fn('status')();
  const logs = gas.calls.logs.map((l) => l.text).join('\n');
  assert.match(logs, /secret=\*\*\*/);
  assert.doesNotMatch(logs, /secret=SECRET/);
  assert.match(logs, /Новая версия/);

  gas.fn('stopBot')();
  assert.equal(gas.sent('deleteWebhook').length, 1);
});
