import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs';
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

// --- НАСТРОЙКИ ---
const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- 1. ЗАРЕЖДАНЕ НА НАРЪЧНИКА (manual.txt) ---
let manualContent = "Липсва файл manual.txt. Моля създайте го.";
try {
    if (fs.existsSync('manual.txt')) {
        manualContent = fs.readFileSync('manual.txt', 'utf8');
        console.log("✅ manual.txt е зареден успешно.");
    } else {
        console.warn("⚠️ ВНИМАНИЕ: manual.txt не е намерен!");
    }
} catch (err) { console.error("Грешка при четене на manual.txt", err); }

// --- 2. TUYA CONFIG (CLOUD) ---
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID || process.env.TUYA_DEVICE_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET || process.env.TUYA_LOCAL_KEY,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- TUYA ФУНКЦИИ (ЕЛЕКТРОМЕР /IOT-03/) ---
async function controlDevice(state) {
    try {
        console.log(`🔌 Tuya: Switch -> ${state}`);
        // Използваме специализирания път за електромери
        await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch', value: state }] }
        });
        return true;
    } catch (e) { 
        console.error('Tuya Error:', e.message);
        return false;
    }
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

// --- 3. АВТОПИЛОТ ЗА ТОКА (CRON) ---
// Проверка на всеки 10 мин
cron.schedule('*/10 * * * *', async () => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const now = new Date();
        
        for (const b of bookings) {
            const checkIn = new Date(b.check_in);
            const checkOut = new Date(b.check_out);
            
            // Включване: 2 часа преди настаняване
            // Изключване: 1 час след напускане
            const onTime = new Date(checkIn.getTime() - (2 * 60 * 60 * 1000));
            const offTime = new Date(checkOut.getTime() + (1 * 60 * 60 * 1000));

            if (now >= onTime && now < offTime && !b.power_on_time) {
                console.log(`💡 АВТО: Пускане на тока за ${b.guest_name}`);
                await controlDevice(true);
                await sql`UPDATE bookings SET power_on_time = NOW() WHERE id = ${b.id}`;
            } 
            else if (now >= offTime && !b.power_off_time) {
                console.log(`🌑 АВТО: Спиране на тока след ${b.guest_name}`);
                await controlDevice(false);
                await sql`UPDATE bookings SET power_off_time = NOW() WHERE id = ${b.id}`;
            }
        }
    } catch (err) { console.error('Cron Error', err.message); }
});

// --- 4. МОЗЪКЪТ НА БОБО (CHAT API) ---
app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body; 
    let bookingData = null;

    // СТЪПКА 1: Проверка на самоличността
    // Търсим код в съобщението ИЛИ в паметта на телефона (authCode)
    const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]{8,10}/);
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;

    if (codeToTest) {
        try {
            // ВАЖНО: Проверка дали сме във времевия прозорец (-2ч / +1ч)
            // Ако е извън прозореца, SQL заявката няма да върне резултат
            const r = await sql`
                SELECT * FROM bookings 
                WHERE reservation_code = ${codeToTest}
                AND NOW() >= (check_in - INTERVAL '2 hours')
                AND NOW() <= (check_out + INTERVAL '1 hour')
                LIMIT 1
            `;

            if (r.length > 0) {
                bookingData = r[0]; // Успех! Потвърден гост.
            } else {
                console.log(`❌ Отказан достъп (Грешен код или изтекло време): ${codeToTest}`);
            }
        } catch (e) { console.error("DB Error", e); }
    }

    // СТЪПКА 2: Инструкции за AI (Приоритети)
    let systemInstruction = `Ти си Бобо - умен иконом на частен апартамент "Smart Stay".
    
    === НАРЪЧНИК (MANUAL.TXT) ===
    ${manualContent}
    =============================
    
    ⚠️ ПРИОРИТЕТИ ПРИ ОТГОВАРЯНЕ (СПАЗВАЙ СТРИКТНО):
    
    1. 🥇 ПЪРВО: НАРЪЧНИКЪТ (Факти за апартамента)
       - Ако питат за кафе, легла, отопление, паркинг -> ПОЛЗВАЙ САМО ФАЙЛА. Не си измисляй удобства.
       
    2. 🥈 ВТОРО: ОБЩА КУЛТУРА (LLM)
       - Ако питат за града, забележителности, времето, ресторанти наоколо -> ИЗПОЛЗВАЙ СВОИТЕ ЗНАНИЯ СВОБОДНО. Бъди полезен гид.

    3. 🔐 ТРЕТО: СИГУРНОСТ (Червената зона)
       - ПИН кодове и Wi-Fi пароли се дават САМО ако виждаш статус [✅ ПОТВЪРДЕН ГОСТ] по-долу.
       - Ако статусът е [❌ НЕПОЗНАТ], кажи: "За тази информация е нужен валиден код на активна резервация."
    `;

    if (bookingData) {
        systemInstruction += `\n
        [✅ СТАТУС: ПОТВЪРДЕН ГОСТ - ${bookingData.guest_name}]
        - ПИН КОД ЗА ВРАТА: ${bookingData.lock_pin}
        - ИНСТРУКЦИЯ: Този човек има право на достъп до Wi-Fi и ПИН кода. Бъди максимално услужлив.`;
    } else {
        systemInstruction += `\n
        [❌ СТАТУС: НЕПОЗНАТ / ПОСЕТИТЕЛ]
        - Няма активен код.
        - ИНСТРУКЦИЯ: Рекламирай апартамента и давай обща информация за района, но ПАЗИ ТАЙНИТЕ (ПИН/Wi-Fi).`;
    }

    // СТЪПКА 3: Избор на модел (Failover система)
    // Пробваме най-новия, ако не стане - резервния
    const modelsToTry = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-1.5-flash"];
    let finalReply = "Бобо има технически затруднения. Моля опитайте пак.";

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ 
                model: modelName, 
                systemInstruction: systemInstruction
            });

            const chat = model.startChat({
                history: history || [], // Ползваме историята от чата
            });

            const result = await chat.sendMessage(message);
            finalReply = result.response.text();
            break; // Ако успеем, спираме цикъла
        } catch (error) {
            console.warn(`⚠️ Грешка с модел ${modelName}, пробвам следващия...`);
        }
    }

    res.json({ reply: finalReply });
});

