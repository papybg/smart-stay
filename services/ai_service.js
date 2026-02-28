import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import fs from 'fs/promises';
import path from 'path';
import { controlPower as sendPowerCommand, controlMeterByAction } from './autoremote.js';
import { validateToken } from './sessionManager.js';

/**
 * ============================================================================
 * SMART-STAY AI SERVICE - ЖЕЛЕЗОБЕТОННА СИСТЕМА ЗА СИГУРНОСТ
 * ============================================================================
 * 
 * Този сервис имплементира мощни контроли на сигурност за автоматизация на имота:
 * - ТОЧНО съответствие на код на домакина (без размито съвпадение)
 * - Верификация на гост чрез HM кодове на резервации в база данни
 * - Защитна стена за предотвращаване на неоторизиран достъп до наръчници
 * - Логика на хранилище на щифтове с автоматично разпределяне
 * - Автоматизирана помощ при аварийна ситуация на тока с известувания
 * - Отказолека на множество модели за отговори на AI
 * 
 * Създано: февруари 2026
 */

// ============================================================================
// КОНФИГУРАЦИЯ И ИНИЦИАЛИЗАЦИЯ
// ============================================================================

// 🔐 EXTERNAL SESSION MANAGEMENT
// Тези функции се постигат от sessionManager.js
// ai_service.js само ВАЛИДИРА токени, НЕ ги генерира или управлява

/**
 * @const {string[]} MODELS - Gemini модели в ред на отказ
 * Първичен модел, последван от каскадни отказни за надежност
 */
const MODELS = [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3-pro-preview"
];
const MODEL_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_MODEL_TIMEOUT_MS || 12000);
const MODEL_COOLDOWN_MS = Number(process.env.GEMINI_MODEL_COOLDOWN_MS || 60000);
const modelCooldownUntil = new Map();
const GROQ_ROUTER_ENABLED = (process.env.GROQ_ROUTER_ENABLED || 'true').toLowerCase() !== 'false';
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;
const GROQ_API_URL = (process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 8000);
const GROQ_DELEGATE_TOKEN = '[[DELEGATE_TO_GEMINI]]';
const BACKUP_API_KEY = process.env.BACKUP_API_KEY || null;
const BACKUP_API_URL = (process.env.BACKUP_API_URL || '').replace(/\/$/, '');
const BACKUP_MODEL = process.env.BACKUP_MODEL || '';
const BACKUP_TIMEOUT_MS = Number(process.env.BACKUP_TIMEOUT_MS || 15000);
const ACCESS_START_BEFORE_CHECKIN_HOURS = Number(process.env.ACCESS_START_BEFORE_CHECKIN_HOURS || 2);
const ACCESS_END_AFTER_CHECKOUT_HOURS = Number(process.env.ACCESS_END_AFTER_CHECKOUT_HOURS || 1);
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || null;
const GOOGLE_PLACES_MAX_RESULTS = Number(process.env.GOOGLE_PLACES_MAX_RESULTS || 3);
const GOOGLE_PLACES_STRICT_MODE = (process.env.GOOGLE_PLACES_STRICT_MODE || 'false').toLowerCase() !== 'false';
const GOOGLE_PLACES_TIMEOUT_MS = Number(process.env.GOOGLE_PLACES_TIMEOUT_MS || 5000);
const GOOGLE_PLACES_BLOCK_COOLDOWN_MS = Number(process.env.GOOGLE_PLACES_BLOCK_COOLDOWN_MS || 3600000);
const GOOGLE_DIRECTIONS_API_KEY = process.env.GOOGLE_DIRECTIONS_API_KEY || GOOGLE_PLACES_API_KEY;
const GOOGLE_DIRECTIONS_TIMEOUT_MS = Number(process.env.GOOGLE_DIRECTIONS_TIMEOUT_MS || 6000);
const GOOGLE_DIRECTIONS_DEFAULT_ORIGIN = process.env.GOOGLE_DIRECTIONS_DEFAULT_ORIGIN || 'Aspen Valley Golf, Ski and Spa Resort, Razlog';
let placesBlockedUntilTs = 0;
let placesBlockedReason = '';

function isPlacesBlockedNow() {
    return placesBlockedUntilTs > Date.now();
}

function markPlacesBlocked(reason = '') {
    placesBlockedUntilTs = Date.now() + GOOGLE_PLACES_BLOCK_COOLDOWN_MS;
    placesBlockedReason = String(reason || '').trim();
    console.warn(`[PLACES] 🚫 Places API временно блокиран за ~${Math.ceil(GOOGLE_PLACES_BLOCK_COOLDOWN_MS / 60000)} мин.`);
}

function getPlacesBlockedHint(language = 'bg') {
    const reason = placesBlockedReason || 'API_KEY_SERVICE_BLOCKED';
    return language === 'en'
        ? `Google Places live lookup is blocked (${reason}). Enable Places API for this API key or adjust API key restrictions in Google Cloud.`
        : `Google Places live търсенето е блокирано (${reason}). Активирайте Places API за този ключ или коригирайте ограниченията на API ключа в Google Cloud.`;
}

function shouldTripPlacesCircuitBreaker(statusCode, errorBody = '') {
    const text = String(errorBody || '').toLowerCase();
    if (statusCode === 403 && text.includes('api_key_service_blocked')) return true;
    if (statusCode === 403 && text.includes('permission_denied') && text.includes('places.googleapis.com')) return true;
    return false;
}

// ============================================================================
// BRAVE SEARCH INTEGRATION (Web Search за туризъм, ресторанти, услуги)
// ============================================================================

const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || null;
const BRAVE_SEARCH_TIMEOUT_MS = Number(process.env.BRAVE_SEARCH_TIMEOUT_MS || 6000);
const BRAVE_SEARCH_MONTHLY_QUOTA = Number(process.env.BRAVE_SEARCH_MONTHLY_QUOTA || 1000);
const BRAVE_SEARCH_WARNING_LEVELS = [70, 85, 95];

let braveQuotaMonth = '';
let braveQuotaUsed = 0;
let braveWarnedLevels = new Set();

function getCurrentQuotaMonth() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ensureBraveQuotaWindow() {
    const currentMonth = getCurrentQuotaMonth();
    if (braveQuotaMonth !== currentMonth) {
        braveQuotaMonth = currentMonth;
        braveQuotaUsed = 0;
        braveWarnedLevels = new Set();
        console.log(`[BRAVE] 🔄 Нов месечен quota прозорец: ${braveQuotaMonth}`);
    }
}

function canUseBraveQuota() {
    ensureBraveQuotaWindow();
    return braveQuotaUsed < BRAVE_SEARCH_MONTHLY_QUOTA;
}

function consumeBraveQuota() {
    ensureBraveQuotaWindow();
    braveQuotaUsed += 1;

    const usagePercent = Math.floor((braveQuotaUsed / BRAVE_SEARCH_MONTHLY_QUOTA) * 100);
    for (const level of BRAVE_SEARCH_WARNING_LEVELS) {
        if (usagePercent >= level && !braveWarnedLevels.has(level)) {
            braveWarnedLevels.add(level);
            console.warn(`[BRAVE] ⚠️ Месечен usage достигна ${usagePercent}% (${braveQuotaUsed}/${BRAVE_SEARCH_MONTHLY_QUOTA})`);
        }
    }
}

function isSearchEligibleQuery(userMessage = '') {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const text = String(userMessage).trim();
    const lowered = text.toLowerCase();

    if (text.length < 8) return false;

    if (containsReservationCode(text)) return false;
    if (isPowerCommandRequest(text)) return false;

    const shortChatPatterns = [
        /^(здра(вей|сти)|hello|hi|hey|ok|okei|thanks|благодаря|мерси)[!.\s]*$/i,
        /^\d+$/,
        /^(yes|no|да|не)[!.\s]*$/i
    ];

    if (shortChatPatterns.some(pattern => pattern.test(lowered))) return false;

    return true;
}

async function searchBrave(query, language = 'bg') {
    if (!BRAVE_SEARCH_API_KEY) return null;
    if (!canUseBraveQuota()) {
        console.warn(`[BRAVE] ⛔ Месечният лимит е изчерпан (${braveQuotaUsed}/${BRAVE_SEARCH_MONTHLY_QUOTA}). Fallback към Gemini без web search.`);
        return null;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), BRAVE_SEARCH_TIMEOUT_MS);

    try {
        consumeBraveQuota();

        const searchParams = new URLSearchParams({
            q: query,
            count: '5',
            result_filter: 'web',
            search_lang: language === 'en' ? 'en' : 'bg'
        });

        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${searchParams.toString()}`, {
            method: 'GET',
            headers: {
                'X-Subscription-Token': BRAVE_SEARCH_API_KEY,
                'Accept': 'application/json'
            },
            signal: controller.signal
        });

        if (!response.ok) {
            const errText = await response.text();
            console.warn(`[BRAVE] Грешка при търсене: ${response.status} ${errText}`);
            return null;
        }

        const data = await response.json();
        const results = Array.isArray(data?.web?.results)
            ? data.web.results
            : (Array.isArray(data?.results) ? data.results : []);

        if (!results.length) {
            console.log('[BRAVE] Няма резултати');
            return null;
        }

        const formatted = results
            .slice(0, 4)
            .map(r => {
                const title = r.title || '';
                const url = r.url || '';
                const description = r.description || (Array.isArray(r.extra_snippets) ? r.extra_snippets.join(' ') : '');
                return `📌 ${title}\n${url}\n${description}`;
            })
            .join('\n\n');

        console.log(`[BRAVE] ✅ Намерени ${results.length} резултата`);
        return formatted;
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.warn(`[BRAVE] Timeout след ${BRAVE_SEARCH_TIMEOUT_MS}ms`);
        } else {
            console.warn('[BRAVE] Грешка:', error.message);
        }
        return null;
    } finally {
        clearTimeout(timeoutHandle);
    }
}

function isManualLikeQuestion(userMessage = '') {
    const text = String(userMessage || '').toLowerCase();
    if (!text.trim()) return false;

    const manualHints = [
        'паркинг', 'wifi', 'wi-fi', 'интернет', 'парола', 'климатик', 'клима',
        'отопление', 'бойлер', 'пералня', 'сушилня', 'печка', 'фурна', 'хладилник',
        'check-in', 'check in', 'check-out', 'check out', 'самонастаняване',
        'адрес', 'локация', 'инструкция', 'инструкции', 'наръчник', 'врата', 'брава',
        'апартамент', 'апартамента', 'комплекс', 'комплекса',
        'tv', 'телевизор', 'дистанционно', 'гараж', 'асансьор', 'код за вход',
        'parking', 'address', 'manual', 'instructions', 'apartment', 'property', 'complex',
        'heater', 'boiler', 'washing machine', 'fridge', 'oven', 'stove', 'door',
        'lock', 'checkin', 'checkout'
    ];

    return manualHints.some(token => text.includes(token));
}

function shouldUseGroqRouterForMessage(userMessage = '') {
    const text = String(userMessage || '').toLowerCase();
    if (!text.trim()) return false;

    // Ако няма ясен property/manual сигнал -> директно Gemini.
    if (!isManualLikeQuestion(text)) return false;

    // Външни услуги/препоръки/общи въпроси -> Gemini, дори да има частични съвпадения.
    const outOfScopePatterns = [
        /кола\s+под\s+наем/i,
        /наем\s+на\s+кола/i,
        /rent\s*a\s*car/i,
        /car\s+rental/i,
        /автомобил\s+под\s+наем/i,
        /къде\s+мога\s+да\s+наема\s+кола/i,
        /препоръча(й|йте)|recommend|best\s+place|най\s*доб(ър|ра|ро)/i,
        /къде\s+мога\s+да|where\s+can\s+i/i
    ];

    if (outOfScopePatterns.some(pattern => pattern.test(text))) return false;

    return true;
}

function canUseGroqRouter() {
    return GROQ_ROUTER_ENABLED && Boolean(GROQ_API_KEY) && Boolean(GROQ_MODEL) && Boolean(genAI);
}

function buildGroqRouterInstruction(role, preferredLanguage, manualContent) {
    const languageRule = preferredLanguage === 'en'
        ? 'Answer in English only.'
        : 'Отговаряй само на български.';
    const roleRule = role === 'stranger'
        ? 'You are speaking with a stranger. Never reveal private or operational-sensitive details.'
        : 'You are speaking with an authenticated user (guest or host).';

    const manualSnippet = String(manualContent || '').slice(0, 12000);

    return `You are Smart-Stay Groq Router. ${languageRule}

CRITICAL ROUTING RULES:
1) If the user asks a property/manual/house-operation question and the answer exists in MANUAL_CONTEXT, answer directly and briefly.
2) If the question is broad/general/off-topic and needs general reasoning or knowledge outside MANUAL_CONTEXT, reply with exactly ${GROQ_DELEGATE_TOKEN}
3) Never output both an answer and ${GROQ_DELEGATE_TOKEN}.
4) Keep answers concise and operational.

SECURITY RULE:
${roleRule}

MANUAL_CONTEXT:
${manualSnippet}`;
}

async function generateWithGroqRouter(role, preferredLanguage, manualContent, history, userMessage) {
    if (!canUseGroqRouter()) return null;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

    try {
        const routerInstruction = buildGroqRouterInstruction(role, preferredLanguage, manualContent);
        const compactHistory = (Array.isArray(history) ? history : [])
            .filter(msg => msg && typeof msg.content === 'string')
            .slice(-8)
            .map(msg => ({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content
            }));

        const response = await fetch(`${GROQ_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [
                    { role: 'system', content: routerInstruction },
                    ...compactHistory,
                    { role: 'user', content: userMessage }
                ],
                temperature: 0.1,
                max_tokens: 700
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`[GROQ_ROUTER] ${response.status} ${response.statusText} - ${errText}`);
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error('[GROQ_ROUTER] Empty response content');

        if (text === GROQ_DELEGATE_TOKEN) {
            console.log('[GROQ_ROUTER] ↪️ Делегирам към Gemini');
            return { delegated: true, reply: null };
        }

        if (text.includes(GROQ_DELEGATE_TOKEN)) {
            console.log('[GROQ_ROUTER] ↪️ Смесен отговор с delegate token, делегирам към Gemini');
            return { delegated: true, reply: null };
        }

        console.log('[GROQ_ROUTER] ✅ Отговорено директно от Groq router');
        return { delegated: false, reply: text };
    } catch (error) {
        console.warn('[GROQ_ROUTER] ⚠️ Грешка, продължавам към Gemini:', error.message);
        return null;
    } finally {
        clearTimeout(timeoutHandle);
    }
}

function buildGeminiCompositionInstruction(systemInstruction, preferredLanguage, manualDraft = '') {
    const languageRule = preferredLanguage === 'en'
        ? 'Write in English.'
        : 'Пиши на български.';

    return `${systemInstruction}

COMPOSITION MODE (MANUAL-FIRST):
- You receive a MANUAL_DRAFT prepared from property manual context.
- Build the final answer primarily from MANUAL_DRAFT.
- You may add extra helpful context from general knowledge ONLY if it does not conflict with MANUAL_DRAFT.
- If you add extra context, keep it short and practical.
- Never invent property-specific facts (codes, contacts, facilities, timings) beyond MANUAL_DRAFT/manual.
- If MANUAL_DRAFT is empty or missing key data, ask a short clarifying question or provide a safe generic recommendation.

${languageRule}`;
}

function parseRetryDelayMs(errorMessage = '') {
    const text = String(errorMessage || '');
    const match = text.match(/Please retry in\s*([\d.]+)s/i) || text.match(/"retryDelay"\s*:\s*"(\d+)s"/i);
    if (!match) return null;
    const seconds = Number.parseFloat(match[1]);
    if (Number.isNaN(seconds) || seconds <= 0) return null;
    return Math.ceil(seconds * 1000);
}

function isQuotaError(errorMessage = '') {
    const text = String(errorMessage || '').toLowerCase();
    return text.includes('429') || text.includes('quota exceeded') || text.includes('too many requests');
}

function isModelCoolingDown(modelName) {
    const until = modelCooldownUntil.get(modelName);
    if (!until) return false;
    if (Date.now() >= until) {
        modelCooldownUntil.delete(modelName);
        return false;
    }
    return true;
}

