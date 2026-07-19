import fs from 'fs/promises';
import path from 'path';
import { controlPower as sendPowerCommand, controlMeterByAction } from './homeassistant.js';

// ── Sub-module imports ─────────────────────────────────────────────────────

import {
    sql, genAI, AUTOMATION_URL, PUBLIC_INFO_FALLBACK,
    GOOGLE_PLACES_API_KEY, GOOGLE_PLACES_MAX_RESULTS,
    GOOGLE_PLACES_STRICT_MODE, GOOGLE_PLACES_TIMEOUT_MS,
    GOOGLE_PLACES_BLOCK_COOLDOWN_MS,
    GOOGLE_DIRECTIONS_API_KEY, GOOGLE_DIRECTIONS_TIMEOUT_MS,
    GOOGLE_DIRECTIONS_CACHE_TTL_MS,
    GOOGLE_DIRECTIONS_RATE_LIMIT_WINDOW_MS,
    GOOGLE_DIRECTIONS_RATE_LIMIT_MAX,
    GOOGLE_MAPS_BUDGET_ALERTS_CONFIGURED,
    BACKUP_API_KEY, BACKUP_API_URL, BACKUP_MODEL,
    MODELS, GROQ_MODEL, GROQ_FALLBACK_MODEL,
    ACCESS_START_BEFORE_CHECKIN_HOURS, ACCESS_END_AFTER_CHECKOUT_HOURS,
    LOCK_CODE_ACCESS_START_BEFORE_CHECKIN_HOURS, LOCK_CODE_ACCESS_END_AFTER_CHECKOUT_HOURS
} from './ai/config.js';

export { assignPinFromDepot, determineUserRole } from './ai/auth.js';
import { determineUserRole } from './ai/auth.js';

import {
    generateWithGemini, generateWithBackupProvider
} from './ai/gemini.js';

import { canUseGroqRouter, generateWithGroqRouter } from './ai/groq.js';

import { searchBrave } from './ai/brave.js';
import { runDetectiveCommand } from './detectiveGateway.js';

export { buildSystemInstruction } from './ai/instructions.js';
import { buildSystemInstruction } from './ai/instructions.js';

import {
    detectPowerCommandIntent, isLikelyPowerCommand,
    isPowerCommandRequest, isPowerStatusRequest,
    containsReservationCode, isBareReservationCodeMessage,
    isReservationCodeIntro, isReservationRefreshRequest,
    isLockCodeLookupRequest,
    isTodayRegistrationsRequest, isActiveNowRequest,
    isTomorrowRegistrationsRequest, isCheckoutTodayRequest,
    isRecentCancelledRequest, isUnknownPowerStatusRequest,
    isDatabaseSnapshotRequest, isHostDbCatchAllRequest,
    isLivePlacesLookupRequest, isMapStyleQuestion,
    isDirectionsRequest, buildDirectionsDestination,
    isRoleIdentityRequest, isModelIdentityRequest, shouldUseGroqRouterForMessage,
    detectPreferredLanguage, isSearchEligibleQuery,
    isMailCheckRequest
} from './ai/intents.js';

// ── Places circuit-breaker state ───────────────────────────────────────────

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

function isGeoSensitiveTourismQuery(text = '') {
    const value = String(text || '').toLowerCase();
    return /екопът|екопътек|еко път|пътека|пътеки|преход|hiking|trail|trails|eco\s*path|tourist\s*route|nature\s*route|tour\s*route/i.test(value);
}

const LOCAL_SEARCH_CENTER = { lat: 41.874389, lng: 23.423650 };
const DEFAULT_LOCAL_RADIUS_KM = 15;

function parseRequestedRadiusKm(text = '') {
    const value = String(text || '').toLowerCase();
    const match = value.match(/(?:до|within|up\s*to)\s*(\d{1,3}(?:[.,]\d+)?)\s*(?:км|km)\b/i)
        || value.match(/(\d{1,3}(?:[.,]\d+)?)\s*(?:км|km)\s*(?:радиус|radius)?/i);
    if (!match?.[1]) return null;
    const parsed = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(parsed)) return null;
    return Math.max(1, Math.min(100, parsed));
}

function shouldUseLocalAreaRadius(text = '') {
    return /(района|в\s+района|околност(та)?|наблизо|близо|край\s+комплекс(а)?|около\s+комплекс(а)?|окло\s+комплекс(а)?|nearby|around\s+the\s+complex|near\s+the\s+complex)/i
        .test(String(text || '').toLowerCase());
}

function getLocalRadiusConstraint(userMessage = '') {
    const requestedRadiusKm = parseRequestedRadiusKm(userMessage);
    const hasLocalAreaHint = shouldUseLocalAreaRadius(userMessage);
    if (!hasLocalAreaHint && !requestedRadiusKm) {
        return { enabled: false, radiusKm: null, requestedRadiusKm: null };
    }

    const radiusKm = requestedRadiusKm || DEFAULT_LOCAL_RADIUS_KM;
    return {
        enabled: true,
        radiusKm,
        requestedRadiusKm,
        localDefaultApplied: !requestedRadiusKm
    };
}

function haversineKm(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lng - a.lng) * Math.PI) / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function buildGeoAnchoredSearchQuery(text = '', language = 'bg') {
    const base = String(text || '').trim();
    if (!base) {
        return language === 'en'
            ? 'services in Razlog and Bansko, Pirin, Bulgaria'
            : 'услуги в гр. Разлог и гр. Банско, Пирин, България';
    }

    const hasLocalArea = /банско|разлог|bansko|razlog/i.test(base);
    if (isGeoSensitiveTourismQuery(base)) {
        return language === 'en'
            ? `${base} city of Razlog city of Bansko Blagoevgrad Province Pirin Bulgaria`
            : `${base} в района на гр. Разлог и гр. Банско, област Благоевград, Пирин, България`;
    }

    if (hasLocalArea) {
        return language === 'en'
            ? `${base} Pirin Bulgaria`
            : `${base} Пирин България`;
    }

    return language === 'en'
        ? `${base} near Bansko and Razlog, Pirin, Bulgaria`
        : `${base} близо до Банско и Разлог, Пирин, България`;
}

// ── Automation client ──────────────────────────────────────────────────────

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

    async getPowerStatus(options = {}) {
        const { silent = false } = options;

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
                            isOn: normalized, timestamp: rows[0].timestamp, source: 'db'
                        });
                    }
                    return { online: true, isOn: normalized, source: 'db', timestamp: rows[0].timestamp };
                }
            } catch (dbErr) {
                if (!silent) console.warn('[AUTOMATION] Грешка при четене на power_history:', dbErr.message);
            }
        }

        try {
            if (!silent) console.log('[AUTOMATION] Получавам статус от услугата за автоматизация...');
            const res = await fetch(`${AUTOMATION_URL}/api/power-status`);
            if (!res.ok) {
                console.warn('[AUTOMATION] Крайната точка върна статус:', res.status);
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
            if (!silent) console.log('[AUTOMATION] Статус на тока получен:', normalized);
            return normalized;
        } catch (e) {
            console.error('[AUTOMATION] Проверката на статус не успя:', e.message);
            return { online: false, isOn: false };
        }
    },

    async controlPower(state, bookingId = null, source = 'ai_command') {
        try {
            const command = state ? 'meter_on' : 'meter_off';
            console.log('[AUTOMATION] 📡 Управление на тока чрез Samsung API:', command);

            const success = await sendPowerCommand(state);
            if (!success) {
                console.warn('[AUTOMATION] ⚠️ Неуспешна Samsung команда');
                return false;
            }

            const nowIso = new Date().toISOString();
            global.powerState = {
                is_on: state,
                source,
                last_update: nowIso
            };

            if (sql) {
                try {
                    await sql`
                        INSERT INTO power_history (is_on, source, timestamp, booking_id)
                        VALUES (${state}, ${source}, ${nowIso}, ${bookingId ? String(bookingId) : null})
                    `;
                } catch (dbErr) {
                    console.warn('[AUTOMATION] ⚠️ DB insert error:', dbErr.message);
                }
            } else {
                console.warn('[AUTOMATION] ⚠️ DATABASE_URL липсва, power_history няма да бъде обновен');
            }

            console.log('[AUTOMATION] ✅ HA командата е приета успешно');
            return true;
        } catch (e) {
            console.error('[AUTOMATION] ❌ Управлението на тока не успя:', e.message);
            return false;
        }
    },

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

    async sendMeterCommand(state) {
        try {
            const action = state ? 'on' : 'off';
            const result = await controlMeterByAction(action);
            return result.success;
        } catch (e) {
            console.error('[AUTOMATION] ❌ sendMeterCommand грешка:', e.message);
            return false;
        }
    },

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
            console.error('[AUTOMATION] Изпращането не успя:', e.message);
            return false;
        }
    },

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