// --- 5. ADMIN & SYSTEM ENDPOINTS ---

app.get('/bookings', async (req, res) => {
    res.json(await sql`SELECT * FROM bookings ORDER BY created_at DESC`);
});

app.post('/add-booking', async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;
    const pin = Math.floor(1000 + Math.random() * 9000); // 4-цифрен ПИН
    try {
        const r = await sql`
            INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status)
            VALUES (${guest_name}, ${check_in}, ${check_out}, ${reservation_code}, ${pin}, 'paid') RETURNING *`;
        res.json({ success: true, pin, booking: r[0] });
    } catch (e) { res.status(500).json({error: e.message}); }
});

app.delete('/bookings/:id', async (req, res) => {
    await sql`DELETE FROM bookings WHERE id = ${req.params.id}`;
    res.json({success: true});
});

// --- НОВА ФУНКЦИЯ ЗА КАЛЕНДАР (AIRBNB COMPATIBLE) ---
app.get('/feed.ics', async (req, res) => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        
        // 1. Помощна функция за форматиране на дата (ISO -> ICS format)
        // Превръща 2026-01-25T14:00:00.000Z в 20260125T140000Z
        const formatDate = (date) => {
            return new Date(date).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        };

        const now = formatDate(new Date()); // Време на генериране (DTSTAMP)

        // 2. Начало на ICS файла (Задължителни хедъри)
        let icsContent = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Smart Stay//Bg',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH' // Важно за синхронизация!
        ].join('\r\n');

        // 3. Добавяне на събитията
        bookings.forEach(b => {
            const start = formatDate(b.check_in);
            const end = formatDate(b.check_out);
            
            // Airbnb изисква уникален UID и DTSTAMP за всяко събитие
            const eventBlock = [
                'BEGIN:VEVENT',
                `UID:${b.id}@smartstay.bg`,     // Уникален ID
                `DTSTAMP:${now}`,                // Кога е генериран файла
                `DTSTART:${start}`,              // Начало
                `DTEND:${end}`,                  // Край
                `SUMMARY:Blocked: ${b.guest_name}`, // Заглавие (Airbnb често го игнорира, но е нужно)
                'STATUS:CONFIRMED',
                'END:VEVENT'
            ].join('\r\n');

            icsContent += '\r\n' + eventBlock;
        });

        // 4. Край на файла
        icsContent += '\r\nEND:VCALENDAR';

        // 5. Изпращане с правилните хедъри
        res.header('Content-Type', 'text/calendar; charset=utf-8');
        res.header('Content-Disposition', 'inline; filename="feed.ics"');
        res.send(icsContent);

    } catch (e) { 
        console.error("ICS Error:", e);
        res.status(500).send("Error generating calendar"); 
    }
});

app.get('/status', async (req, res) => {
    try {
        const status = await getTuyaStatus();
        res.json({ is_on: status ? status.value : false });
    } catch (err) { res.json({ is_on: false }); }
});

app.get('/toggle', async (req, res) => {
    try {
        const status = await getTuyaStatus();
        if (status) {
            await controlDevice(!status.value);
            res.json({ success: true, new_state: !status.value });
        } else {
            res.status(500).json({ error: "Device switch not found" });
        }
    } catch (err) { res.status(500).json({ error: "Toggle Failed" }); }
});

// --- СТАРТ ---
app.listen(PORT, () => {
    console.log(`🚀 Bobo is live on port ${PORT}`);
    syncBookingsFromGmail(); // Първоначална синхронизация
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000); // Синхронизация на всеки 15 мин
});