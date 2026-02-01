import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs';
import nodemailer from 'nodemailer';
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

// --- НАСТРОЙКИ ---
const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- 1. НАСТРОЙКА НА ПОЩА ---
const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

async function sendNotification(subject, text) {
    try {
        await mailer.sendMail({
            from: `"Smart Stay Bot" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `⚡ ${subject}`,
            text: text
        });
        console.log(`📧 Изпратен имейл: ${subject}`);
    } catch (e) { console.error("Mail Error:", e.message); }
}

// --- 2. ЗАРЕЖДАНЕ НА НАРЪЧНИКА ---
let manualContent = "Липсва файл manual.txt.";
try {
    if (fs.existsSync('manual.txt')) {
        manualContent = fs.readFileSync('manual.txt', 'utf8');
    }
} catch (err) { console.error(err); }

// --- 3. TUYA & SMART DEVICES ---
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET,
});

async function controlDevice(state) {
    try {
        await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch', value: state }] }
        });
        return true;
    } catch (e) { console.error('Tuya Error:', e.message); return false; }
}

async function getTuyaStatus() {
    try {
        const res = await tuya.request({ method: 'GET', path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status` });
        return res.result.find(s => s.code === 'switch');
    } catch (e) { return null; }
}

// --- ФУНКЦИЯ ЗА БРАВАТА (LOCKIN G30) ---
async function createLockPin(pin, name, checkInDate, checkOutDate) {
    console.log('🔍 DEBUG - LOCK_DEVICE_ID:', process.env.LOCK_DEVICE_ID);
    
    if (!process.env.LOCK_DEVICE_ID) {
        console.error('❌ LOCK_DEVICE_ID липсва в environment variables!');
        return false;
    }
    
    try {
        // За Lockin през Gateway се ползват СЕКУНДИ (не милисекунди)
        const startTime = Math.floor(new Date(checkInDate).getTime() / 1000);
        const endTime = Math.floor(new Date(checkOutDate).getTime() / 1000);
        
        console.log('🔍 DEBUG - Времена:', { startTime, endTime, pin: pin.toString() });

        const response = await tuya.request({
            method: 'POST',
            path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}/door-lock/password-ticket/ticket-create`,
            body: {
                password: pin.toString(),
                password_type: "ticket",
                ticket_id: `guest_${Date.now()}`,
                effective_time: startTime,
                invalid_time: endTime,
                name: name
            }
        });
        
        console.log(`🔐 Ключалка Отговор:`, JSON.stringify(response, null, 2));
        return response.success === true || response.result;
    } catch (error) {
        console.error("❌ Грешка брава - Message:", error.message);
        console.error("❌ Грешка брава - Stack:", error.stack);
        if (error.response) {
            console.error("❌ API Response:", JSON.stringify(error.response.data, null, 2));
        }
        return false;
    }
}

async function getLockStatus() {
    return { installed: false, battery: 0, status: "Unknown" };
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- 4. АВТОПИЛОТ (CRON) С ИМЕЙЛИ ---
cron.schedule('*/1 * * * *', async () => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const currentStatus = await getTuyaStatus();
        const isDeviceOn = currentStatus ? currentStatus.value : false;
        const now = new Date();

        for (const b of bookings) {
            if (!b.power_on_time || !b.power_off_time) continue;

            const start = new Date(b.power_on_time);
            const end = new Date(b.power_off_time);

            if (now >= start && now < end) {
                if (!isDeviceOn) {
                    console.log(`🟢 Включвам тока за: ${b.guest_name}`);
                    await controlDevice(true);
                    await sendNotification("ТОКЪТ Е ПУСНАТ", `Гост: ${b.guest_name}.`);
                }
            } 
            else if (now >= end && now < new Date(end.getTime() + 5*60000)) {
                if (isDeviceOn) {
                    const hasOverlap = bookings.some(other => {
                        if (other.id === b.id) return false;
                        const oStart = new Date(other.power_on_time);
                        const oEnd = new Date(other.power_off_time);
                        return now >= oStart && now < oEnd;
                    });

                    if (!hasOverlap) {
                        console.log(`🔴 Изключвам тока след: ${b.guest_name}`);
                        await controlDevice(false);
                        await sendNotification("ТОКЪТ Е СПРЯН", `Гост: ${b.guest_name} напусна.`);
                    }
                }
            }
        }
    } catch (err) { console.error('Cron Error', err); }
});

// --- 5. МОЗЪКЪТ НА ИКО (CHAT API) ---
app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body;
    
    // Проверка на хардуера
    const powerStatus = await getTuyaStatus();
    const isOnline = powerStatus !== null;
    const isOn = isOnline ? powerStatus.value : false;
    
    // Текуща дата за AI
    const currentDateTime = new Date().toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' });

    // ОПРЕДЕЛЯНЕ НА РОЛЯ И ПРАВА
    let bookingData = null;
    let role = "stranger";
    let guestInfo = "";
    
    // --- ПОПРАВКА В REGEX-А ---
    // Сега хваща HM + всякакви букви/цифри, без ограничение в дължината
    const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]+/);
    
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;
    
    if(codeToTest) {
        console.log(`🔎 Тествам код: ${codeToTest}`); // Лог за дебъгване
    }

    if (codeToTest === process.env.HOST_CODE) {
        role = "host";
    } else if (codeToTest) {
        try {
            const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeToTest} LIMIT 1`;
            if (r.length > 0) {
                bookingData = r[0];
                role = "guest";
                guestInfo = `
👤 ВАШАТА РЕЗЕРВАЦИЯ:
- Име: ${bookingData.guest_name}
- Check-in: ${new Date(bookingData.check_in).toLocaleString('bg-BG')}
- Check-out: ${new Date(bookingData.check_out).toLocaleString('bg-BG')}
- Код за брава: ${bookingData.lock_pin || 'няма данни'}
`;
            } else {
                console.log("❌ Кодът не е намерен в базата.");
            }
        } catch (e) { console.error("DB Error", e); }
    }

    let systemInstruction = "";
    
    if (role === "host") {
        systemInstruction = `
📅 ДНЕС Е: ${currentDateTime} (Българско време)
🔑 РЕЖИМ: ДОМАКИН/АДМИНИСТРАТОР

📊 ТОК СТАТУС:
- Мрежа: ${isOnline ? "✅ ОНЛАЙН" : "❌ ОФЛАЙН"}
- Бушон: ${isOn ? "✅ ВКЛЮЧЕН" : "⚠️ ИЗКЛЮЧЕН"}

📋 ПЪЛЕН НАРЪЧНИК:
${manualContent}

🤖 ТВОИ ВЪЗМОЖНОСТИ:
- Пълен достъп до информация и управление.
- Отговаряй на български.
`;
    } else if (role === "guest") {
        systemInstruction = `
📅 ДНЕС Е: ${currentDateTime} (Българско време)
🏠 ДОБРЕ ДОШЛИ В АПАРТАМЕНТ D105!

${guestInfo}

📋 ИНФОРМАЦИЯ ЗА ВАШИЯ ПРЕСТОЙ:
${manualContent}

📊 СТАТУС НА СИСТЕМИТЕ:
- Електричество: ${isOn ? "✅ Работи" : "⚠️ Проблем"}

🎯 ВАЖНО ЗА WIFI:
- Мрежа: SmartStay_Guest
- Парола: vacation_mode
(Давай паролата само ако питат)

⚠️ ПРИ ПРОБЛЕМ:
- При спешност използвам [ALERT: ...] за да уведомя домакина.

💬 ТОНЪТ МИ: Приятелски, полезен. Отговарям на български.
`;
    } else {
        systemInstruction = `
📅 ДНЕС Е: ${currentDateTime} (Българско време)
👋 ЗДРАВЕЙТЕ! АЗ СЪМ ИКО.

🔒 СТАТУС: Непознат посетител.

ℹ️ МОГА ДА ВИ КАЖА:
- Обща информация за комплекса и района.
- Как да направите резервация.

🚫 НЕ МОГА ДА СПОДЕЛЯ:
- WiFi парола
- Код за врата
- Лична информация

🔑 ЗА ДОСТЪП: Моля въведете код на резервация (HM...), за да активирам асистента.
`;
    }

    const modelsToTry = ["gemini-3-pro-preview", "gemini-flash-latest", "gemini-3-flash-preview"];
    let finalReply = "Ико има техническо затруднение.";

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
            const chat = model.startChat({ history: history || [] });
            const result = await chat.sendMessage(message);
            finalReply = result.response.text();
            
            const needsPower = /няма ток|без ток|не работи ток|изключен ток|спрян ток/i.test(message);
            if (needsPower && isOnline && !isOn && role === 'guest') {
                await controlDevice(true);
                if (!finalReply.includes("Включвам")) {
                    finalReply += "\n\n✅ (Система: Автоматично възстанових захранването.)";
                }
                await sendNotification("АВАРИЙНО ВКЛЮЧВАНЕ", `Клиентът поиска ток. Пуснах го автоматично.\n\nГост: ${bookingData ? bookingData.guest_name : 'Непознат'}`);
            }

            if (finalReply.includes('[ALERT:')) {
                const match = finalReply.match(/\[ALERT:(.*?)\]/);
                if (match && match[1]) {
                    await sendNotification("СЪОБЩЕНИЕ ОТ ГОСТ", `${match[1]}\n\nГост: ${bookingData ? bookingData.guest_name : 'Непознат'}\nРоля: ${role}`);
                }
                finalReply = finalReply.replace(/\[ALERT:.*?\]/g, '').trim();
            }

            break; 
        } catch (error) { 
            console.error(`❌ Грешка с модел ${modelName}:`, error.message); 
        }
    }

    res.json({ reply: finalReply });
});

