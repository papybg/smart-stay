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
import path from 'path';

// ==================================================================
// --- ГЛОБАЛНИ НАСТРОЙКИ И ИНИЦИАЛИЗАЦИЯ ---
// ==================================================================

const app = express();
const PORT = process.env.PORT || 10000;

// База данни
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

// AI Модел (Google Gemini)
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==================================================================
// --- 1. НАСТРОЙКА НА ПОЩА (NODEMAILER) ---
// ==================================================================

const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

/**
 * Изпраща известие до администратора при важни събития
 */
async function sendNotification(subject, text) {
    try {
        const info = await mailer.sendMail({
            from: `"Smart Stay Bot" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `⚡ ${subject}`,
            text: text
        });
        console.log(`📧 [EMAIL] Изпратен: ${subject} | ID: ${info.messageId}`);
    } catch (e) {
        console.error("❌ [EMAIL ERROR]:", e.message);
    }
}

// ==================================================================
// --- 2. ЗАРЕЖДАНЕ НА НАРЪЧНИКА (Manual.txt) ---
// ==================================================================

let manualContent = "Липсва файл manual.txt. Моля, създайте го.";
try {
    if (fs.existsSync('manual.txt')) {
        manualContent = fs.readFileSync('manual.txt', 'utf8');
        console.log("📖 [SYSTEM] Наръчникът е зареден успешно.");
    } else {
        console.warn("⚠️ [SYSTEM] Файлът manual.txt не е намерен.");
    }
} catch (err) {
    console.error("❌ [SYSTEM] Грешка при четене на manual.txt:", err);
}

// ==================================================================
// --- 3. TUYA ВРЪЗКА (УМЕН ДОМ) ---
// ==================================================================

const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET,
});

/**
 * Управление на релето за тока (Power Switch)
 */
async function controlDevice(state) {
    console.log(`🔌 [POWER] Опит за превключване на тока: ${state ? 'ON' : 'OFF'}`);
    try {
        const response = await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch', value: state }] }
        });
        console.log(`🔌 [POWER] Резултат: ${response.success ? 'Успех' : 'Неуспех'}`);
        return true;
    } catch (e) {
        console.error('❌ [TUYA ERROR] Control Device:', e.message);
        return false;
    }
}

/**
 * Взима текущия статус на тока (ON/OFF)
 */
async function getTuyaStatus() {
    try {
        const res = await tuya.request({
            method: 'GET',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status`
        });
        const switchStatus = res.result.find(s => s.code === 'switch');
        return switchStatus;
    } catch (e) {
        console.error('❌ [TUYA ERROR] Get Status:', e.message);
        return null;
    }
}

/**
 * Взима статус на батерията/състоянието на бравата (Lock Status)
 */
async function getLockStatus() {
    try {
        const res = await tuya.request({
            method: 'GET',
            path: `/v1.0/iot-03/devices/${process.env.LOCK_DEVICE_ID}/status`
        });
        return res.result; // Връща целия масив със статуси (батерия, заключено/отключено)
    } catch (e) {
        console.error('❌ [LOCK ERROR] Get Status:', e.message);
        return null;
    }
}

// ==================================================================
// --- 4. УПРАВЛЕНИЕ НА БРАВАТА (3 МЕТОДА) ---
// ==================================================================

/**
 * Опитва да създаде ПИН код чрез 3 различни метода последователно
 */
