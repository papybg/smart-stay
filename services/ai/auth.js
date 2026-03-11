/**
 * auth.js — Верификация на роли (хост/гост/непознат) и управление на PIN кодове.
 */

import { validateToken } from '../sessionManager.js';
import { sql, HOST_CODE, ACCESS_START_BEFORE_CHECKIN_HOURS, ACCESS_END_AFTER_CHECKOUT_HOURS } from './config.js';

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

    if (authCode) {
        const normalizedAuthCode = String(authCode).trim().toLowerCase();
        const normalizedHostCode = String(HOST_CODE).trim().toLowerCase();
        if (normalizedAuthCode === normalizedHostCode) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: authCode съвпада с HOST_CODE');
            return true;
        }
    }

    if (userMessage) {
        console.log('[SECURITY] Верификация на домакина: проверявам userMessage...');
        const trimmedMessage = String(userMessage).trim().toLowerCase();
        const normalizedHostCode = String(HOST_CODE).trim().toLowerCase();

        if (trimmedMessage === normalizedHostCode) {
            console.log('[SECURITY] ✅ ДОМАКИН ВЕРИФИЦИРАН: userMessage съвпада с HOST_CODE');
            return true;
        }

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
 * Проверява за HOST_CODE в последните user съобщения от history.
 */
export function isHostVerifiedInHistory(history = []) {
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

// ── Guest verification ─────────────────────────────────────────────────────

/**
 * Верифицира гост чрез HM резервационен код в базата данни.
 */
export async function verifyGuestByHMCode(authCode, userMessage, history = []) {
    console.log('[SECURITY] Верификация на гост: търся HM код...');
    const hmCodePattern = /HM[A-Z0-9_-]+/i;

    let codeToVerify = null;
    if (authCode && hmCodePattern.test(authCode)) {
        codeToVerify = authCode.toUpperCase();
        console.log('[SECURITY] HM код намерен в authCode');
    }

    if (!codeToVerify && userMessage) {
        const match = userMessage.match(hmCodePattern);
        if (match) {
            codeToVerify = match[0].toUpperCase();
            console.log('[SECURITY] HM код намерен в userMessage');
        }
    }

    if (!codeToVerify && Array.isArray(history)) {
        for (let index = history.length - 1; index >= 0; index--) {
            const msg = history[index];
            if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') continue;
            const match = msg.content.match(hmCodePattern);
            if (match) {
                codeToVerify = match[0].toUpperCase();
                console.log('[SECURITY] HM код намерен в history');
                break;
            }
        }
    }

    if (!codeToVerify) {
        console.log('[SECURITY] Не е намерен HM код в authCode или съобщение');
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
                        LIMIT 1
                    `;
                    if (rows.length) {
                        console.log('[SECURITY] Намерена резервация по име:', rows[0].guest_name);
                        return { role: 'guest', booking: rows[0] };
                    }
                } catch (e) {
                    console.warn('[SECURITY] Грешка при верификация по име:', e.message);
                }
            }
        }
        return { role: 'stranger', booking: null };
    }

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
            console.log('[DATABASE] ✅ Резервация намерена за код:', codeToVerify);
            return { role: 'guest', booking: bookings[0] };
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

        console.log('[DATABASE] ❌ Не е намерена резервация за HM код:', codeToVerify);
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

    // ПРОВЕРКА #2: GUEST (HM код в базата)
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