// --- API ЗА ТАБЛОТО (DASHBOARD) ---

// 1. SYNC
app.get('/sync', async (req, res) => {
    console.log('⚡ Ръчно стартиране на Детектива...');
    try {
        await syncBookingsFromGmail(); 
        res.send('✅ Детективът приключи! Провери таблицата.');
    } catch (err) {
        console.error(err);
        res.status(500).send('❌ Грешка при синхронизация: ' + err.message);
    }
});

// 2. DELETE
app.delete('/bookings/:id', async (req, res) => {
    try {
        await sql`DELETE FROM bookings WHERE id = ${req.params.id}`;
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Error deleting' });
    }
});

// 3. POST
app.post('/add-booking', async (req, res) => {
    const { guest_name, reservation_code, check_in, check_out } = req.body;
    
    const inDate = new Date(check_in);
    const outDate = new Date(check_out);
    const powerOn = new Date(inDate.getTime() - (2 * 60 * 60 * 1000));
    const powerOff = new Date(outDate.getTime() + (1 * 60 * 60 * 1000));
    const pin = Math.floor(1000 + Math.random() * 9000);

    try {
        await sql`
            INSERT INTO bookings (guest_name, reservation_code, check_in, check_out, power_on_time, power_off_time, source, payment_status, lock_pin)
            VALUES (${guest_name}, ${reservation_code}, ${check_in}, ${check_out}, ${powerOn.toISOString()}, ${powerOff.toISOString()}, 'manual', 'paid', ${pin})
        `;
        res.status(201).json({ message: 'Added!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add' });
    }
});