// ── Power source status ────────────────────────────────────────────────────

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
        if (role === 'guest' && bookingData?.booking_id) {
            const rows = await sql`
                SELECT is_on, timestamp FROM power_history
                WHERE booking_id = ${String(bookingData.booking_id)}
                ORDER BY timestamp DESC LIMIT 1
            `;
            const status = normalizeStatus(rows[0]?.is_on);
            if (status) return { available: true, state: status };
        }

        if (role === 'guest' && bookingData?.reservation_code) {
            const fallbackRows = await sql`
                SELECT is_on, timestamp FROM power_history
                WHERE booking_id = ${String(bookingData.reservation_code)}
                ORDER BY timestamp DESC LIMIT 1
            `;
            const fallbackStatus = normalizeStatus(fallbackRows[0]?.is_on);
            if (fallbackStatus) return { available: true, state: fallbackStatus };
        }

        const latestRows = await sql`
            SELECT is_on, timestamp FROM power_history
            ORDER BY timestamp DESC LIMIT 1
        `;

        if (latestRows.length === 0) return { available: true, state: null };

        const status = normalizeStatus(latestRows[0]?.is_on);
        return { available: true, state: status || null };
    } catch (error) {
        console.error('[DB] 🔴 Грешка при четене на power_history:', error.message);
        return { available: false, state: null };
    }
}

// ── Directions ─────────────────────────────────────────────────────────────

function stripHtmlTags(value = '') {
    return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const ASPEN_VALLEY_COORDS = '41.874389,23.423650';
const SOFIA_AIRPORT_CANONICAL = 'Sofia Airport (SOF), Sofia, Bulgaria';
const directionsCache = new Map();
const directionsRateState = new Map();
let hasWarnedForMapsBudgetAlerts = false;

function normalizeRateLimitKeySegment(value = '') {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 80);
}

function getDirectionsRateLimitKey(role = 'stranger', bookingData = null) {
    if (role === 'guest' && bookingData?.reservation_code) {
        return `guest:${normalizeRateLimitKeySegment(bookingData.reservation_code)}`;
    }
    if (role === 'host') return 'host:global';
    return `stranger:${normalizeRateLimitKeySegment(bookingData?.reservation_code || '') || 'anon'}`;
}

