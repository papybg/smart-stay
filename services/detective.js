import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';

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
    console.log('🕵️ Ико Детектива проверява за нови резервации или анулации...');
    try {
        if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY || !process.env.GMAIL_CLIENT_ID) {
            console.error('❌ Липсват ENV променливи!');
            return;
        }

        const sql = neon(process.env.DATABASE_URL);
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET,
            'https://developers.google.com/oauthplayground'
        );
        oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        
        // ФИЛТЪР: Търсим всичко важно
        const query = '(from:automated@airbnb.com OR from:pepetrow@gmail.com) (confirmed OR потвърдена OR потвърдено OR резервация OR reservation OR cancelled OR canceled OR анулирана OR анулиране OR code OR код) is:unread';
        
        const res = await gmail.users.messages.list({ userId: 'me', q: query });
        const messages = res.data?.messages || [];

        console.log(`🔎 Намерени писма: ${messages.length}`);

        for (const msg of messages) {
            const details = await processMessage(msg.id, gmail, genAI);
            
            if (details && details.reservation_code) {
                
                // --- АНУЛАЦИЯ ---
                if (details.status === 'cancelled') {
                    console.log(`🚫 Анулация за: ${details.reservation_code}`);
                    await executeQueryWithRetry(async () => {
                        await sql`
                            UPDATE bookings 
                            SET payment_status = 'cancelled', lock_pin = NULL, updated_at = NOW()
                            WHERE reservation_code = ${details.reservation_code}
                        `;
                    });
                    console.log(`🗑️ Резервация ${details.reservation_code} е маркира като анулирана.`);
                } 
                
                // --- НОВА / ОБНОВЕНА ---
                else {
                    console.log(`📝 Обработка на: ${details.guest_name} (Настаняване: ${details.check_in})`);
                    const pin = Math.floor(1000 + Math.random() * 9000);
                    
                    await executeQueryWithRetry(async () => {
                        await sql`
                            INSERT INTO bookings (reservation_code, guest_name, check_in, check_out, source, payment_status, lock_pin)
                            VALUES (${details.reservation_code}, ${details.guest_name}, ${details.check_in}, ${details.check_out}, 'airbnb', 'paid', ${pin})
                            ON CONFLICT (reservation_code) 
                            DO UPDATE SET 
                                guest_name = EXCLUDED.guest_name, 
                                check_in = EXCLUDED.check_in, 
                                check_out = EXCLUDED.check_out,
                                payment_status = 'paid',
                                lock_pin = bookings.lock_pin;
                        `;
                    });
                    console.log(`✅ Успешен запис с точни часове!`);
                }
                
                // Маркираме като прочетено
                await gmail.users.messages.modify({
                    userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] }
                });

            } else {
                console.warn(`⚠️ Писмо ${msg.id}: Неуспешен анализ.`);
            }
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
        
        // --- ТУК Е МАГИЯТА ЗА ЧАСОВЕТЕ ---
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