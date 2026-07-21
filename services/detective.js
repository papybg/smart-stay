import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { assignPinFromDepot } from './ai_service.js';
import { parseSofiaDateTime } from './time.js';

export async function syncBookingsPowerFromLatestHistory() {
    try {
        if (!process.env.DATABASE_URL) {
            return { success: false, updatedCount: 0, reason: 'DATABASE_URL missing' };
        }

        const sql = neon(process.env.DATABASE_URL);
        const latestRows = await sql`
            SELECT is_on, timestamp, booking_id
            FROM power_history
            ORDER BY timestamp DESC
            LIMIT 1
        `;

        if (!latestRows.length) {
            return { success: true, updatedCount: 0, reason: 'no history rows' };
        }

        const latest = latestRows[0];
        const state = latest.is_on ? 'on' : 'off';
        const statusTs = latest.timestamp || new Date();
        const bookingIdRaw = latest.booking_id == null ? null : String(latest.booking_id).trim();
        const bookingId = bookingIdRaw && /^\d+$/.test(bookingIdRaw) ? Number(bookingIdRaw) : null;

        // 1) Explicit booking_id from power_history is the strongest source of truth.
        if (bookingId) {
            const byId = await sql`
                UPDATE bookings
                SET power_status = ${state},
                    power_status_updated_at = ${statusTs}
                WHERE id = ${bookingId}
                  AND COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                RETURNING id
            `;

            if (byId.length) {
                return {
                    success: true,
                    updatedCount: byId.length,
                    state,
                    timestamp: statusTs,
                    strategy: 'booking_id'
                };
            }
        }

        // 2) Match by access window from bookings table.
        const updated = await sql`
            UPDATE bookings
            SET power_status = ${state},
                power_status_updated_at = ${statusTs}
            WHERE power_on_time <= ${statusTs}
              AND power_off_time >= ${statusTs}
              AND COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
            RETURNING id
        `;

        if (updated.length) {
            return {
                success: true,
                updatedCount: updated.length,
                state,
                timestamp: statusTs,
                strategy: 'power_window'
            };
        }

        // 3) If command happened just after checkout, attach it to the most recent ended booking.
        const recentlyEnded = await sql`
            UPDATE bookings
            SET power_status = ${state},
                power_status_updated_at = ${statusTs}
            WHERE id IN (
                SELECT id
                FROM bookings
                WHERE check_out <= ${statusTs}
                  AND check_out >= (${statusTs}::timestamptz - INTERVAL '6 hours')
                  AND COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
                ORDER BY check_out DESC
                LIMIT 1
            )
            RETURNING id
        `;

        return {
            success: true,
            updatedCount: recentlyEnded.length,
            state,
            timestamp: statusTs,
            strategy: recentlyEnded.length ? 'recent_checkout_fallback' : 'no_match'
        };
    } catch (error) {
        console.error('[DETECTIVE] 🔴 Power sync error:', error.message);
        return { success: false, updatedCount: 0, reason: error.message };
    }
}

async function executeQueryWithRetry(queryFn, maxRetries = 3, delay = 10000) {
    for (let i = 0; i < maxRetries; i++) {
        try { return await queryFn(); } 
        catch (err) {
            if (err.message.includes('timeout') || err.message.includes('connection')) {
                console.log(`⚠️ БД опит ${i + 1}/${maxRetries}...`);
                if (i < maxRetries - 1) await new Promise(res => setTimeout(res, delay));
                else throw err;
            } else throw err;
        }
    }
}

function normalizeBookingDateValue(dateValue, fallbackYear) {
    const parsed = parseSofiaDateTime(dateValue);
    if (!parsed) return dateValue;

    if (fallbackYear && Math.abs(parsed.getFullYear() - fallbackYear) > 1) {
        const corrected = new Date(parsed);
        corrected.setFullYear(fallbackYear);
        return corrected.toISOString();
    }

    return parsed.toISOString();
}

