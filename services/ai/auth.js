/**
 * auth.js — Верификация на роли (хост/гост/непознат) и управление на PIN кодове.
 */

import { validateToken } from '../sessionManager.js';
import { sql, HOST_CODE, ACCESS_START_BEFORE_CHECKIN_HOURS, ACCESS_END_AFTER_CHECKOUT_HOURS } from './config.js';

function normalizeAccessCode(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function isBookingWithinAccessWindow(booking) {
    if (!booking?.check_in || !booking?.check_out) return false;

    const checkInTs = new Date(booking.check_in);
    const checkOutTs = new Date(booking.check_out);
    if (Number.isNaN(checkInTs.getTime()) || Number.isNaN(checkOutTs.getTime())) return false;

    const windowStart = new Date(checkInTs.getTime() - (ACCESS_START_BEFORE_CHECKIN_HOURS * 60 * 60 * 1000));
    const windowEnd = new Date(checkOutTs.getTime() + (ACCESS_END_AFTER_CHECKOUT_HOURS * 60 * 60 * 1000));
    const now = new Date();

    return now >= windowStart && now <= windowEnd;
}

function getBookingAccessWindowStatus(booking) {
    if (!booking?.check_in || !booking?.check_out) {
        return { inWindow: false, phase: 'invalid', windowStart: null, windowEnd: null };
    }

    const checkInTs = new Date(booking.check_in);
    const checkOutTs = new Date(booking.check_out);
    if (Number.isNaN(checkInTs.getTime()) || Number.isNaN(checkOutTs.getTime())) {
        return { inWindow: false, phase: 'invalid', windowStart: null, windowEnd: null };
    }

    const windowStart = new Date(checkInTs.getTime() - (ACCESS_START_BEFORE_CHECKIN_HOURS * 60 * 60 * 1000));
    const windowEnd = new Date(checkOutTs.getTime() + (ACCESS_END_AFTER_CHECKOUT_HOURS * 60 * 60 * 1000));
    const now = new Date();
    if (now < windowStart) {
        return { inWindow: false, phase: 'before_open', windowStart, windowEnd };
    }
    if (now > windowEnd) {
        return { inWindow: false, phase: 'after_close', windowStart, windowEnd };
    }
    return { inWindow: true, phase: 'active', windowStart, windowEnd };
}

function isReservationCodeToken(value = '') {
    const token = String(value || '').trim();
    return /^(?=[A-Za-z0-9_-]{5,40}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+$/.test(token);
}

function findReservationCodeTokenInText(value = '') {
    const tokens = String(value || '').match(/[A-Za-z0-9_-]{5,40}/g) || [];
    return tokens.find(token => isReservationCodeToken(token)) || null;
}

// ── Host verification ──────────────────────────────────────────────────────

/**
 * Проверява дали authCode или userMessage съдържат точния HOST_CODE.
 */
export function isHostVerified(authCode, userMessage) {
    if (!HOST_CODE) {
        console.error('[SECURITY] ❌ КРИТИЧНО: HOST_CODE не е конфигуран в Render environment');
        return false;
    }

    console.log('[SECURITY] Верификация на домакина: проверявам authCode...');

    const normalizedHostCode = normalizeAccessCode(HOST_CODE);
    const exactHostCode = String(HOST_CODE).trim().toLowerCase();

    if (authCode) {
        const normalizedAuthCode = normalizeAccessCode(authCode);
        const exactAuthCode = String(authCode).trim().toLowerCase();
        if (exactAuthCode === exactHostCode || (normalizedAuthCode && normalizedAuthCode === normalizedHostCode)) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: authCode съвпада с HOST_CODE');
            return true;
        }
    }

    if (userMessage) {
        console.log('[SECURITY] Верификация на домакина: проверявам userMessage...');
        const trimmedMessage = String(userMessage).trim().toLowerCase();
        const normalizedMessage = normalizeAccessCode(trimmedMessage);

        if (trimmedMessage === exactHostCode || (normalizedMessage && normalizedMessage === normalizedHostCode)) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: userMessage съвпада с HOST_CODE');
            return true;
        }

        const escapedHostCode = exactHostCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hostCodePattern = new RegExp(`(^|[^a-z0-9])${escapedHostCode}([^a-z0-9]|$)`, 'i');
        if (hostCodePattern.test(trimmedMessage)) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: намерен точен HOST_CODE в userMessage');
            return true;
        }

        // fallback: сравнение с всеки алфанумерен token от съобщението
        const tokens = trimmedMessage.match(/[a-z0-9_-]{4,80}/gi) || [];
        for (const token of tokens) {
            const normalizedToken = normalizeAccessCode(token);
            if (normalizedToken && normalizedToken === normalizedHostCode) {
                console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: HOST_CODE съвпада с token от userMessage');
                return true;
            }
        }
    }

    console.log('[SECURITY] ❌ Верификация на домакина НЕУДАЧНА: не е намерено съответствие');
    return false;
}

