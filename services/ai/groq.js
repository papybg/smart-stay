/**
 * groq.js — Groq Router: отговаря на property/manual въпроси директно;
 * делегира към Gemini за всичко останало.
 */

import {
    GROQ_ROUTER_ENABLED,
    GROQ_API_KEY,
    GROQ_API_URL,
    GROQ_MODEL,
    GROQ_FALLBACK_MODEL,
    GROQ_TIMEOUT_MS,
    GROQ_DELEGATE_TOKEN
} from './config.js';

export function canUseGroqRouter() {
    return GROQ_ROUTER_ENABLED && Boolean(GROQ_API_KEY) && Boolean(GROQ_MODEL);
}

function getGroqModelsInOrder() {
    const models = [GROQ_MODEL, GROQ_FALLBACK_MODEL]
        .map(model => String(model || '').trim())
        .filter(Boolean);
    return [...new Set(models)];
}

export function buildGroqRouterInstruction(role, preferredLanguage, manualContent) {
    const languageRule = preferredLanguage === 'en'
        ? 'Answer in English only.'
        : 'Отговаряй само на български.';
    const roleRule = role === 'stranger'
        ? 'You are speaking with a stranger. Never reveal private or operational-sensitive details.'
        : 'You are speaking with an authenticated user (guest or host).';
    const manualSnippet = String(manualContent || '').slice(0, 12000);

    const unauthorizedReply = 'За този въпрос е нужна оторизация. Моля, въведете регистрационния код на активна резервация, за да продължим.';
    const genericRefusalReply = 'В момента не мога да отговоря на този въпрос.';

    return `You are Smart-Stay Groq Router. ${languageRule}

CRITICAL ROUTING RULES:
1) For property/manual/house-operation questions, answer ONLY if the answer is explicitly present in MANUAL_CONTEXT.
2) If a property/manual answer is missing, ambiguous, partial, or you are not fully certain from MANUAL_CONTEXT, reply with exactly "${unauthorizedReply}".
3) Never guess, infer, reconstruct, autocomplete, or invent property details such as Wi-Fi names, Wi-Fi passwords, lock codes, contacts, addresses, prices, rules, schedules, or amenities.
4) If ROLE is stranger: answer ONLY from MANUAL_CONTEXT. For everything outside MANUAL_CONTEXT, reply with exactly "${unauthorizedReply}".
5) If ROLE is authenticated user (guest/host): for safe general factual questions (e.g. geography, basic definitions, simple world knowledge) you MAY answer directly from your own knowledge if confidence is high.
6) If ROLE is authenticated user and the question likely needs live/current data, external verification, or long open-ended reasoning, reply with exactly ${GROQ_DELEGATE_TOKEN}.
7) If ROLE is authenticated user and you are not confident in a general-factual answer, reply with exactly "${genericRefusalReply}".
8) For navigation/route/distance/time-to-travel questions (e.g. "как се стига", "маршрут", "колко километра", "колко време с кола"), reply with exactly ${GROQ_DELEGATE_TOKEN} unless the answer is explicitly present in MANUAL_CONTEXT.
9) Never output both an answer and ${GROQ_DELEGATE_TOKEN}.
10) Keep answers concise and operational.

SECURITY RULE:
${roleRule}

MANUAL_CONTEXT:
${manualSnippet}`;
}

export async function generateWithGroqRouter(role, preferredLanguage, manualContent, history, userMessage) {
    if (!canUseGroqRouter()) {
        return { delegated: true, reply: null, decision: 'skip', model: null, reason: 'router_unavailable' };
    }

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

        const modelsToTry = getGroqModelsInOrder();
        let lastError = null;

        for (const modelName of modelsToTry) {
            try {
                const response = await fetch(`${GROQ_API_URL}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${GROQ_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: modelName,
                        messages: [
                            { role: 'system', content: routerInstruction },
                            ...compactHistory,
                            { role: 'user', content: userMessage }
                        ],
                        temperature: 0,
                        max_tokens: 700
                    }),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`[GROQ_ROUTER:${modelName}] ${response.status} ${response.statusText} - ${errText}`);
                }

                const data = await response.json();
                const text = data?.choices?.[0]?.message?.content?.trim();
                if (!text) throw new Error(`[GROQ_ROUTER:${modelName}] Empty response content`);

                if (text === GROQ_DELEGATE_TOKEN || text.includes(GROQ_DELEGATE_TOKEN)) {
                    console.log(`[GROQ_ROUTER] ↪️ Делегирам към Gemini (model=${modelName})`);
                    return { delegated: true, reply: null, decision: 'delegated', model: modelName, reason: 'delegate_token' };
                }

                console.log(`[GROQ_ROUTER] ✅ Отговорено директно от Groq router (model=${modelName})`);
                return { delegated: false, reply: text, decision: 'answered', model: modelName, reason: 'manual_answer' };
            } catch (modelError) {
                lastError = modelError;
                console.warn(`[GROQ_ROUTER] ⚠️ Модел ${modelName} отказа:`, modelError.message);
            }
        }

        if (lastError) throw lastError;
        throw new Error('[GROQ_ROUTER] No configured models available');
    } catch (error) {
        console.warn('[GROQ_ROUTER] ⚠️ Грешка, продължавам към Gemini:', error.message);
        return { delegated: true, reply: null, decision: 'error', model: null, reason: error.message };
    } finally {
        clearTimeout(timeoutHandle);
    }
}