async function createLockPin(pin, name, checkInDate, checkOutDate) {
    console.log(`🔐 [LOCK SYSTEM] Стартиране на процедура за ${name} (PIN: ${pin})...`);
    
    // Подготовка на времената (Важно за Tuya API)
    // Времената трябва да са съобразени с часовата зона на устройството
    
    // Времена в секунди (Unix Timestamp) - за Online API
    // Връщаме 10 мин назад (buffer), за да избегнем грешки "Future time"
    const startSec = Math.floor((new Date(checkInDate).getTime() - 10 * 60000) / 1000); 
    const endSec = Math.floor(new Date(checkOutDate).getTime() / 1000);
    
    // Времена в милисекунди - за Ticket/Offline API
    const startMs = new Date(checkInDate).getTime() - 10 * 60000;
    const endMs = new Date(checkOutDate).getTime();

    let report = [];
    let success = false;

    // --- МЕТОД 1: Smart Lock Online (Gateway Standard) ---
    // Това е официалният метод за Wi-Fi/Zigbee Gateway брави
    try {
        console.log("   👉 Опит 1: Online Password API...");
        await tuya.request({
            method: 'POST',
            path: `/v1.0/smart-lock/devices/${process.env.LOCK_DEVICE_ID}/password/temp`,
            body: { 
                name: name, 
                password: pin.toString(), 
                effective_time: startSec, 
                invalid_time: endSec, 
                type: 2 // Периодична парола
            }
        });
        report.push("✅ Метод 1 (Online V1): УСПЕХ");
        success = true;
    } catch (e) { 
        console.warn(`   ⚠️ Грешка Метод 1: ${e.message}`);
        report.push(`❌ Метод 1 (Online V1): Грешка (${e.message})`); 
    }

    // --- МЕТОД 2: Bluetooth Ticket (Specific for Lockin G30) ---
    // Ако първият не стане, пробваме метода с "билети" (Ticket), специфичен за Lockin
    if (!success) {
        try {
            console.log("   👉 Опит 2: Ticket API...");
            await tuya.request({
                method: 'POST',
                path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}/door-lock/temp-password`,
                body: { 
                    name: name, 
                    password: pin.toString(), 
                    start_time: startMs, 
                    expire_time: endMs, 
                    password_type: "ticket" 
                }
            });
            report.push("✅ Метод 2 (Ticket): УСПЕХ");
            success = true;
        } catch (e) { 
            console.warn(`   ⚠️ Грешка Метод 2: ${e.message}`);
            report.push(`❌ Метод 2 (Ticket): Грешка (${e.message})`); 
        }
    }

    // --- МЕТОД 3: Offline Algorithm (Fallback) ---
    // Последен шанс: Опит за генериране на офлайн алгоритмичен код
    if (!success) {
        try {
            console.log("   👉 Опит 3: Offline API...");
            await tuya.request({
                method: 'POST',
                path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}/door-lock/temp-password`,
                body: { 
                    name: name, 
                    password: pin.toString(), 
                    start_time: startMs, 
                    expire_time: endMs, 
                    password_type: "offline" 
                }
            });
            report.push("✅ Метод 3 (Offline): УСПЕХ");
            success = true;
        } catch (e) { 
            console.warn(`   ⚠️ Грешка Метод 3: ${e.message}`);
            report.push(`❌ Метод 3 (Offline): Грешка (${e.message})`); 
        }
    }

    console.log("📝 [LOCK REPORT]:", JSON.stringify(report, null, 2));
    return { success, report };
}

// ==================================================================
// --- 5. АВТОПИЛОТ (CRON ЗА ТОКА) ---
// ==================================================================

// Проверка всяка минута
cron.schedule('*/1 * * * *', async () => {
    // console.log("⏳ [CRON] Проверка на резервации...");
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const currentStatus = await getTuyaStatus();
        const isDeviceOn = currentStatus ? currentStatus.value : false;
        const now = new Date();

        for (const b of bookings) {
            // Пропускаме резервации без валидни времена за ток
            if (!b.power_on_time || !b.power_off_time) continue;

            const start = new Date(b.power_on_time);
            const end = new Date(b.power_off_time);

            // СЦЕНАРИЙ 1: Време е за настаняване (Токът трябва да е ВКЛ)
            if (now >= start && now < end) {
                if (!isDeviceOn) {
                    console.log(`✅ [AUTO] Пускане на ток за ${b.guest_name}`);
                    await controlDevice(true);
                    await sendNotification("ТОКЪТ Е ПУСНАТ", `Гост: ${b.guest_name}. Настаняване.`);
                }
            } 
            // СЦЕНАРИЙ 2: Време е за напускане (Токът трябва да е ИЗКЛ)
            // Добавяме 5 минути толеранс след check-out
            else if (now >= end && now < new Date(end.getTime() + 5*60000)) {
                if (isDeviceOn) {
                    // Критична проверка: Има ли застъпваща се резервация?
                    const hasOverlap = bookings.some(other => {
                        if (other.id === b.id) return false;
                        const oStart = new Date(other.power_on_time);
                        const oEnd = new Date(other.power_off_time);
                        // Ако текущото време попада в друга резервация
                        return now >= oStart && now < oEnd;
                    });
                    
                    if (!hasOverlap) {
                        console.log(`🛑 [AUTO] Спиране на ток след ${b.guest_name}`);
                        await controlDevice(false);
                        await sendNotification("ТОКЪТ Е СПРЯН", `Гост: ${b.guest_name} напусна.`);
                    } else {
                        console.log(`⚠️ [AUTO] Токът остава пуснат заради следващ гост.`);
                    }
                }
            }
        }
    } catch (err) { 
        console.error('❌ [CRON ERROR]:', err); 
    }
});