function isBroadCountryOrigin(value = '') {
    const normalized = String(value || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
    return /^(гърция|гръц(ия|ка)|greece|greek|македония|северна\s+македония|north\s*macedonia|macedonia|албания|albania|сърбия|serbia|румъния|romania|турция|turkey)$/.test(normalized);
}
const BORDER_ORIGINS = [
    {
        pattern: /^(гърция|гръц(ия|ка)|greece|greek)$/i,
        place: 'Kulata-Promachonas Border Crossing, Bulgaria'
    },
    {
        pattern: /^(македония|северна\s+македония|north\s*macedonia|macedonia|албания|albania)$/i,
        place: 'Stanke Lisichkovo Border Checkpoint, Bulgaria'
    },
    {
        pattern: /^(сърбия|serbia)$/i,
        place: 'Kalotina Border Checkpoint, Bulgaria'
    },
    {
        pattern: /^(румъния|romania)$/i,
        place: 'Ruse Border Checkpoint, Bulgaria'
    },
    {
        pattern: /^(турция|turkey)$/i,
        place: 'Kapitan Andreevo Border Checkpoint, Bulgaria'
    }
];

function normalizeDirectionsPlace(value = '') {
    return String(value || '')
        .replace(/[?.!,]+$/g, '')
        .replace(/^(как\s+да\s+стигна|как\s+да\s+отида|маршрут(ът)?\s*(е)?|route|directions)\s+/i, '')
        .replace(/^(до|to|от|from)\s+/i, '')
        .trim();
}

function isRouteFollowUpMessage(userMessage = '', history = []) {
    const text = String(userMessage || '').trim().toLowerCase();
    if (!text) return false;

    // Short follow-ups like "а от ксанти" or "от солун" should inherit route context.
    const looksLikeOriginFollowUp = /^(а\s+)?от\s+.{2,}$/i.test(text);
    if (!looksLikeOriginFollowUp) return false;

    const recentUserMessage = (Array.isArray(history) ? history : [])
        .slice()
        .reverse()
        .find(msg => msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim());

    if (!recentUserMessage) return false;
    return isDirectionsRequest(recentUserMessage.content);
}

function getManualRouteReplyForStranger(userMessage, language = 'bg', isRouteContext = false) {
    const text = String(userMessage || '').toLowerCase();
    const asksDirections = isDirectionsRequest(userMessage) || isRouteContext;
    if (!asksDirections) return null;

    const fromSofia = /\bсофия\b|\bsofia\b/i.test(text);
    const fromGreece = /гръц|гърц|greece|greek|кулата|промахон|илинден|ексохи|ксанти|xanthi|ξανθη|солун|thessaloniki|thessalonica|θεσσαλονικη/i.test(text);
    const fromPlovdiv = /\bпловдив\b|\bplovdiv\b/i.test(text);
    const fromWest = /македон|macedonia|north\s*macedonia|скопие|skopje|албани|albania|тирана|tirana|дуръс|durres|серби|serbia|белград|belgrade|румъни|romania|букурещ|bucharest|германи|germany|немци|munich|munchen|мюнхен|berlin|виена|vienna|австри|austria|загреб|zagreb|хърват|croatia|словени|slovenia|будапеща|budapest|унгар|hungary/i.test(text);

    if (fromSofia) {
        return language === 'en'
            ? 'Route from Sofia to Aspen Valley: approximately 155 km, usually around 2h 30m to 3h 30m depending on traffic. Main route: Struma Motorway (A3) to Simitli, then road II-19 through Predela toward Aspen Valley / Bansko.'
            : 'Маршрут от София до Aspen Valley: около 155 км, обичайно между 2 ч. 30 мин. и 3 ч. 30 мин. според трафика. Основен маршрут: АМ „Струма“ (A3) до Симитли, след това път II-19 през прохода Предела в посока Aspen Valley / Банско.';
    }

    if (fromGreece) {
        return language === 'en'
            ? 'Route from the Greek border to Aspen Valley: via Kulata checkpoint (about 100 km, around 1h 40m in normal traffic) or via Ilinden-Exochi checkpoint (about 70 km, around 1h 15m, with mountain road sections).'
            : 'Маршрут от гръцката граница до Aspen Valley: през ГКПП Кулата (около 100 км, обичайно ~1 ч. 40 мин. при нормален трафик) или през ГКПП Илинден - Ексохи (около 70 км, обичайно ~1 ч. 15 мин., с планински участъци).';
    }

    if (fromPlovdiv) {
        return language === 'en'
            ? 'Route from Plovdiv to Aspen Valley: most commonly via Pazardzhik - Belovo - Yundola - Yakoruda. Approx. 145 km and around 2h 45m depending on road conditions.'
            : 'Маршрут от Пловдив до Aspen Valley: най-често през Пазарджик - Белово - Юндола - Якоруда. Около 145 км и приблизително 2 ч. 45 мин. според пътната обстановка.';
    }

    if (fromWest) {
        return language === 'en'
            ? 'Route from the west (North Macedonia / Albania) to Aspen Valley: use Stanke Lisichkovo (Delchevo) border crossing, continue toward Blagoevgrad, then south on E79 to Simitli, and finally road II-19 through Predela pass to Razlog / Aspen Valley.'
            : 'Маршрут от запад (Македония / Албания) до Aspen Valley: използвайте ГКПП Станке Лисичково (Делчево), продължете към Благоевград, след това на юг по E79 до Симитли и накрая по път II-19 през прохода Предел до Разлог / Aspen Valley.';
    }

    return language === 'en'
        ? 'Please use these coordinates 41.874389, 23.423650 (https://maps.app.goo.gl/so3NdoVnPGZ3cQp49) for navigation.'
        : 'Моля, използвайте тези координати 41.874389, 23.423650 (https://maps.app.goo.gl/so3NdoVnPGZ3cQp49) за навигация.';
}

function isComplexAlias(value = '') {
    const text = String(value || '').toLowerCase();
    return /^(комплекса\s+аспен\s+валей|комплекс\s+аспен\s+валей|аспен\s+валей|aspen\s*valley|комплекса|комплекс|апартамент(а)?|имот(а)?|до\s+нас|to\s+the\s+complex)$/i.test(text)
        || /(комплекса\s+аспен\s+валей|комплекс\s+аспен\s+валей|\bаспен\s+валей\b|\baspen\s*valley\b|\bd106\b|\bд106\b|св\.?\s*никола\s*32|янколова\s*река\s*96|2760\s*разлог)/i.test(text);
}

function normalizeKnownDirectionsPlace(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return raw;

    if (isComplexAlias(raw)) {
        return ASPEN_VALLEY_COORDS;
    }

    const normalized = raw
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (/(летище\s*софия|sof\b|sofia\s*airport|airport\s*sofia|международно\s+летище\s+софия)/i.test(normalized)) {
        return SOFIA_AIRPORT_CANONICAL;
    }

    if (/^(софия|sofia|sofia\s+bulgaria|софия\s+българия)$/.test(normalized)) {
        return 'Sofia, Bulgaria';
    }

    if (/^(банско|bansko)$/.test(normalized)) {
        return 'Bansko, Bulgaria';
    }

    if (/^(разлог|razlog)$/.test(normalized)) {
        return 'Razlog, Bulgaria';
    }

    for (const border of BORDER_ORIGINS) {
        if (border.pattern.test(normalized)) {
            return border.place;
        }
    }

    return raw;
}

function parseDirectionsEndpoints(userMessage = '') {
    const text = String(userMessage || '').trim();
    const homeBase = ASPEN_VALLEY_COORDS;

    if (!text) return { origin: homeBase, destination: null, rawOrigin: '', rawDestination: '' };

    const fromToMatch = text.match(/(?:^|\s)(?:от|from)\s+(.+?)\s+(?:до|to)\s+(.+)$/i);
    if (fromToMatch?.[1] && fromToMatch?.[2]) {
        const rawOrigin = normalizeDirectionsPlace(fromToMatch[1]);
        const rawDestination = normalizeDirectionsPlace(fromToMatch[2]);
        let origin = rawOrigin;
        let destination = rawDestination;
        origin = normalizeKnownDirectionsPlace(origin);
        destination = normalizeKnownDirectionsPlace(destination);
        if (isComplexAlias(origin)) origin = homeBase;
        if (isComplexAlias(destination)) destination = homeBase;
        return { origin: origin || homeBase, destination: destination || null, rawOrigin, rawDestination };
    }

    const toFromMatch = text.match(/(?:^|\s)(?:до|to)\s+(.+?)\s+(?:от|from)\s+(.+)$/i);
    if (toFromMatch?.[1] && toFromMatch?.[2]) {
        const rawDestination = normalizeDirectionsPlace(toFromMatch[1]);
        const rawOrigin = normalizeDirectionsPlace(toFromMatch[2]);
        let destination = rawDestination;
        let origin = rawOrigin;
        destination = normalizeKnownDirectionsPlace(destination);
        origin = normalizeKnownDirectionsPlace(origin);
        if (isComplexAlias(origin)) origin = homeBase;
        if (isComplexAlias(destination)) destination = homeBase;
        return { origin: origin || homeBase, destination: destination || null, rawOrigin, rawDestination };
    }

    const rawDestination = normalizeDirectionsPlace(buildDirectionsDestination(text) || '');
    const destination = normalizeKnownDirectionsPlace(rawDestination);
    if (isComplexAlias(destination)) {
        return { origin: homeBase, destination: homeBase, rawOrigin: '', rawDestination };
    }
    return { origin: homeBase, destination: destination || null, rawOrigin: '', rawDestination };
}

async function getDirectionsReply(userMessage, language = 'bg', role = 'stranger', bookingData = null) {
    if (!GOOGLE_DIRECTIONS_API_KEY) return null;

    const { origin, destination, rawOrigin } = parseDirectionsEndpoints(userMessage);
    if (!destination) return null;

    if (rawOrigin && isBroadCountryOrigin(rawOrigin)) {
        return language === 'en'
            ? 'To avoid routing from a random point in that country, please specify a city or border checkpoint (e.g. Kulata, Ilinden, Stanke Lisichkovo).'
            : 'За да избегна маршрут от случайна точка в държавата, посочете град или ГКПП (напр. Кулата, Илинден, Станке Лисичково).';
    }

    const limiterKey = getDirectionsRateLimitKey(role, bookingData);
    const nowTs = Date.now();
    const limiter = directionsRateState.get(limiterKey) || { count: 0, resetAt: nowTs + GOOGLE_DIRECTIONS_RATE_LIMIT_WINDOW_MS };
    if (nowTs > limiter.resetAt) {
        limiter.count = 0;
        limiter.resetAt = nowTs + GOOGLE_DIRECTIONS_RATE_LIMIT_WINDOW_MS;
    }
    limiter.count += 1;
    directionsRateState.set(limiterKey, limiter);

    if (limiter.count > GOOGLE_DIRECTIONS_RATE_LIMIT_MAX) {
        return language === 'en'
            ? 'Route requests are temporarily rate-limited. Please try again in a few minutes, or use coordinates 41.874389, 23.423650.'
            : 'Заявките за маршрут са временно ограничени. Опитайте след няколко минути или използвайте координати 41.874389, 23.423650.';
    }

    if (!GOOGLE_MAPS_BUDGET_ALERTS_CONFIGURED && !hasWarnedForMapsBudgetAlerts) {
        hasWarnedForMapsBudgetAlerts = true;
        console.warn('[DIRECTIONS] ⚠️ GOOGLE_MAPS_BUDGET_ALERTS_CONFIGURED=false. Препоръчително е да настроите budget alerts в Google Cloud.');
    }

    const cacheKey = `${String(language || 'bg').toLowerCase()}|${String(origin || '').toLowerCase()}|${String(destination || '').toLowerCase()}`;
    const cached = directionsCache.get(cacheKey);
    if (cached && cached.expiresAt > nowTs && typeof cached.reply === 'string' && cached.reply.trim()) {
        return cached.reply;
    }

    try {
        const params = new URLSearchParams({
            origin,
            destination,
            mode: 'driving',
            language: language === 'en' ? 'en' : 'bg',
            key: GOOGLE_DIRECTIONS_API_KEY
        });

        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), GOOGLE_DIRECTIONS_TIMEOUT_MS);

        const response = await fetch(
            `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`,
            { method: 'GET', signal: controller.signal }
        );
        clearTimeout(timeoutHandle);

        if (!response.ok) {
            console.warn('[DIRECTIONS] ⚠️ Грешка при заявка:', response.status);
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

        const allSteps = Array.isArray(leg.steps) ? leg.steps : [];
        const steps = allSteps.slice(0, 8);
        const stepLines = steps.map((step, index) => {
            const instruction = stripHtmlTags(step?.html_instructions || step?.maneuver || '');
            const distanceText = step?.distance?.text || '';
            const durationText = step?.duration?.text || '';
            return `${index + 1}. ${instruction}${distanceText || durationText ? ` (${distanceText}${distanceText && durationText ? ', ' : ''}${durationText})` : ''}`;
        });
        const hasMoreSteps = allSteps.length > steps.length;
        const finalDestinationLabel = isComplexAlias(destination) || destination === ASPEN_VALLEY_COORDS
            ? 'Aspen Valley, Разлог'
            : (leg.end_address || destination);
        if (hasMoreSteps) {
            stepLines.push(`… и следвайте навигацията до: ${finalDestinationLabel}`);
        } else {
            stepLines.push(`Крайна точка: ${finalDestinationLabel}`);
        }

        const resolvedOrigin = (typeof leg?.start_location?.lat === 'number' && typeof leg?.start_location?.lng === 'number')
            ? `${leg.start_location.lat},${leg.start_location.lng}`
            : (leg.start_address || origin);
        const resolvedDestination = (typeof leg?.end_location?.lat === 'number' && typeof leg?.end_location?.lng === 'number')
            ? `${leg.end_location.lat},${leg.end_location.lng}`
            : (leg.end_address || destination);

        const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(resolvedOrigin)}&destination=${encodeURIComponent(resolvedDestination)}&travelmode=driving`;

        if (language === 'en') {
            const reply = `✅ SOURCE: Google Directions API (live)\nRoute from ${leg.start_address || origin} to ${finalDestinationLabel}:\nDistance: ${leg.distance?.text || 'N/A'}\nEstimated time: ${leg.duration?.text || 'N/A'}\n\n${stepLines.join('\n')}\n\nOpen in Google Maps: ${mapsUrl}`;
            directionsCache.set(cacheKey, { reply, expiresAt: Date.now() + GOOGLE_DIRECTIONS_CACHE_TTL_MS });
            return reply;
        }
        const reply = `✅ ИЗТОЧНИК: Google Directions API (live)\nМаршрут от ${leg.start_address || origin} до ${finalDestinationLabel}:\nРазстояние: ${leg.distance?.text || 'N/A'}\nОриентировъчно време: ${leg.duration?.text || 'N/A'}\n\n${stepLines.join('\n')}\n\nОтвори в Google Maps: ${mapsUrl}`;
        directionsCache.set(cacheKey, { reply, expiresAt: Date.now() + GOOGLE_DIRECTIONS_CACHE_TTL_MS });
        return reply;
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.warn(`[DIRECTIONS] ⚠️ Timeout след ${GOOGLE_DIRECTIONS_TIMEOUT_MS}ms`);
        } else {
            console.warn('[DIRECTIONS] ⚠️ Exception:', error.message);
        }
        return null;
    }
}

// ── Google Places ──────────────────────────────────────────────────────────

function buildPlacesSearchQuery(userMessage, language = 'bg') {
    return buildGeoAnchoredSearchQuery(userMessage, language);
}

async function getLivePlacesReply(userMessage, language = 'bg') {
    if (!GOOGLE_PLACES_API_KEY) return null;
    if (isPlacesBlockedNow()) return null;

    try {
        const textQuery = buildPlacesSearchQuery(userMessage, language);
        const radiusConstraint = getLocalRadiusConstraint(userMessage);
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), GOOGLE_PLACES_TIMEOUT_MS);

        const payload = {
            textQuery,
            pageSize: Math.max(1, Math.min(GOOGLE_PLACES_MAX_RESULTS, 5)),
            languageCode: language === 'en' ? 'en' : 'bg'
        };

        if (radiusConstraint.enabled) {
            payload.locationRestriction = {
                circle: {
                    center: {
                        latitude: LOCAL_SEARCH_CENTER.lat,
                        longitude: LOCAL_SEARCH_CENTER.lng
                    },
                    radius: radiusConstraint.radiusKm * 1000
                }
            };
        }

        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
                'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.googleMapsUri,places.location'
            },
            body: JSON.stringify(payload),
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

        const enrichedPlaces = places
            .map((place) => {
                const lat = place?.location?.latitude;
                const lng = place?.location?.longitude;
                const hasLocation = typeof lat === 'number' && typeof lng === 'number';
                const distanceKm = hasLocation
                    ? haversineKm(LOCAL_SEARCH_CENTER, { lat, lng })
                    : null;
                return {
                    place,
                    distanceKm
                };
            })
            .filter((entry) => {
                if (!radiusConstraint.enabled) return true;
                if (!Number.isFinite(entry.distanceKm)) return false;
                return entry.distanceKm <= radiusConstraint.radiusKm;
            })
            .sort((a, b) => {
                const ad = Number.isFinite(a.distanceKm) ? a.distanceKm : Number.POSITIVE_INFINITY;
                const bd = Number.isFinite(b.distanceKm) ? b.distanceKm : Number.POSITIVE_INFINITY;
                return ad - bd;
            });

        if (!enrichedPlaces.length) {
            if (radiusConstraint.enabled) {
                return language === 'en'
                    ? `✅ SOURCE: Google Maps Places API (live)\nI could not find reliable results within ${radiusConstraint.radiusKm} km from Aspen Valley.\nIf you want more options, specify a larger radius in km.`
                    : `✅ ИЗТОЧНИК: Google Maps Places API (live)\nНе открих надеждни резултати в радиус до ${radiusConstraint.radiusKm} км от комплекса.\nАко желаете допълнителни предложения, моля уточнете по-голям радиус в км.`;
            }

            return language === 'en'
                ? '✅ SOURCE: Google Maps Places API (live)\nI could not find reliable live map results for this request in Bansko/Razlog right now.'
                : '✅ ИЗТОЧНИК: Google Maps Places API (live)\nНе открих надеждни live резултати в картите за тази заявка в района на Банско/Разлог.';
        }

        const lines = enrichedPlaces.map(({ place, distanceKm }, index) => {
            const name = place?.displayName?.text || (language === 'en' ? `Place ${index + 1}` : `Локация ${index + 1}`);
            const address = place?.formattedAddress || (language === 'en' ? 'Address unavailable' : 'Няма адрес');
            const mapsUrl = place?.googleMapsUri || '';
            const distanceLine = Number.isFinite(distanceKm)
                ? (language === 'en'
                    ? `   Distance from complex: ${distanceKm.toFixed(1)} km`
                    : `   Разстояние от комплекса: ${distanceKm.toFixed(1)} км`)
                : '';

            return mapsUrl
                ? `${index + 1}. ${name}\n   ${address}${distanceLine ? `\n${distanceLine}` : ''}\n   ${mapsUrl}`
                : `${index + 1}. ${name}\n   ${address}${distanceLine ? `\n${distanceLine}` : ''}`;
        });

        if (radiusConstraint.enabled) {
            return language === 'en'
                ? `✅ SOURCE: Google Maps Places API (live)\nThese are the nearest results within ${radiusConstraint.radiusKm} km from Aspen Valley, sorted from nearest to farthest:\n\n${lines.join('\n\n')}\n\nIf you want additional options, please specify up to what distance (km) to search.`
                : `✅ ИЗТОЧНИК: Google Maps Places API (live)\nТова са най-близките резултати до ${radiusConstraint.radiusKm} км от комплекса, подредени от най-близки към най-далечни:\n\n${lines.join('\n\n')}\n\nАко желаете допълнителни предложения, моля уточнете до какво разстояние (км) да търся.`;
        }

        return language === 'en'
            ? `✅ SOURCE: Google Maps Places API (live)\nLive map results in Bansko/Razlog:\n\n${lines.join('\n\n')}`
            : `✅ ИЗТОЧНИК: Google Maps Places API (live)\nLive резултати от карти за Банско/Разлог:\n\n${lines.join('\n\n')}`;
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.warn(`[PLACES] ⚠️ Timeout след ${GOOGLE_PLACES_TIMEOUT_MS}ms`);
        } else {
            console.warn('[PLACES] ⚠️ Exception:', error.message);
        }
        return null;
    }
}

// ── DB report helpers ──────────────────────────────────────────────────────

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
                SELECT check_in, check_out, payment_status FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                  AND check_in <= NOW() AND check_out > NOW()
                ORDER BY check_in ASC LIMIT 20
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
                SELECT check_in, check_out, payment_status FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                  AND check_in < ${tomorrowEndExpr} AND check_out > ${tomorrowStartExpr}
                ORDER BY check_in ASC LIMIT 20
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
                SELECT check_out, payment_status FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                  AND check_out >= ${dayStartExpr} AND check_out < ${dayEndExpr}
                ORDER BY check_out ASC LIMIT 20
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
                SELECT check_in, check_out FROM bookings
                WHERE COALESCE(LOWER(payment_status), '') = 'cancelled'
                  AND check_out >= (NOW() - INTERVAL '7 day')
                ORDER BY check_out DESC LIMIT 20
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
                SELECT check_in, check_out, power_status FROM bookings
                WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                  AND check_in <= NOW() AND check_out > NOW()
                  AND (power_status IS NULL OR LOWER(power_status) = 'unknown')
                ORDER BY check_in ASC LIMIT 20
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
            SELECT check_in, check_out, payment_status FROM bookings
            WHERE COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
              AND check_in < date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia') + INTERVAL '1 day'
              AND check_out > date_trunc('day', NOW() AT TIME ZONE 'Europe/Sofia')
            ORDER BY check_in ASC LIMIT 20
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

        return language === 'en'
            ? `Today registrations in the database (${rows.length}):\n\n${lines.join('\n')}`
            : `Регистрации за днес в базата (${rows.length}):\n\n${lines.join('\n')}`;
    } catch (error) {
        console.error('[HOST] 🔴 Грешка при регистрации за днес:', error.message);
        return language === 'en'
            ? 'I could not load today registrations from the database.'
            : 'Не успях да заредя регистрациите за днес от базата.';
    }
}

// ── Lock code / booking reply helpers ─────────────────────────────────────

function getLockAccessWindow(bookingData) {
    const checkInTs = new Date(bookingData?.check_in);
    const checkOutTs = new Date(bookingData?.check_out);
    if (Number.isNaN(checkInTs.getTime()) || Number.isNaN(checkOutTs.getTime())) {
        return { from: null, to: null };
    }
    const from = new Date(checkInTs.getTime() - (LOCK_CODE_ACCESS_START_BEFORE_CHECKIN_HOURS * 60 * 60 * 1000));
    const to = new Date(checkOutTs.getTime() + (LOCK_CODE_ACCESS_END_AFTER_CHECKOUT_HOURS * 60 * 60 * 1000));
    return { from, to };
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
                ? 'A lock code is provided only when a reservation number is supplied or detected.'
                : 'Код за брава се дава само срещу номер на резервация. Моля, изпратете кода на вашата резервация.';
        }

        try {
            const rows = await sql`
                SELECT id, reservation_code, check_in, check_out, lock_pin FROM bookings
                WHERE id = ${bookingData.booking_id} LIMIT 1
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
                    ? `I checked the database: the lock code for booking ${row.reservation_code} is ${row.lock_pin}. Allowed access window: ${accessFrom} → ${accessTo}.`
                    : `Проверих базата: кодът за бравата за резервация ${row.reservation_code} е ${row.lock_pin}. Разрешен прозорец за достъп: ${accessFrom} → ${accessTo}.`;
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
            return `Welcome, ${bookingData.guest_name}. Your reservation code ${bookingData.reservation_code} is active from ${checkIn} to ${checkOut}. I checked the database: your temporary lock code is ${bookingData.lock_pin}. Allowed access window: ${accessFrom || checkIn} → ${accessTo || checkOut}.`;
        }
        return `Welcome, ${bookingData.guest_name}. Your reservation code ${bookingData.reservation_code} is active from ${checkIn} to ${checkOut}. I checked the database: there is no generated temporary lock code yet. Access window: ${accessFrom || checkIn} → ${accessTo || checkOut}.`;
    }

    if (hasLockCodeInDb) {
        return `Привет, ${bookingData.guest_name}. Кодът ви за резервация ${bookingData.reservation_code} е активен за периода от ${checkIn} до ${checkOut}. Проверих базата: временният код за бравата е ${bookingData.lock_pin}. Разрешен прозорец за достъп: ${accessFrom || checkIn} → ${accessTo || checkOut}.`;
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
        return `I rechecked your reservation in real time.\n\nReservation code: ${bookingData.reservation_code}\nGuest: ${bookingData.guest_name}\nCheck-in: ${checkIn}\nCheck-out: ${checkOut}\nTemporary lock code: managed in Tuya and sent in the allowed access window\nConfigured lock-code access window: ${accessFrom || checkIn} → ${accessTo || checkOut}`;
    }
    return `Проверих отново резервацията в реално време.\n\nКод за резервация: ${bookingData.reservation_code}\nГост: ${bookingData.guest_name}\nНастаняване: ${checkIn}\nНапускане: ${checkOut}\nВременен код за бравата: управлява се в Tuya и се изпраща в разрешения прозорец за достъп\nКонфигуриран прозорец за достъп до lock code: ${accessFrom || checkIn} → ${accessTo || checkOut}`;
}

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

