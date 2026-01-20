require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const cron = require('node-cron');
const ical = require('node-ical');
const fs = require('fs');

const app = express();

// --- 1. CORS НАСТРОЙКИ ---
app.use(cors({
    origin: [
        'https://stay.bgm-design.com',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.json());

// --- 2. SECURITY: BASIC AUTH ---
const basicAuth = (req, res, next) => {
    const user = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASS || 'smartstay2026';
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login && password && login === user && password === pass) return next();
    res.set('WWW-Authenticate', 'Basic realm="Smart Stay Admin"');
    res.status(401).send('Authentication required.');
};

app.get(['/admin.html', '/remote.html'], basicAuth, (req, res, next) => next());
app.use(express.static('public'));

// --- 3. ВРЪЗКИ ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const tuya = new TuyaContext({
  baseUrl: 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_ACCESS_SECRET,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- 4. КЕШ ЗА TUYA ---
let deviceCache = { isOn: false, lastUpdated: 0 };

async function getSmartStatus() {
    const now = Date.now();
    if (now - deviceCache.lastUpdated > 30000) {
        try {
            const data = await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status`, method: 'GET' });
            if(data.success) {
                const sw = data.result.find(i => i.code === 'switch');
                deviceCache.isOn = sw ? sw.value : false;
                deviceCache.lastUpdated = now;
            }
        } catch (e) { console.error("Tuya Status Error:", e.message); }
    }
    return deviceCache.isOn;
}

// --- 5. ЕКСПОРТ НА КАЛЕНДАР (.ics) ---
app.get('/feed.ics', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM bookings");
        let icsData = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SmartStay//NONSGML v1.0//EN\n";
        
        result.rows.forEach(b => {
            const start = new Date(b.check_in).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            const end = new Date(b.check_out).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            icsData += "BEGIN:VEVENT\n";
            icsData += `UID:${b.id}@smartstay.com\n`;
            icsData += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'}\n`;
            icsData += `DTSTART:${start}\n`;
            icsData += `DTEND:${end}\n`;
            icsData += `SUMMARY:Blocked: ${b.guest_name}\n`;
            icsData += "END:VEVENT\n";
        });
        
        icsData += "END:VCALENDAR";
        res.set('Content-Type', 'text/calendar');
        res.send(icsData);
    } catch (e) {
        console.error(e);
        res.status(500).send("Calendar Error");
    }
});

// --- 6. AI ЧАТ (Gemini 3 Flash Preview + Fallback) ---
app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;
    let manualData = "";
    try {
        if (fs.existsSync('manual.txt')) manualData = fs.readFileSync('manual.txt', 'utf8');
    } catch (err) { console.error("No manual found."); }

    const systemInstruction = `
    Ти си Smart Stay Иконом.
    1. ВИДИШ ЛИ КОД (HMxxxx, A1B2C3): Върни САМО "CHECK_CODE: [кодът]".
    2. НЯМА ЛИ КОД: Говори любезно на БГ, ползвайки тези данни:
    ${manualData}
    `;

    async function generateAIResponse(prompt, instructions) {
        try {
            console.log("🤖 Опит с Gemini 3 Flash Preview...");
            const model = genAI.getGenerativeModel({ model: "gemini-3.0-flash-preview", systemInstruction: instructions });
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (error) {
            console.warn("⚠️ Gemini 3 failed. Превключвам на Gemini 2.5 Flash.", error.message);
            try {
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: instructions });
                const result = await model.generateContent(prompt);
                return result.response.text();
            } catch (err2) { throw new Error("AI Failed completely."); }
        }
    }

    try {
        let botResponse = await generateAIResponse(userMessage, systemInstruction);
        botResponse = botResponse.trim();

        if (botResponse.includes("CHECK_CODE:")) {
            const code = botResponse.split(":")[1].trim().replace(/[\[\]]/g, "");
            const dbRes = await pool.query("SELECT * FROM bookings WHERE reservation_code = $1", [code]);
            const dbData = dbRes.rows.length > 0 ? dbRes.rows[0] : null;

            if (dbData) {
                const prompt = `Резервация намерена: ${JSON.stringify(dbData)}. Поздрави госта, дай му ПИН кода (${dbData.lock_pin}) и му пожелай приятен престой.`;
                botResponse = await generateAIResponse(prompt, systemInstruction);
            } else {
                botResponse = "Не намирам резервация с този код.";
            }
        }
        res.json({ reply: botResponse });
    } catch (err) {
        console.error("AI Error:", err);
        res.json({ reply: "В момента обновяваме системите си. Моля опитайте след малко." });
    }
});

// --- 7. АВТОПИЛОТ (Cron) ---
cron.schedule('*/10 * * * *', async () => {
    try {
        const r = await pool.query("SELECT * FROM bookings WHERE check_in::timestamp < (NOW() AT TIME ZONE 'UTC' + INTERVAL '6 hours') AND check_out::timestamp > (NOW() AT TIME ZONE 'UTC') AND power_on_time IS NULL");
        for (const b of r.rows) {
            await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`, method: 'POST', body: { commands: [{ code: 'switch', value: true }] } });
            await pool.query("UPDATE bookings SET power_on_time = NOW() WHERE id = $1", [b.id]);
        }
    } catch (e) { console.error(e); }
});

cron.schedule('*/10 * * * *', async () => {
    try {
        const r = await pool.query("SELECT * FROM bookings WHERE check_out::timestamp < (NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour') AND check_out::timestamp > (NOW() AT TIME ZONE 'UTC' - INTERVAL '24 hours') AND power_off_time IS NULL");
        for (const b of r.rows) {
            await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`, method: 'POST', body: { commands: [{ code: 'switch', value: false }] } });
            await pool.query("UPDATE bookings SET power_off_time = NOW() WHERE id = $1", [b.id]);
        }
    } catch (e) { console.error(e); }
});