// 4. ICAL
app.get('/feed.ics', async (req, res) => {
    const bookings = await sql`SELECT * FROM bookings WHERE payment_status = 'paid'`;
    let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SmartStay//Bansko//EN\n";
    bookings.forEach(b => {
        const start = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        const end = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        icsContent += "BEGIN:VEVENT\n";
        icsContent += `SUMMARY:${b.guest_name}\n`;
        icsContent += `DTSTART:${start}\n`;
        icsContent += `DTEND:${end}\n`;
        icsContent += `DESCRIPTION:Code: ${b.reservation_code}\\nPIN: ${b.lock_pin}\n`;
        icsContent += "END:VEVENT\n";
    });
    icsContent += "END:VCALENDAR";
    res.header('Content-Type', 'text/calendar');
    res.send(icsContent);
});

// --- ДРУГИ ---
app.get('/bookings', async (req, res) => { res.json(await sql`SELECT * FROM bookings ORDER BY check_in ASC`); });
app.get('/status', async (req, res) => { try { const s = await getTuyaStatus(); res.json({ is_on: s ? s.value : false }); } catch (e) { res.json({ is_on: false }); } });
app.get('/toggle', async (req, res) => { try { const s = await getTuyaStatus(); if(s) { await controlDevice(!s.value); res.json({success:true}); } else throw new Error(); } catch(e){ res.status(500).json({error:"Fail"}); } });
app.get('/lock-status', async (req, res) => { res.json(await getLockStatus()); });
// Тест линк: https://smart-stay.onrender.com/test-lock
app.get('/test-lock', async (req, res) => {
    const now = new Date();
    const later = new Date(now.getTime() + 30 * 60000); // Кодът ще важи 30 минути
    const success = await createLockPin("654321", "Test_Manual", now, later);
    
    if (success) res.json({ msg: "✅ Успех! Пробвай код 654321# на вратата." });
    else res.json({ msg: "❌ Грешка! Провери дали LOCK_DEVICE_ID е в Render." });
});

app.listen(PORT, () => {
    console.log(`🚀 Iko is live on port ${PORT}`);
    syncBookingsFromGmail();
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});
