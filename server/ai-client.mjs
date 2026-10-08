const USAGE_KEY = 'aiUsage';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_CONCURRENT_REQUESTS = 2;
const memoryUsage = new WeakMap();
let activeRequests = 0;

class ModelRequestError extends Error {
  constructor(code) {
    super('AI request failed');
    this.name = 'ModelRequestError';
    this.code = code;
  }
}

function configuredInteger(name, fallback, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function limits() {
  return {
    daily: configuredInteger('AI_DAILY_REQUEST_LIMIT', 150, 10000),
    hourly: configuredInteger('AI_USER_HOURLY_LIMIT', 20, 1000),
    assistantTokens: configuredInteger('AI_ASSISTANT_MAX_TOKENS', 1200, 4000),
    assessmentTokens: configuredInteger('AI_REVIEW_MAX_TOKENS', 3000, 6000),
  };
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function dayKey(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function usageState(store) {
  const state = typeof store.setting === 'function' && typeof store.setSetting === 'function'
    ? store.setting(USAGE_KEY, null)
    : memoryUsage.get(store);
  return {
    daily: state?.daily && typeof state.daily === 'object' && !Array.isArray(state.daily) ? { ...state.daily } : {},
    hourly: Array.isArray(state?.hourly) ? [...state.hourly] : [],
  };
}

function updateUsage(store, work) {
  const mutate = () => {
    const state = usageState(store);
    const result = work(state);
    if (typeof store.setting === 'function' && typeof store.setSetting === 'function') store.setSetting(USAGE_KEY, state);
    else memoryUsage.set(store, state);
    return result;
  };
  return typeof store.transaction === 'function' ? store.transaction(mutate) : mutate();
}

function dailyUsage(state, day) {
  const usage = state.daily[day];
  return {
    requests: tokenCount(usage?.requests),
    inputTokens: tokenCount(usage?.inputTokens),
    outputTokens: tokenCount(usage?.outputTokens),
  };
}

export function getModelUsage(store, at = Date.now()) {
  const day = dayKey(at);
  const configured = limits();
  return { day, ...dailyUsage(usageState(store), day), dailyLimit: configured.daily, userHourlyLimit: configured.hourly, concurrentLimit: MAX_CONCURRENT_REQUESTS };
}

function reserveRequest(store, kind, actorId, at, configured) {
  const day = dayKey(at);
  updateUsage(store, state => {
    const oldestDay = dayKey(at - 29 * DAY_MS);
    state.daily = Object.fromEntries(Object.entries(state.daily).filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && key >= oldestDay));
    state.hourly = state.hourly.filter(entry => typeof entry?.actorId === 'string' && Number.isFinite(entry.at) && entry.at > at - HOUR_MS);
    const usage = dailyUsage(state, day);
    if (usage.requests >= configured.daily) throw new ModelRequestError('daily_limit');
    if (kind === 'assistant') {
      const actor = String(actorId ?? 'anonymous');
      if (state.hourly.filter(entry => entry.actorId === actor).length >= configured.hourly) throw new ModelRequestError('hourly_limit');
      state.hourly.push({ actorId: actor, at });
    }
    state.daily[day] = { ...usage, requests: usage.requests + 1 };
  });
  return day;
}

function recordTokens(store, day, usage) {
  const inputTokens = tokenCount(usage?.prompt_tokens);
  const outputTokens = tokenCount(usage?.completion_tokens);
  if (!inputTokens && !outputTokens) return;
  updateUsage(store, state => {
    const current = dailyUsage(state, day);
    state.daily[day] = { ...current, inputTokens: current.inputTokens + inputTokens, outputTokens: current.outputTokens + outputTokens };
  });
}

const SAFE_FAILURES = {
  daily_limit: 'Достигнут суточный лимит запросов к ИИ; он обновляется в 00:00 UTC.',
  hourly_limit: 'Достигнут лимит запросов к ИИ за последний час для этого пользователя.',
  busy: 'Сейчас выполняются два запроса к ИИ. Повторите запрос позже.',
  unauthorized: 'API-ключ не принят провайдером.',
  forbidden: 'У API-ключа нет доступа к выбранной модели.',
  model_unavailable: 'Выбранная модель недоступна для этого API-ключа.',
  quota: 'Провайдер сообщил об исчерпании квоты или средств API.',
  rate_limited: 'Провайдер временно ограничил частоту запросов.',
  provider_error: 'Сервис модели временно недоступен.',
  timeout: 'Модель не ответила за отведённое время.',
  network: 'Не удалось связаться с сервисом модели.',
  invalid_response: 'Модель вернула некорректный ответ.',
  truncated: 'Ответ модели не поместился в установленный лимит токенов.',
  rejected: 'Провайдер отклонил запрос к модели.',
};

export function safeModelFailure(error) {
  return error instanceof ModelRequestError ? SAFE_FAILURES[error.code] ?? null : null;
}

async function responseFailure(response) {
  let providerCode;
  try { providerCode = (await response.json())?.error?.code; } catch { /* Only a whitelisted code is used; raw provider responses stay private. */ }
  const codes = { insufficient_quota: 'quota', model_not_found: 'model_unavailable', invalid_api_key: 'unauthorized', rate_limit_exceeded: 'rate_limited' };
  const code = typeof providerCode === 'string' && Object.hasOwn(codes, providerCode) ? codes[providerCode]
    : response.status === 401 ? 'unauthorized'
      : response.status === 403 ? 'forbidden'
        : response.status === 404 ? 'model_unavailable'
          : response.status === 429 ? 'rate_limited'
            : response.status >= 500 ? 'provider_error' : 'rejected';
  return new ModelRequestError(code);
}

export async function requestModel({ store, kind, actorId, messages, timeoutMs = 45000, now = Date.now }) {
  if (kind !== 'assistant' && kind !== 'assessment') throw new TypeError('Unknown model request kind');
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) throw new ModelRequestError('busy');
  const configured = limits();
  const day = reserveRequest(store, kind, actorId, Number(now()), configured);
  activeRequests += 1;
  try {
    const model = process.env.AI_MODEL;
    const maxTokens = kind === 'assistant' ? configured.assistantTokens : configured.assessmentTokens;
    const gpt5 = /^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model ?? '');
    const body = {
      model,
      ...(gpt5 ? { reasoning_effort: 'minimal', max_completion_tokens: maxTokens } : { temperature: kind === 'assistant' ? 0.1 : 0.15, max_tokens: maxTokens }),
      response_format: { type: 'json_object' },
      messages,
    };
    let response;
    try {
      response = await fetch(`${process.env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', ...(process.env.AI_API_KEY ? { Authorization: `Bearer ${process.env.AI_API_KEY}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ModelRequestError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network');
    }
    if (!response.ok) throw await responseFailure(response);
    let result;
    try { result = await response.json(); } catch { throw new ModelRequestError('invalid_response'); }
    recordTokens(store, day, result?.usage);
    if (!Array.isArray(result?.choices) || !result.choices.length) throw new ModelRequestError('invalid_response');
    if (result.choices[0]?.finish_reason === 'length') throw new ModelRequestError('truncated');
    return result;
  } finally {
    activeRequests -= 1;
  }
}
