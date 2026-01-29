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
    console.log('🕵️ Ико Детектива сканира пощата за нови резервации...');
    try {
        if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY || !process.env.GMAIL_CLIENT_ID) {
            console.error('❌ Липсват ENV променливи!');
            return;
        }

        const sql = neon(process.env.DATABASE_URL);
        // Превключваме на стабилния 2.5 Flash
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET,
            'https://developers.google.com/oauthplayground'
        );
        oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        
        // 1. ПОДОБРЕН ФИЛТЪР: Добавяме всички форми на "потвърдено" и "резервация"
        // Също така търсим и "Code" или "Код", което често се среща в темите
        const query = '(from:automated@airbnb.com OR from:pepetrow@gmail.com) (confirmed OR потвърдена OR потвърдено OR резервация OR reservation OR code OR код) is:unread';
        
        const res = await gmail.users.messages.list({ userId: 'me', q: query });
        const messages = res.data?.messages || [];

        console.log(`🔎 Намерени писма за обработка: ${messages.length}`);

        for (const msg of messages) {
            const details = await processMessage(msg.id, gmail, genAI);
            
            if (details && details.reservation_code && details.guest_name) {
                console.log(`📝 Подготвям запис за: ${details.guest_name}`);
                const pin = Math.floor(1000 + Math.random() * 9000);
                
                await executeQueryWithRetry(async () => {
                    await sql`
                        INSERT INTO bookings (reservation_code, guest_name, check_in, check_out, source, payment_status, lock_pin)
                        VALUES (${details.reservation_code}, ${details.guest_name}, ${details.check_in}, ${details.check_out}, 'airbnb', 'paid', ${pin})
                        ON CONFLICT (reservation_code) 
                        DO UPDATE SET 
                            guest_name = EXCLUDED.guest_name, 
                            check_in = EXCLUDED.check_in, 
                            check_out = EXCLUDED.check_out;
                    `;
                });
                
                await gmail.users.messages.modify({
                    userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] }
                });
                console.log(`✅ Ико записа резервация: ${details.guest_name} (${details.reservation_code})`);
            } else {
                console.warn(`⚠️ Писмо ${msg.id}: Данните не са пълни или AI не ги разпозна.`, details);
            }
        }
    } catch (err) { console.error('❌ Критична грешка при синхронизация:', err); }
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
        
        // 2. ПОДОБРЕН ПРОМПТ (Инструкция): Учим го на български думи
        const prompt = `
        Analyze this email (could be in English or Bulgarian) and extract booking details.
        
        Target Data Points:
        1. Reservation Code: Starts usually with 'HM'. Look in Subject and Body.
        2. Guest Name: Look after "Guest", "Guest name", "Гост", "Име".
        3. Check-in Date: Look after "Check-in", "Starts", "Настаняване", "Пристигане", "Дата".
        4. Check-out Date: Look after "Check-out", "Ends", "Освобождаване", "Напускане".

        FORMAT RULES:
        - Convert all dates to "YYYY-MM-DD" format.
        - Return ONLY valid JSON.
        - JSON Structure: {"reservation_code": "STRING", "guest_name": "STRING", "check_in": "YYYY-MM-DD", "check_out": "YYYY-MM-DD"}
        
        Email Text:
        ${fullText}`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json|```/g, '').trim();
        
        console.log(`🤖 AI отговор за ${id}:`, text);

        try {
            return JSON.parse(text);
        } catch (e) {
            console.error('❌ JSON Error:', text);
            return null;
        }
    } catch (err) {
        console.error(`❌ Грешка при обработка на писмо ${id}:`, err);
        return null;
    }
}