/**
 * Проверява за HOST_CODE в последните user съобщения от history.
 */
export function isHostVerifiedInHistory(history = []) {
    if (!HOST_CODE || !Array.isArray(history) || history.length === 0) return false;

    const exactHostCode = String(HOST_CODE).trim().toLowerCase();
    const normalizedHostCode = normalizeAccessCode(HOST_CODE);
    const escapedHostCode = exactHostCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hostCodePattern = new RegExp(`(^|[^a-z0-9])${escapedHostCode}([^a-z0-9]|$)`, 'i');

    const recentUserMessages = history
        .filter(msg => msg && msg.role === 'user' && typeof msg.content === 'string')
        .slice(-12);

    for (let index = recentUserMessages.length - 1; index >= 0; index--) {
        const text = String(recentUserMessages[index].content || '').trim().toLowerCase();
        if (!text) continue;
        const normalizedText = normalizeAccessCode(text);
        if (text === exactHostCode || (normalizedText && normalizedText === normalizedHostCode) || hostCodePattern.test(text)) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: HOST_CODE намерен в history');
            return true;
        }

        const tokens = text.match(/[a-z0-9_-]{4,80}/gi) || [];
        if (tokens.some(token => normalizeAccessCode(token) === normalizedHostCode)) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: HOST_CODE намерен в history');
            return true;
        }
    }
    return false;
}

// ── Guest verification ─────────────────────────────────────────────────────

/**
 * Верифицира гост чрез резервационен код в базата данни.
 */