function setModelCooldown(modelName, errorMessage = '') {
    const retryDelayMs = parseRetryDelayMs(errorMessage);
    const cooldownMs = Math.max(MODEL_COOLDOWN_MS, retryDelayMs || 0);
    const until = Date.now() + cooldownMs;
    modelCooldownUntil.set(modelName, until);
    console.warn(`[AI] ⏳ Модел ${modelName} е в cooldown за ~${Math.ceil(cooldownMs / 1000)}s`);
}

async function sendMessageWithTimeout(chat, userMessage, modelName) {
    return await Promise.race([
        chat.sendMessage(userMessage),
        new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`[MODEL_TIMEOUT] ${modelName} exceeded ${MODEL_REQUEST_TIMEOUT_MS}ms`));
            }, MODEL_REQUEST_TIMEOUT_MS);
        })
    ]);
}

async function generateWithBackupProvider(systemInstruction, history, userMessage) {
    if (!BACKUP_API_KEY || !BACKUP_API_URL || !BACKUP_MODEL) return null;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), BACKUP_TIMEOUT_MS);

    try {
        const messages = [
            { role: 'system', content: systemInstruction },
            ...((Array.isArray(history) ? history : [])
                .filter(msg => msg && typeof msg.content === 'string')
                .map(msg => ({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: msg.content
                }))),
            { role: 'user', content: userMessage }
        ];

        console.log(`[BACKUP] 🤖 Опит с backup модел: ${BACKUP_MODEL}`);
        const response = await fetch(`${BACKUP_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BACKUP_API_KEY}`
            },
            body: JSON.stringify({
                model: BACKUP_MODEL,
                messages,
                temperature: 0.3
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`[BACKUP] ${response.status} ${response.statusText} - ${errText}`);
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error('[BACKUP] Empty response content');

        console.log('[BACKUP] ✅ Успешен fallback отговор');
        return text;
    } catch (error) {
        console.error('[BACKUP] 🔴 Грешка:', error.message);
        return null;
    } finally {
        clearTimeout(timeoutHandle);
    }
}

/**
 * @const {any} sql - Neon клиент на база данни за PostgreSQL заявки
 * Инициализиран от DATABASE_URL променлива на окръжение
 * ⚡ ОПТИМИЗИРАНО: pool с намален idle време за спане на Neon (0 CU при неактивност)
 */
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

/**
 * @const {GoogleGenerativeAI} genAI - Google Generative AI клиент
 * Инициализиран от GEMINI_API_KEY променлива на окръжение
 */
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

/**
 * @const {string} AUTOMATION_URL - Базов URL на услугата за автоматизация
 * Маршрути за контрол на тока, получаване на статус и изпращане на известувания
 */
const AUTOMATION_URL = process.env.AUTOMATION_SERVICE_URL || 'http://localhost:10000';

/**
 * @const {string} HOST_CODE - КРИТИЧНО: Тайния код на домакина
 * Използва се за 100% точно съответствие (размитото съвпадение е забранено)
 * Съхранява се в променлива на окръжение, никога не е твърдо кодирана
 */
const HOST_CODE = process.env.HOST_CODE;

/**
 * @const {string} PUBLIC_INFO_FALLBACK - Твърдо кодирана публична информация
 * Използва се, когда ролята е 'непознат' за предотвращаване на неоторизиран достъп до manual.txt
 * Съдържа само адрес на имот, удобства и обща информация за резервация
 * КРИТИЧНА ЗАЩИТНА СТЕНА: Това предотвращава разтичане на чувствителни оперативни детайли
 */
const PUBLIC_INFO_FALLBACK = `
🏠 ASPEN VALLEY - АПАРТАМЕНТ D106

🔑 РЕЗЕРВАЦИЯ:
- За регистрирани гости: въведете вашия код на резервация
- За нови резервации: посетете нашия уебсайт

⚠️ ВАЖНО:
- Паролите и кодовете не се дават на непознати
- За достъп до услуги е необходима регистрирана резервация
`;


// ============================================================================
// КЛИЕНТ НА УСЛУГАТА ЗА АВТОМАТИЗАЦИЯ
// ============================================================================

/**
 * @namespace automationClient
 * @description Капсулира вся комуникация с външната услуга за автоматизация
 * Управлява управление на тока, известувания и заявки за резервации
 */
