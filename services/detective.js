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
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET,
            'https://developers.google.com/oauthplayground'
        );
        oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        
        // МОДИФИЦИРАНА ЗАЯВКА: Махаме твърдия подател за целите на теста или добавяме твоя имейл
        // query: 'subject:(confirmed OR потвърдена OR reservation) is:unread'
        const query = '(from:automated@airbnb.com OR from:pepetrow@gmail.com) (confirmed OR потвърдена) is:unread';
        
        const res = await gmail.users.messages.list({ userId: 'me', q: query });
        const messages = res.data?.messages || [];

        if (messages.length === 0) {
            console.log('📭 Няма нови имейли, отговарящи на критериите.');
        }

        for (const msg of messages) {
            const details = await processMessage(msg.id, gmail, genAI);
            if (details && details.reservation_code) {
                const pin = Math.floor(1000 + Math.random() * 9000);
                await executeQueryWithRetry(async () => {
                    await sql`
                        INSERT INTO bookings (reservation_code, guest_name, check_in, check_out, source, payment_status, lock_pin)
                        VALUES (${details.reservation_code}, ${details.guest_name}, ${details.check_in}, ${details.check_out}, 'airbnb', 'paid', ${pin})
                        ON CONFLICT (reservation_code) 
                        DO UPDATE SET payment_status = 'paid', updated_at = NOW();
                    `;
                });
                
                await gmail.users.messages.modify({
                    userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] }
                });
                console.log(`✅ Ико записа резервация: ${details.guest_name} (${details.reservation_code})`);
            }
        }
    } catch (err) { console.error('❌ Грешка при синхронизация:', err); }
}

async function processMessage(id, gmail, genAI) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        
        const payload = res.data.payload;
        let body = "";

        // По-стабилно извличане на тялото (рекурсивно търсене на текст)
        const getBody = (part) => {
            if (part.body.data) return Buffer.from(part.body.data, 'base64').toString();
            if (part.parts) return part.parts.map(getBody).join('\n');
            return "";
        };
        body = getBody(payload);

        const prompt = `Extract JSON from this booking email. 
        Format: {"reservation_code": "HM...", "guest_name": "Name", "check_in": "YYYY-MM-DD", "check_out": "YYYY-MM-DD"}. 
        If the data is missing, return null.
        Text: ${body}`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json|```/g, '').trim();
        return JSON.parse(text);
    } catch (err) {
        console.error(`❌ Грешка при четене на писмо: ${id}`, err);
        return null;
    }
}