// --- 8. SYNC AIRBNB (БРОНИРАНА ВЕРСИЯ) ---
const syncAirbnb = async () => {
    const icalUrl = process.env.AIRBNB_ICAL_URL;
    
    if (!icalUrl) {
        console.error('Липсва AIRBNB_ICAL_URL в .env файла');
        return;
    }

    try {
        const events = await ical.async.fromURL(icalUrl);
        
        // 1. Дефинираме "Хоризонт" - днешна дата и дата след 1 година
        const now = new Date();
        const maxFutureDate = new Date();
        maxFutureDate.setFullYear(now.getFullYear() + 1);

        let addedCount = 0;

        for (const k in events) {
            // ТУК Е "БРОНИЖИЛЕТКАТА" - Всяка резервация е в собствен try/catch
            try {
                const event = events[k];
                if (event.type !== 'VEVENT') continue;
                if (!event.start) continue;
                
                const startDate = new Date(event.start);
                const endDate = new Date(event.end || event.start);

                // --- ЗАЩИТАТА (ФИЛТЪР) ---
                // 1. Ако е минало събитие (по-старо от вчера) -> Пропускаме
                // 2. Ако е твърде далеч в бъдещето (над 1 година) -> Пропускаме
                if (startDate < new Date(now.getTime() - 86400000) || startDate > maxFutureDate) {
                    continue;
                }
                
                let resCode = event.uid || `airbnb-${startDate.getTime()}`;
                const desc = event.description || "";
                const codeMatch = desc.match(/(HM[A-Z0-9]{8})/);
                if (codeMatch) resCode = codeMatch[1];
                
                // Airbnb скрива имената, затова слагаме етикет
                let guestName = event.summary === 'Reserved' || !event.summary 
                    ? 'Airbnb Guest (Synced)' 
                    : event.summary;

                // Орязване за всеки случай
                if (guestName.length > 250) guestName = guestName.substring(0, 250);
                if (resCode.length > 250) resCode = resCode.substring(0, 250);

                const exists = await pool.query("SELECT id FROM bookings WHERE reservation_code = $1", [resCode]);
                if (exists.rows.length === 0) {
                    const pin = Math.floor(100000 + Math.random() * 900000).toString();
                    await pool.query("INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES ($1, $2, $3, $4, $5, 'paid')", [guestName, startDate, endDate, resCode, pin]);
                    addedCount++;
                    console.log(`✅ Imported booking: ${startDate.toISOString()} - ${guestName}`);
                }
            } catch (innerError) {
                // Ако един запис гръмне, само го логваме и продължаваме!
                console.error(`⚠️ Skipping bad event: ${innerError.message}`);
            }
        }
        console.log(`Sync complete. New bookings added: ${addedCount}`);
    } catch (e) { console.error("Airbnb Critical Error:", e.message); }
};
cron.schedule('*/30 * * * *', syncAirbnb);

// --- 9. API ROUTES & EMERGENCY FIX ---

// СПЕЦИАЛЕН РУТ ЗА РЪЧНА ПОПРАВКА НА БАЗАТА (TEXT TYPE)
app.get('/emergency-fix', async (req, res) => {
    try {
        await pool.query("ALTER TABLE bookings ALTER COLUMN reservation_code TYPE TEXT");
        await pool.query("ALTER TABLE bookings ALTER COLUMN guest_name TYPE TEXT");
        res.send("✅ УСПЕХ! Колоните вече са тип TEXT (безлимитни). Проблемът е решен завинаги.");
    } catch (e) {
        res.status(500).send("Грешка при фикс: " + e.message);
    }
});

app.get('/status', basicAuth, async (req, res) => { try { res.json({ is_on: await getSmartStatus() }); } catch (e) { res.status(500).json(e); } });
app.get('/toggle', basicAuth, async (req, res) => { try { const s = await getSmartStatus(); await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`, method: 'POST', body: { commands: [{ code: 'switch', value: !s }] } }); deviceCache.isOn = !s; deviceCache.lastUpdated = Date.now(); res.send(`OK: ${!s}`); } catch (e) { res.status(500).send(e.message); } });
app.post('/add-booking', basicAuth, async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;
    if (!guest_name || !check_in || !check_out || !reservation_code) return res.status(400).json({ error: "Missing data" });
    try {
        const c = await pool.query("SELECT id FROM bookings WHERE reservation_code = $1", [reservation_code]);
        if (c.rows.length > 0) return res.status(400).json({ error: "Code exists" });
        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const r = await pool.query("INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES ($1, $2, $3, $4, $5, 'paid') RETURNING lock_pin", [guest_name, check_in, check_out, reservation_code, pin]);
        res.json({ success: true, pin: r.rows[0].lock_pin });
    } catch (e) { res.status(500).json({ error: "Error" }); }
});
app.get('/bookings', basicAuth, async (req, res) => { const r = await pool.query('SELECT * FROM bookings ORDER BY check_in DESC'); res.json(r.rows); });
app.delete('/bookings/:id', basicAuth, async (req, res) => { await pool.query('DELETE FROM bookings WHERE id = $1', [req.params.id]); res.json({ success: true }); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    syncAirbnb();
});