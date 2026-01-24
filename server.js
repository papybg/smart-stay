import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs'; // За четене на manual.txt
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- 1. ЗАРЕЖДАНЕ НА НАРЪЧНИКА (manual.txt) ---
let manualContent = "Липсва файл manual.txt";
try {
    if (fs.existsSync('manual.txt')) {
        manualContent = fs.readFileSync('manual.txt', 'utf8');
        console.log("✅ manual.txt е зареден успешно.");
    } else {
        console.warn("⚠️ ВНИМАНИЕ: manual.txt не е намерен! Създай го в главната папка.");
    }
} catch (err) { console.error("Грешка при четене на manual.txt", err); }

// --- TUYA CONFIG ---
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID || process.env.TUYA_DEVICE_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET || process.env.TUYA_LOCAL_KEY,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- TUYA CORE (IOT-03) ---
async function controlDevice(state) {
    try {
        console.log(`🔌 Tuya: Switch -> ${state}`);
        await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch', value: state }] }
        });
    } catch (e) { console.error('Tuya Error:', e.message); }
}

async function getTuyaStatus() {
    try {
        const res = await tuya.request({ 
            method: 'GET', 
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status` 
        });
        return res.result.find(s => s.code === 'switch');
    } catch (e) { return null; }
}

// --- АВТОПИЛОТ (CRON) ---
// Включва/Изключва тока според графика
cron.schedule('*/10 * * * *', async () => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const now = new Date();
        for (const b of bookings) {
            const checkIn = new Date(b.check_in);
            const checkOut = new Date(b.check_out);
            
            // Токът се пуска 2 часа преди настаняване и спира 1 час след напускане
            const onTime = new Date(checkIn.getTime() - (2 * 60 * 60 * 1000));
            const offTime = new Date(checkOut.getTime() + (1 * 60 * 60 * 1000));

            if (now >= onTime && now < offTime && !b.power_on_time) {
                console.log(`💡 АВТО: Пускане за ${b.guest_name}`);
                await controlDevice(true);
                await sql`UPDATE bookings SET power_on_time = NOW() WHERE id = ${b.id}`;
            } else if (now >= offTime && !b.power_off_time) {
                console.log(`🌑 АВТО: Спиране след ${b.guest_name}`);
                await controlDevice(false);
                await sql`UPDATE bookings SET power_off_time = NOW() WHERE id = ${b.id}`;
            }
        }
    } catch (err) { console.error('Cron Error'); }
});

// --- API ЗА ЧАТ (BRAIN OF BOBO) ---
app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body; 
    let bookingData = null;

    // 1. ПРОВЕРКА НА САМОЛИЧНОСТТА
    // Търсим код в текущото съобщение ИЛИ от паметта на браузъра (authCode)
    const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]{8,10}/);
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;

    if (codeToTest) {
        try {
            // ВАЖНО: Проверка за валидност във времето (-2ч преди, +1ч след)
            const r = await sql`
                SELECT * FROM bookings 
                WHERE reservation_code = ${codeToTest}
                AND NOW() >= (check_in - INTERVAL '2 hours')
                AND NOW() <= (check_out + INTERVAL '1 hour')
                LIMIT 1
            `;

            if (r.length > 0) {
                bookingData = r[0]; // УРА! Имаме валиден гост в правилния часови пояс.
            } else {
                console.log(`Отхвърлен достъп (грешен код или изтекло време): ${codeToTest}`);
            }
        } catch (e) { console.error("DB Error", e); }
    }

    // 2. ИНСТРУКЦИИ ЗА БОБО (PROMPT ENGINEERING)
    let systemInstruction = `Ти си Бобо - иконом на Smart Stay. Говориш на български.
    
    === НАРЪЧНИК ЗА АПАРТАМЕНТА (MANUAL) ===
    ${manualContent}
    ========================================
    
    ПРАВИЛА ЗА СИГУРНОСТ:
    1. Този чат е свързан с умен дом.
    2. В "Наръчника" по-горе има както публична, така и ЗАЩИТЕНА информация (Wi-Fi, кодове).
    3. АКО по-долу виждаш [СИСТЕМНИ ДАННИ - ПОТВЪРДЕН ГОСТ], имаш право да му казваш ВСИЧКО от наръчника + неговия ПИН.
    4. АКО НЯМА системни данни, ти говориш с непознат. Имаш право да казваш САМО публична информация (локация, правила, удобства). ЗАБРАНЕНО е да даваш Wi-Fi пароли и ПИН кодове на непознати. Помоли ги за код на резервация.
    `;

    if (bookingData) {
        systemInstruction += `\n
        [СИСТЕМНИ ДАННИ - ПОТВЪРДЕН ГОСТ ✅]
        - ИМЕ: ${bookingData.guest_name}
        - ЛИЧЕН ПИН КОД ЗА ВРАТА: ${bookingData.lock_pin}
        - Статус: Активна резервация.
        - ИНСТРУКЦИЯ: Клиентът е удостоверен. Можеш да му дадеш Wi-Fi паролата от наръчника и неговия ПИН код. Бъди максимално полезен.`;
    } else {
        systemInstruction += `\n
        [СТАТУС: НЕПОЗНАТ ПОСЕТИТЕЛ ❌]
        - Няма активна резервация.
        - ИНСТРУКЦИЯ: Не казвай Wi-Fi пароли и ПИН кодове! Отговаряй само на общи въпроси.`;
    }

    // 3. ГЕНЕРИРАНЕ НА ОТГОВОР (Gemini 2.5 с Failover)
    const modelsToTry = ["gemini-2.5-flash", "gemini-1.5-flash"];
    let finalReply = "Бобо има проблем с връзката. Моля опитайте пак.";

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ 
                model: modelName, 
                systemInstruction: systemInstruction
            });

            // Ползваме историята от фронтенда, ако я има
            const chat = model.startChat({
                history: history || [],
            });

            const result = await chat.sendMessage(message);
            finalReply = result.response.text();
            break; // Успех!
        } catch (error) {
            console.warn(`Retry model due to: ${error.message}`);
        }
    }

    res.json({ reply: finalReply });
});

// --- ADMIN & UTILS ---
app.get('/bookings', async (req, res) => { res.json(await sql`SELECT * FROM bookings ORDER BY created_at DESC`); });
app.post('/add-booking', async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;
    const pin = Math.floor(1000 + Math.random() * 9000);
    try {
        const r = await sql`INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES (${guest_name}, ${check_in}, ${check_out}, ${reservation_code}, ${pin}, 'paid') RETURNING *`;
        res.json({ success: true, pin, booking: r[0] });
    } catch (e) { res.status(500).json({error: e.message}); }
});
app.delete('/bookings/:id', async (req, res) => { await sql`DELETE FROM bookings WHERE id = ${req.params.id}`; res.json({success: true}); });
app.get('/status', async (req, res) => { try { const s = await getTuyaStatus(); res.json({ is_on: s ? s.value : false }); } catch (e) { res.json({ is_on: false }); } });
app.get('/toggle', async (req, res) => { try { const s = await getTuyaStatus(); if(s) { await controlDevice(!s.value); res.json({success:true}); } else throw new Error(); } catch(e){ res.status(500).json({error:"Fail"}); } });

app.listen(PORT, () => {
    console.log(`🚀 Bobo is live on port ${PORT}`);
    syncBookingsFromGmail(); // Стартираме "Детектива" за нови резервации
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000); // Проверка на всеки 15 мин
});