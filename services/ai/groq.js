/**
 * groq.js — Groq Router: отговаря на property/manual въпроси директно;
 * делегира към Gemini за всичко останало.
 */

import {
    GROQ_ROUTER_ENABLED,
    GROQ_API_KEY,
    GROQ_API_URL,
    GROQ_MODEL,
    GROQ_TIMEOUT_MS,
    GROQ_DELEGATE_TOKEN,
    genAI
} from './config.js';

export function canUseGroqRouter() {
    return GROQ_ROUTER_ENABLED && Boolean(GROQ_API_KEY) && Boolean(GROQ_MODEL) && Boolean(genAI);
}

export function buildGroqRouterInstruction(role, preferredLanguage, manualContent) {
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

export async function generateWithGroqRouter(role, preferredLanguage, manualContent, history, userMessage) {
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

        if (text === GROQ_DELEGATE_TOKEN || text.includes(GROQ_DELEGATE_TOKEN)) {
            console.log('[GROQ_ROUTER] ↪️ Делегирам към Gemini');
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
