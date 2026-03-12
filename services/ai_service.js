import fs from 'fs/promises';
import path from 'path';
import { controlPower as sendPowerCommand, controlMeterByAction } from './autoremote.js';
import { validateToken } from './sessionManager.js';

// ── Sub-module imports ─────────────────────────────────────────────────────

import {
    sql, genAI, AUTOMATION_URL, PUBLIC_INFO_FALLBACK,
    GOOGLE_PLACES_API_KEY, GOOGLE_PLACES_MAX_RESULTS,
    GOOGLE_PLACES_STRICT_MODE, GOOGLE_PLACES_TIMEOUT_MS,
    GOOGLE_PLACES_BLOCK_COOLDOWN_MS,
    GOOGLE_DIRECTIONS_API_KEY, GOOGLE_DIRECTIONS_TIMEOUT_MS,
    GOOGLE_DIRECTIONS_DEFAULT_ORIGIN,
    BACKUP_API_KEY, BACKUP_API_URL, BACKUP_MODEL,
    ACCESS_START_BEFORE_CHECKIN_HOURS, ACCESS_END_AFTER_CHECKOUT_HOURS
} from './ai/config.js';

export { assignPinFromDepot, determineUserRole } from './ai/auth.js';
import { determineUserRole } from './ai/auth.js';

import {
    generateWithGemini, generateWithBackupProvider
} from './ai/gemini.js';

import { canUseGroqRouter, generateWithGroqRouter } from './ai/groq.js';

import { searchBrave } from './ai/brave.js';

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
    isRoleIdentityRequest, shouldUseGroqRouterForMessage,
    detectPreferredLanguage, isSearchEligibleQuery
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
            const status = await this.getPowerStatus({ silent: true });
            if (status.isOn === state) {
                console.log('[AUTOMATION] ⚠️ Токът вече е', state ? 'ON' : 'OFF', '- пропускам команда');
                return true;
            }

            const command = state ? 'meter_on' : 'meter_off';
            console.log('[AUTOMATION] 📡 Управление на тока чрез Samsung API:', command);

            const success = await sendPowerCommand(state);
            if (!success) {
                console.warn('[AUTOMATION] ⚠️ Неуспешна Samsung команда');
                return false;
            }

            console.log('[AUTOMATION] ✅ Команда изпратена, изчаквам потвърждение');

            const confirmed = await this.waitForPowerState(state, 5000);
            if (!confirmed) {
                console.warn('[AUTOMATION] ⚠️ Няма потвърждение от Tasker, резервен метод (meter)');
                await this.sendMeterCommand(state);
                return false;
            }

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

// ── Power confirmation polling ─────────────────────────────────────────────

async function waitForPowerConfirmation(expectedState, timeoutMs = 20000) {
    console.log(`[POWER:WAIT] ⏳ Очаквам потвърждение от Tasker за ${expectedState ? 'ON' : 'OFF'}...`);
    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
        const latestStatus = await automationClient.getPowerStatus({ silent: true });
        const currentState = latestStatus?.isOn;
        if (currentState === expectedState) {
            const waited = Date.now() - startTime;
            console.log(`[POWER:WAIT] ✅ ПОТВЪРДЕНО! Actual state: ${currentState}, Чакахме: ${waited}ms`);
            return { success: true, actualState: currentState, waited };
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    const waited = Date.now() - startTime;
    console.log(`[POWER:WAIT] ⏰ TIMEOUT! Очаквахме ${expectedState ? 'ON' : 'OFF'} в ${waited}ms`);
    return { success: false, actualState: null, waited };
}

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
        } else {
            console.warn('[DIRECTIONS] ⚠️ Exception:', error.message);
        }
        return null;
    }
}

// ── Google Places ──────────────────────────────────────────────────────────

function buildPlacesSearchQuery(userMessage) {
    const text = String(userMessage || '').trim();
    if (!text) return 'services in Bansko and Razlog';
    if (/банско|разлог|bansko|razlog/i.test(text)) return text;
    return `${text} near Bansko and Razlog`;
}

