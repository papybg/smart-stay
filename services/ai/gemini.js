/**
 * gemini.js — Gemini multi-model fallback + Backup provider (OpenAI-compatible).
 */

import {
    MODELS,
    MODEL_REQUEST_TIMEOUT_MS,
    MODEL_COOLDOWN_MS,
    modelCooldownUntil,
    BACKUP_API_KEY,
    BACKUP_API_URL,
    BACKUP_MODEL,
    BACKUP_TIMEOUT_MS,
    genAI
} from './config.js';

// ── Retry / cooldown helpers ───────────────────────────────────────────────

export function parseRetryDelayMs(errorMessage = '') {
    const text = String(errorMessage || '');
    const match = text.match(/Please retry in\s*([\d.]+)s/i) || text.match(/"retryDelay"\s*:\s*"(\d+)s"/i);
    if (!match) return null;
    const seconds = Number.parseFloat(match[1]);
    if (Number.isNaN(seconds) || seconds <= 0) return null;
    return Math.ceil(seconds * 1000);
}

export function isQuotaError(errorMessage = '') {
    const text = String(errorMessage || '').toLowerCase();
    return text.includes('429') || text.includes('quota exceeded') || text.includes('too many requests');
}

export function isModelCoolingDown(modelName) {
    const until = modelCooldownUntil.get(modelName);
    if (!until) return false;
    if (Date.now() >= until) {
        modelCooldownUntil.delete(modelName);
        return false;
    }
    return true;
}

export function setModelCooldown(modelName, errorMessage = '') {
    const retryDelayMs = parseRetryDelayMs(errorMessage);
    const cooldownMs = Math.max(MODEL_COOLDOWN_MS, retryDelayMs || 0);
    const until = Date.now() + cooldownMs;
    modelCooldownUntil.set(modelName, until);
    console.warn(`[AI] ⏳ Модел ${modelName} е в cooldown за ~${Math.ceil(cooldownMs / 1000)}s`);
}

// ── Send with timeout ──────────────────────────────────────────────────────

export async function sendMessageWithTimeout(chat, userMessage, modelName) {
    return await Promise.race([
        chat.sendMessage(userMessage),
        new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`[MODEL_TIMEOUT] ${modelName} exceeded ${MODEL_REQUEST_TIMEOUT_MS}ms`));
            }, MODEL_REQUEST_TIMEOUT_MS);
        })
    ]);
}

// ── History formatter ──────────────────────────────────────────────────────

export function formatHistory(history) {
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

    while (normalized.length && normalized[0].role !== 'user') normalized.shift();

    if (!normalized.length) {
        console.log('[HISTORY] ℹ️ Няма валидна история за Gemini -> изпращам празна history');
        return [];
    }

    return normalized;
}

// ── Composition instruction builder ───────────────────────────────────────

export function buildGeminiCompositionInstruction(systemInstruction, preferredLanguage, manualDraft = '') {
    const languageRule = preferredLanguage === 'en' ? 'Write in English.' : 'Пиши на български.';

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

// ── Multi-model Gemini generate ────────────────────────────────────────────

/**
 * Опитва всички Gemini модели от MODELS списъка с fallback.
 * Връща { reply, generatedByModel } или { reply: null, generatedByModel: false }
 */
export async function generateWithGemini(systemInstruction, history, userMessage, manualDraftFromRouter = null) {
    if (!genAI) return { reply: null, generatedByModel: false };

    for (const modelName of MODELS) {
        if (isModelCoolingDown(modelName)) {
            console.log(`⏭️ Пропускам ${modelName} (cooldown активен)`);
            continue;
        }

        try {
            const effectiveSystemInstruction = manualDraftFromRouter
                ? buildGeminiCompositionInstruction(systemInstruction, 'bg', manualDraftFromRouter)
                : systemInstruction;

            const effectiveUserMessage = manualDraftFromRouter
                ? `USER_QUESTION:\n${userMessage}\n\nMANUAL_DRAFT:\n${manualDraftFromRouter}\n\nTASK:\nСъздай финален отговор за потребителя.`
                : userMessage;

            const model = genAI.getGenerativeModel({
                model: modelName,
                systemInstruction: effectiveSystemInstruction
            });

            const chat = model.startChat({
                history: formatHistory(history),
                generationConfig: { maxOutputTokens: 4000 }
            });

            console.log(`🤖 Опит за генериране с модел: ${modelName}`);
            const result = await sendMessageWithTimeout(chat, effectiveUserMessage, modelName);
            return { reply: result.response.text(), generatedByModel: true };
        } catch (modelError) {
            console.warn(`⚠️ Модел ${modelName} отказа:`, modelError.message);
            if (isQuotaError(modelError?.message)) setModelCooldown(modelName, modelError.message);
        }
    }

    return { reply: null, generatedByModel: false };
}

// ── Backup provider (OpenAI-compatible) ───────────────────────────────────

export async function generateWithBackupProvider(systemInstruction, history, userMessage) {
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
            body: JSON.stringify({ model: BACKUP_MODEL, messages, temperature: 0.3 }),
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