function normalizeReservationCodeValue(value = '') {
    return String(value || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function normalizeReservationStatus(rawStatus, sourceText = '') {
    const statusText = String(rawStatus || '').trim().toLowerCase();
    const contextText = String(sourceText || '').toLowerCase();

    if (/cancel|cancell|anul|отмен|анулир/.test(statusText)) {
        return 'cancelled';
    }
    if (/confirm|approved|booked|paid|потвър|резервир/.test(statusText)) {
        return 'confirmed';
    }

    if (/reservation (is )?cancelled|booking (is )?cancelled|cancelled reservation|cancellation confirmed|отменена резервация|резервацията е отменена|анулирана резервация/.test(contextText)) {
        return 'cancelled';
    }
    if (/reservation confirmed|booking confirmed|нова резервация|потвърдена резервация/.test(contextText)) {
        return 'confirmed';
    }

    return 'unknown';
}

export async function syncBookingsFromGmail(options = {}) {
    const { ignoreLastCheck = false } = options;
    const stats = {
        success: false,
        ignoreLastCheck,
        query: null,
        afterFilter: null,
        totalCount: 0,
        matchedCount: 0,
        processedCount: 0,
        upsertedCount: 0,
        cancelledCount: 0,
        cancelledNoMatchCount: 0,
        failedCount: 0,
        reservationCodes: [],
        reason: null
    };
    console.log('🕵️ Ико Детектива проверява за нови резервации...');
    try {
        if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY || !process.env.GMAIL_CLIENT_ID) {
            console.error('❌ Липсват ENV променливи!');
            stats.reason = 'MISSING_ENV';
            return stats;
        }

        const sql = neon(process.env.DATABASE_URL);

        const afterFilter = ignoreLastCheck ? 'newer_than:7d' : 'newer_than:1d';

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET,
            'https://developers.google.com/oauthplayground'
        );
        oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        
        // ФИЛТЪР
        // търсим всички писма (прочетени и непрочетени)
        // при ръчен sync: последни 7 дни; при автоматичен: последни 24 часа
        // от позволените податели
        const allowedSenders = [
            'automated@airbnb.com',
            'pepetrow@gmail.com',
            process.env.SMTP_USER,
            process.env.SMTP_FROM,
            process.env.TEST_AIRBNB_FROM
        ]
            .map(v => String(v || '').trim().toLowerCase())
            .filter(Boolean)
            .filter((value, index, array) => array.indexOf(value) === index);

        const senderQuery = allowedSenders.length
            ? '(' + allowedSenders.map(sender => `from:${sender}`).join(' OR ') + ')'
            : '(from:automated@airbnb.com)';

        const query = `${senderQuery} ${afterFilter}`;
        const res = await gmail.users.messages.list({ userId: 'me', q: query });
        const messages = res.data?.messages || [];

        const totalCount = messages.length;
        stats.query = query;
        stats.afterFilter = afterFilter;
        stats.totalCount = totalCount;
        console.log('[DETECTIVE] 📬 Gmail query:', { query, afterFilter, totalCount });

        stats.matchedCount = messages.length;

        console.log(`🔎 Всички подходящи (без subject): ${totalCount}, след subject-филтър: ${messages.length}`);

        // after processing we'll update last check timestamp

        for (const msg of messages) {
            stats.processedCount += 1;
            const details = await processMessage(msg.id, gmail, genAI);
            
            if (details && details.reservation_code) {
                if (!stats.reservationCodes.includes(details.reservation_code)) {
                    stats.reservationCodes.push(details.reservation_code);
                }
                const normalizedStatus = normalizeReservationStatus(details.status);
                let handled = false;
                
                // --- АНУЛАЦИЯ ---
                if (normalizedStatus === 'cancelled') {
                    console.log(`🚫 Анулация за: ${details.reservation_code}`);
                    const normalizedReservationCode = normalizeReservationCodeValue(details.reservation_code);
                    if (!normalizedReservationCode) {
                        stats.failedCount += 1;
                        console.warn('[DETECTIVE] ⚠️ Празен/невалиден reservation_code при анулация. Пропускам.');
                        continue;
                    }

                    const cancelledRows = await executeQueryWithRetry(async () => {
                        return await sql`
                            UPDATE bookings 
                            SET payment_status = 'cancelled', lock_pin = NULL, updated_at = NOW(),
                            power_on_time = NULL, power_off_time = NULL
                            WHERE regexp_replace(UPPER(reservation_code), '[^A-Z0-9]', '', 'g') = ${normalizedReservationCode}
                            RETURNING id, reservation_code
                        `;
                    });

                    const affected = Array.isArray(cancelledRows) ? cancelledRows.length : 0;
                    if (affected > 0) {
                        stats.cancelledCount += affected;
                        console.log(`🗑️ Анулирани резервации: ${affected} (код: ${details.reservation_code}).`);
                    } else {
                        stats.cancelledNoMatchCount += 1;
                        console.warn(`[DETECTIVE] ⚠️ Няма съвпадение за анулация по код ${details.reservation_code} (normalized=${normalizedReservationCode}).`);
                    }

                    handled = true;
                } 
                
                // --- НОВА / ОБНОВЕНА ---
                else if (normalizedStatus === 'confirmed') {
                    // ТУК Е ПРОМЯНАТА: ИЗЧИСЛЯВАМЕ ТОКА
                    const checkInDate = parseSofiaDateTime(details.check_in);
                    const checkOutDate = parseSofiaDateTime(details.check_out);

                    if (!checkInDate || !checkOutDate) {
                        console.warn('[DETECTIVE] ⚠️ Невалидни check_in/check_out от имейла:', details.reservation_code);
                        continue;
                    }

                    // Ток Вкл: 2 часа преди настаняване
                    const powerOn = new Date(checkInDate.getTime() - (2 * 60 * 60 * 1000));
                    
                    // Ток Изкл: 1 час след напускане
                    const powerOff = new Date(checkOutDate.getTime() + (1 * 60 * 60 * 1000));

                    console.log(`📝 Ток график: ВКЛ ${powerOn.toISOString()} | ИЗКЛ ${powerOff.toISOString()}`);

                    // Вземи съществуващ PIN, или алокирай нов само за нова резервация
                    const existingBooking = await executeQueryWithRetry(async () => {
                        const rows = await sql`
                            SELECT id, lock_pin
                            FROM bookings
                            WHERE reservation_code = ${details.reservation_code}
                            LIMIT 1
                        `;
                        return rows[0] || null;
                    });

                    let pin = existingBooking?.lock_pin || null;
                    if (!pin) {
                        // pass id plus reservation_code so assignPin can update correctly
                        pin = await assignPinFromDepot({ id: existingBooking?.id, reservation_code: details.reservation_code });
                    }
                    
                    await executeQueryWithRetry(async () => {
                        await sql`
                            INSERT INTO bookings (reservation_code, guest_name, check_in, check_out, power_on_time, power_off_time, source, payment_status, lock_pin)
                            VALUES (${details.reservation_code}, ${details.guest_name}, ${checkInDate.toISOString()}, ${checkOutDate.toISOString()}, ${powerOn.toISOString()}, ${powerOff.toISOString()}, 'airbnb', 'paid', ${pin})
                            ON CONFLICT (reservation_code) 
                            DO UPDATE SET 
                                guest_name = EXCLUDED.guest_name, 
                                check_in = EXCLUDED.check_in, 
                                check_out = EXCLUDED.check_out,
                                power_on_time = EXCLUDED.power_on_time, -- Обновяваме и тока
                                power_off_time = EXCLUDED.power_off_time,
                                payment_status = 'paid',
                                lock_pin = COALESCE(bookings.lock_pin, EXCLUDED.lock_pin);
                        `;
                    });
                    stats.upsertedCount += 1;
                    console.log(`✅ Успешен запис с график за тока!`);
                    handled = true;
                } else {
                    stats.failedCount += 1;
                    console.warn(`[DETECTIVE] ⚠️ Неразпознат статус "${details.status}" за ${details.reservation_code}. Пропускам писмото.`);
                }

                if (handled) {
                    await gmail.users.messages.modify({
                        userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] }
                    });
                }

            } else {
                stats.failedCount += 1;
                console.warn(`⚠️ Писмо ${msg.id}: Неуспешен анализ.`);
            }
        }

        // record current time as last email check
        try {
            await sql`INSERT INTO system_settings (key, value) VALUES ('last_email_check', NOW()) ON CONFLICT (key) DO UPDATE SET value = NOW()`;
        } catch (e) {
            console.warn('[DETECTIVE] ⚠️ Неуспешен запис на last_email_check:', e.message);
        }

        stats.success = true;
        stats.reason = 'OK';
        return stats;

    } catch (err) {
        console.error('❌ Критична грешка:', err);
        stats.reason = err?.message || 'SYNC_FAILED';
        return stats;
    }
}