function getModelIdentityReply(language = 'bg') {
    const geminiChain = Array.isArray(MODELS) ? MODELS.filter(Boolean) : [];
    const groqPrimary = String(GROQ_MODEL || '').trim();
    const groqFallback = String(GROQ_FALLBACK_MODEL || '').trim();
    const backupModel = String(BACKUP_MODEL || '').trim();

    if (language === 'en') {
        const lines = [
            'Current runtime model routing:',
            `- Groq Router primary: ${groqPrimary || 'not configured'}`,
            `- Groq Router fallback: ${groqFallback || 'not configured'}`,
            `- Gemini chain: ${geminiChain.length ? geminiChain.join(' -> ') : 'not configured'}`,
            `- Backup model: ${backupModel || 'not configured'}`
        ];
        return lines.join('\n');
    }

    const lines = [
        'Текуща runtime схема на моделите:',
        `- Groq Router primary: ${groqPrimary || 'не е конфигуриран'}`,
        `- Groq Router fallback: ${groqFallback || 'не е конфигуриран'}`,
        `- Gemini верига: ${geminiChain.length ? geminiChain.join(' -> ') : 'не е конфигурирана'}`,
        `- Backup модел: ${backupModel || 'не е конфигуриран'}`
    ];
    return lines.join('\n');
}