const automationClient = {
    normalizePowerStateFromStatus(rawStatus) {
        if (typeof rawStatus === 'boolean') return rawStatus;
        if (typeof rawStatus === 'number') {
            if (rawStatus === 1) return true;
            if (rawStatus === 0) return false;
            return null;
        }
        if (typeof rawStatus === 'string') {
            const value = rawStatus.trim().toLowerCase();
            if (['on', 'true', '1', 'вкл', 'включен', 'active'].includes(value)) return true;
            if (['off', 'false', '0', 'изкл', 'изключен', 'inactive'].includes(value)) return false;
        }
        return null;
    },

    /**
     * Получава текущия статус на системата за тока от услугата за автоматизация
     * @async
     * @returns {Promise<{online: boolean, isOn: boolean}>} Обект със статус на тока
     * @throws Мълчаливо връща офлайн статус при мрежова грешка
     */
    async getPowerStatus(options = {}) {
        const { silent = false } = options;

        // Tasker/history is authoritative; try reading latest row from database first
        if (sql) {
            try {
                const rows = await sql`
                    SELECT is_on, timestamp
                    FROM power_history
                    ORDER BY timestamp DESC
                    LIMIT 1
                `;
                if (rows.length) {
                    const raw = rows[0].is_on;
                    const normalized = automationClient.normalizePowerStateFromStatus(raw);
                    if (!silent) {
                        console.log('[AUTOMATION] Статус на тока от power_history:', {
                            isOn: normalized,
                            timestamp: rows[0].timestamp,
                            source: 'db'
                        });
                    }
                    return { online: true, isOn: normalized, source: 'db', timestamp: rows[0].timestamp };
                }
            } catch (dbErr) {
                if (!silent) console.warn('[AUTOMATION] Грешка при четене на power_history:', dbErr.message);
                // fall through to automation endpoint
            }
        }

        // fallback to automation service (previous behaviour)
        try {
            if (!silent) {
                console.log('[AUTOMATION] Получавам статус на тока от услугата за автоматизация...');
            }
            const res = await fetch(`${AUTOMATION_URL}/api/power-status`);
            if (!res.ok) {
                console.warn('[AUTOMATION] Крайната точка върна статус, различен от 200:', res.status);
                return { online: false, isOn: false };
            }
            const status = await res.json();
            const normalizedIsOn =
                typeof status?.isOn === 'boolean'
                    ? status.isOn
                    : automationClient.normalizePowerStateFromStatus(
                        status?.is_on ?? status?.state ?? status?.status ?? status?.received?.is_on
                    );

            const normalized = {
                ...status,
                online: status?.online !== false,
                isOn: typeof normalizedIsOn === 'boolean' ? normalizedIsOn : false
            };

            if (!silent) {
                console.log('[AUTOMATION] Статус на тока получен:', normalized);
            }
            return normalized;
        } catch (e) {
            console.error('[AUTOMATION] Проверката на статус на тока не успя:', e.message);
            return { online: false, isOn: false };
        }
    },

    /**
     * Управлява състоянието на тока чрез услугата за автоматизация
     * КРИТИЧНО: Вика обновения API endpoint, който автоматично триггерира Telegram команда
     * - true изпраща 'ВКЛ' към Telegram бот
     * - false изпраща 'ИЗКЛ' към Telegram бот
     * 
     * Се вика при спешни ситуации (гост докладва липса на ток) или при AI команди
     * @async
     * @param {boolean} state - True за включване на тока, false за изключване
     * @returns {Promise<boolean>} True при успешно управление, false в противния случай
     * @throws Мълчаливо връща false при мрежова грешка
     */
    async controlPower(state, bookingId = null, source = 'ai_command') {
        try {
            // first, fetch current known status
            const status = await this.getPowerStatus({ silent: true });
            if (status.isOn === state) {
                console.log('[AUTOMATION] ⚠️ Токът вече е', state ? 'ON' : 'OFF', '- пропускам команда');
                return true; // няма нужда от действие
            }

            const command = state ? 'meter_on' : 'meter_off';
            console.log('[AUTOMATION] 📡 Управление на тока чрез Samsung API:', command);

            const success = await sendPowerCommand(state);
            if (!success) {
                console.warn('[AUTOMATION] ⚠️ Неуспешна Samsung команда');
                return false;
            }

            console.log('[AUTOMATION] ✅ Команда успешно изпратена към Samsung, изчаквам потвърждение');

            // wait a few seconds for Tasker feedback to arrive
            const confirmed = await this.waitForPowerState(state, 5000);
            if (!confirmed) {
                console.warn('[AUTOMATION] ⚠️ Няма потвърждение от Tasker, използвам резервен метод (meter)');
                // variant2: изпрати на meter-endpoint
                await sendMeterCommand(state);
                return false;
            }

            return true;
        } catch (e) {
            console.error('[AUTOMATION] ❌ Управлението на тока не успя:', e.message);
            return false;
        }
    },

    // helper: waits until power-status reports expected state or timeout
    async waitForPowerState(expectedState, timeoutMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const s = await this.getPowerStatus({ silent: true });
                if (s.isOn === expectedState) return true;
            } catch (_) {}
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    },

    // helper: send meter command as fallback
    async sendMeterCommand(state) {
        try {
            const action = state ? 'on' : 'off';
            const result = await controlMeterByAction(action);
            return result.success;
        } catch (e) {
            console.error('[AUTOMATION] ❌ sendMeterCommand error:', e.message);
            return false;
        }
    },

    /**
     * Изпраща спешно известување до домакина чрез услугата за автоматизация
     * Активира се, когато гост докладва проблеми или системата открие проблеми
     * @async
     * @param {string} message - Известувателното съобщение, описващо ситуацията
     * @param {Object} guestInfo - Обект с информация за госта
     * @param {string} guestInfo.guest_name - Пълното име на госта
     * @param {string} guestInfo.reservation_code - HM код, идентифициращ резервацията
     * @returns {Promise<boolean>} True, ако известуванието е изпратено успешно
     */
    async sendAlert(message, guestInfo) {
        try {
            console.log('[AUTOMATION] Изпращам известување до домакина:', message);
            await fetch(`${AUTOMATION_URL}/api/alert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, guestInfo })
            });
            console.log('[AUTOMATION] Известуванието е изпратено успешно');
            return true;
        } catch (e) {
            console.error('[AUTOMATION] Изпращането на известуване не успя:', e.message);
            return false;
        }
    },

    /**
     * Получава всички текущи резервации от услугата за автоматизация
     * Използва се за верификация на гост и разпределяне на щифт
     * @async
     * @returns {Promise<Array>} Масив от обекти резервации от база данни
     */
    async getBookings() {
        try {
            console.log('[AUTOMATION] Получавам всички резервации...');
            const res = await fetch(`${AUTOMATION_URL}/api/bookings`);
            if (!res.ok) {
                console.warn('[AUTOMATION] Крайната точка за резервации не успя:', res.status);
                return [];
            }
            const bookings = await res.json();
            console.log('[AUTOMATION] Получени', bookings.length, 'резервации');
            return bookings;
        } catch (e) {
            console.error('[AUTOMATION] Получаването на резервации не успя:', e.message);
            return [];
        }
    }
};

// ============================================================================
// СЛОЙ ЗА СИГУРНОСТ: ОПРЕДЕЛЯНЕ НА РОЛЯТА НА ПОТРЕБИТЕЛЯ
// ============================================================================

/**
 * ЖЕЛЕЗОБЕТОННА ВЕРИФИКАЦИЯ НА ДОМАКИНА - ТОЧНО СЪОТВЕТСТВИЕ НА КОД
 * 
 * Определя дали потребителят е ДОМАКИНА, като сравнява с process.env.HOST_CODE
 * КРИТИЧНА СИГУРНОСТ: Използва === за ТОЧНО съответствие на строка
 * ЗАБРАНЕНО: .includes(), размито съвпадение или частично сравнение на низове
 * 
 * @private
 * @param {string|null} authCode - Код от заглавка за разрешение или форма
 * @param {string|null} userMessage - Съобщение на потребителя (проверено за вграден код)
 * @returns {boolean} True само ако е намерено ТОЧНО съответствие
 */
function isHostVerified(authCode, userMessage) {
    // ПРАВИЛО НА СИГУРНОСТ #1: СЪДЪРЖАНЕ НА КОД НА ДОМАКИНА
    // Проверява дали authCode или съобщението СЪДЪРЖА HOST_CODE
    
    // Проверка дали HOST_CODE е дефиниран
    if (!HOST_CODE) {
        console.error('[SECURITY] ❌ КРИТИЧНО: HOST_CODE не е конфигуран в Render environment');
        return false;
    }
    
    console.log('[SECURITY] Верификация на домакина: проверявам authCode...');
    // Нормализирай authCode за whitespace проблеми от JSON
    if (authCode) {
        const normalizedAuthCode = String(authCode).trim().toLowerCase();
        const normalizedHostCode = String(HOST_CODE).trim().toLowerCase();
        
        console.log(`[SECURITY] DEBUG: authCode="${normalizedAuthCode}" (${normalizedAuthCode.length} знака)`);
        console.log(`[SECURITY] DEBUG: HOST_CODE="${normalizedHostCode}" (${normalizedHostCode.length} знака)`);
        
        // Проверява ТОЧНО съответствие (case-insensitive)
        if (normalizedAuthCode === normalizedHostCode) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: authCode съвпада с HOST_CODE');
            return true;
        }
    }

    if (userMessage) {
        console.log('[SECURITY] Верификация на домакина: проверявам userMessage...');
        const trimmedMessage = String(userMessage).trim().toLowerCase();
        const normalizedHostCode = String(HOST_CODE).trim().toLowerCase();

        // 1) Точно съответствие на целото съобщение
        if (trimmedMessage === normalizedHostCode) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: userMessage съвпада с HOST_CODE');
            return true;
        }

        // 2) Точно съответствие вътре в съобщението (работи и при кодове със символи)
        const escapedHostCode = normalizedHostCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hostCodePattern = new RegExp(`(^|[^a-z0-9])${escapedHostCode}([^a-z0-9]|$)`, 'i');
        if (hostCodePattern.test(trimmedMessage)) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: намерен точен HOST_CODE в userMessage');
            return true;
        }
    }

    console.log('[SECURITY] ❌ Верификация на домакина НЕУДАЧНА: не е намерено съответствие');
    return false;
}

/**
 * Проверка за домакински код в последните user съобщения от history
 * Използва се за устойчивост в chat сесия без token.
 *
 * @param {Array} history
 * @returns {boolean}
 */
function isHostVerifiedInHistory(history = []) {
    if (!HOST_CODE || !Array.isArray(history) || history.length === 0) return false;

    const normalizedHostCode = String(HOST_CODE).trim().toLowerCase();
    const escapedHostCode = normalizedHostCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hostCodePattern = new RegExp(`(^|[^a-z0-9])${escapedHostCode}([^a-z0-9]|$)`, 'i');

    const recentUserMessages = history
        .filter(msg => msg && msg.role === 'user' && typeof msg.content === 'string')
        .slice(-12);

    for (let index = recentUserMessages.length - 1; index >= 0; index--) {
        const text = String(recentUserMessages[index].content || '').trim().toLowerCase();
        if (!text) continue;
        if (text === normalizedHostCode || hostCodePattern.test(text)) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: HOST_CODE намерен в history');
            return true;
        }
    }

    return false;
}

function detectPowerCommandIntent(rawMessage = '') {
    const normalizedText = String(rawMessage || '').toLowerCase();
    if (!normalizedText.trim()) {
        return { isInclude: false, isExclude: false };
    }

    const cleaned = normalizedText.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
    const tokens = new Set(cleaned.split(/\s+/).filter(Boolean));

    const excludeTokenHits = [
        'изключи', 'изключа', 'изключване', 'изключвам',
        'спри', 'спирай', 'спиране',
        'угаси', 'угаси', 'угасване',
        'изгаси', 'изгася', 'изгасване',
        'κλείσε', 'κλεισε', 'κλείσιμο',
        'σβήσε', 'σβησε',
        'σταμάτα', 'σταματα',
        'opreste', 'oprește', 'oprire', 'stinge', 'stingeți',
        'iskljuci', 'isključi', 'ugasite', 'ugasi', 'stani', 'stani',
        'искључи', 'угаси', 'стани',
        'исклучи', 'изгаси', 'згасни', 'стопирај', 'сопри',
        'ausschalten', 'ausschalte', 'ausmachen', 'aus', 'stoppen',
        'kapat', 'kapatın', 'kapatin', 'durdur', 'söndür', 'sondur',
        'off'
    ];
    const includeTokenHits = [
        'включи', 'включа', 'включване', 'включвам',
        'пусни', 'пусна', 'пуснеш', 'пускане',
        'цъкни', 'цъкна',
        'възстанови', 'възстановяване',
        'άναψε', 'αναψε',
        'άνοιξε', 'ανοιξε', 'άνοιγμα',
        'porneste', 'pornește', 'aprinde', 'activeaza', 'activează',
        'ukljuci', 'uključi', 'upali', 'pokreni',
        'укључи', 'упали', 'покрени',
        'вклучи', 'вклучи', 'пушти', 'уклучи',
        'einschalten', 'einschalte', 'anmachen', 'anmachen',
        'aç', 'ac', 'açın', 'acin', 'yak',
        'on'
    ];

    const hasExcludeToken = excludeTokenHits.some(token => tokens.has(token));
    const hasExcludePhrase = /power\s*off|turn\s*off|cut\s*power|κλείσε\s+το\s+ρεύμα|κλεισε\s+το\s+ρευμα|σβήσε\s+το\s+ρεύμα|σβησε\s+το\s+ρευμα|opreste\s+curentul|oprește\s+curentul|stinge\s+curentul|iskljuci\s+struju|isključi\s+struju|угаси\s+струју|исклучи\s+струја|aus\s+strom|strom\s+aus|schalte\s+strom\s+aus|elektriği\s+kapat|elektrigi\s+kapat/i.test(normalizedText);
    const isExclude = hasExcludeToken || hasExcludePhrase;

    const hasIncludeToken = includeTokenHits.some(token => tokens.has(token)) || /дай\s+ток/i.test(normalizedText);
    const hasIncludePhrase = /power\s*on|turn\s*on|restore\s*power|άναψε\s+το\s+ρεύμα|αναψε\s+το\s+ρευμα|άνοιξε\s+το\s+ρεύμα|ανοιξε\s+το\s+ρευμα|porneste\s+curentul|pornește\s+curentul|aprinde\s+curentul|ukljuci\s+struju|uključi\s+struju|укључи\s+струју|вклучи\s+струја|strom\s+an|schalte\s+strom\s+ein|elektriği\s+aç|elektrigi\s+ac/i.test(normalizedText);
    const isInclude = !isExclude && (hasIncludeToken || hasIncludePhrase);

    return { isInclude, isExclude };
}

function isLikelyPowerCommand(userMessage = '') {
    const { isInclude, isExclude } = detectPowerCommandIntent(userMessage);
    if (isInclude || isExclude) return true;

    const text = String(userMessage || '');
    return /включи|включване|пусни|пуснеш|цъкни|възстанови|спри|изключи|угаси|изгаси|power\s*on|power\s*off|turn\s*on|turn\s*off|restore\s*power|cut\s*power|άναψε|αναψε|άνοιξε|ανοιξε|κλείσε|κλεισε|σβήσε|σβησε|σταμάτα|σταματα|porneste|pornește|aprinde|activeaza|activează|opreste|oprește|stinge|ukljuci|uključi|iskljuci|isključi|укључи|искључи|вклучи|исклучи|einschalten|ausschalten|anmachen|ausmachen|strom\s+an|strom\s+aus|aç|ac|kapat|durdur|söndür|sondur/i.test(text);
}

/**
 * ВЕРИФИКАЦИЯ НА ГОСТ ЧРЕЗ HM КОДОВЕ НА РЕЗЕРВАЦИИ
 * 
 * Използва regex за извличане на HM кодове от съобщения и верификация срещу таблица резервации
 * HM кодове са уникални идентификатори на резервации на гости
 * 
 * @private
 * @async
 * @param {string|null} authCode - Код, предоставен в заглавката за разрешение
 * @param {string} userMessage - Съобщение потенциално съдържащо HM код
 * @returns {Promise<{role: 'guest'|'stranger', booking: Object|null}>}
 */
async function verifyGuestByHMCode(authCode, userMessage, history = []) {
    console.log('[SECURITY] Верификация на гост: търся HM код...');
    
    // ПРАВИЛО НА СИГУРНОСТ #2: REGEX ШАБЛОН ЗА HM КОДОВЕ
    // Шаблон: HM seguito от алфанумерични знаци (формат на код на резервация)
    const hmCodePattern = /HM[A-Z0-9_-]+/i;
    
    // Проверя authCode първо
    let codeToVerify = null;
    if (authCode && hmCodePattern.test(authCode)) {
        codeToVerify = authCode.toUpperCase();
        console.log('[SECURITY] HM код намерен в authCode:', codeToVerify);
    }
    
    // Проверя userMessage за вграден HM код
    if (!codeToVerify && userMessage) {
        const match = userMessage.match(hmCodePattern);
        if (match) {
            codeToVerify = match[0].toUpperCase();
            console.log('[SECURITY] HM код намерен в userMessage:', codeToVerify);
        }
    }

    // Проверя recent user history (ако текущото съобщение е от типа "провери пак")
    if (!codeToVerify && Array.isArray(history)) {
        for (let index = history.length - 1; index >= 0; index--) {
            const msg = history[index];
            if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') continue;
            const match = msg.content.match(hmCodePattern);
            if (match) {
                codeToVerify = match[0].toUpperCase();
                console.log('[SECURITY] HM код намерен в history:', codeToVerify);
                break;
            }
        }
    }

    if (!codeToVerify) {
        console.log('[SECURITY] Не е намерен HM код в authCode или съобщение');
        return { role: 'stranger', booking: null };
    }

    // Ако нямаме база данни, не можем да верифицираме
    if (!sql) {
        console.warn('[DATABASE] SQL клиент не е инициализиран - не мога да верифицирам HM код');
        return { role: 'stranger', booking: null };
    }

        try {
                const normalizedReservationCode = codeToVerify.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        console.log('[DATABASE] Запитвам таблица резервации за HM код:', codeToVerify);
        const bookings = await sql`
            SELECT * FROM bookings 
                        WHERE regexp_replace(UPPER(reservation_code), '[^A-Z0-9]', '', 'g') = ${normalizedReservationCode}
              AND COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                            AND (check_in - make_interval(hours => ${ACCESS_START_BEFORE_CHECKIN_HOURS})) <= NOW()
                            AND (check_out + make_interval(hours => ${ACCESS_END_AFTER_CHECKOUT_HOURS})) > NOW()
            LIMIT 1
        `;

        if (bookings.length > 0) {
            const booking = bookings[0];
            console.log('[DATABASE] ✅ Резервация намерена за код:', codeToVerify);
            console.log('[DATABASE] Име на гост:', booking.guest_name);
            return { role: 'guest', booking };
        }

        // Допълнителен диагностичен лог: кодът съществува ли, но е изтекъл/анулиран
        const archived = await sql`
            SELECT reservation_code, payment_status, check_out
            FROM bookings
            WHERE regexp_replace(UPPER(reservation_code), '[^A-Z0-9]', '', 'g') = ${normalizedReservationCode}
            LIMIT 1
        `;
        if (archived.length > 0) {
            console.log('[DATABASE] ⚠️ Кодът съществува, но не е активен (изтекъл или анулиран):', codeToVerify);
        }

        console.log('[DATABASE] ❌ Не е намерена резервация за HM код:', codeToVerify);
        return { role: 'stranger', booking: null };
    } catch (e) {
        console.error('[DATABASE] Грешка при запитване на резервации:', e.message);
        return { role: 'stranger', booking: null };
    }
}

/**
 * ЛОГИКА НА ХРАНИЛИЩЕ НА ЩИФТОВЕ - АВТОМАТИЧНО РАЗПРЕДЕЛЯНЕ
 * 
 * Вземи първия неизползван щифт от таблица pin_depot
 * Маркира го като използван в база данни
 * Актуализира резервацията на гост със своя назначен щифт
 * 
 * КРИТИЧНО: Вика се само веднъж на гост (проверено по съществуване на lock_pin)
 * Гарантира, че всеки гост получава уникален щифт за достъп до имота
 * 
 * @private
 * @async
 * @param {Object} booking - Обект резервация от база данни
 * @returns {Promise<string|null>} Назначен щифт код или null ако няма налични
 */
export async function assignPinFromDepot(booking) {
    console.log('[PIN_DEPOT] Проверявам дали гост вече има щифт...');
    
    // Ако гост вече има щифт, го върни
    if (booking.lock_pin) {
        console.log('[PIN_DEPOT] Гост вече има назначен щифт:', booking.lock_pin);
        return booking.lock_pin;
    }

    console.log('[PIN_DEPOT] Гост все още нема щифт - вземам от хранилище...');

    if (!sql) {
        console.warn('[PIN_DEPOT] SQL не е налично - не мога да назнача щифт');
        return null;
    }

    try {
        console.log('[DATABASE] Запитвам pin_depot за първи неизползван щифт...');
        const freePins = await sql`
            SELECT id, pin_code FROM pin_depot 
            WHERE is_used = FALSE 
            ORDER BY id ASC 
            LIMIT 1
        `;

        if (freePins.length === 0) {
            console.error('[PIN_DEPOT] ❌ Нямаме налични неизползвани щифтове в хранилището!');
            return null;
        }

        const pin = freePins[0];
        console.log('[PIN_DEPOT] Намерен налична щифт, маркирам като използван:', pin.pin_code);

        // Маркира щифта като използван в хранилището
        await sql`
            UPDATE pin_depot 
            SET is_used = TRUE, assigned_at = NOW()
            WHERE id = ${pin.id}
        `;
        console.log('[PIN_DEPOT] ✅ Щифт маркиран като използван в хранилището');

        // Актуализира резервацията с новия щифт
        console.log('[DATABASE] Назначавам щифт на запис резервация...');
        await sql`
            UPDATE bookings 
            SET lock_pin = ${pin.pin_code}, pin_assigned_at = NOW()
            WHERE id = ${booking.id}
        `;
        console.log('[PIN_DEPOT] ✅ Щифт назначен на резервация на гост:', pin.pin_code);

        return pin.pin_code;
    } catch (e) {
        console.error('[PIN_DEPOT] Грешка при разпределяне на щифт:', e.message);
        return null;
    }
}

/**
 * ОСНОВНА ФУНКЦИЯ ЗА ОПРЕДЕЛЯНЕ НА РОЛЯТА
 * 
 * Организира всички проверки за сигурност, за да определи ролята на потребителя:
 * 1. Е ли потребителят ДОМАКИНА? (ТОЧНО съответствие на код)
 * 2. Е ли потребителят ГОСТ? (HM верификация на код в база данни)
 * 3. В противния случай: НЕПОЗНАТ (ограничен достъп)
 * 
 * За гости, също обработва разпределяне на щифт от хранилище
 * 
 * @async
 * @param {string|null} authCode - Код за разрешение от заявка
 * @param {string|null} userMessage - Текст на съобщение на потребителя
 * @returns {Promise<{role: 'host'|'guest'|'stranger', data: Object|null}>}
 *          Връща ролята и свързаните метаданни (инфо на гост, данни на резервация)
 */
export async function determineUserRole(authCode, userMessage, history = []) {
    console.log('\n[SECURITY] ========== НАЧАЛО ОПРЕДЕЛЯНЕ НА РОЛЯТА НА ПОТРЕБИТЕЛЯ ==========');
    console.log('[SECURITY] authCode/token предоставен:', !!authCode);
    console.log('[SECURITY] userMessage предоставен:', !!userMessage);

    // ПРОВЕРКА #0: ВАЛИДИРАНЕ НА SESSION TOKEN (НОВО)
    if (authCode) {
        const sessionToken = validateToken(authCode);  // ← Използва функцията от sessionManager
        if (sessionToken) {
            console.log(`[SECURITY] ✅ SESSION TOKEN валиден за ${sessionToken.role}`);
            console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
            return { role: sessionToken.role, data: null };
        }
    }

    // ПРОВЕРКА #1: ВЕРИФИКАЦИЯ НА ДОМАКИНА (ТОЧНО СЪОТВЕТСТВИЕ НА КОД)
    if (isHostVerified(authCode, userMessage)) {
        console.log('[SECURITY] Определена роля: ДОМАКИН');
        console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
        return { role: 'host', data: null };
    }

    // ПРОВЕРКА #2: ВЕРИФИКАЦИЯ НА ГОСТ (HM КОД В БАЗА ДАННИ)
    const guestCheck = await verifyGuestByHMCode(authCode, userMessage, history);
    if (guestCheck.role === 'guest' && guestCheck.booking) {
        const booking = guestCheck.booking;
        console.log('[PIN_DEPOT] Четя щифт за гост от резервация...');

        // Четем щифта из резервация (детектив вече го е разпределил)
        const lockPin = booking.lock_pin;

        const guestData = {
            guest_name: booking.guest_name,
            reservation_code: booking.reservation_code,
            check_in: booking.check_in,
            check_out: booking.check_out,
            lock_pin: lockPin,
            booking_id: booking.id
        };

        console.log('[SECURITY] Определена роля: ГОСТ');
        console.log('[SECURITY] Данни на гост подготвени:', guestData.guest_name);
        console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
        return { role: 'guest', data: guestData };
    }

    // ПРОВЕРКА #2.5: ВЕРИФИКАЦИЯ НА ДОМАКИНА ОТ HISTORY (fallback за chat сесии без token)
    // ВАЖНО: изпълнява се СЛЕД guest верификация, за да не засенчва валиден HM код.
    if (isHostVerifiedInHistory(history)) {
        console.log('[SECURITY] Определена роля: ДОМАКИН (history fallback)');
        console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
        return { role: 'host', data: null };
    }

    // ПО ПОДРАЗБИРАНЕ: НЕПОЗНАТ (ОГРАНИЧЕН ДОСТЪП)
    console.log('[SECURITY] Определена роля: НЕПОЗНАТ');
    console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
    return { role: 'stranger', data: null };
}

// ============================================================================
// СТРОИТЕЛ НА СИСТЕМНО УКАЗАНИЕ - SINGLE SOURCE OF TRUTH (SSoT) АРХИТЕКТУРА
// ============================================================================

/**
 * ⚙️ АНАЛИЗ НА РЕФАКТОРИРАНЕ - SINGLE SOURCE OF TRUTH ПРИНЦИП
 * 
 * ПРОБЛЕМ - Старата версия:
 * ❌ Хардкодирани данни вътре в JavaScript (Apartment D105, SmartStay_Guest, etc.)
 * ❌ Дублирана информация между JavaScript и manual.txt
 * ❌ AI беше подвластен на JavaScript логика, не на manual
 * ❌ Сложност и конфликти при актуализирани на имота
 * 
 * РЕШЕНИЕ - SSoT архитектура:
 * ✅ ЕДИН източник на истина = manual.txt файлът
 * ✅ JavaScript е само "машина за доставка" на данни
 * ✅ Динамични данни = bookingData + powerStatus
 * ✅ AI инструкции наказват: "Използвай САМО manual съдържанието"
 * 
 * ПОТОК НА ИНФОРМАЦИЯ:
 * 1. manual.txt (всичко за имота - WiFi, правила, удобства, контакти)
 * 2. bookingData (кой е гостът, когато пристига, когато си тръгва)
 * 3. powerStatus (дали тока е работи)
 * 4. currentDateTime (когато е сега)
 * 5. role (домакин/гост/непознат) => ДОСТЪП ДО manual
 * 
 * ВХОД: function buildSystemInstruction(role, data, powerStatus, manual, currentDateTime)
 * ИЗХОД: Системна инструкция за AI (базирана на role + manual + динамични данни)
 * 
 * @param {string} role - 'host' | 'guest' | 'stranger' (от determineUserRole)
 * @param {Object|null} data - Всичко за гост или null: {guest_name, reservation_code, check_in, check_out, lock_pin, booking_id}
 * @param {Object} powerStatus - {online: boolean, isOn: boolean}
 * @param {string} manual - Пълното съдържание на manual.txt (вход от файл или PUBLIC_INFO_FALLBACK)
 * @param {string} currentDateTime - ISO дата/час на български
 * @returns {string} Системна инструкция за Gemini AI (с СТРОГИ правила за manual-only)
 */
export function buildSystemInstruction(role, data, powerStatus, manual, currentDateTime, preferredLanguage = 'bg') {
    const { online, isOn } = powerStatus;
    const languageInstruction = preferredLanguage === 'en'
        ? 'Respond in ENGLISH. Keep answers concise, clear, and practical.'
        : 'Отговаряй на БЪЛГАРСКИ език. Тон: приветлив, професионален, насочен към помощ.';
    
    // АНАЛИЗ: Логиране на входни параметри (за дебъг)
    console.log('[AI:SSoT] 🏗️ Строя системно указание със SSoT архитектура');
    console.log('[AI:SSoT] Role:', role, '| Manual дължина:', manual.length, 'байта');
    console.log('[AI:SSoT] Power: онлайн=' + online + ', включен=' + isOn);
    if (data) {
        console.log('[AI:SSoT] Guest data: ' + data.guest_name + ' (период: ' + new Date(data.check_in).toLocaleDateString('bg-BG') + ' - ' + new Date(data.check_out).toLocaleDateString('bg-BG') + ')');
    }

    // ============================================================================
    // ДИНАМИЧЕН BASE БЛОК - Еднакъв за всички роли
    // КРИТИЧНО: Само текущо време и статус, БЕЗ хардкодирани детайли
    // ============================================================================
    const baseBlock = `
⏰ ДАТА И ЧАС: ${currentDateTime} (българска часова зона)
🔌 СТАТУС НА СИСТЕМАТА: ${online && isOn ? '✅ ОНЛАЙН И ВКЛЮЧЕН' : online && !isOn ? '⚠️ ОНЛАЙН НО ИЗКЛЮЧЕН' : '❌ ОФЛАЙН'}
`;

    // ============================================================================
    // ROLE-SPECIFIC БЛОКОВЕ - Минимално и фокусирано
    // ============================================================================
    let roleBlock = '';
    let accessWarning = '';

    if (role === 'host') {
        console.log('[AI:SSoT] 👑 Режим ДОМАКИН - Пълен административен достъп');
        roleBlock = `
🔐 НИВО НА ДОСТЪП: АДМИНИСТРАТОР
📋 ФУНКЦИИ: Управление на имот, гости, известувания, диагностика на ток
`;
    } else if (role === 'guest') {
        console.log('[AI:SSoT] 👤 Режим ГОСТ - Ограничен достъп базиран на резервация');
        
        // КРИТИЧНО: Само ако имаме действителна резервация
        if (data) {
            roleBlock = `
🔐 НИВО НА ДОСТЪП: ГОСТ
📋 ФУНКЦИИ: Отговаряй само на конкретния въпрос на госта, без да изписваш пълен пакет с контакти/пароли/инструкции предварително.
📌 ПРАВИЛО: Давай само минималната нуждна информация за искането. Ако питат за Wi‑Fi, дай Wi‑Fi. Ако питат за контакти, дай контакти. Ако не питат, не ги изписвай.
`;
        } else {
            console.warn('[AI:SSoT] ⚠️ ГОСТ без данни за резервация - нещо е грешно!');
            roleBlock = `
🔐 НИВО НА ДОСТЪП: ГОСТ (резервация не намерена)
`;
        }
    } else if (role === 'stranger') {
        console.log('[AI:SSoT] 🚫 Режим НЕПОЗНАТ - Защитена публична информация');
        accessWarning = `
🔓 ⚠️ ЗАЩИТА НА ДОСТЪПА:
   Вече немаш активна резервация. Видима е САМО публична информация.
    За полен достъп: въведи своя код за резервация или направи нова резервация.
`;
    }

    // ЯЗЫКОВИ ПРАВИЛА - INTELLIGENT MODE (CONTEXT-AWARE FILTERING)
    // АНАЛИЗ: Интелигентен режим - разрешава общите познания за неимотни въпроси
    // ============================================================================
    const strictInstructions = `

════════════════════════════════════════════════════════════════════════
🧠 ИНТЕЛИГЕНТНО РЕЖИМ ЗА AI АСИСТЕНТА (INTELLIGENT FILTERING)
════════════════════════════════════════════════════════════════════════

✅ ПРАВИЛО 1 - ИНФОРМАЦИЯ ЗА ИМОТА (STRICT MODE - ПЪЛНА ИНФОРМАЦИЯ):
   • Въпроси за имот / комплекс → ВСЯКА релевантна информация от MANUAL
   • Въпроси за удобства → ВСИЧКИ: кухненски бокс, отопление, бойлер, техника, СПА, басейн, паркинг
   • Въпроси за район → ВСИЧКИ: магазини, ресторанти, здравеопазване, адрес, разположение
   • Въпроси за контакти / правила / WiFi / кодове → САМО от MANUAL, НЕ измислени!
   • Въпроси за комплекс и апартамент ЕДНОВРЕМЕННО → ЦЯЛАТА информация: апартамент + 4 блока + удобства + район
   ⚠️ ЗАБРАНЕНО: Частични отговори! Ако питат за комплекса, включи ВСИЧКИ секции от MANUAL!

✅ ПРАВИЛО 2 - ОБЩИ ПОЗНАНИЯ (NATURAL MODE):
   • Въпроси за метеорология, география, история → Ползвай знанието си
   • Математика, наука, съвети, препоръки → Ползвай знанието си
   • Информация за България, региона, местоположението → Ползвай знанието си
   • Полезни советики за туристи, пътуване → Ползвай знанието си
   🎯 Цел: Помогни на гост като интелигентен асистент, не като файл читач

✅ ПРАВИЛО 3 - ГИБРИДНА КОМБИНИРАНА ЛОГИКА:
   • Ако въпросът смесва имот + общо (e.g. "Близо ли е до плажа?"):
     → Начало: "Според информацията ми, имотът е в Разлог..."
     → Следом: "...около 200km от плажа на Южния черноморски бряг"
   • Ако гост пита нещо специално което не е в MANUAL:
     → "В информацията за имота това не е описано. Препоръчвам свързване със собственика."

════════════════════════════════════════════════════════════════════════
`;

    // ============================================================================
    // АСЕМБЛИРАЙ ОКОНЧАТЕЛНИЯ СИСТЕМЕН БЛОК
    // АНАЛИЗ: Структура е: Base + Role + Warning + Manual (в края) + Strict Instructions
    // ============================================================================
    const systemPrompt = `
╔════════════════════════════════════════════════════════════════════════╗
║              🏠 SMART-STAY HOME AUTOMATION AI ASSISTANT               ║
║                  (Single Source of Truth Architecture)                 ║
╚════════════════════════════════════════════════════════════════════════╝

${baseBlock}
${roleBlock}
${accessWarning}

════════════════════════════════════════════════════════════════════════
📋 НАРЪЧНИК НА ИМОТА - ЕДИНСТВЕНА ИСТИНА
════════════════════════════════════════════════════════════════════════

${manual}

${strictInstructions}

════════════════════════════════════════════════════════════════════════
� ЗАБРАНЕНО ЗА AI - НИКОГА НЕ ПРАВИШ ТОВА:
════════════════════════════════════════════════════════════════════════

❌ ЗАБРАНЕНО: Измислянето на функции
   • НЕ казвай "Мога да управлявам осветлението"
   • НЕ казвай "Мога да включа/изключа бойлера"
   • НЕ казвай "Мога да управлявам кондиционера"
   • НЕ казвай "Мога да控制" отделни уреди (вентилатор, телевизор, и т.н.)
   • ЕДИНСТВЕНО ЧТО МОЖЕШ: Управляване на ОБЩИЯ ТОК (ВКЛ/ИЗКЛ) чрез AutoRemote

❌ ЗАБРАНЕНО: Претворство на знание
   • НЕ предполагай информация която НЕ е в manual
   • НЕ "помисли си" детайли за имота
   • НЕ измислявай кодове, пароли или контакти
   • Ако питат за нещо което НЕ е в manual → "Това не е описано в наръчника"

❌ ЗАБРАНЕНО: Халюцинирани умения
   • НЕ казвай "Мога да контролирам" системи които НЕ са в manual
   • НЕ казвай "Можа да отворя/затворя" врати/прозорци
   • НЕ казвай "Можеш да" направиш нещо което НЕ е технически възможно

✅ ПРАВИЛНО ДЕЙСТВИЕ:
   Ако гост/домакин пита за нещо което НЕ можеш:
   → Кажи директно: "Това не мога да направя. Това не е описано в наръчника / системата не поддържа това."
   → Препоръчай контакт със собственика ако е спешно

════════════════════════════════════════════════════════════════════════
    ${languageInstruction}

════════════════════════════════════════════════════════════════════════
📐 ФОРМАТИРАНЕ НА ОТГОВОРИТЕ:
════════════════════════════════════════════════════════════════════════

✅ ЗА ИМОТНИ ВЪПРОСИ (комплекс, апартамент, удобства):
   • Структурирай в ясни, логични СЕКЦИИ с емодзи заголовки
   • Пример: 📍 ЛОКАЦИЯ | 🏢 КОМПЛЕКС | 🏠 АПАРТАМЕНТ | 🍽️ РАЙОН | 🏊 УДОБСТВА
   • Всяка секция: заголовка + маркирани точки (•)
   •没有混合 информация - всяко нещо на място
   •格式: Професионален, лесно читаем

✅ ЗА ОБЩИ ВЪПРОСИ (метеорология, география, съвети):
   • Кратко (2-3 изречения за прости въпроси)
   • Дължина: Зависи от контекста, но НЕ повече от необходимото
   • Тонът: Информативен и практичен

✅ ЗА СМЕСЕНИ ВЪПРОСИ (комплекс + близко до плажа):
   • Начало: Manual информация (структурирана)
   • Преход: "Регионалният контекст:"
   • След това: Географски/туристически контекст

════════════════════════════════════════════════════════════════════════
🎯 ТОНЪТ ПО РОЛЯ:
════════════════════════════════════════════════════════════════════════

👑 ДОМАКИН (host):
   • Кратък и директен
   • Само конкретния отговор

👤 ГОСТ (guest):
   • Приветлив и кратък
   • Само конкретния отговор

🚫 НЕПОЗНАТ (stranger):
   • Учтив и кратък
   • Само публична информация
    • САМО от manual-public
    • БЕЗ външни търсения (Google Places / Directions / Brave)

════════════════════════════════════════════════════════════════════════
⚠️ ОГРАНИЧЕНИЯ НА ФУНКЦИИТЕ (НЕ на общите познания):
════════════════════════════════════════════════════════════════════════

❌ Системата НЯМА управление на отделни уреди:
   • НЕ можеш управлявам осветление, бойлер, кондиционер, телевизор и т.н.
   • ЕДИНСТВЕНО управление: ОБЩ ТОК (ВКЛ/ИЗКЛ) за целия апартамент
   • Ако питат как да управляват уреди → "Нямам достъп до тези системи, съжалявам! Единствено могу да включа или изключа целия ток на апартамента."

❌ За ИМОТНИ детайли: SZIGORODUAN от manual
   • Ако е в manual → цял отговор с данни
   • Ако НЕ е в manual → "Това не мога да вам кажа. Най-добре е да попитате собственика! 😊"
   • Кодове, пароли, контакти → НИКОГА не измислявай! Само точно това което е в manual

✅ За ОБЩИТЕ ПОЗНАНИЯ: Свободен отговор!
   • Виц → КДА, мога да кажа виц! 😄
   • История, география, matematik → ДА, могу!
   • Съвети за туризъм, пътуване → ДА, могу!
   • Препоръки, советики → ДА, могу!
   → Ключ: Общите познания са ПОЗВОЛЕНИ, ограниченията са за ФУНКЦИИ на системата, НЕ за разговор!

════════════════════════════════════════════════════════════════════════
`;

    console.log('[AI:SSoT] ✅ Системна инструкция завършена (' + systemPrompt.length + ' символа)');
    return systemPrompt;
}

// ============================================================================
// АВТОМАТИЗАЦИЯ НА СПЕШНОСТ НА ТОК
// ============================================================================

/**
 * ⏳ ОЧАКВАНЕ НА TASKER ПОТВЪРЖДЕНИЕ
 * 
 * Когато изпратим команда към Tasker, изчакваме реалния отговор
 * Вместо да казваме "включих тока" (лъжа), чакаме 20 сек
 * и тогава казваме реалното состояние
 * 
 * @async
 * @param {boolean} expectedState - Какво состояние очаквам (true за ON, false за OFF)
 * @param {number} timeoutMs - Максимално време за чакане (ms)
 * @returns {Promise<{success: boolean, actualState: boolean|null, waited: number}>}
 */
async function waitForPowerConfirmation(expectedState, timeoutMs = 20000) {
    console.log(`[POWER:WAIT] ⏳ Очаквам потвърждение от Tasker за ${expectedState ? 'ON' : 'OFF'}...`);
    
    const startTime = Date.now();
    const pollInterval = 500; // Проверка всеки 500ms
    
    while (Date.now() - startTime < timeoutMs) {
        const latestStatus = await automationClient.getPowerStatus({ silent: true });
        const currentState = latestStatus?.isOn;
        const hasChanged = currentState === expectedState;
        
        if (hasChanged) {
            const waited = Date.now() - startTime;
            console.log(`[POWER:WAIT] ✅ ПОТВЪРДЕНО! Actual state: ${currentState}, Чакахме: ${waited}ms`);
            return {
                success: true,
                actualState: currentState,
                waited: waited
            };
        }
        
        // Чакай преди следващата проверка
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    // Timeout - не получихме потвърждение
    const waited = Date.now() - startTime;
    console.log(`[POWER:WAIT] ⏰ TIMEOUT! Очаквахме ${expectedState ? 'ON' : 'OFF'}, но не се случи в ${waited}ms`);
    return {
        success: false,
        actualState: null,
        waited: waited
    };
}

/**
 * РАЗПОЗНАВАНЕ НА СПЕШНОСТ НА ТОК И ОТГОВОР
 * 
 * Мониторира съобщенията на гост за оплаквания, свързани с ток
 * Ако гост докладва липса на ток И powerStatus.isOn е false:
 * 1. Автоматично задейства controlPower(true) за възстановяване на ток
 * 2. Изпраща спешно известување до домакина с информация за гост
 * 3. Връща системна бележка, която да се добави към отговор на AI
 * 
 * КРИТИЧНО: Изпълнява се само за ролята ГОСТ (не за непознати или домакини)
 * 
 * Ключни думи, които се разпознават: няма ток, без ток, не работи ток и т.н.
 * 
 * @async
 * @param {string} userMessage - Съобщение на гост
 * @param {string} role - Ролята на потребителя
 * @param {Object|null} bookingData - Информация за резервация на гост
 * @returns {Promise<string>} Системна бележка за добавяне (или празен низ)
 */
export async function checkEmergencyPower(userMessage, role, bookingData) {
    console.log('\n[POWER] Проверявам за спешни ситуации на тока...');

    // АВТОМАТИЗАЦИЯ НА ТОК: За гости и домакини
    if (role !== 'guest' && role !== 'host') {
        console.log('[POWER] Не е гост или домакин - пропускам проверките на ток');
        return "";
    }

    // Разпознава ключови думи на български език, свързани със спешни ситуации
    const emergencyPowerKeywords = /няма ток|без ток|не работи ток|спрян ток|изключен ток|няма енергия|NO POWER|нет тока/i;
    const medicalEmergencyKeywords = /болен|травма|инфаркт|помощ|спешност|здравословен|насилие|пожар/i;
    const powerCommandKeywords = /включи|включване|пусни|пуснеш|цъкни|възстанови|дай\s+ток|изключи|спри|угаси|изгаси|махни\s+тока|power\s*on|power\s*off|turn\s*on|turn\s*off|restore\s*power|cut\s*power|άναψε|αναψε|άνοιξε|ανοιξε|κλείσε|κλεισε|σβήσε|σβησε|σταμάτα|σταματα|porneste|pornește|aprinde|activeaza|activează|opreste|oprește|stinge|ukljuci|uključi|iskljuci|isključi|укључи|искључи|вклучи|исклучи|einschalten|ausschalten|anmachen|ausmachen|strom\s+an|strom\s+aus|aç|ac|kapat|durdur|söndür|sondur/i;
    
    const needsPower = emergencyPowerKeywords.test(userMessage);
    const needsMedical = medicalEmergencyKeywords.test(userMessage);
    const isPowerCommand = powerCommandKeywords.test(userMessage) || isLikelyPowerCommand(userMessage);

    if (!needsPower && !needsMedical && !isPowerCommand) {
        console.log('[POWER] Не са разпознати ключови думи за спешност или команди за управление');
        return "";
    }

    // КОМАНДИ ЗА УПРАВЛЕНИЕ НА ТОК (за всички роли - ако е разпозната команда)
    // Ако има ясна команда за управление на тока, изпълни я независимо от роля
    if (isPowerCommand) {
        console.log('[POWER] 🎯 КОМАНДА ЗА УПРАВЛЕНИЕ НА ТОК РАЗПОЗНАТА (role=' + role + ')');
        const commandSource = role === 'host' ? 'host_command' : 'guest_command';
        
        const { isInclude, isExclude } = detectPowerCommandIntent(userMessage);
        
        if (isInclude) {
            console.log('[POWER] ⚡ КОМАНДА: ВКЛЮЧИ ТОКА');
            await automationClient.controlPower(true, bookingData?.id, commandSource);
            
            // ⏳ ИЗЧАКАЙ РЕАЛНОТО ПОТВЪРЖДЕНИЕ ОТ TASKER
            const confirmation = await waitForPowerConfirmation(true, 20000);
            console.log(`[POWER] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);

            return confirmation.success
                ? 'Разбрах. Пуснах тока и получих потвърждение от системата. ✅'
                : 'Изпратих команда за включване на тока, но още нямам потвърждение от Tasker. Провери след 20-30 секунди.';
        } else if (isExclude) {
            console.log('[POWER] ⚡ КОМАНДА: ИЗКЛЮЧИ ТОКА');
            await automationClient.controlPower(false, bookingData?.id, commandSource);
            
            // ⏳ ИЗЧАКАЙ РЕАЛНОТО ПОТВЪРЖДЕНИЕ ОТ TASKER
            const confirmation = await waitForPowerConfirmation(false, 20000);
            console.log(`[POWER] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);

            return confirmation.success
                ? 'Разбрах. Спрях тока и получих потвърждение от системата. ✅'
                : 'Изпратих команда за спиране на тока, но още нямам потвърждение от Tasker. Провери след 20-30 секунди.';
        }
    }

    // МЕДИЦИНСКА СПЕШНОСТ
    if (needsMedical) {
        console.log('[POWER] 🚑 МЕДИЦИНСКА СПЕШНОСТ РАЗПОЗНАТА: Гост има здравословна проблем!');
        
        // Известява домакина - това е критично
        await automationClient.sendAlert(
            `🚑 МЕДИЦИНСКА СПЕШНОСТ: Гост ${bookingData?.guest_name} (${bookingData?.reservation_code}) докладва здравословна проблем.`,
            {
                guest_name: bookingData?.guest_name || 'Непознат',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role: role,
                timestamp: new Date().toISOString(),
                action: 'medical-emergency',
                severity: 'CRITICAL'
            }
        );
        
        // Остави AI да генерира отговор от manual (където е казано да се обади 112)
        return "";
    }

    console.log('[POWER] ⚠️ СПЕШНОСТ РАЗПОЗНАТА: Гост докладва липса на ток!');

    // ОВЪРАЙД НА ГОСТ: Ако гост се жали на "Няма ток", автоматично включва тока
    // Това е защитна мярка - гостът ще получи ток дори ако е планирано изключване
    console.log('[POWER] 🚨 ОВЪРАЙД НА ГОСТ АКТИВИРАН: Принудително включване на ток');
    
    const overrideSuccess = await automationClient.controlPower(true, bookingData?.id, 'ai_emergency_override');
    
    // ⏳ ИЗЧАКАЙ РЕАЛНОТО ПОТВЪРЖДЕНИЕ ОТ TASKER
    const confirmation = await waitForPowerConfirmation(true, 20000);
    console.log(`[POWER:OVERRIDE] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);

    if (overrideSuccess || confirmation.success) {
        console.log('[POWER] ✅ Команда за возстановяване на ток изпратена успешно');
        
        // Изпраща известуване до домакина
        await automationClient.sendAlert(
            `🚨 СПЕШНО ВЪЗСТАНОВЯВАНЕ НА ТОК: Гост ${bookingData?.guest_name} (${bookingData?.reservation_code}) докладва липса на ток. Ток е включен автоматично.`,
            {
                guest_name: bookingData?.guest_name || 'Непознат',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role: role,
                timestamp: new Date().toISOString(),
                action: 'power-override'
            }
        );

        console.log('[POWER] Известуванието е изпратено до домакина');
        return 'Получих сигнал за липса на ток. Пуснах тока и уведомих домакина. ✅';
    } else {
        console.log('[POWER] ❌ Команда за управление на ток не успя');
        
        // Известува домакина за проблема
        await automationClient.sendAlert(
            `🔴 КРИТИЧНО: Гост ${bookingData?.guest_name} докладва липса на ток, но автоматичното включване не успя. Необходима е преглед.`,
            {
                guest_name: bookingData?.guest_name || 'Непознат',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role: role,
                timestamp: new Date().toISOString(),
                action: 'power-override-failed'
            }
        );
        
        return 'Опитах да включа тока, но автоматичното възстановяване не успя. Уведомих домакина за спешна проверка.';
    }
}

/**
 * Разпознава дали потребителят иска директно управление на тока
 * Използва се за твърда авторизационна бариера преди AI отговор
 *
 * @param {string} userMessage
 * @returns {boolean}
 */
function isPowerCommandRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return isLikelyPowerCommand(userMessage);
}