export async function verifyGuestByHMCode(authCode, userMessage, history = []) {
    console.log('[SECURITY] Верификация на гост: търся код за резервация...');

    let codeToVerify = null;
    if (authCode && isReservationCodeToken(authCode)) {
        codeToVerify = String(authCode).trim().toUpperCase();
        console.log('[SECURITY] Код за резервация намерен в authCode');
    }

    if (!codeToVerify && userMessage) {
        const token = findReservationCodeTokenInText(userMessage);
        if (token) {
            codeToVerify = token.toUpperCase();
            console.log('[SECURITY] Код за резервация намерен в userMessage');
        }
    }

    if (!codeToVerify && Array.isArray(history)) {
        for (let index = history.length - 1; index >= 0; index--) {
            const msg = history[index];
            if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') continue;
            const token = findReservationCodeTokenInText(msg.content);
            if (token) {
                codeToVerify = token.toUpperCase();
                console.log('[SECURITY] Код за резервация намерен в history');
                break;
            }
        }
    }

    if (!codeToVerify) {
        console.log('[SECURITY] Не е намерен код за резервация в authCode или съобщение');
        // Опит за поименна верификация
        if (userMessage && sql) {
            const nameMatch = userMessage.match(/\b([A-Za-zА-Яа-я]+)\s+([A-Za-zА-Яа-я]+)\b/);
            if (nameMatch) {
                const n1 = nameMatch[1].toLowerCase();
                const n2 = nameMatch[2].toLowerCase();
                console.log('[SECURITY] Опит за верификация по имена:', n1, n2);
                try {
                    const rows = await sql`
                        SELECT * FROM bookings
                        WHERE LOWER(guest_name) LIKE ${'%' + n1 + '%'}
                          AND LOWER(guest_name) LIKE ${'%' + n2 + '%'}
                          AND COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                        ORDER BY check_in ASC
                        LIMIT 1
                    `;
                    if (rows.length) {
                        const booking = rows[0];
                        const access = getBookingAccessWindowStatus(booking);
                        if (!access.inWindow) {
                            console.log('[SECURITY] Резервацията по име е извън разрешения прозорец за достъп:', booking.guest_name);
                            return {
                                role: 'stranger',
                                booking: null,
                                accessWindow: {
                                    phase: access.phase,
                                    windowStart: access.windowStart ? access.windowStart.toISOString() : null,
                                    windowEnd: access.windowEnd ? access.windowEnd.toISOString() : null,
                                    reservationCode: booking.reservation_code || null
                                }
                            };
                        }

                        console.log('[SECURITY] Намерена резервация по име:', booking.guest_name);
                        return { role: 'guest', booking };
                    }
                } catch (e) {
                    console.warn('[SECURITY] Грешка при верификация по име:', e.message);
                }
            }
        }
        return { role: 'stranger', booking: null };
    }

    if (!sql) {
        console.warn('[DATABASE] SQL клиент не е инициализиран - не мога да верифицирам код за резервация');
        return { role: 'stranger', booking: null };
    }

    try {
        const normalizedReservationCode = codeToVerify.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        console.log('[DATABASE] Запитвам таблица резервации за код:', codeToVerify);
        const bookings = await sql`
            SELECT * FROM bookings
            WHERE regexp_replace(UPPER(reservation_code), '[^A-Z0-9]', '', 'g') = ${normalizedReservationCode}
              AND COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
            LIMIT 1
        `;

        if (bookings.length > 0) {
            const booking = bookings[0];
            const access = getBookingAccessWindowStatus(booking);
            if (!access.inWindow) {
                console.log('[DATABASE] ⚠️ Кодът съществува, но е извън разрешения прозорец за достъп:', codeToVerify);
                return {
                    role: 'stranger',
                    booking: null,
                    accessWindow: {
                        phase: access.phase,
                        windowStart: access.windowStart ? access.windowStart.toISOString() : null,
                        windowEnd: access.windowEnd ? access.windowEnd.toISOString() : null,
                        reservationCode: booking.reservation_code || codeToVerify
                    }
                };
            }

            console.log('[DATABASE] ✅ Резервация намерена за код (в разрешен прозорец):', codeToVerify);
            return { role: 'guest', booking };
        }

        // Диагностичен лог: кодът съществува ли, но е изтекъл/анулиран
        const archived = await sql`
            SELECT reservation_code, payment_status, check_out
            FROM bookings
            WHERE regexp_replace(UPPER(reservation_code), '[^A-Z0-9]', '', 'g') = ${normalizedReservationCode}
            LIMIT 1
        `;
        if (archived.length > 0) {
            console.log('[DATABASE] ⚠️ Кодът съществува, но не е активен (изтекъл или анулиран):', codeToVerify);
        }

        console.log('[DATABASE] ❌ Не е намерена резервация за код:', codeToVerify);
        return { role: 'stranger', booking: null };
    } catch (e) {
        console.error('[DATABASE] Грешка при запитване на резервации:', e.message);
        return { role: 'stranger', booking: null };
    }
}

// ── PIN depot ──────────────────────────────────────────────────────────────

/**
 * Взема първия свободен PIN от pin_depot и го назначава на резервацията.
 */