// ==================================================================
// --- 6. ЧАТ БОТ (GEMINI MODELS) ---
// ==================================================================

app.post('/api/chat', async (req, res) => {
    const { message, history, authCode } = req.body;
    
    // Събиране на контекст за бота
    const powerStatus = await getTuyaStatus();
    const isOnline = powerStatus !== null;
    const currentDateTime = new Date().toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' });

    let bookingData = null;
    let role = "stranger";
    
    // Проверка за код (HMxxxx) в съобщението или auth полето
    const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]+/);
    const codeToTest = textCodeMatch ? textCodeMatch[0] : authCode;

    if (codeToTest === process.env.HOST_CODE) {
        role = "host";
    } else if (codeToTest) {
        // Търсене в базата данни
        const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeToTest} LIMIT 1`;
        if (r.length > 0) { 
            bookingData = r[0]; 
            role = "guest"; 
        }
    }

    // Системна инструкция
    const systemInstruction = `
    Текущо време: ${currentDateTime}.
    Роля на потребителя: ${role}.
    Име на госта: ${bookingData ? bookingData.guest_name : "Неизвестен"}.
    Статус на тока: ${isOnline ? "Онлайн" : "Офлайн"}.
    Наръчник: ${manualContent}.
    Ти си Ико - умен иконом на апартамент в Банско.
    `;
    
    // --- ИЗБОР НА МОДЕЛ (ТВОИТЕ СПЕЦИФИЧНИ ВЕРСИИ) ---
    const modelsToTry = ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"];
    let finalReply = "Съжалявам, Ико има техническо затруднение в момента.";

    for (const modelName of modelsToTry) {
        try {
            // console.log(`🤖 Опит с модел: ${modelName}`);
            const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
            const chat = model.startChat({ history: history || [] });
            const result = await chat.sendMessage(message);
            finalReply = result.response.text();
            break; // Успех -> излизаме от цикъла
        } catch (error) { 
            console.error(`❌ Грешка с модел ${modelName}:`, error.message); 
            // Продължаваме към следващия модел
        }
    }
    res.json({ reply: finalReply });
});

// ==================================================================
// --- 7. API ЕНДПОЙНТИ (СЪРВЪРНИ ФУНКЦИИ) ---
// ==================================================================

// 7.1 Синхронизация с Gmail
app.get('/sync', async (req, res) => { 
    try {
        await syncBookingsFromGmail(); 
        res.send('✅ Синхронизацията с Gmail е успешна.'); 
    } catch (e) {
        res.status(500).send('Грешка при синхронизация: ' + e.message);
    }
});

// 7.2 Списък с резервации
app.get('/bookings', async (req, res) => { 
    try {
        const list = await sql`SELECT * FROM bookings ORDER BY check_in ASC`;
        res.json(list); 
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7.3 Изтриване на резервация
app.delete('/bookings/:id', async (req, res) => { 
    try {
        await sql`DELETE FROM bookings WHERE id = ${req.params.id}`; 
        res.send('OK'); 
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 7.4 Ръчно добавяне на резервация
app.post('/add-booking', async (req, res) => {
    try {
        const { guest_name, reservation_code, check_in, check_out } = req.body;
        // Генериране на 6-цифрен ПИН
        const pin = Math.floor(100000 + Math.random() * 899999);
        
        // Запис в базата
        await sql`INSERT INTO bookings (guest_name, reservation_code, check_in, check_out, lock_pin) VALUES (${guest_name}, ${reservation_code}, ${check_in}, ${check_out}, ${pin})`;
        
        // Опит за създаване на парола веднага (фонов процес)
        createLockPin(pin, guest_name.split(' ')[0], check_in, check_out);
        
        res.send('OK');
    } catch (e) {
        console.error("Add Booking Error:", e);
        res.status(500).send(e.message);
    }
});

// 7.5 iCal Feed (За Airbnb/Booking календари)
app.get('/feed.ics', async (req, res) => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        
        // Стандартен VCALENDAR хедър
        let icsContent = "BEGIN:VCALENDAR\n";
        icsContent += "VERSION:2.0\n";
        icsContent += "PRODID:-//SmartStay//Bansko//EN\n";
        icsContent += "CALSCALE:GREGORIAN\n";
        icsContent += "METHOD:PUBLISH\n";
        
        bookings.forEach(b => {
            const start = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            const end = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            
            icsContent += "BEGIN:VEVENT\n";
            icsContent += `UID:${b.reservation_code || b.id}@smartstay.bg\n`;
            icsContent += `DTSTAMP:${stamp}\n`;
            icsContent += `DTSTART:${start}\n`;
            icsContent += `DTEND:${end}\n`;
            icsContent += `SUMMARY:${b.guest_name}\n`;
            icsContent += `DESCRIPTION:Reservation Code: ${b.reservation_code} | PIN: ${b.lock_pin}\n`;
            icsContent += "STATUS:CONFIRMED\n";
            icsContent += "END:VEVENT\n";
        });
        
        icsContent += "END:VCALENDAR";
        
        res.header('Content-Type', 'text/calendar; charset=utf-8');
        res.header('Content-Disposition', 'attachment; filename="calendar.ics"');
        res.send(icsContent);
    } catch (e) {
        console.error("ICS Error:", e);
        res.status(500).send("ICS Generation Error");
    }
});

// 7.6 Статус на тока (JSON)
app.get('/status', async (req, res) => { 
    try {
        const s = await getTuyaStatus(); 
        res.json({ is_on: s ? s.value : false }); 
    } catch (e) {
        res.json({ is_on: false, error: "Tuya Error" });
    }
});

// 7.7 Статус на бравата (Върната функция!)
app.get('/lock-status', async (req, res) => {
    const status = await getLockStatus();
    res.json(status || { error: "Няма връзка с бравата" });
});

// 7.8 Ръчно превключване на тока (Toggle)
app.get('/toggle', async (req, res) => { 
    try {
        const s = await getTuyaStatus(); 
        if(s) {
            await controlDevice(!s.value); 
            res.json({success:true, new_state: !s.value}); 
        } else {
            res.status(500).json({success:false, error: "Няма връзка с устройството"});
        }
    } catch(e) {
        res.status(500).json({success:false, error: e.message}); 
    }
});

// 7.9 ТЕСТ ЛИНК: Пълна диагностика на бравата
app.get('/test-lock', async (req, res) => {
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60000); // 1 час напред
    
    // Пробваме с тестови код и име
    console.log("🛠️ Ръчен тест на бравата стартиран...");
    const result = await createLockPin("654321", "Test_Manual_Run", now, later);
    
    res.json({ 
        overall_success: result.success, 
        methods_report: result.report,
        msg: result.success ? "УСПЕХ! Поне един метод сработи. Пробвай 654321#" : "Провал. Виж отчета."
    });
});

// ==================================================================
// --- 8. СТАРТИРАНЕ НА СЪРВЪРА ---
// ==================================================================

app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Iko Server is running on port ${PORT}`);
    console.log(`📅 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`=========================================`);
    
    // Първоначална синхронизация при старт
    syncBookingsFromGmail();
    
    // Периодична синхронизация (на всеки 15 мин)
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});