/**
 * Разпознава въпрос от типа "има ли ток" (само статус)
 * Използва се за кратък детерминистичен отговор без генерация от AI
 *
 * @param {string} userMessage
 * @returns {boolean}
 */
function isPowerStatusRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const statusKeywords = /има ли ток|има ток|няма ли ток|статус на тока|как е токът|токът има ли го|има ли електричество|има електричество|няма електричество|има ли захранване|има захранване|няма захранване|има ли ток в апартамента|ток има ли|power status|is there power|electricity status|is electricity on/i;
    return statusKeywords.test(userMessage);
}

async function getSourcePowerStatus(role, bookingData) {
    if (!sql) return { available: false, state: null };

    const normalizeStatus = (value) => {
        if (typeof value === 'boolean') return value ? 'on' : 'off';
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'on' || normalized === 'off') return normalized;
        if (normalized === 'true' || normalized === '1') return 'on';
        if (normalized === 'false' || normalized === '0') return 'off';
        return null;
    };

    try {
        // За гост: първо опитай ред, свързан с неговата резервация
        if (role === 'guest' && bookingData?.booking_id) {
            const rows = await sql`
                SELECT is_on, timestamp
                FROM power_history
                WHERE booking_id = ${String(bookingData.booking_id)}
                ORDER BY timestamp DESC
                LIMIT 1
            `;
            const status = normalizeStatus(rows[0]?.is_on);
            if (status) {
                return { available: true, state: status };
            }
        }

        if (role === 'guest' && bookingData?.reservation_code) {
            const fallbackRows = await sql`
                SELECT is_on, timestamp
                FROM power_history
                WHERE booking_id = ${String(bookingData.reservation_code)}
                ORDER BY timestamp DESC
                LIMIT 1
            `;
            const fallbackStatus = normalizeStatus(fallbackRows[0]?.is_on);
            if (fallbackStatus) {
                return { available: true, state: fallbackStatus };
            }
        }

        // Source of truth: последният запис в power_history
        const latestRows = await sql`
            SELECT is_on, timestamp
            FROM power_history
            ORDER BY timestamp DESC
            LIMIT 1
        `;

        if (latestRows.length === 0) {
            return { available: true, state: null };
        }

        const status = normalizeStatus(latestRows[0]?.is_on);
        if (status) {
            return { available: true, state: status };
        }

        return { available: true, state: null };
    } catch (error) {
        console.error('[DB] 🔴 Грешка при четене на power_history:', error.message);
        return { available: false, state: null };
    }
}

