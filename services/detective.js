import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { assignPinFromDepot } from './ai_service.js';

export async function syncBookingsPowerFromLatestHistory() {
    try {
        if (!process.env.DATABASE_URL) {
            return { success: false, updatedCount: 0, reason: 'DATABASE_URL missing' };
        }

        const sql = neon(process.env.DATABASE_URL);
        const latestRows = await sql`
            SELECT is_on, timestamp
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

        const updated = await sql`
            UPDATE bookings
            SET power_status = ${state},
                power_status_updated_at = ${statusTs}
            WHERE check_in <= ${statusTs}
              AND check_out > ${statusTs}
              AND COALESCE(LOWER(payment_status), 'paid') <> 'cancelled'
            RETURNING id
        `;

        return { success: true, updatedCount: updated.length, state, timestamp: statusTs };
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

export async function syncBookingsFromGmail() {
    console.log('🕵️ Ико Детектива проверява за нови резервации...');
    try {
        if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY || !process.env.GMAIL_CLIENT_ID) {
            console.error('❌ Липсват ENV променливи!');
            return;
        }

        const sql = neon(process.env.DATABASE_URL);

        // read last check timestamp from settings table
        let lastCheck = null;
        try {
            const row = await sql`SELECT value FROM system_settings WHERE key = 'last_email_check'`;
            if (row.length) {
                lastCheck = row[0].value;
            }
        } catch (e) {
            console.warn('[DETECTIVE] ⚠️ Няма last_email_check или грешка при четене:', e.message);
        }

        const afterFilter = lastCheck
            ? `after:${Math.floor(new Date(lastCheck).getTime() / 1000)}`
            : 'newer_than:30d';

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET,
            'https://developers.google.com/oauthplayground'
        );
        oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        
        // ФИЛТЪР
        // по-широк филтър: търсим думи, които означават потвърждение/анулиране/резервация
        // + само непрочетени и в рамките на последните 30 дни
        const baseQuery = '(from:automated@airbnb.com OR from:pepetrow@gmail.com) is:unread newer_than:30d';
        // широкият (без subject) за статистика
        const baseRes = await gmail.users.messages.list({ userId: 'me', q: baseQuery });
        const totalCount = baseRes.data?.messages?.length || 0;

        const query = '(from:automated@airbnb.com OR from:pepetrow@gmail.com) (subject:потвърдена OR subject:потвърдено OR subject:confirmed OR subject:cancelled OR subject:canceled OR subject:анулирана OR subject:резервация) is:unread newer_than:30d';
        
        const res = await gmail.users.messages.list({ userId: 'me', q: query });
        const messages = res.data?.messages || [];

        console.log(`🔎 Всички подходящи (без subject): ${totalCount}, след subject-филтър: ${messages.length}`);

        // after processing we'll update last check timestamp

        for (const msg of messages) {
            const details = await processMessage(msg.id, gmail, genAI);
            
            if (details && details.reservation_code) {
                
                // --- АНУЛАЦИЯ ---
                if (details.status === 'cancelled') {
                    console.log(`🚫 Анулация за: ${details.reservation_code}`);
                    await executeQueryWithRetry(async () => {
                        await sql`
                            UPDATE bookings 
                            SET payment_status = 'cancelled', lock_pin = NULL, updated_at = NOW(),
                            power_on_time = NULL, power_off_time = NULL
                            WHERE reservation_code = ${details.reservation_code}
                        `;
                    });
                    console.log(`🗑️ Резервация ${details.reservation_code} е маркирана като анулирана.`);
                } 
                
                // --- НОВА / ОБНОВЕНА ---
                else {
                    // ТУК Е ПРОМЯНАТА: ИЗЧИСЛЯВАМЕ ТОКА
                    const checkInDate = new Date(details.check_in);
                    const checkOutDate = new Date(details.check_out);

                    // Ток Вкл: 2 часа преди настаняване
                    const powerOn = new Date(checkInDate.getTime() - (2 * 60 * 60 * 1000));
                    
                    // Ток Изкл: 1 час след напускане
                    const powerOff = new Date(checkOutDate.getTime() + (1 * 60 * 60 * 1000));

                    console.log(`📝 Ток график: ВКЛ ${powerOn.toISOString()} | ИЗКЛ ${powerOff.toISOString()}`);

                    // Вземи съществуващ PIN, или алокирай нов само за нова резервация
                    const existingBooking = await executeQueryWithRetry(async () => {
                        const rows = await sql`
                            SELECT lock_pin
                            FROM bookings
                            WHERE reservation_code = ${details.reservation_code}
                            LIMIT 1
                        `;
                        return rows[0] || null;
                    });

                    let pin = existingBooking?.lock_pin || null;
                    if (!pin) {
                        const tempBooking = { lock_pin: null };
                        pin = await assignPinFromDepot(tempBooking);
                    }
                    
                    await executeQueryWithRetry(async () => {
                        await sql`
                            INSERT INTO bookings (reservation_code, guest_name, check_in, check_out, power_on_time, power_off_time, source, payment_status, lock_pin)
                            VALUES (${details.reservation_code}, ${details.guest_name}, ${details.check_in}, ${details.check_out}, ${powerOn.toISOString()}, ${powerOff.toISOString()}, 'airbnb', 'paid', ${pin})
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
                    console.log(`✅ Успешен запис с график за тока!`);
                }
                
                await gmail.users.messages.modify({
                    userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] }
                });

            } else {
                console.warn(`⚠️ Писмо ${msg.id}: Неуспешен анализ.`);
            }
        }

        // record current time as last email check
        try {
            await sql`INSERT INTO system_settings (key, value) VALUES ('last_email_check', NOW()) ON CONFLICT (key) DO UPDATE SET value = NOW()`;
        } catch (e) {
            console.warn('[DETECTIVE] ⚠️ Неуспешен запис на last_email_check:', e.message);
        }

    } catch (err) { console.error('❌ Критична грешка:', err); }
}

async function processMessage(id, gmail, genAI) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        
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
        
        FORMAT (JSON ONLY):
        {
            "status": "confirmed" OR "cancelled",
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
            return JSON.parse(text);
        } catch (e) {
            console.error('❌ JSON Error:', text);
            return null;
        }
    } catch (err) {
        console.error(`❌ Грешка при писмо ${id}:`, err);
        return null;
    }
}