async function processMessage(id, gmail, genAI) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const messageDate = res.data.internalDate ? new Date(Number(res.data.internalDate)) : new Date();
        const fallbackYear = Number.isNaN(messageDate.getTime()) ? new Date().getFullYear() : messageDate.getFullYear();
        const currentYear = new Date().getFullYear();
        
        const payload = res.data.payload;
        const subject = payload.headers.find(h => h.name === 'Subject')?.value || '';
        
        const getBody = (part) => {
            if (part.body && part.body.data) return Buffer.from(part.body.data, 'base64').toString('utf-8');
            if (part.parts) return part.parts.map(getBody).join('\n');
            return "";
        };
        const body = getBody(payload);
        const fullText = `Subject: ${subject}\n\nBody:\n${body}`;
        
        const prompt = `
        Analyze this Airbnb email (English or Bulgarian).
        
        TASK:
        1. Determine STATUS: "confirmed" or "cancelled".
        2. Extract Details including SPECIFIC TIME if available.
        
        TIME RULES:
        - Look for times like "22:00", "14:00", "2 PM", "10 PM".
        - If NO time is found in text, use defaults: Check-in = 15:00, Check-out = 11:00.
        - Combine Date and Time into ISO format: "YYYY-MM-DD HH:mm:ss".
        - IMPORTANT: Current year is ${currentYear}. All reservation dates must be ${currentYear} or later unless explicitly stated otherwise in the email.
        
        FORMAT (JSON ONLY):
        {
            "status": "confirmed" OR "cancelled" (use exactly one of these two, lowercase),
            "reservation_code": "HM...",
            "guest_name": "Name",
            "check_in": "YYYY-MM-DD HH:mm:ss", 
            "check_out": "YYYY-MM-DD HH:mm:ss"
        }
        
        Email Text:
        ${fullText}`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json|```/g, '').trim();
        
        console.log(`🤖 AI Данни за ${id}:`, text);

        try {
            const details = JSON.parse(text);
            if (details && typeof details === 'object') {
                details.status = normalizeReservationStatus(details.status, `${subject}\n${body}`);
                details.check_in = normalizeBookingDateValue(details.check_in, fallbackYear);
                details.check_out = normalizeBookingDateValue(details.check_out, fallbackYear);
            }
            return details;
        } catch (e) {
            console.error('❌ JSON Error:', text);
            return null;
        }
    } catch (err) {
        console.error(`❌ Грешка при писмо ${id}:`, err);
        return null;
    }
}