/**
 * Разпознава въпроси за ролята на потребителя
 *
 * @param {string} userMessage
 * @returns {boolean}
 */
function isRoleIdentityRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const roleKeywords = /какъв съм аз|каква е ролята ми|кой съм аз|дали съм гост|дали съм домакин|am i guest|am i host|what is my role|who am i/i;
    return roleKeywords.test(userMessage);
}

function isReservationRefreshRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const refreshKeywords = /провери пак|провери отново|обнови резервацията|рефрешни резервацията|check again|check my reservation again|refresh reservation|recheck reservation/i;
    return refreshKeywords.test(userMessage);
}

function isReservationCodeIntro(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const introKeywords = /код(ът)?\s*(ми)?\s*за\s*резервация|reservation code|my code is|my reservation is|i am\s+hm[a-z0-9_-]+|i'm\s+hm[a-z0-9_-]+|аз\s+съм\s*hm[a-z0-9_-]+|имам резервация|i have reservation|i have a reservation/i;
    return introKeywords.test(userMessage);
}

function isBareReservationCodeMessage(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const trimmed = String(userMessage).trim();
    return /^HM[A-Z0-9_-]+$/i.test(trimmed);
}

function containsReservationCode(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /HM[A-Z0-9_-]+/i.test(userMessage);
}

function isLockCodeLookupRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /код\s+за\s+бравата|код\s+за\s+вратата|код\s+за\s+вход|lock\s+code|door\s+code|entry\s+code|tuya\s+code|парола\s+за\s+бравата/i.test(userMessage);
}

function isTodayRegistrationsRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const keywords = /каква(и)?\s+регистраци(я|и)\s+има\s+за\s+днес|регистраци(я|и)\s+за\s+днес|резерваци(я|и)\s+за\s+днес|какви\s+резервации\s+има\s+днес|днешн(и|ата)\s+регистраци(я|и)|има\s+ли\s+регистраци(я|и)\s+днес|today registrations|today bookings|bookings for today/i;
    return keywords.test(userMessage);
}

function isActiveNowRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /активни\s+резерваци(я|и)\s+сега|активни\s+регистраци(я|и)\s+сега|колко\s+са\s+активните\s+сега|има\s+ли\s+активни\s+гост(и|а)\s+в\s+момента|кой\s+е\s+настанен\s+в\s+момента|active\s+bookings\s+now|active\s+registrations\s+now/i.test(userMessage);
}

function isTomorrowRegistrationsRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /резерваци(я|и)\s+за\s+утре|регистраци(я|и)\s+за\s+утре|tomorrow\s+bookings|tomorrow\s+registrations/i.test(userMessage);
}

function isCheckoutTodayRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /check\s*-?out\s+днес|напускан(е|ия)\s+днес|излиза(т)?\s+днес|checkout\s+today|check-out\s+today/i.test(userMessage);
}

function isRecentCancelledRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /анулиран(и|ия)\s+(резерваци(я|и))?|cancelled\s+bookings|canceled\s+bookings|анулаци(я|и)\s+последните/i.test(userMessage);
}

function isUnknownPowerStatusRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /unknown\s+power|неизвестен\s+статус\s+на\s+тока|липсващ\s+статус\s+на\s+тока|power_status\s+unknown/i.test(userMessage);
}

function isDatabaseSnapshotRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /прочети\s+базата|чети\s+базата|покажи\s+базата|какво\s+има\s+в\s+базата|покажи\s+данните\s+от\s+bookings|дай\s+справка\s+от\s+базата|статус\s+на\s+базата|резюме\s+от\s+базата|използвай\s+базата|database\s+snapshot|database\s+report|read\s+the\s+database|show\s+database\s+status|bookings\s+database\s+summary/i.test(userMessage);
}

function isLivePlacesLookupRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const text = String(userMessage).toLowerCase();

    const hasServiceIntent = /къде\s+мога\s+да|къде\s+има|какви|какво\s+има|маршрут|маршрути|колко|как\s+да\s+стигна|адрес|телефон|работно\s+време|препоръчай|where\s+can\s+i|where\s+is|what|which|route|routes|how\s+much|how\s+to\s+get|address|phone|opening\s+hours|recommend/i.test(text);
    const hasLocalBusinessKeyword = /кола\s+под\s+наем|наем|rent\s*a\s*car|car\s*rental|аптека|pharmacy|такси|taxi|ресторант|restaurant|кафе|cafe|бар|bar|магазин|shop|supermarket|супермаркет|банкомат|atm|сервиз|service|repair|ски\s*училище|ski\s*school|училище|school|ски\s*гардероб|ski\s*locker|locker|storage|ски\s*под\s*наем|ski\s*rental|голф|golf|спа|spa|масаж|massage|фитнес|gym|басейн|pool|лекар|doctor|болница|hospital|дентист|dentist|пекарна|bakery|маршрут|route|екскурзия|excursion|tour|гид|guide|транспорт|transport|автобус|bus|трансфер|transfer/i.test(text);
    const hasAreaContext = /банско|разлог|в\s+района|наблизо|nearby|in\s+the\s+area|around/i.test(text);

    return (hasServiceIntent && hasLocalBusinessKeyword) || (hasLocalBusinessKeyword && hasAreaContext);
}

function isMapStyleQuestion(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const text = String(userMessage).toLowerCase();

    const hasMapIntent = /къде|какви|маршрут|маршрути|колко|как\s+да\s+стигна|адрес|наблизо|в\s+района|карти|where|which|route|routes|how\s+much|how\s+to\s+get|nearby|map|maps|address|location/i.test(text);
    const hasServiceOrPlace = /под\s+наем|наем|rent|rental|car|кола|аптека|такси|ресторант|кафе|бар|хотел|магазин|банкомат|голф|ски|ски\s*училище|ski\s*school|училище|school|ски\s*гардероб|ski\s*locker|locker|storage|service|pharmacy|taxi|restaurant|hotel|shop|supermarket|atm|golf|ski|spa|massage|gym|pool|doctor|hospital|dentist|bakery|route|excursion|tour|transport|bus|transfer/i.test(text);
    const hasArea = /банско|разлог|bansko|razlog/i.test(text);

    return (hasMapIntent && hasServiceOrPlace) || (hasServiceOrPlace && hasArea);
}

function isDirectionsRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    const text = String(userMessage).toLowerCase();
    return /как\s+да\s+стигна|как\s+да\s+отида|маршрут\s+до|маршрут|route\s+to|directions\s+to|how\s+to\s+get\s+to|how\s+do\s+i\s+get\s+to/i.test(text);
}

function buildDirectionsDestination(userMessage) {
    const text = String(userMessage || '').trim();
    if (!text) return null;

    const patterns = [
        /(?:как\s+да\s+стигна\s+до|как\s+да\s+отида\s+до|маршрут\s+до)\s+(.+)$/i,
        /(?:route\s+to|directions\s+to|how\s+to\s+get\s+to|how\s+do\s+i\s+get\s+to)\s+(.+)$/i,
        /\bдо\s+(.+)$/i,
        /\bto\s+(.+)$/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            const destination = match[1].trim().replace(/[?.!,]+$/, '').trim();
            if (destination.length >= 2) return destination;
        }
    }

    return text.length >= 3 ? text : null;
}