function formatAccessWindowDateTime(value, language = 'bg') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Sofia',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        hour12: false
    }).formatToParts(date);

    const day = parts.find(p => p.type === 'day')?.value || '00';
    const month = parts.find(p => p.type === 'month')?.value || '00';
    const year = parts.find(p => p.type === 'year')?.value || '0000';
    const hour = parts.find(p => p.type === 'hour')?.value || '00';
    const connector = language === 'en' ? 'at' : 'в';

    return `${day}.${month}.${year} ${connector} ${hour}:00`;
}

function getAccessWindowStateReply(accessWindow, language = 'bg') {
    if (!accessWindow?.phase) return null;

    if (accessWindow.phase === 'before_open') {
        const availableAt = formatAccessWindowDateTime(accessWindow.windowStart, language) || '-';
        return language === 'en'
            ? `Hi there! 😊 Iko will be ready to assist you from ${availableAt}. Until then, feel free to reach your host at +359 888 600 851.`
            : `Здравейте! 😊 Ико ще е готов да ви съдейства от ${availableAt}. Дотогава може да се свържете с домакина на +359 888 600 851.`;
    }

    if (accessWindow.phase === 'after_close') {
        return language === 'en'
            ? 'Hope you had an amazing stay! 😊 Iko is no longer active for this reservation. For any feedback, please contact your host at +359 888 600 851.'
            : 'Надяваме се, че сте имали страхотен престой! 😊 Ико вече не е активен за тази резервация. За обратна връзка, моля свържете се с домакина на +359 888 600 851.';
    }

    return null;
}

