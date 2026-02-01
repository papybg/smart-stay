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

// --- НАСТРОЙКИ НА СЪРВЪРА ---
const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- 1. НАСТРОЙКА НА ПОЩА (NODEMAILER) ---
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
    } catch (e) {
        console.error("Mail Error:", e.message);
    }
}

// --- 2. ЗАРЕЖДАНЕ НА НАРЪЧНИКА ---
let manualContent = "Липсва файл manual.txt.";
try {
    if (fs.existsSync('manual.txt')) {
        manualContent = fs.readFileSync('manual.txt', 'utf8');
    }
} catch (err) {
    console.error("Грешка при четене на manual.txt:", err);
}

// --- 3. TUYA ВРЪЗКА (ТОК И БРАВА) ---
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET,
});

// --> Функция за управление на ТОКА
async function controlDevice(state) {
    try {
        await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: {
                commands: [{ code: 'switch', value: state }]
            }
        });
        return true;
    } catch (e) {
        console.error('Tuya Switch Error:', e.message);
        return false;
    }
}

// --> Функция за проверка на статус (ТОК)
async function getTuyaStatus() {
    try {
        const res = await tuya.request({
            method: 'GET',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status`
        });
        return res.result.find(s => s.code === 'switch');
    } catch (e) {
        return null;
    }
}

// --> НОВА ФУНКЦИЯ: Генериране на ПИН код за БРАВАТА (Lockin G30)
async function createLockPin(pin, name, checkInDate, checkOutDate) {
    try {
        // Tuya API изисква времето в секунди (Unix timestamp)
        const startTime = Math.floor(new Date(checkInDate).getTime() / 1000);
        const endTime = Math.floor(new Date(checkOutDate).getTime() / 1000);

        const response = await tuya.request({
            method: 'POST',
            path: `/v1.0/smart-lock/devices/${process.env.LOCK_DEVICE_ID}/password/temp`,
            body: {
                name: name,          // Име на паролата в Tuya
                password: pin,       // Самият код (6-10 цифри)
                effective_time: startTime,
                invalid_time: endTime,
                type: 2              // Тип 2 = Периодична парола (валидна от-до)
            }
        });
        
        console.log(`🔐 Ключалка: Успешно създаден код за ${name} (${pin})`);
        return response.success;
    } catch (error) {
        console.error("❌ Грешка с бравата:", error.message);
        return false;
    }
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- 4. АВТОПИЛОТ (CRON JOBS) ---
cron.schedule('*/1 * * * *', async () => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const currentStatus = await getTuyaStatus();
        const isDeviceOn = currentStatus ? currentStatus.value : false;
        const now = new Date();

        // Проверка на всички резервации
        for (const b of bookings) {
            // Ако няма часове за ток, пропускаме
            if (!b.power_on_time || !b.power_off_time) continue;

            const start = new Date(b.power_on_time);
            const end = new Date(b.power_off_time);

            // Сценарий 1: Трябва да е пуснато
            if (now >= start && now < end) {
                if (!isDeviceOn) {
                    console.log(`🟢 Включвам тока за: ${b.guest_name}`);
                    await controlDevice(true);
                    await sendNotification("ТОКЪТ Е ПУСНАТ", `Гост: ${b.guest_name} пристигна.`);
                }
            } 
            // Сценарий 2: Времето е изтекло
            else if (now >= end && now < new Date(end.getTime() + 5*60000)) { // 5 мин толеранс за проверката
                if (isDeviceOn) {
                    // Проверка за застъпване (дали няма друг гост веднага след това)
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
                    } else {
                        console.log(`⚠️ Токът остава включен заради следващ гост.`);
                    }
                }
            }
        }
    } catch (err) {
        console.error('Cron Job Error', err);
    }
});

// --- 5. ЧАТ ИЗКУСТВЕН ИНТЕЛЕКТ ---
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history, authCode } = req.body;
        
        // Проверка на хардуера за контекст
        const powerStatus = await getTuyaStatus();
        const isOnline = powerStatus !== null;
        const isOn = isOnline ? powerStatus.value : false;
        
        const currentDateTime = new Date().toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' });

        // Логика за идентификация
        let bookingData = null;
        let role = "stranger";
        let guestInfo = "";
        
        // Търсене на код в съобщението или authCode
        const textCodeMatch = message.trim().toUpperCase().match(/HM[A-Z0-9]+/);
        const codeToTest = textCodeMatch ? textCodeMatch[0] : (authCode || "").trim();

        if (codeToTest === process.env.HOST_CODE) {
            role = "host";
        } else if (codeToTest) {
            const r = await sql`SELECT * FROM bookings WHERE reservation_code = ${codeToTest} LIMIT 1`;
            if (r.length > 0) {
                bookingData = r[0];
                role = "guest";
                guestInfo = `
Данни за госта:
- Име: ${bookingData.guest_name}
- Настаняване: ${new Date(bookingData.check_in).toLocaleString('bg-BG')}
- Напускане: ${new Date(bookingData.check_out).toLocaleString('bg-BG')}
- ПИН код за врата: ${bookingData.lock_pin || 'Липсва генериран ПИН'}
`;
            }
        }

        // Инструкции според ролята
        let systemInstruction = "";
        
        if (role === "host") {
            systemInstruction = `
СИСТЕМНО ВРЕМЕ: ${currentDateTime}
РОЛЯ: АДМИНИСТРАТОР (Бобо)
СИСТЕМА: Ти управляваш целия апартамент.
СТАТУС ТОК: ${isOnline ? (isOn ? "ВКЛЮЧЕН" : "ИЗКЛЮЧЕН") : "ОФЛАЙН (Няма връзка)"}
НАРЪЧНИК: ${manualContent}
`;
        } else if (role === "guest") {
            systemInstruction = `
СИСТЕМНО ВРЕМЕ: ${currentDateTime}
РОЛЯ: ИКОНОМ (Virtual Butler) за ${bookingData.guest_name}.
ТВОЯТА ЦЕЛ: Да помагаш на госта с всичко нужно за апартамента.
ВАЖНО: Гостът има резервация. ${guestInfo}
СТАТУС ТОК: ${isOn ? "Работи" : "Спрян (ако гостът е в стаята, предложи да го пуснеш)"}

WIFI INFO:
- Мрежа: SmartStay_Guest
- Парола: vacation_mode (Давай само ако попитат)

НАРЪЧНИК: ${manualContent}
ТОН: Любезен, гостоприемен, отговаряй на Български.
`;
        } else {
            systemInstruction = `
СИСТЕМНО ВРЕМЕ: ${currentDateTime}
РОЛЯ: ОХРАНА / РЕЦЕПЦИЯ
Ти си Ико. Не познаваш този потребител.
Не давай никаква лична информация, кодове за врати или WiFi пароли.
Помоли любезно за Код на Резервация (започва с HM...), за да го обслужиш.
Можеш да даваш обща информация за локацията, ако е в наръчника.
НАРЪЧНИК: ${manualContent}
`;
        }

        // Извикване на AI
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro", systemInstruction });
        const chat = model.startChat({ history: history || [] });
        const result = await chat.sendMessage(message);
        let finalReply = result.response.text();

        // Специални команди в отговора на AI
        // 1. Аварийно пускане на ток от гост
        const needsPower = /няма ток|без ток|не работи ток|изключен ток|спрян ток/i.test(message);
        if (needsPower && isOnline && !isOn && role === 'guest') {
            await controlDevice(true);
            finalReply += "\n\n(Система: Автоматично възстанових захранването, защото сте разпознат гост.)";
            await sendNotification("АВАРИЙНО ВКЛЮЧВАНЕ", `Гостът ${bookingData.guest_name} поиска ток през чата.`);
        }

        // 2. Alert към хоста
        if (finalReply.includes('[ALERT:')) {
            const match = finalReply.match(/\[ALERT:(.*?)\]/);
            if (match && match[1]) {
                await sendNotification("СЪОБЩЕНИЕ ОТ ГОСТ", `${match[1]}\nГост: ${bookingData ? bookingData.guest_name : "Непознат"}`);
            }
            // Чистим маркера от чата
            finalReply = finalReply.replace(/\[ALERT:.*?\]/g, '').trim();
        }

        res.json({ reply: finalReply });

    } catch (e) {
        console.error(e);
        res.status(500).json({ reply: "Ико има временен технически проблем." });
    }
});

// --- 6. API ЕНДПОЙНТОВЕ ЗА ТАБЛОТО И УПРАВЛЕНИЕ ---

// Синхронизация с Gmail
app.get('/sync', async (req, res) => {
    console.log('⚡ Ръчно стартиране на Детектива...');
    try {
        await syncBookingsFromGmail(); 
        res.send('✅ Детективът приключи! Провери базата данни.');
    } catch (err) {
        console.error(err);
        res.status(500).send('❌ Грешка при синхронизация: ' + err.message);
    }
});

// Изтриване на резервация
app.delete('/bookings/:id', async (req, res) => {
    try {
        await sql`DELETE FROM bookings WHERE id = ${req.params.id}`;
        res.json({ message: 'Deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Error deleting booking' });
    }
});

// Ръчно добавяне на резервация (Dashboard)
app.post('/add-booking', async (req, res) => {
    const { guest_name, reservation_code, check_in, check_out } = req.body;
    
    // Автоматично изчисляване на тока (2 часа преди, 1 час след)
    const inDate = new Date(check_in);
    const outDate = new Date(check_out);
    const powerOn = new Date(inDate.getTime() - (2 * 60 * 60 * 1000));
    const powerOff = new Date(outDate.getTime() + (1 * 60 * 60 * 1000));
    
    // Генериране на случаен ПИН
    const pin = Math.floor(1000 + Math.random() * 9000);

    try {
        await sql`
            INSERT INTO bookings (guest_name, reservation_code, check_in, check_out, power_on_time, power_off_time, source, payment_status, lock_pin)
            VALUES (${guest_name}, ${reservation_code}, ${check_in}, ${check_out}, ${powerOn.toISOString()}, ${powerOff.toISOString()}, 'manual', 'paid', ${pin})
        `;
        
        // ОПЦИЯ: Тук може да се извика createLockPin автоматично, ако желаеш
        // await createLockPin(pin.toString(), guest_name, inDate, outDate);

        res.status(201).json({ message: 'Booking added manually!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add booking' });
    }
});

// iCal Feed за Airbnb/Booking
app.get('/feed.ics', async (req, res) => {
    try {
        const bookings = await sql`SELECT * FROM bookings WHERE payment_status = 'paid'`;
        
        let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SmartStay//Bansko//EN\n";
        
        bookings.forEach(b => {
            const start = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            const end = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            
            icsContent += "BEGIN:VEVENT\n";
            icsContent += `UID:${b.id}@smartstay.com\n`;
            icsContent += `SUMMARY:${b.guest_name}\n`;
            icsContent += `DTSTART:${start}\n`;
            icsContent += `DTEND:${end}\n`;
            icsContent += `DESCRIPTION:Res Code: ${b.reservation_code}\\nPIN: ${b.lock_pin}\n`;
            icsContent += "END:VEVENT\n";
        });
        
        icsContent += "END:VCALENDAR";
        res.header('Content-Type', 'text/calendar');
        res.send(icsContent);
    } catch (e) {
        res.status(500).send("Calendar Error");
    }
});

// Списък резервации (JSON)
app.get('/bookings', async (req, res) => { 
    try {
        const list = await sql`SELECT * FROM bookings ORDER BY check_in ASC`;
        res.json(list);
    } catch(e) { res.json([]); }
});

// Статус на тока
app.get('/status', async (req, res) => { 
    try { 
        const s = await getTuyaStatus(); 
        res.json({ is_on: s ? s.value : false }); 
    } catch (e) { res.json({ is_on: false }); } 
});

// Ръчно превключване на тока (Toggle)
app.get('/toggle', async (req, res) => { 
    try { 
        const s = await getTuyaStatus(); 
        if(s) { 
            await controlDevice(!s.value); 
            res.json({success:true}); 
        } else {
            throw new Error("Device offline");
        } 
    } catch(e){ 
        res.status(500).json({error:"Fail"}); 
    } 
});

// 🔹 ТЕСТ ЗА БРАВАТА (НОВ ЕНДПОЙНТ) 🔹
app.get('/test-lock', async (req, res) => {
    // Тест: Създава код 123456 за следващите 10 минути
    const now = new Date();
    const later = new Date(now.getTime() + 10 * 60000); // +10 минути
    
    console.log("🛠️ Тествам бравата...");
    const success = await createLockPin("123456", "TestUser_Manual", now, later);
    
    if (success) {
        res.json({ msg: "✅ Успех! Изпратих код 123456 към бравата. Пробвай го!" });
    } else {
        res.json({ msg: "❌ Грешка! Провери логовете в Render и дали LOCK_DEVICE_ID е верен." });
    }
});

// Статус на бравата (Dummy за фронтенда)
app.get('/lock-status', async (req, res) => { 
    res.json({ installed: true, battery: "Unknown", status: "Online (via Tuya)" }); 
});

// --- СТАРТИРАНЕ ---
app.listen(PORT, () => {
    console.log(`🚀 Iko Server is running on port ${PORT}`);
    
    // Първоначална синхронизация
    syncBookingsFromGmail();
    
    // Периодична синхронизация (на всеки 15 мин)
    setInterval(syncBookingsFromGmail, 15 * 60 * 1000);
});