function stripHtmlTags(value = '') {
    return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getDirectionsReply(userMessage, language = 'bg') {
    if (!GOOGLE_DIRECTIONS_API_KEY) return null;

    const destination = buildDirectionsDestination(userMessage);
    if (!destination) return null;

    try {
        const params = new URLSearchParams({
            origin: GOOGLE_DIRECTIONS_DEFAULT_ORIGIN,
            destination,
            mode: 'driving',
            language: language === 'en' ? 'en' : 'bg',
            key: GOOGLE_DIRECTIONS_API_KEY
        });

        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), GOOGLE_DIRECTIONS_TIMEOUT_MS);

        const response = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`, {
            method: 'GET',
            signal: controller.signal
        });

        clearTimeout(timeoutHandle);

        if (!response.ok) {
            const errText = await response.text();
            console.warn('[DIRECTIONS] ⚠️ Грешка при заявка:', response.status, errText);
            return null;
        }

        const data = await response.json();
        if (data?.status !== 'OK' || !Array.isArray(data?.routes) || !data.routes.length) {
            console.warn('[DIRECTIONS] ⚠️ Няма валиден маршрут:', data?.status || 'UNKNOWN');
            return language === 'en'
                ? '✅ SOURCE: Google Directions API (live)\nI could not find a reliable route for this destination right now.'
                : '✅ ИЗТОЧНИК: Google Directions API (live)\nНе успях да намеря надежден маршрут до тази дестинация в момента.';
        }

        const leg = data.routes[0]?.legs?.[0];
        if (!leg) return null;

        const steps = Array.isArray(leg.steps) ? leg.steps.slice(0, 8) : [];
        const stepLines = steps.map((step, index) => {
            const instruction = stripHtmlTags(step?.html_instructions || step?.maneuver || '');
            const distanceText = step?.distance?.text || '';
            const durationText = step?.duration?.text || '';
            return `${index + 1}. ${instruction}${distanceText || durationText ? ` (${distanceText}${distanceText && durationText ? ', ' : ''}${durationText})` : ''}`;
        });

        const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(GOOGLE_DIRECTIONS_DEFAULT_ORIGIN)}&destination=${encodeURIComponent(destination)}&travelmode=driving`;

        if (language === 'en') {
            return `✅ SOURCE: Google Directions API (live)\nRoute from ${leg.start_address || GOOGLE_DIRECTIONS_DEFAULT_ORIGIN} to ${leg.end_address || destination}:\nDistance: ${leg.distance?.text || 'N/A'}\nEstimated time: ${leg.duration?.text || 'N/A'}\n\n${stepLines.join('\n')}\n\nOpen in Google Maps: ${mapsUrl}`;
        }

        return `✅ ИЗТОЧНИК: Google Directions API (live)\nМаршрут от ${leg.start_address || GOOGLE_DIRECTIONS_DEFAULT_ORIGIN} до ${leg.end_address || destination}:\nРазстояние: ${leg.distance?.text || 'N/A'}\nОриентировъчно време: ${leg.duration?.text || 'N/A'}\n\n${stepLines.join('\n')}\n\nОтвори в Google Maps: ${mapsUrl}`;
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.warn(`[DIRECTIONS] ⚠️ Timeout след ${GOOGLE_DIRECTIONS_TIMEOUT_MS}ms`);
            return null;
        }
        console.warn('[DIRECTIONS] ⚠️ Exception:', error.message);
        return null;
    }
}

function buildPlacesSearchQuery(userMessage) {
    const text = String(userMessage || '').trim();
    if (!text) return 'services in Bansko and Razlog';

    if (/банско|разлог|bansko|razlog/i.test(text)) {
        return text;
    }

    return `${text} near Bansko and Razlog`;
}

async function getLivePlacesReply(userMessage, language = 'bg') {
    if (!GOOGLE_PLACES_API_KEY) return null;
    if (isPlacesBlockedNow()) {
        return null;
    }

    try {
        const textQuery = buildPlacesSearchQuery(userMessage);
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), GOOGLE_PLACES_TIMEOUT_MS);
        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
                'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.googleMapsUri'
            },
            body: JSON.stringify({
                textQuery,
                pageSize: Math.max(1, Math.min(GOOGLE_PLACES_MAX_RESULTS, 5)),
                languageCode: language === 'en' ? 'en' : 'bg'
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutHandle);

        if (!response.ok) {
            const errText = await response.text();
            console.warn('[PLACES] ⚠️ Грешка при търсене:', response.status, errText);
            if (shouldTripPlacesCircuitBreaker(response.status, errText)) {
                markPlacesBlocked(response.status === 403 ? 'API_KEY_SERVICE_BLOCKED/PERMISSION_DENIED' : `HTTP_${response.status}`);
            }
            return null;
        }

        const data = await response.json();
        const places = Array.isArray(data?.places) ? data.places : [];

        if (!places.length) {
            return language === 'en'
                ? '✅ SOURCE: Google Maps Places API (live)\nI could not find reliable live map results for this request in Bansko/Razlog right now.'
                : '✅ ИЗТОЧНИК: Google Maps Places API (live)\nНе открих надеждни live резултати в картите за тази заявка в района на Банско/Разлог.';
        }

        const lines = places.map((place, index) => {
            const name = place?.displayName?.text || (language === 'en' ? `Place ${index + 1}` : `Локация ${index + 1}`);
            const address = place?.formattedAddress || (language === 'en' ? 'Address unavailable' : 'Няма адрес');
            const mapsUrl = place?.googleMapsUri || '';
            return mapsUrl
                ? `${index + 1}. ${name}\n   ${address}\n   ${mapsUrl}`
                : `${index + 1}. ${name}\n   ${address}`;
        });

        return language === 'en'
            ? `✅ SOURCE: Google Maps Places API (live)\nLive map results in Bansko/Razlog:\n\n${lines.join('\n\n')}`
            : `✅ ИЗТОЧНИК: Google Maps Places API (live)\nLive резултати от карти за Банско/Разлог:\n\n${lines.join('\n\n')}`;
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.warn(`[PLACES] ⚠️ Timeout след ${GOOGLE_PLACES_TIMEOUT_MS}ms`);
            return null;
        }
        console.warn('[PLACES] ⚠️ Exception:', error.message);
        return null;
    }
}

function isHostDbCatchAllRequest(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') return false;
    return /(база(та)?|database|bookings)/i.test(userMessage) && /(резервац|регистрац|активни|днес|утре|анулиран|справка|статус|summary|report)/i.test(userMessage);
}

async function getDatabaseSnapshotReply(role, language = 'bg') {
    if (role !== 'host') {
        return language === 'en'
            ? 'Database reports are available only for host access.'
            : 'Справките от базата са достъпни само за домакин.';
    }

    if (!sql) {
        return language === 'en'
            ? 'Database is not available right now.'
            : 'Базата данни не е достъпна в момента.';
    }

    try {
        const rows = await sql`
            SELECT
                COUNT(*) FILTER (
                    WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                      AND check_in <= NOW()
                      AND check_out > NOW()
                ) AS active_now,
                COUNT(*) FILTER (
                    WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                      AND check_in < date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia') + INTERVAL '1 day'
                      AND check_out > date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia')
                ) AS today_total,
                COUNT(*) FILTER (
                    WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                      AND check_in < date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia') + INTERVAL '2 day'
                      AND check_out > date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia') + INTERVAL '1 day'
                ) AS tomorrow_total,
                COUNT(*) FILTER (
                    WHERE COALESCE(LOWER(payment_status), '') = 'cancelled'
                      AND check_out >= (NOW() - INTERVAL '7 day')
                ) AS cancelled_last_7d,
                COUNT(*) FILTER (
                    WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                      AND check_in <= NOW()
                      AND check_out > NOW()
                      AND (power_status IS NULL OR LOWER(power_status) = 'unknown')
                ) AS active_unknown_power
            FROM bookings
        `;

        const stats = rows[0] || {};
        const activeNow = Number(stats.active_now || 0);
        const todayTotal = Number(stats.today_total || 0);
        const tomorrowTotal = Number(stats.tomorrow_total || 0);
        const cancelledLast7d = Number(stats.cancelled_last_7d || 0);
        const activeUnknownPower = Number(stats.active_unknown_power || 0);

        if (language === 'en') {
            return `Database snapshot (bookings):\n\n• Active now: ${activeNow}\n• Registrations today: ${todayTotal}\n• Registrations tomorrow: ${tomorrowTotal}\n• Cancelled (last 7 days): ${cancelledLast7d}\n• Active with unknown power: ${activeUnknownPower}`;
        }

        return `Справка от базата (bookings):\n\n• Активни сега: ${activeNow}\n• Регистрации за днес: ${todayTotal}\n• Регистрации за утре: ${tomorrowTotal}\n• Анулирани (последни 7 дни): ${cancelledLast7d}\n• Активни с unknown power: ${activeUnknownPower}`;
    } catch (error) {
        console.error('[HOST] 🔴 Грешка при database snapshot:', error.message);
        return language === 'en'
            ? 'I could not load database snapshot from bookings.'
            : 'Не успях да заредя справка от bookings.';
    }
}

async function getHostReportReply(reportType, role, language = 'bg') {
    if (role !== 'host') {
        return language === 'en'
            ? 'This report is available only for host access.'
            : 'Тази справка е достъпна само за домакин.';
    }

    if (!sql) {
        return language === 'en'
            ? 'Database is not available right now.'
            : 'Базата данни не е достъпна в момента.';
    }

    const dayStartExpr = sql`date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia')`;
    const dayEndExpr = sql`date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia') + INTERVAL '1 day'`;
    const tomorrowStartExpr = sql`date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia') + INTERVAL '1 day'`;
    const tomorrowEndExpr = sql`date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia') + INTERVAL '2 day'`;

    try {
        if (reportType === 'active_now') {
            const rows = await sql`
                SELECT check_in, check_out, payment_status
                FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                  AND check_in <= NOW()
                  AND check_out > NOW()
                ORDER BY check_in ASC
                LIMIT 20
            `;

            if (!rows.length) return language === 'en' ? 'No active registrations right now.' : 'Няма активни регистрации в момента.';
            const locale = language === 'en' ? 'en-GB' : 'bg-BG';
            const lines = rows.map(row => `• ${new Date(row.check_in).toLocaleString(locale, { timeZone: 'Europe/Sofia' })} → ${new Date(row.check_out).toLocaleString(locale, { timeZone: 'Europe/Sofia' })} | ${row.payment_status || 'paid'}`);
            return language === 'en'
                ? `Active registrations now (${rows.length}):\n\n${lines.join('\n')}`
                : `Активни регистрации в момента (${rows.length}):\n\n${lines.join('\n')}`;
        }

        if (reportType === 'tomorrow') {
            const rows = await sql`
                SELECT check_in, check_out, payment_status
                FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                  AND check_in < ${tomorrowEndExpr}
                  AND check_out > ${tomorrowStartExpr}
                ORDER BY check_in ASC
                LIMIT 20
            `;
            if (!rows.length) return language === 'en' ? 'No registrations for tomorrow.' : 'Няма регистрации за утре.';
            const locale = language === 'en' ? 'en-GB' : 'bg-BG';
            const lines = rows.map(row => `• ${new Date(row.check_in).toLocaleString(locale, { timeZone: 'Europe/Sofia' })} → ${new Date(row.check_out).toLocaleString(locale, { timeZone: 'Europe/Sofia' })} | ${row.payment_status || 'paid'}`);
            return language === 'en'
                ? `Registrations for tomorrow (${rows.length}):\n\n${lines.join('\n')}`
                : `Регистрации за утре (${rows.length}):\n\n${lines.join('\n')}`;
        }

        if (reportType === 'checkout_today') {
            const rows = await sql`
                SELECT check_out, payment_status
                FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                  AND check_out >= ${dayStartExpr}
                  AND check_out < ${dayEndExpr}
                ORDER BY check_out ASC
                LIMIT 20
            `;
            if (!rows.length) return language === 'en' ? 'No check-outs for today.' : 'Няма напускания за днес.';
            const locale = language === 'en' ? 'en-GB' : 'bg-BG';
            const lines = rows.map(row => `• ${new Date(row.check_out).toLocaleString(locale, { timeZone: 'Europe/Sofia' })} | ${row.payment_status || 'paid'}`);
            return language === 'en'
                ? `Check-outs today (${rows.length}):\n\n${lines.join('\n')}`
                : `Напускания днес (${rows.length}):\n\n${lines.join('\n')}`;
        }

        if (reportType === 'cancelled_recent') {
            const rows = await sql`
                SELECT check_in, check_out
                FROM bookings
                WHERE COALESCE(LOWER(payment_status), '') = 'cancelled'
                  AND check_out >= (NOW() - INTERVAL '7 day')
                ORDER BY check_out DESC
                LIMIT 20
            `;
            if (!rows.length) return language === 'en' ? 'No cancelled bookings in the last 7 days.' : 'Няма анулирани резервации за последните 7 дни.';
            const locale = language === 'en' ? 'en-GB' : 'bg-BG';
            const lines = rows.map(row => `• ${new Date(row.check_in).toLocaleString(locale, { timeZone: 'Europe/Sofia' })} → ${new Date(row.check_out).toLocaleString(locale, { timeZone: 'Europe/Sofia' })}`);
            return language === 'en'
                ? `Cancelled bookings (last 7 days, ${rows.length}):\n\n${lines.join('\n')}`
                : `Анулирани резервации (последни 7 дни, ${rows.length}):\n\n${lines.join('\n')}`;
        }

        if (reportType === 'unknown_power') {
            const rows = await sql`
                SELECT check_in, check_out, power_status
                FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                  AND check_in <= NOW()
                  AND check_out > NOW()
                  AND (power_status IS NULL OR LOWER(power_status) = 'unknown')
                ORDER BY check_in ASC
                LIMIT 20
            `;
            if (!rows.length) return language === 'en' ? 'No active bookings with unknown power status.' : 'Няма активни резервации с unknown статус на тока.';
            const locale = language === 'en' ? 'en-GB' : 'bg-BG';
            const lines = rows.map(row => `• ${new Date(row.check_in).toLocaleString(locale, { timeZone: 'Europe/Sofia' })} → ${new Date(row.check_out).toLocaleString(locale, { timeZone: 'Europe/Sofia' })}`);
            return language === 'en'
                ? `Active bookings with unknown power status (${rows.length}):\n\n${lines.join('\n')}`
                : `Активни резервации с unknown статус на тока (${rows.length}):\n\n${lines.join('\n')}`;
        }
    } catch (error) {
        console.error('[HOST] 🔴 Грешка при host report:', reportType, error.message);
        return language === 'en'
            ? 'I could not load this report from the database.'
            : 'Не успях да заредя тази справка от базата.';
    }

    return language === 'en' ? 'Unknown report request.' : 'Непознат тип справка.';
}

async function getTodayRegistrationsReply(role, language = 'bg') {
    if (role !== 'host') {
        return language === 'en'
            ? 'This information is available only for host access.'
            : 'Тази информация е достъпна само за домакин.';
    }

    if (!sql) {
        return language === 'en'
            ? 'Database is not available right now.'
            : 'Базата данни не е достъпна в момента.';
    }

    try {
                const rows = await sql`
                        SELECT check_in, check_out, payment_status
            FROM bookings
            WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
              AND check_in < date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia') + INTERVAL '1 day'
              AND check_out > date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia')
            ORDER BY check_in ASC
            LIMIT 20
        `;

        if (!rows || rows.length === 0) {
            return language === 'en'
                ? 'There are no active registrations for today in the database.'
                : 'Няма активни регистрации за днес в базата.';
        }

        const locale = language === 'en' ? 'en-GB' : 'bg-BG';
        const lines = rows.map(row => {
            const inTime = new Date(row.check_in).toLocaleString(locale, { timeZone: 'Europe/Sofia' });
            const outTime = new Date(row.check_out).toLocaleString(locale, { timeZone: 'Europe/Sofia' });
            return `• ${inTime} → ${outTime} | ${row.payment_status || 'paid'}`;
        });

        if (language === 'en') {
            return `Today registrations in the database (${rows.length}):\n\n${lines.join('\n')}`;
        }

        return `Регистрации за днес в базата (${rows.length}):\n\n${lines.join('\n')}`;
    } catch (error) {
        console.error('[HOST] 🔴 Грешка при четене на регистрации за днес:', error.message);
        return language === 'en'
            ? 'I could not load today registrations from the database.'
            : 'Не успях да заредя регистрациите за днес от базата.';
    }
}

