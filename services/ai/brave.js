/**
 * brave.js — Brave Search интеграция с месечен quota tracking.
 */

import {
    BRAVE_SEARCH_API_KEY,
    BRAVE_SEARCH_TIMEOUT_MS,
    BRAVE_SEARCH_MONTHLY_QUOTA,
    BRAVE_SEARCH_WARNING_LEVELS
} from './config.js';

// ── Quota state ────────────────────────────────────────────────────────────
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

export function canUseBraveQuota() {
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

// ── Main search function ───────────────────────────────────────────────────

export async function searchBrave(query, language = 'bg') {
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