// ============================================================================
// EXPORTED: checkEmergencyPower
// ============================================================================

export async function checkEmergencyPower(userMessage, role, bookingData) {
    console.log('\n[POWER] Проверявам за спешни ситуации на тока...');

    if (role !== 'guest' && role !== 'host') {
        console.log('[POWER] Не е гост или домакин - пропускам');
        return '';
    }

    const emergencyPowerKeywords = /няма ток|без ток|не работи ток|спрян ток|изключен ток|няма енергия|NO POWER|нет тока/i;
    const medicalEmergencyKeywords = /болен|травма|инфаркт|помощ|спешност|здравословен|насилие|пожар/i;
    const powerCommandKeywords = /включи|включване|пусни|пуснеш|цъкни|възстанови|дай\s+ток|изключи|спри|угаси|изгаси|махни\s+тока|power\s*on|power\s*off|turn\s*on|turn\s*off|restore\s*power|cut\s*power|άναψε|αναψε|άνοιξε|ανοιξε|κλείσε|κλεισε|σβήσε|σβησε|σταμάτα|σταματα|porneste|pornește|aprinde|activeaza|activează|opreste|oprește|stinge|ukljuci|uključi|iskljuci|isključi|укључи|искључи|вклучи|исклучи|einschalten|ausschalten|anmachen|ausmachen|strom\s+an|strom\s+aus|aç|ac|kapat|durdur|söndür|sondur/i;

    const needsPower = emergencyPowerKeywords.test(userMessage);
    const needsMedical = medicalEmergencyKeywords.test(userMessage);
    const isPowerCommand = powerCommandKeywords.test(userMessage) || isLikelyPowerCommand(userMessage);

    if (!needsPower && !needsMedical && !isPowerCommand) {
        console.log('[POWER] Не са разпознати ключови думи за спешност или команди');
        return '';
    }

    if (isPowerCommand) {
        console.log('[POWER] 🎯 КОМАНДА ЗА УПРАВЛЕНИЕ НА ТОК (role=' + role + ')');
        const commandSource = role === 'host' ? 'host_command' : 'guest_command';
        const { isInclude, isExclude } = detectPowerCommandIntent(userMessage);

        if (isInclude) {
            console.log('[POWER] ⚡ КОМАНДА: ВКЛЮЧИ ТОКА');
            const success = await automationClient.controlPower(true, bookingData?.id, commandSource);
            console.log(`[POWER] Резултат от HA команда: success=${success}`);
            return success
                ? 'Разбрах. Пуснах тока успешно. ✅'
                : 'Изпратих команда за включване на тока, но Home Assistant не потвърди успех. Провери системата.';
        } else if (isExclude) {
            console.log('[POWER] ⚡ КОМАНДА: ИЗКЛЮЧИ ТОКА');
            const success = await automationClient.controlPower(false, bookingData?.id, commandSource);
            console.log(`[POWER] Резултат от HA команда: success=${success}`);
            return success
                ? 'Разбрах. Спрях тока успешно. ✅'
                : 'Изпратих команда за спиране на тока, но Home Assistant не потвърди успех. Провери системата.';
        }
    }

    if (needsMedical) {
        console.log('[POWER] 🚑 МЕДИЦИНСКА СПЕШНОСТ РАЗПОЗНАТА');
        await automationClient.sendAlert(
            `🚑 МЕДИЦИНСКА СПЕШНОСТ: Гост ${bookingData?.guest_name} (${bookingData?.reservation_code}) докладва здравословна проблем.`,
            {
                guest_name: bookingData?.guest_name || 'Непознат',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role,
                timestamp: new Date().toISOString(),
                action: 'medical-emergency',
                severity: 'CRITICAL'
            }
        );
        return '';
    }

    console.log('[POWER] 🚨 ОВЪРАЙД НА ГОСТ АКТИВИРАН: Принудително включване на ток');
    const overrideSuccess = await automationClient.controlPower(true, bookingData?.id, 'ai_emergency_override');
    console.log(`[POWER:OVERRIDE] Резултат от HA команда: success=${overrideSuccess}`);

    if (overrideSuccess) {
        console.log('[POWER] ✅ Команда за возстановяване на ток изпратена успешно');
        await automationClient.sendAlert(
            `🚨 СПЕШНО ВЪЗСТАНОВЯВАНЕ НА ТОК: Гост ${bookingData?.guest_name} (${bookingData?.reservation_code}) докладва липса на ток. Ток е включен автоматично.`,
            {
                guest_name: bookingData?.guest_name || 'Непознат',
                reservation_code: bookingData?.reservation_code || 'N/A',
                role,
                timestamp: new Date().toISOString(),
                action: 'emergency-power-restore',
                severity: 'HIGH'
            }
        );

        return `Разбрах! Изпратих сигнал към апартамента. 📡

⏳ Какво следва: Трябва да получите потвърждение до 30 секунди.

⚠️ Ако нищо не се случи: Това означава, че комуникацията с апартамента е прекъсната. В 99% от случаите това значи ЦЕНТРАЛНА АВАРИЯ в района.

🔗 Проверете тук: https://info.electrohold.bg (Община Разлог)`;
    }

    return '';
}

// ============================================================================
// EXPORTED: processAlerts
// ============================================================================

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
        await automationClient.sendAlert(alertMessage, {
            guest_name: bookingData?.guest_name || 'Неизвестен гост',
            reservation_code: bookingData?.reservation_code || 'N/A',
            role,
            timestamp: new Date().toISOString()
        });
        console.log('[ALERTS] Известуванието е изпратено до домакина успешно');
    }

    const cleanedResponse = aiResponse.replace(/\[ALERT:.*?\]/g, '').trim();
    console.log('[ALERTS] Известувателни маркери премахнати от отговор');
    return cleanedResponse;
}

// ============================================================================
// EXPORTED: getAIResponse
// ============================================================================