async function getLockCodeLookupReply(role, bookingData, language = 'bg') {
    if (role !== 'guest' && role !== 'host') {
        return language === 'en'
            ? 'Lock code details are available only for verified guest or host.'
            : 'Детайли за кода на бравата са достъпни само за верифициран гост или домакин.';
    }

    if (!sql) {
        return language === 'en'
            ? 'Database is not available right now.'
            : 'Базата данни не е достъпна в момента.';
    }

    if (role === 'guest') {
        if (!bookingData?.booking_id) {
            return language === 'en'
                ? 'I cannot find an active reservation linked to this chat.'
                : 'Не намирам активна резервация, свързана с този чат.';
        }

        try {
            const rows = await sql`
                SELECT id, reservation_code, check_in, check_out, lock_pin
                FROM bookings
                WHERE id = ${bookingData.booking_id}
                LIMIT 1
            `;

            if (!rows.length) {
                return language === 'en'
                    ? 'I could not find this booking in the database.'
                    : 'Не намерих тази резервация в базата.';
            }

            const row = rows[0];
            const locale = language === 'en' ? 'en-GB' : 'bg-BG';
            const accessWindow = getLockAccessWindow(row);
            const checkIn = new Date(row.check_in).toLocaleString(locale, { timeZone: 'Europe/Sofia' });
            const checkOut = new Date(row.check_out).toLocaleString(locale, { timeZone: 'Europe/Sofia' });
            const accessFrom = accessWindow.from
                ? accessWindow.from.toLocaleString(locale, { timeZone: 'Europe/Sofia' })
                : checkIn;
            const accessTo = accessWindow.to
                ? accessWindow.to.toLocaleString(locale, { timeZone: 'Europe/Sofia' })
                : checkOut;

            if (row.lock_pin) {
                return language === 'en'
                    ? `I checked the database: a temporary lock code exists for booking ${row.reservation_code}. For security, I do not show the code in chat. It will be provided within the allowed access window: ${accessFrom} → ${accessTo}.`
                    : `Проверих базата: има временен код за бравата за резервация ${row.reservation_code}. От съображения за сигурност не показвам кода в чата. Той ще бъде предоставен в разрешения прозорец за достъп: ${accessFrom} → ${accessTo}.`;
            }

            return language === 'en'
                ? `I checked the database: there is no generated temporary lock code yet for booking ${row.reservation_code}. Reservation period: ${checkIn} → ${checkOut}.`
                : `Проверих базата: все още няма генериран временен код за бравата за резервация ${row.reservation_code}. Период на резервацията: ${checkIn} → ${checkOut}.`;
        } catch (error) {
            console.error('[DB] 🔴 Грешка при lock code lookup (guest):', error.message);
            return language === 'en'
                ? 'I could not read lock code status from the database.'
                : 'Не успях да прочета статуса на кода за бравата от базата.';
        }
    }

    return language === 'en'
        ? 'For host: ask with a specific reservation code (HM...) to check lock code status.'
        : 'За домакин: изпрати конкретен код на резервация (HM...), за да проверя статуса на кода за бравата.';
}

function getLockAccessWindow(bookingData) {
    const checkInTs = new Date(bookingData?.check_in);
    const checkOutTs = new Date(bookingData?.check_out);

    if (Number.isNaN(checkInTs.getTime()) || Number.isNaN(checkOutTs.getTime())) {
        return { from: null, to: null };
    }

    const from = new Date(checkInTs.getTime() - (ACCESS_START_BEFORE_CHECKIN_HOURS * 60 * 60 * 1000));
    const to = new Date(checkOutTs.getTime() + (ACCESS_END_AFTER_CHECKOUT_HOURS * 60 * 60 * 1000));
    return { from, to };
}

function getGuestOnboardingReply(bookingData, language = 'bg') {
    if (!bookingData) {
        return language === 'en'
            ? 'I could not validate an active reservation code.'
            : 'Не успях да валидирам активен код за резервация.';
    }

    const locale = language === 'en' ? 'en-GB' : 'bg-BG';
    const checkIn = new Date(bookingData.check_in).toLocaleString(locale, { timeZone: 'Europe/Sofia' });
    const checkOut = new Date(bookingData.check_out).toLocaleString(locale, { timeZone: 'Europe/Sofia' });
    const accessWindow = getLockAccessWindow(bookingData);
    const accessFrom = accessWindow.from
        ? accessWindow.from.toLocaleString(locale, { timeZone: 'Europe/Sofia' })
        : null;
    const accessTo = accessWindow.to
        ? accessWindow.to.toLocaleString(locale, { timeZone: 'Europe/Sofia' })
        : null;
    const hasLockCodeInDb = Boolean(bookingData.lock_pin);

    if (language === 'en') {
        if (hasLockCodeInDb) {
            return `Welcome, ${bookingData.guest_name}. Your reservation code ${bookingData.reservation_code} is active from ${checkIn} to ${checkOut}. I checked the database: a temporary lock code exists and will be provided in the allowed access window: ${accessFrom || checkIn} → ${accessTo || checkOut}.`;
        }
        return `Welcome, ${bookingData.guest_name}. Your reservation code ${bookingData.reservation_code} is active from ${checkIn} to ${checkOut}. I checked the database: there is no generated temporary lock code yet. Access window: ${accessFrom || checkIn} → ${accessTo || checkOut}.`;
    }

    if (hasLockCodeInDb) {
        return `Привет, ${bookingData.guest_name}. Кодът ви за резервация ${bookingData.reservation_code} е активен за периода от ${checkIn} до ${checkOut}. Проверих базата: има временен код за бравата и той ще бъде предоставен в разрешения прозорец за достъп: ${accessFrom || checkIn} → ${accessTo || checkOut}.`;
    }

    return `Привет, ${bookingData.guest_name}. Кодът ви за резервация ${bookingData.reservation_code} е активен за периода от ${checkIn} до ${checkOut}. Проверих базата: все още няма генериран временен код за бравата. Разрешен прозорец за достъп: ${accessFrom || checkIn} → ${accessTo || checkOut}.`;
}

function getReservationRefreshReply(role, bookingData, language = 'bg') {
    if (role !== 'guest' || !bookingData) {
        return language === 'en'
            ? 'I cannot find an active reservation linked to this chat right now.'
            : 'В момента не намирам активна резервация, свързана с този чат.';
    }

    const locale = language === 'en' ? 'en-GB' : 'bg-BG';
    const checkIn = new Date(bookingData.check_in).toLocaleString(locale, { timeZone: 'Europe/Sofia' });
    const checkOut = new Date(bookingData.check_out).toLocaleString(locale, { timeZone: 'Europe/Sofia' });
    const accessWindow = getLockAccessWindow(bookingData);
    const accessFrom = accessWindow.from
        ? accessWindow.from.toLocaleString(locale, { timeZone: 'Europe/Sofia' })
        : null;
    const accessTo = accessWindow.to
        ? accessWindow.to.toLocaleString(locale, { timeZone: 'Europe/Sofia' })
        : null;

    if (language === 'en') {
        return `I rechecked your reservation in real time.

Reservation code: ${bookingData.reservation_code}
Guest: ${bookingData.guest_name}
Check-in: ${checkIn}
Check-out: ${checkOut}
Temporary lock code: managed in Tuya and sent in the allowed access window
Code validity window (power ON → power OFF): ${accessFrom || checkIn} → ${accessTo || checkOut}`;
    }

    return `Проверих отново резервацията в реално време.

Код за резервация: ${bookingData.reservation_code}
Гост: ${bookingData.guest_name}
Настаняване: ${checkIn}
Напускане: ${checkOut}
Временен код за бравата: управлява се в Tuya и се изпраща в разрешения прозорец за достъп
Валидност на кода (пускане на ток → спиране на ток): ${accessFrom || checkIn} → ${accessTo || checkOut}`;
}

/**
 * Открива предпочитан език от текущо съобщение и history
 * По подразбиране: български
 *
 * @param {string} userMessage
 * @param {Array} history
 * @returns {'bg'|'en'}
 */
function detectPreferredLanguage(userMessage, history = []) {
    const toEnglishRegex = /please in english|in english|speak english|english please|на английски|говори на английски/i;
    const toBulgarianRegex = /на български|говори на български|in bulgarian|bulgarian please|speak bulgarian/i;

    const detectByAlphabet = (text) => {
        const value = String(text || '');
        const latinChars = (value.match(/[A-Za-z]/g) || []).length;
        const cyrillicChars = (value.match(/[А-Яа-яЁё]/g) || []).length;

        if (latinChars === 0 && cyrillicChars === 0) return null;
        if (latinChars >= 6 && latinChars > cyrillicChars * 2) return 'en';
        if (cyrillicChars >= 6 && cyrillicChars > latinChars * 2) return 'bg';

        const englishSignal = /\b(the|and|is|are|please|hello|wifi|password|electricity|booking|reservation|can you|i need)\b/i;
        const bulgarianSignal = /\b(и|или|има|няма|моля|здравей|парола|интернет|резервация|ток|какво|искам)\b/i;
        if (englishSignal.test(value) && !bulgarianSignal.test(value)) return 'en';
        if (bulgarianSignal.test(value) && !englishSignal.test(value)) return 'bg';
        return null;
    };

    const candidates = [
        userMessage,
        ...((Array.isArray(history) ? history : [])
            .slice()
            .reverse()
            .filter(msg => msg && msg.role === 'user' && typeof msg.content === 'string')
            .map(msg => msg.content))
    ];

    for (const text of candidates) {
        if (!text) continue;
        if (toEnglishRegex.test(text)) return 'en';
        if (toBulgarianRegex.test(text)) return 'bg';

        const inferred = detectByAlphabet(text);
        if (inferred) return inferred;
    }

    return 'bg';
}

/**
 * Детерминистичен отговор за текуща роля
 *
 * @param {'host'|'guest'|'stranger'} role
 * @param {'bg'|'en'} language
 * @returns {string}
 */
function getRoleIdentityReply(role, language = 'bg') {
    if (language === 'en') {
        if (role === 'host') return 'You are authenticated as host.';
        if (role === 'guest') return 'You are authenticated as guest.';
        return 'You are currently unauthenticated.';
    }

    if (role === 'host') return 'В момента сте идентифициран като домакин.';
    if (role === 'guest') return 'В момента сте идентифициран като гост.';
    return 'В момента сте неоторизиран потребител.';
}

// ============================================================================
// ОБРАБОТКА НА ИЗВЕСТУВАНИЯ
// ============================================================================

/**
 * ОБРАБОТКА НА ИЗВЕСТУВАТЕЛНИ МАРКЕРИ
 * 
 * Сканира отговор на AI за маркери [ALERT: ...]
 * Извлича съобщение за известуване и го изпраща до домакина чрез услугата за автоматизация
 * Премахва известувателни маркери от отговора преди връщане към потребителя
 * 
 * Формат: [ALERT: Съобщение за изпращане до домакина]
 * 
 * @async
 * @param {string} aiResponse - Текст на отговор от Gemini AI
 * @param {string} role - Ролята на потребителя
 * @param {Object|null} bookingData - Информация за резервация на гост
 * @returns {Promise<string>} Отговор с премахнати известувателни маркери
 */
export async function processAlerts(aiResponse, role, bookingData) {
    console.log('[ALERTS] Сканирам отговор за известувателни маркери...');

    if (!aiResponse.includes('[ALERT:')) {
        console.log('[ALERTS] Не са намерени известувания в отговора');
        return aiResponse;
    }

    const match = aiResponse.match(/\[ALERT:(.*?)\]/);

    if (match && match[1]) {
        const alertMessage = match[1].trim();
        console.log('[ALERTS] Открит известувателен маркер:', alertMessage);

        await automationClient.sendAlert(
            alertMessage,
            {
                guest_name: bookingData?.guest_name || 'Неизвестен гост',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role: role,
                timestamp: new Date().toISOString()
            }
        );

        console.log('[ALERTS] Известуванието е изпратено до домакина успешно');
    }

    const cleanedResponse = aiResponse.replace(/\[ALERT:.*?\]/g, '').trim();
    console.log('[ALERTS] Известувателни маркери премахнати от отговор');
    return cleanedResponse;
}

// ============================================================================
// ГЕНЕРИРАНЕ НА ОТГОВОР НА AI СЪС МНОГОМОДЕЛНА ОТКАЗОВА ЛОГИКА
// ============================================================================

/**
 * Форматира история на разговор за API на Gemini
 * 
 * Приема история в множество формати (JSON низ или масив)
 * Преобразува към формат, съвместим с Gemini, с правилно съпоставяне на ролята
 * 
 * @private
 * @param {string|Array} history - История на разговор
 * @returns {Array} Форматиран масив от съобщения за Gemini
 */
function formatHistory(history) {
    console.log('[HISTORY] Форматирам история на разговор...');
    let parsed = [];

    if (typeof history === 'string') {
        try {
            parsed = JSON.parse(history);
            console.log('[HISTORY] Разбран JSON низ, съобщения:', parsed.length);
        } catch (e) {
            console.error('[HISTORY] Неудача при разбиране на JSON история:', e.message);
            return [];
        }
    } else if (Array.isArray(history)) {
        parsed = history;
        console.log('[HISTORY] Използвам масив история, съобщения:', parsed.length);
    }

    const normalized = parsed
        .filter(msg => msg && typeof msg.content === 'string' && msg.content.trim())
        .map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: String(msg.content).trim() }]
        }));

    while (normalized.length && normalized[0].role !== 'user') {
        normalized.shift();
    }

    if (!normalized.length) {
        console.log('[HISTORY] ℹ️ Няма валидна история за Gemini (или започва с assistant) -> изпращам празна history');
        return [];
    }

    return normalized;
}

/**
 * ОСНОВНА ФУНКЦИЯ ЗА ОТГОВОР НА AI СЪС МНОГОМОДЕЛНА ОТКАЗОВА ЛОГИКА
 * 
 * Организира пълния процес:
 * 1. Валидира входни данни
 * 2. Определя ролята на потребителя (със проверки на сигурност)
 * 3. Зарежда наръчник на имот (почитайки правилата на защитната стена)
 * 4. Получава статус на тока
 * 5. Строи системно указание за ролята
 * 6. Запитва първичния модел Gemini
 * 7. АКО първичния се провали, опитва отказови модели (каскада от 3 модела)
 * 8. Проверява за спешни ситуации на ток и задейства автоматизация
 * 9. Обработва известувателни маркери
 * 10. Връща чист отговор на потребителя
 * 
 * СТРАТЕГИЯ НА ОТКАЗ:
 * - Първо опитва gemini-3-pro-preview
 * - Отказ към gemini-flash-latest ако първичния се провали
 * - Финален отказ към gemini-3-flash-preview
 * - Връща общо съобщение за грешка, ако всички модели се провалят
 * 
 * @async
 * @param {string} userMessage - Входно съобщение на потребителя
 * @param {string|Array} history - История на разговор
 * @param {string|null} authCode - Код за разрешение от заявка
 * @returns {Promise<string>} Текст на отговор на AI на български
 */