async function getLivePlacesReply(userMessage, language = 'bg') {
    if (!GOOGLE_PLACES_API_KEY) return null;
    if (isPlacesBlockedNow()) return null;

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
    const from = new Date(checkInTs.getTime() - (ACCESS_START_BEFORE_CHECKIN_HOURS * 60 * 60 * 1000));
    const to = new Date(checkOutTs.getTime() + (ACCESS_END_AFTER_CHECKOUT_HOURS * 60 * 60 * 1000));
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
                : 'Код за брава се дава само срещу номер на резервация. Моля, изпратете вашия HM код.';
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
        return `I rechecked your reservation in real time.\n\nReservation code: ${bookingData.reservation_code}\nGuest: ${bookingData.guest_name}\nCheck-in: ${checkIn}\nCheck-out: ${checkOut}\nTemporary lock code: managed in Tuya and sent in the allowed access window\nCode validity window (power ON → power OFF): ${accessFrom || checkIn} → ${accessTo || checkOut}`;
    }
    return `Проверих отново резервацията в реално време.\n\nКод за резервация: ${bookingData.reservation_code}\nГост: ${bookingData.guest_name}\nНастаняване: ${checkIn}\nНапускане: ${checkOut}\nВременен код за бравата: управлява се в Tuya и се изпраща в разрешения прозорец за достъп\nВалидност на кода (пускане на ток → спиране на ток): ${accessFrom || checkIn} → ${accessTo || checkOut}`;
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
            await automationClient.controlPower(true, bookingData?.id, commandSource);
            const confirmation = await waitForPowerConfirmation(true, 20000);
            console.log(`[POWER] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);
            return confirmation.success
                ? 'Разбрах. Пуснах тока и получих потвърждение от системата. ✅'
                : 'Изпратих команда за включване на тока, но още нямам потвърждение от Tasker. Провери след 20-30 секунди.';
        } else if (isExclude) {
            console.log('[POWER] ⚡ КОМАНДА: ИЗКЛЮЧИ ТОКА');
            await automationClient.controlPower(false, bookingData?.id, commandSource);
            const confirmation = await waitForPowerConfirmation(false, 20000);
            console.log(`[POWER] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);
            return confirmation.success
                ? 'Разбрах. Спрях тока и получих потвърждение от системата. ✅'
                : 'Изпратих команда за спиране на тока, но още нямам потвърждение от Tasker. Провери след 20-30 секунди.';
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
    const confirmation = await waitForPowerConfirmation(true, 20000);
    console.log(`[POWER:OVERRIDE] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);

    if (overrideSuccess || confirmation.success) {
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
    if (!genAI && !(BACKUP_API_KEY && BACKUP_API_URL && BACKUP_MODEL)) {
        console.error('🔴 ГРЕШКА: Липсват Gemini и backup API конфигурации');
        return 'В момента имам техническо затруднение (API Key Error).';
    }

    // 1. Роля + предпочитан език
    const { role, data } = await determineUserRole(authCode, userMessage, history);
    const preferredLanguage = detectPreferredLanguage(userMessage, history);
    const manualScopeQuestion = shouldUseGroqRouterForMessage(userMessage);
    let forceGeminiDirect = false;
    let braveSearchResults = null;

    // 2. Детерминистични отговори (без AI)
    if (isRoleIdentityRequest(userMessage)) {
        return getRoleIdentityReply(role, preferredLanguage);
    }

    if (role === 'guest' && (isReservationCodeIntro(userMessage) || isBareReservationCodeMessage(userMessage) || containsReservationCode(userMessage))) {
        return getGuestOnboardingReply(data, preferredLanguage);
    }

    if (isReservationRefreshRequest(userMessage)) {
        return getReservationRefreshReply(role, data, preferredLanguage);
    }

    if (isLockCodeLookupRequest(userMessage)) {
        return await getLockCodeLookupReply(role, data, preferredLanguage);
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

    const allowExternalLookups = role !== 'stranger';

    // 2.1. Google Directions
    if (allowExternalLookups && isDirectionsRequest(userMessage)) {
        const directionsReply = await getDirectionsReply(userMessage, preferredLanguage);
        if (directionsReply) return directionsReply;

        if (GOOGLE_PLACES_STRICT_MODE) {
            return preferredLanguage === 'en'
                ? '❌ SOURCE: Google Directions API (live) not available.'
                : '❌ ИЗТОЧНИК: Google Directions API (live) не е наличен.';
        }
        forceGeminiDirect = true;
        console.log('[DIRECTIONS] ↪️ Няма live directions. Форсирам Gemini direct.');
    }

    // 2.2. Google Places
    if (allowExternalLookups && (isLivePlacesLookupRequest(userMessage) || isMapStyleQuestion(userMessage))) {
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

    // 2.3. Brave web search
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

    if (braveSearchResults) {
        const searchContextLabel = preferredLanguage === 'en'
            ? '\n\n=== LIVE WEB SEARCH RESULTS (via Brave Search API) ===\nIncorporate this real-time information into your answer:'
            : '\n\n=== LIVE WEB SEARCH РЕЗУЛТАТИ (via Brave Search API) ===\nВключи тази live информация в твоя отговор:';
        systemInstruction += `${searchContextLabel}\n${braveSearchResults}`;
    }

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
        console.log(`[GROQ_ROUTER] Старт на router проверка (manualLike=${manualScopeQuestion})`);

        if (manualScopeQuestion) {
            const routerResult = await generateWithGroqRouter(role, preferredLanguage, manualContent, history, userMessage);
            if (routerResult?.reply) {
                manualDraftFromRouter = routerResult.reply;
                console.log('[GROQ_ROUTER] 🧩 Получен MANUAL_DRAFT, предавам към Gemini');
            }
        } else {
            console.log('[GROQ_ROUTER] ⏭️ Bypass към Gemini (въпрос извън manual обхвата)');
        }
    } else if (forceGeminiDirect) {
        console.log('[ROUTING] ⏭️ Force Gemini direct (live web/maps context)');
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
        const confirmation = await waitForPowerConfirmation(true, 20000);
        console.log(`[POWER:GUEST_EMERGENCY] Резултат: success=${confirmation.success}, waited=${confirmation.waited}ms`);

        if (success || confirmation.success) {
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