export async function assignPinFromDepot(booking) {
    console.log('[PIN_DEPOT] Проверявам дали гост вече има щифт...');

    if (!booking) booking = {};
    if (!booking.id && booking.reservation_code && sql) {
        try {
            const rows = await sql`
                SELECT id, lock_pin FROM bookings WHERE reservation_code = ${booking.reservation_code} LIMIT 1
            `;
            if (rows.length) booking = { ...booking, ...rows[0] };
        } catch (e) {
            console.warn('[PIN_DEPOT] Неуспешно търсене на резервация по код:', e.message);
        }
    }

    if (booking.lock_pin) {
        console.log('[PIN_DEPOT] Гост вече има назначен щифт');
        return booking.lock_pin;
    }

    console.log('[PIN_DEPOT] Гост все още няма щифт - вземам от хранилище...');

    if (!sql) {
        console.warn('[PIN_DEPOT] SQL не е налично - не мога да назнача щифт');
        return null;
    }

    try {
        const guestName = String(booking?.guest_name || '').trim();
        const reservationCode = String(booking?.reservation_code || '').trim();
        const isTestBooking = guestName.toLowerCase().startsWith('test user') || reservationCode.toUpperCase().startsWith('TST-');

        console.log('[DATABASE] Запитвам pin_depot за първи неизползван щифт...');

        let freePins = [];
        if (isTestBooking) {
            freePins = await sql`
                SELECT id, pin_code FROM pin_depot
                WHERE is_used = FALSE
                  AND pin_name ILIKE 'TEST:%'
                ORDER BY id ASC
                LIMIT 1
            `;
        }

        if (!freePins.length) {
            freePins = await sql`
                SELECT id, pin_code FROM pin_depot
                WHERE is_used = FALSE
                ORDER BY id ASC
                LIMIT 1
            `;
        }

        if (freePins.length === 0) {
            console.error('[PIN_DEPOT] ❌ Нямаме налични неизползвани щифтове в хранилището!');
            return null;
        }

        const pin = freePins[0];
        console.log('[PIN_DEPOT] Намерен наличен щифт, маркирам като използван');

        await sql`
            UPDATE pin_depot
            SET is_used = TRUE, assigned_at = NOW()
            WHERE id = ${pin.id}
        `;
        console.log('[PIN_DEPOT] ✅ Щифт маркиран като използван в хранилището');

        if (booking.id) {
            await sql`
                UPDATE bookings
                SET lock_pin = ${pin.pin_code}, pin_assigned_at = NOW()
                WHERE id = ${booking.id}
            `;
            console.log('[PIN_DEPOT] ✅ Щифт назначен на резервация на гост');
        } else if (booking.reservation_code) {
            await sql`
                UPDATE bookings
                SET lock_pin = ${pin.pin_code}, pin_assigned_at = NOW()
                WHERE reservation_code = ${booking.reservation_code}
            `;
            console.log('[PIN_DEPOT] ✅ Щифт назначен по резервационен код');
        } else {
            console.warn('[PIN_DEPOT] Нямам начин да актуализирам резервация (липсва id и код)');
        }

        return pin.pin_code;
    } catch (e) {
        console.error('[PIN_DEPOT] Грешка при разпределяне на щифт:', e.message);
        return null;
    }
}

// ── Main role determination ────────────────────────────────────────────────

/**
 * Определя ролята на потребителя: host | guest | stranger.
 */
export async function determineUserRole(authCode, userMessage, history = []) {
    console.log('\n[SECURITY] ========== НАЧАЛО ОПРЕДЕЛЯНЕ НА РОЛЯТА НА ПОТРЕБИТЕЛЯ ==========');
    console.log('[SECURITY] authCode/token предоставен:', !!authCode);
    console.log('[SECURITY] userMessage предоставен:', !!userMessage);

    // ПРОВЕРКА #0: SESSION TOKEN
    if (authCode) {
        const sessionToken = validateToken(authCode);
        if (sessionToken) {
            console.log(`[SECURITY] ✅ SESSION TOKEN валиден за ${sessionToken.role}`);
            console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
            return { role: sessionToken.role, data: null };
        }
    }

    // ПРОВЕРКА #1: HOST (точно съответствие на код)
    if (isHostVerified(authCode, userMessage)) {
        console.log('[SECURITY] Определена роля: ДОМАКИН');
        console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
        return { role: 'host', data: null };
    }

    // ПРОВЕРКА #2: GUEST (код за резервация в базата)
    const guestCheck = await verifyGuestByHMCode(authCode, userMessage, history);
    if (guestCheck.role === 'guest' && guestCheck.booking) {
        const booking = guestCheck.booking;
        console.log('[PIN_DEPOT] Четя щифт за гост от резервация...');
        const guestData = {
            guest_name: booking.guest_name,
            reservation_code: booking.reservation_code,
            check_in: booking.check_in,
            check_out: booking.check_out,
            lock_pin: booking.lock_pin,
            booking_id: booking.id
        };
        console.log('[SECURITY] Определена роля: ГОСТ');
        console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
        return { role: 'guest', data: guestData };
    }

    if (guestCheck?.accessWindow) {
        console.log('[SECURITY] Определена роля: НЕПОЗНАТ (извън прозорец за достъп)');
        console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========' );
        return { role: 'stranger', data: null, accessWindow: guestCheck.accessWindow };
    }

    // ПРОВЕРКА #2.5: HOST от history (fallback за chat сесии без token)
    if (isHostVerifiedInHistory(history)) {
        console.log('[SECURITY] Определена роля: ДОМАКИН (history fallback)');
        console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
        return { role: 'host', data: null };
    }

    // DEFAULT: STRANGER
    console.log('[SECURITY] Определена роля: НЕПОЗНАТ');
    console.log('[SECURITY] ========== ПРОВЕРКА НА СИГУРНОСТ ЗАВЪРШЕНА ==========\n');
    return { role: 'stranger', data: null };
}