export async function getAIResponse(userMessage, history = [], authCode = null) {
    // 1. ПРОВЕРКА НА API KEY
    if (!genAI && !(BACKUP_API_KEY && BACKUP_API_URL && BACKUP_MODEL)) {
        console.error('🔴 ГРЕШКА: Липсват Gemini и backup API конфигурации');
        return "В момента имам техническо затруднение (API Key Error).";
    }

    // 2. ОПРЕДЕЛЯНЕ НА РОЛЯ И ДАННИ (Поправка: добавено е ", data")
    const { role, data } = await determineUserRole(authCode, userMessage, history);
    const preferredLanguage = detectPreferredLanguage(userMessage, history);
    const manualScopeQuestion = shouldUseGroqRouterForMessage(userMessage);
    let forceGeminiDirect = false;
    let braveSearchResults = null;

    // 2.3. ДЕТЕРМИНИСТИЧЕН ОТГОВОР ЗА РОЛЯТА (без Gemini)
    if (isRoleIdentityRequest(userMessage)) {
        return getRoleIdentityReply(role, preferredLanguage);
    }

    // 2.35. КРАТКО ПОТВЪРЖДЕНИЕ ПРИ ПОДАДЕН КОД НА РЕЗЕРВАЦИЯ
    if (role === 'guest' && (isReservationCodeIntro(userMessage) || isBareReservationCodeMessage(userMessage) || containsReservationCode(userMessage))) {
        return getGuestOnboardingReply(data, preferredLanguage);
    }

    // 2.4. ДЕТЕРМИНИСТИЧЕН REFRESH НА РЕЗЕРВАЦИЯ (без Gemini)
    if (isReservationRefreshRequest(userMessage)) {
        return getReservationRefreshReply(role, data, preferredLanguage);
    }

    if (isLockCodeLookupRequest(userMessage)) {
        return await getLockCodeLookupReply(role, data, preferredLanguage);
    }

    // 2.45. ДЕТЕРМИНИСТИЧЕН HOST ОТГОВОР ЗА "РЕГИСТРАЦИИ ЗА ДНЕС"
    if (isTodayRegistrationsRequest(userMessage)) {
        return await getTodayRegistrationsReply(role, preferredLanguage);
    }

    // 2.46. ДЕТЕРМИНИСТИЧНИ HOST СПРАВКИ
    if (isActiveNowRequest(userMessage)) {
        return await getHostReportReply('active_now', role, preferredLanguage);
    }
    if (isTomorrowRegistrationsRequest(userMessage)) {
        return await getHostReportReply('tomorrow', role, preferredLanguage);
    }
    if (isCheckoutTodayRequest(userMessage)) {
        return await getHostReportReply('checkout_today', role, preferredLanguage);
    }
    if (isRecentCancelledRequest(userMessage)) {
        return await getHostReportReply('cancelled_recent', role, preferredLanguage);
    }
    if (isUnknownPowerStatusRequest(userMessage)) {
        return await getHostReportReply('unknown_power', role, preferredLanguage);
    }
    if (isDatabaseSnapshotRequest(userMessage)) {
        return await getDatabaseSnapshotReply(role, preferredLanguage);
    }
    if (role === 'host' && isHostDbCatchAllRequest(userMessage)) {
        return await getDatabaseSnapshotReply(role, preferredLanguage);
    }

    const allowExternalLookups = role !== 'stranger';

    // 2.465. LIVE DIRECTIONS (Google Directions API) за маршрутни въпроси
    if (allowExternalLookups && isDirectionsRequest(userMessage)) {
        const directionsReply = await getDirectionsReply(userMessage, preferredLanguage);
        if (directionsReply) {
            return directionsReply;
        }

        if (GOOGLE_PLACES_STRICT_MODE) {
            return preferredLanguage === 'en'
                ? '❌ SOURCE: Google Directions API (live) not available. Verified route lookup is blocked in strict mode. Set GOOGLE_DIRECTIONS_API_KEY/GOOGLE_PLACES_API_KEY or disable strict mode.'
                : '❌ ИЗТОЧНИК: Google Directions API (live) не е наличен. В strict режим провереният маршрут е блокиран. Задайте GOOGLE_DIRECTIONS_API_KEY/GOOGLE_PLACES_API_KEY или изключете strict режима.';
        }

        forceGeminiDirect = true;
        console.log('[DIRECTIONS] ↪️ Няма live directions резултат. Форсирам Gemini direct.');
    }

    // 2.47. LIVE MAP LOOKUP (Google Places) за локални услуги около Банско/Разлог
    if (allowExternalLookups && (isLivePlacesLookupRequest(userMessage) || isMapStyleQuestion(userMessage))) {
        const livePlacesReply = await getLivePlacesReply(userMessage, preferredLanguage);
        if (livePlacesReply) {
            return livePlacesReply;
        }
        if (GOOGLE_PLACES_STRICT_MODE) {
            const blockedHint = isPlacesBlockedNow() ? `\n${getPlacesBlockedHint(preferredLanguage)}` : '';
            return preferredLanguage === 'en'
                ? `❌ SOURCE: Google Maps Places API (live) not available. Verified map lookup is blocked in strict mode. Set GOOGLE_PLACES_API_KEY or disable strict mode.${blockedHint}`
                : `❌ ИЗТОЧНИК: Google Maps Places API (live) не е наличен. В strict режим провереното търсене е блокирано. Задайте GOOGLE_PLACES_API_KEY или изключете strict режима.${blockedHint}`;
        }

        forceGeminiDirect = true;
        console.log('[PLACES] ↪️ Няма live maps резултат. Форсирам Gemini direct (без Groq/manual router).');
    }

    // 2.48. WEB SEARCH (Brave) за ресторанти, наем, туристически маршрути
    if (allowExternalLookups && !manualScopeQuestion && isSearchEligibleQuery(userMessage)) {
        const searchQuery = preferredLanguage === 'en'
            ? userMessage
            : `${userMessage} near Bansko Razlog Bulgaria`;

        braveSearchResults = await searchBrave(searchQuery, preferredLanguage);
        if (braveSearchResults) {
            console.log('[BRAVE] ✅ Интегрирам резултатите в Gemini контекст');
            forceGeminiDirect = true;
        }
    }

    // 2.5. ТВЪРДА АВТОРИЗАЦИОННА БАРИЕРА ЗА УПРАВЛЕНИЕ НА ТОК
    // Ако няма валидна роля (guest/host), никога не допускай AI да обещава действие.
    const requestedPowerCommand = isPowerCommandRequest(userMessage);
    if (requestedPowerCommand && role !== 'guest' && role !== 'host') {
        console.warn('[SECURITY] 🚫 Блокирана команда за ток от неоторизиран потребител');
        if (preferredLanguage === 'en') {
            return `I cannot execute power commands because you are not authorized.

To get access:
- Host: sign in with a valid token.
- Guest: send a valid reservation code from an active booking.

After successful verification, I will execute the command immediately.`;
        }
        return `Не мога да изпълня команда за тока, защото не сте оторизиран.

За достъп:
- Домакин: влезте с валиден token.
- Гост: изпратете валиден код за резервация от активна резервация.

След успешна верификация ще изпълня командата веднага.`;
    }
    
    // 3. ПОЛУЧАВАНЕ НА СТАТУС НА ТОКА
    const powerStatus = await automationClient.getPowerStatus();
    const locale = preferredLanguage === 'en' ? 'en-GB' : 'bg-BG';
    const currentDateTime = new Date().toLocaleString(locale, { timeZone: 'Europe/Sofia' });

    // 3.5 КРАТЪК ДЕТЕРМИНИСТИЧЕН ОТГОВОР ЗА СТАТУС НА ТОКА
    // Изискване: без час, само кратка информация
    if (isPowerStatusRequest(userMessage) && !requestedPowerCommand) {
        const sourceStatus = await getSourcePowerStatus(role, data);
        if (!sourceStatus.available) {
            return preferredLanguage === 'en'
                ? 'I currently cannot read power source status.'
                : 'В момента не мога да прочета статуса от power history.';
        }

        if (sourceStatus.state === 'on') {
            return preferredLanguage === 'en' ? 'Yes, there is electricity.' : 'Да, има ток.';
        }
        if (sourceStatus.state === 'off') {
            return preferredLanguage === 'en' ? 'No, there is no electricity.' : 'Не, няма ток.';
        }

        return preferredLanguage === 'en'
            ? 'There is no power history status at the moment.'
            : 'В момента няма статус в power history.';
    }

    // 4. ЧЕТЕНЕ НА МАНУАЛА (РАЗДЕЛЕН НА ПУБЛИЧЕН И ЧАСТЕН)
    let manualContent = "";
    try {
        if (role === 'stranger') {
            // Публична информация за непознати
            const publicPath = path.join(process.cwd(), 'services', 'manual-public.txt');
            manualContent = await fs.readFile(publicPath, 'utf-8');
            console.log('📖 Прочетен manual-public.txt (публичен достъп)');
        } else {
            // Пълна информация за гости и домакин
            const privatePath = path.join(process.cwd(), 'services', 'manual-private.txt');
            manualContent = await fs.readFile(privatePath, 'utf-8');
            console.log('📖 Прочетен manual-private.txt (частен достъп)');
        }
    } catch (error) {
        console.error('🔴 Грешка при четене на наръчник:', error.message);
        // Резервни пътища
        try {
            if (role === 'stranger') {
                manualContent = await fs.readFile(path.join(process.cwd(), 'manual-public.txt'), 'utf-8');
            } else {
                manualContent = await fs.readFile(path.join(process.cwd(), 'manual-private.txt'), 'utf-8');
            }
        } catch (e) {
            manualContent = role === 'stranger' ? PUBLIC_INFO_FALLBACK : "Няма достъп до наръчника.";
        }
    }

    // 5. ИНСТРУКЦИИ ЗА ИКО (Вече 'data' съществува и няма да гърми)
    let systemInstruction = buildSystemInstruction(role, data, powerStatus, manualContent, currentDateTime, preferredLanguage);

    // Добави Brave search резултати ако са налични
    if (braveSearchResults) {
        const searchContextLabel = preferredLanguage === 'en'
            ? '\n\n=== LIVE WEB SEARCH RESULTS (via Brave Search API) ===\nIncorporate this real-time information into your answer:'
            : '\n\n=== LIVE WEB SEARCH РЕЗУЛТАТИ (via Brave Search API) ===\nВключи тази live информация в твоя отговор:';
        systemInstruction += `${searchContextLabel}\n${braveSearchResults}`;
    }

    // 5.5. ПРОВЕРКА ЗА КОМАНДИ НА ТОК ПРЕДИ AI ГЕНЕРИРАНЕ
    // Ако домакинът или гост командва управление на тока, изпълни го веднага
    const powerCommandResult = await checkEmergencyPower(userMessage, role, data);
    if (powerCommandResult) {
        console.log('[MAIN] ✅ Команда за управление на ток е разпозната и изпълнена');
        return powerCommandResult;
    }

    // 6. SAFE ROUTER: GROQ ПЪРВО (manual/property), GEMINI ПРИ DELEGATE
    let finalReply = "В момента имам техническо затруднение. Моля, опитайте след малко.";
    let generatedByModel = false;
    let manualDraftFromRouter = null;

    if (!forceGeminiDirect && canUseGroqRouter()) {
        console.log(`[GROQ_ROUTER] Старт на router проверка (manualLike=${manualScopeQuestion})`);

        if (manualScopeQuestion) {
            const routerResult = await generateWithGroqRouter(
                role,
                preferredLanguage,
                manualContent,
                history,
                userMessage
            );

            if (routerResult?.reply) {
                manualDraftFromRouter = routerResult.reply;
                console.log('[GROQ_ROUTER] 🧩 Получен MANUAL_DRAFT, предавам към Gemini за финален отговор');
            }
        } else {
            console.log('[GROQ_ROUTER] ⏭️ Bypass към Gemini (въпрос извън имотния/manual обхват)');
        }
    } else if (forceGeminiDirect) {
        console.log('[ROUTING] ⏭️ Force Gemini direct (live web/maps context)');
    }

    // 6.5. ГЕНЕРИРАНЕ С GEMINI (ако няма финален отговор от Groq)

    if (!generatedByModel && genAI) {
        for (const modelName of MODELS) {
            if (isModelCoolingDown(modelName)) {
                console.log(`⏭️ Пропускам ${modelName} (cooldown активен)`);
                continue;
            }

            try {
                const effectiveSystemInstruction = manualDraftFromRouter
                    ? buildGeminiCompositionInstruction(systemInstruction, preferredLanguage, manualDraftFromRouter)
                    : systemInstruction;
                const effectiveUserMessage = manualDraftFromRouter
                    ? `USER_QUESTION:\n${userMessage}\n\nMANUAL_DRAFT:\n${manualDraftFromRouter}\n\nTASK:\nСъздай финален отговор за потребителя.`
                    : userMessage;

                const model = genAI.getGenerativeModel({ 
                    model: modelName, 
                    systemInstruction: effectiveSystemInstruction 
                });

                const chatHistory = formatHistory(history);

                const chat = model.startChat({
                    history: chatHistory,
                    generationConfig: { maxOutputTokens: 4000 }
                });

                console.log(`🤖 Опит за генериране с модел: ${modelName}`);
                const result = await sendMessageWithTimeout(chat, effectiveUserMessage, modelName);
                finalReply = result.response.text();
                generatedByModel = true;
                break;
            } catch (modelError) {
                console.warn(`⚠️ Модел ${modelName} отказа:`, modelError.message);

                if (isQuotaError(modelError?.message)) {
                    setModelCooldown(modelName, modelError.message);
                }
                continue;
            }
        }
    }

    // 6.8 Ако Gemini не отговори, но имаме manual draft от router -> върни го като безопасен fallback
    if (!generatedByModel && manualDraftFromRouter) {
        finalReply = manualDraftFromRouter;
        generatedByModel = true;
    }

    // 7 BACKUP PROVIDER FALLBACK (DeepSeek/Groq/Mistral)
    if (!generatedByModel) {
        const backupReply = await generateWithBackupProvider(systemInstruction, history, userMessage);
        if (backupReply) {
            finalReply = backupReply;
            generatedByModel = true;
        }
    }

    // 8. АВАРИЙНО УПРАВЛЕНИЕ НА ТОКА
    // Ако е гост, няма ток и се оплаква -> пускаме го
    if (role === 'guest' && !powerStatus.isOn && /няма ток|спря ток|токът не работи/i.test(userMessage)) {
        console.log('🚨 АВАРИЯ: Гост докладва липса на ток. Опит за възстановяване...');
        const success = await automationClient.controlPower(true, data?.booking_id, 'ai_guest_emergency'); // Това ще прати и Telegram команда
        
        // ⏳ ИЗЧАКАЙ РЕАЛНОТО ПОТВЪРЖДЕНИЕ ОТ TASKER
        const confirmation = await waitForPowerConfirmation(true, 20000);
        console.log(`[POWER:GUEST_EMERGENCY] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);
        
        if (success || confirmation.success) {
            await automationClient.sendAlert("Автоматично възстановяване на ток за гост", data);
            finalReply = `Разбрах! Изпратих сигнал към апартамента. 📡

⏳ Какво следва: Трябва да получите потвърждение до 30 секунди.

⚠️ Ако нищо не се случи и аз не потвърдя: Това означава, че комуникацията с апартамента е прекъсната. В 99% от случаите това значи ЦЕНТРАЛНА АВАРИЯ в района.

🔗 Проверете тук: https://info.electrohold.bg (Община Разлог)`;
        }
    }

    const isTechnicalFallbackReply = typeof finalReply === 'string'
        && /в момента имам техническо затруднение|technical difficulty/i.test(finalReply);

    if (braveSearchResults && generatedByModel && !isTechnicalFallbackReply && typeof finalReply === 'string' && finalReply.trim()) {
        const bravePrefix = preferredLanguage === 'en'
            ? '✅ SOURCE: Brave Web Search (live)'
            : '✅ ИЗТОЧНИК: Brave Web Search (live)';

        if (!finalReply.startsWith(bravePrefix)) {
            finalReply = `${bravePrefix}\n${finalReply}`;
        }
    } else if (manualDraftFromRouter && typeof finalReply === 'string' && finalReply.trim()) {
        const groqPrefix = preferredLanguage === 'en'
            ? '✅ SOURCE: Groq Manual Router + Property Manual'
            : '✅ ИЗТОЧНИК: Groq Manual Router + Наръчник на имота';

        if (!finalReply.startsWith(groqPrefix)) {
            finalReply = `${groqPrefix}\n${finalReply}`;
        }
    }

    return finalReply;
}

// ============================================================================
// ФУНКЦИЯ ЗА ОБРАТНА СЪВМЕСТИМОСТ
// ============================================================================

/**
 * Наследена функция за обратна съвместимост
 * Проверява дали код на резервация съществува и връща информация на гост със щифт
 * 
 * @async
 * @param {string} reservationCode - Код на резервация HM на гост
 * @returns {Promise<Object|null>} Информация на гост със щифт или null ако не е намерена
 */
export async function checkBookingAndGetPin(reservationCode) {
    console.log('[LEGACY] checkBookingAndGetPin викана за код:', reservationCode);
    const { role, data } = await determineUserRole(reservationCode, '');

    if (role === 'guest' && data) {
        const result = {
            guest_name: data.guest_name,
            pin: data.lock_pin,
            check_in: data.check_in
        };
        console.log('[LEGACY] Връщам данни на гост:', result);
        return result;
    }

    console.log('[LEGACY] Не е намерена валидна резервация');
    return null;
}