export async function getAIResponse(userMessage, history = [], authCode = null) {
    if (!genAI && !canUseGroqRouter() && !(BACKUP_API_KEY && BACKUP_API_URL && BACKUP_MODEL)) {
        console.error('🔴 ГРЕШКА: Липсват Gemini, Groq router и backup API конфигурации');
        return 'В момента имам техническо затруднение (API Key Error).';
    }

    // 1. Роля + предпочитан език
    const { role, data, accessWindow } = await determineUserRole(authCode, userMessage, history);
    const preferredLanguage = detectPreferredLanguage(userMessage, history);
    const manualScopeQuestion = shouldUseGroqRouterForMessage(userMessage);
    let forceGeminiDirect = false;
    let braveSearchResults = null;

    const accessWindowReply = getAccessWindowStateReply(accessWindow, preferredLanguage);
    if (accessWindowReply) return accessWindowReply;

    // 2. Детерминистични отговори (без AI)
    if (isModelIdentityRequest(userMessage)) {
        return getModelIdentityReply(preferredLanguage);
    }

    if (isRoleIdentityRequest(userMessage)) {
        return getRoleIdentityReply(role, preferredLanguage);
    }

    // Приоритет: ако потребителят изрично иска код за брава,
    // не връщаме onboarding, а директно правим lookup.
    if (isLockCodeLookupRequest(userMessage)) {
        return await getLockCodeLookupReply(role, data, preferredLanguage);
    }

    if (role === 'guest' && (isReservationCodeIntro(userMessage) || isBareReservationCodeMessage(userMessage) || containsReservationCode(userMessage))) {
        return getGuestOnboardingReply(data, preferredLanguage);
    }

    if (isReservationRefreshRequest(userMessage)) {
        return getReservationRefreshReply(role, data, preferredLanguage);
    }

    if (isTodayRegistrationsRequest(userMessage)) {
        return await getTodayRegistrationsReply(role, preferredLanguage);
    }

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

    // 2.5. Ръчна проверка на пощата при поискване от домакина
    if (role === 'host' && isMailCheckRequest(userMessage)) {
        console.log('[MAIL_CHECK] 📬 Домакин поиска ръчна проверка на Gmail');
        try {
            const execution = await runDetectiveCommand('sync_email_now', { ignoreLastCheck: true, source: 'host_chat' });
            if (!execution.success) {
                return preferredLanguage === 'en'
                    ? `I could not run detective email sync (${execution.error || 'unknown error'}).`
                    : `Не успях да пусна детектива за синк на пощата (${execution.error || 'неизвестна грешка'}).`;
            }

            const sync = execution.result || {};
            if (preferredLanguage === 'en') {
                return `Detective sync finished.\n\nQuery: ${sync.query || 'N/A'}\nFound unread: ${Number(sync.matchedCount || 0)}\nProcessed: ${Number(sync.processedCount || 0)}\nUpserted bookings: ${Number(sync.upsertedCount || 0)}\nCancelled: ${Number(sync.cancelledCount || 0)}\nFailed parse: ${Number(sync.failedCount || 0)}\nCodes: ${(sync.reservationCodes || []).join(', ') || 'none'}`;
            }

            return `Синкът на детектива приключи.\n\nЗаявка: ${sync.query || 'N/A'}\nНамерени непрочетени: ${Number(sync.matchedCount || 0)}\nОбработени: ${Number(sync.processedCount || 0)}\nЪпсертнати резервации: ${Number(sync.upsertedCount || 0)}\nАнулирани: ${Number(sync.cancelledCount || 0)}\nНеуспешен parse: ${Number(sync.failedCount || 0)}\nКодове: ${(sync.reservationCodes || []).join(', ') || 'няма'}`;
        } catch (e) {
            console.error('[MAIL_CHECK] 🔴 Грешка при ръчна проверка:', e.message);
            return preferredLanguage === 'en'
                ? 'I tried to check the inbox but ran into a technical issue.'
                : 'Опитах да проверя пощата, но имах техническа грешка.';
        }
    }

    const isAuthorized = role === 'guest' || role === 'host';
    const hasDirectionsIntent = isDirectionsRequest(userMessage) || isRouteFollowUpMessage(userMessage, history);
    const hasPlacesIntent = isLivePlacesLookupRequest(userMessage) || isMapStyleQuestion(userMessage);
    const hasSearchIntent = !manualScopeQuestion && isSearchEligibleQuery(userMessage);
    const routeFallbackReply = preferredLanguage === 'en'
        ? 'Please use these coordinates 41.874389, 23.423650 (https://maps.app.goo.gl/so3NdoVnPGZ3cQp49) for navigation.'
        : 'Моля, използвайте тези координати 41.874389, 23.423650 (https://maps.app.goo.gl/so3NdoVnPGZ3cQp49) за навигация.';

    // 2.4. Сигурностна бариера за командване на ток от неоторизиран
    const requestedPowerCommand = isPowerCommandRequest(userMessage);
    if (requestedPowerCommand && role !== 'guest' && role !== 'host') {
        console.warn('[SECURITY] 🚫 Блокирана команда за ток от неоторизиран потребител');
        return preferredLanguage === 'en'
            ? `I cannot execute power commands because you are not authorized.\n\nTo get access:\n- Host: sign in with a valid token.\n- Guest: send a valid reservation code from an active booking.\n\nAfter successful verification, I will execute the command immediately.`
            : `Не мога да изпълня команда за тока, защото не сте оторизиран.\n\nЗа достъп:\n- Домакин: влезте с валиден token.\n- Гост: изпратете валиден код за резервация от активна резервация.\n\nСлед успешна верификация ще изпълня командата веднага.`;
    }

    // 3. Статус на тока
    const powerStatus = await automationClient.getPowerStatus();
    const locale = preferredLanguage === 'en' ? 'en-GB' : 'bg-BG';
    const currentDateTime = new Date().toLocaleString(locale, { timeZone: 'Europe/Sofia' });

    // 3.5. Кратък отговор само за статус на ток
    if (isPowerStatusRequest(userMessage) && !requestedPowerCommand) {
        const sourceStatus = await getSourcePowerStatus(role, data);
        if (!sourceStatus.available) {
            return preferredLanguage === 'en'
                ? 'I currently cannot read power source status.'
                : 'В момента не мога да прочета статуса от power history.';
        }
        if (sourceStatus.state === 'on') return preferredLanguage === 'en' ? 'Yes, there is electricity.' : 'Да, има ток.';
        if (sourceStatus.state === 'off') return preferredLanguage === 'en' ? 'No, there is no electricity.' : 'Не, няма ток.';
        return preferredLanguage === 'en'
            ? 'There is no power history status at the moment.'
            : 'В момента няма статус в power history.';
    }

    // 4. Четене на manual
    let manualContent = '';
    try {
        if (role === 'stranger') {
            manualContent = await fs.readFile(path.join(process.cwd(), 'services', 'manual-public.txt'), 'utf-8');
            console.log('📖 Прочетен manual-public.txt');
        } else {
            manualContent = await fs.readFile(path.join(process.cwd(), 'services', 'manual-private.txt'), 'utf-8');
            console.log('📖 Прочетен manual-private.txt');
        }
    } catch (error) {
        console.error('🔴 Грешка при четене на наръчник:', error.message);
        try {
            manualContent = await fs.readFile(
                path.join(process.cwd(), role === 'stranger' ? 'manual-public.txt' : 'manual-private.txt'),
                'utf-8'
            );
        } catch (e) {
            manualContent = role === 'stranger' ? PUBLIC_INFO_FALLBACK : 'Няма достъп до наръчника.';
        }
    }

    // 5. Системна инструкция
    let systemInstruction = buildSystemInstruction(role, data, powerStatus, manualContent, currentDateTime, preferredLanguage);

    // 5.5. Команди за ток
    const powerCommandResult = await checkEmergencyPower(userMessage, role, data);
    if (powerCommandResult) {
        console.log('[MAIN] ✅ Команда за управление на ток е разпозната и изпълнена');
        return powerCommandResult;
    }

    // 6. Groq router → Gemini (или директно Gemini)
    let finalReply = 'В момента имам техническо затруднение. Моля, опитайте след малко.';
    let generatedByModel = false;
    let manualDraftFromRouter = null;

    if (!forceGeminiDirect && canUseGroqRouter()) {
        console.log(`[GROQ_ROUTER] Старт на router first-pass (manualLike=${manualScopeQuestion})`);
        const routerResult = await generateWithGroqRouter(role, preferredLanguage, manualContent, history, userMessage);

        console.log('[MODEL_ROUTING] GROQ_DECISION:', {
            decision: routerResult?.decision || 'unknown',
            delegated: Boolean(routerResult?.delegated),
            model: routerResult?.model || null,
            reason: routerResult?.reason || null,
            manualLike: manualScopeQuestion,
            role
        });

        if (routerResult?.reply) {
            console.log('[GROQ_ROUTER] ✅ Директен отговор от Groq (без Gemini пост-обработка)');
            return routerResult.reply;
        } else {
            console.log('[GROQ_ROUTER] ↪️ Делегация/без отговор -> продължавам към Gemini');
        }
    } else if (forceGeminiDirect) {
        console.log('[MODEL_ROUTING] GROQ_DECISION:', {
            decision: 'skip',
            delegated: true,
            model: null,
            reason: 'force_gemini_direct',
            manualLike: manualScopeQuestion,
            role
        });
        console.log('[ROUTING] ⏭️ Force Gemini direct (live web/maps context)');
    } else {
        console.log('[MODEL_ROUTING] GROQ_DECISION:', {
            decision: 'skip',
            delegated: true,
            model: null,
            reason: 'router_unavailable',
            manualLike: manualScopeQuestion,
            role
        });
    }

    // 6.2. Строг manual-only режим за неоторизиран потребител
    if (!isAuthorized) {
        console.log('[MODEL_ROUTING] HIERARCHY_PATH=stranger_manual_only', {
            role,
            manualLike: manualScopeQuestion,
            delegatedToExternal: false
        });
        if (hasDirectionsIntent) {
            const routeReply = getManualRouteReplyForStranger(userMessage, preferredLanguage, true);
            if (routeReply) {
                const usedFallback = routeReply.includes('41.874389, 23.423650');
                console.log('[MODEL_ROUTING] ROUTE_MANUAL_RESULT', {
                    source: usedFallback ? 'coordinates_fallback' : 'manual_route',
                    role
                });
                return routeReply;
            }
            console.log('[MODEL_ROUTING] ROUTE_FALLBACK=manual_coordinates');
            return routeFallbackReply;
        }
        return preferredLanguage === 'en'
            ? 'This question requires authorization. Please enter your active reservation registration code so I can continue.'
            : 'За този въпрос е нужна оторизация. Моля, въведете регистрационния код на активна резервация, за да продължим.';
    }

    console.log('[MODEL_ROUTING] HIERARCHY_PATH=authorized_delegated', {
        role,
        manualLike: manualScopeQuestion,
        directions: hasDirectionsIntent,
        places: hasPlacesIntent,
        search: hasSearchIntent
    });

    // 6.3. За оторизирани: външни lookup-и СЛЕД Groq делегация
    if (hasDirectionsIntent) {
        const directionsReply = await getDirectionsReply(userMessage, preferredLanguage, role, data);
        if (directionsReply) return directionsReply;

        if (GOOGLE_PLACES_STRICT_MODE) {
            return preferredLanguage === 'en'
                ? '❌ SOURCE: Google Directions API (live) not available.'
                : '❌ ИЗТОЧНИК: Google Directions API (live) не е наличен.';
        }
        console.log('[DIRECTIONS] ↪️ Няма live directions. Връщам координати fallback (без Gemini).');
        return routeFallbackReply;
    }

    if (hasPlacesIntent) {
        const livePlacesReply = await getLivePlacesReply(userMessage, preferredLanguage);
        if (livePlacesReply) return livePlacesReply;

        if (GOOGLE_PLACES_STRICT_MODE) {
            const blockedHint = isPlacesBlockedNow() ? `\n${getPlacesBlockedHint(preferredLanguage)}` : '';
            return preferredLanguage === 'en'
                ? `❌ SOURCE: Google Maps Places API (live) not available.${blockedHint}`
                : `❌ ИЗТОЧНИК: Google Maps Places API (live) не е наличен.${blockedHint}`;
        }
        forceGeminiDirect = true;
        console.log('[PLACES] ↪️ Няма live maps резултат. Форсирам Gemini direct.');
    }

    if (hasSearchIntent) {
        const searchQuery = buildGeoAnchoredSearchQuery(userMessage, preferredLanguage);
        braveSearchResults = await searchBrave(searchQuery, preferredLanguage);
        if (braveSearchResults) {
            console.log('[BRAVE] ✅ Интегрирам резултатите в Gemini контекст');
            forceGeminiDirect = true;
        }
    }

    if (braveSearchResults) {
        if (isGeoSensitiveTourismQuery(userMessage)) {
            const geoSafetyInstruction = preferredLanguage === 'en'
                ? '\n\nGeo safety rule: For hiking, eco paths, and tourist route topics, accept only places in Pirin, Bulgaria (Razlog/Bansko area). Ignore or explicitly reject results from North Macedonia or other countries with similar place names.'
                : '\n\nГео правило: При екопътеки, преходи и туристически маршрути приемай само места в Пирин, България (района Разлог/Банско). Игнорирай или изрично отхвърляй резултати от Северна Македония или други държави със сходни топоними.';
            systemInstruction += geoSafetyInstruction;
        }

        const searchContextLabel = preferredLanguage === 'en'
            ? '\n\n=== LIVE WEB SEARCH RESULTS (via Brave Search API) ===\nFor this request, treat these live results as the highest-priority source. Answer only from these results for web-search content. Do not say that information is missing if relevant results are present. Do not invent venues, names, addresses, menus, or locations beyond what is explicitly stated below. If the live results are inconclusive, say so plainly.'
            : '\n\n=== LIVE WEB SEARCH РЕЗУЛТАТИ (via Brave Search API) ===\nЗа този въпрос третирай тези live резултати като източник с най-висок приоритет. За уеб-търсенето отговаряй само по тези резултати. Не казвай, че няма информация, ако по-долу има релевантни резултати. Не измисляй заведения, имена, адреси, менюта или локации извън изрично написаното по-долу. Ако live резултатите са неубедителни, кажи го директно.';
        systemInstruction += `${searchContextLabel}\n${braveSearchResults}`;
    }

    // 6.5. Gemini генериране
    if (!generatedByModel) {
        const geminiResult = await generateWithGemini(systemInstruction, history, userMessage, manualDraftFromRouter);
        if (geminiResult.reply) {
            finalReply = geminiResult.reply;
            generatedByModel = true;
        }
    }

    // 6.8. Ако Gemini не отговори — върни manual draft ако има
    if (!generatedByModel && manualDraftFromRouter) {
        finalReply = manualDraftFromRouter;
        generatedByModel = true;
    }

    // 7. Backup provider fallback
    if (!generatedByModel) {
        const backupReply = await generateWithBackupProvider(systemInstruction, history, userMessage);
        if (backupReply) {
            finalReply = backupReply;
            generatedByModel = true;
        }
    }

    // 8. Аварийно управление на тока за гост без ток
    if (role === 'guest' && !powerStatus.isOn && /няма ток|спря ток|токът не работи/i.test(userMessage)) {
        console.log('🚨 АВАРИЯ: Гост докладва липса на ток. Опит за възстановяване...');
        const success = await automationClient.controlPower(true, data?.booking_id, 'ai_guest_emergency');
        console.log(`[POWER:GUEST_EMERGENCY] Резултат от HA команда: success=${success}`);

        if (success) {
            await automationClient.sendAlert('Автоматично възстановяване на ток за гост', data);
            finalReply = `Разбрах! Изпратих сигнал към апартамента. 📡

⏳ Какво следва: Трябва да получите потвърждение до 30 секунди.

⚠️ Ако нищо не се случи и аз не потвърдя: Това означава, че комуникацията с апартамента е прекъсната. В 99% от случаите това значи ЦЕНТРАЛНА АВАРИЯ в района.

🔗 Проверете тук: https://info.electrohold.bg (Община Разлог)`;
        }
    }

    // 9. Source prefix
    const isTechnicalFallback = typeof finalReply === 'string'
        && /в момента имам техническо затруднение|technical difficulty/i.test(finalReply);

    if (braveSearchResults && generatedByModel && !isTechnicalFallback && typeof finalReply === 'string' && finalReply.trim()) {
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
// EXPORTED: checkBookingAndGetPin (legacy)
// ============================================================================

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
