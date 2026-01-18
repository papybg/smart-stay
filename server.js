require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const cron = require('node-cron');
const ical = require('node-ical'); // Изисква: npm install node-ical

const app = express();
app.use(cors());
app.use(express.json());

// --- SECURITY: BASIC AUTH ---
const basicAuth = (req, res, next) => {
    const user = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASS || 'smartstay2026'; // Смени паролата в .env!
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login && password && login === user && password === pass) return next();
    res.set('WWW-Authenticate', 'Basic realm="Smart Stay Admin"');
    res.status(401).send('Authentication required.');
};

// Защитаваме админските панели ПРЕДИ да ги сервираме като статични файлове
app.get(['/admin.html', '/remote.html'], basicAuth, (req, res, next) => next());

app.use(express.static('public'));

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

// --- CACHE SYSTEM (Пестене на заявки) ---
let deviceCache = {
    isOn: false,
    lastUpdated: 0
};

// Помощна функция: Взима статус интелигентно (от кеша или от Tuya)
async function getSmartStatus() {
    const now = Date.now();
    // Ако информацията е по-стара от 30 секунди, питаме Tuya
    if (now - deviceCache.lastUpdated > 30000) {
        const data = await tuya.request({ path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status`, method: 'GET' });
        const sw = data.result.find(i => i.code === 'switch');
        deviceCache.isOn = sw.value;
        deviceCache.lastUpdated = now;
    }
    return deviceCache.isOn;
}

// --- DB MIGRATION TOOL (Еднократно изпълнение) ---
app.get('/update-db', basicAuth, async (req, res) => {
    try {
        await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_on_time TIMESTAMP");
        await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_off_time TIMESTAMP");
        res.send("✅ Базата данни е обновена успешно! Добавени са колони за история на тока.");
    } catch (e) { res.status(500).send("Грешка: " + e.message); }
});

// --- АВТОПИЛОТ ---
cron.schedule('*/10 * * * *', async () => {
    try {
        const query = `
            SELECT * FROM bookings 
            WHERE check_in::timestamp > (NOW() AT TIME ZONE 'UTC') 
            AND check_in::timestamp < (NOW() AT TIME ZONE 'UTC' + INTERVAL '6 hours')
        `;
        const result = await pool.query(query);
        
        // Обхождаме всяка намерена резервация поотделно
        for (const booking of result.rows) {
            // Ако вече сме отбелязали, че токът е пуснат за тази резервация, пропускаме
            if (booking.power_on_time) continue;

            console.log("🛎️ Автопилот: Пускам тока за гости.");
            await tuya.request({
                path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
                method: 'POST',
                body: { commands: [{ code: 'switch', value: true }] }
            });
            // 1. Първо проверяваме статуса (през кеша)
            const isAlreadyOn = await getSmartStatus();

            if (!isAlreadyOn) {
                console.log("🛎️ Автопилот: Пускам тока за гости.");
                await tuya.request({
                    path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
                    method: 'POST',
                    body: { commands: [{ code: 'switch', value: true }] }
                });
                // Обновяваме кеша ръчно, защото знаем, че сме го пуснали
                deviceCache.isOn = true;
                deviceCache.lastUpdated = Date.now();
            } else { console.log("✅ Автопилот: Токът вече е пуснат. Няма нужда от действие."); }
            
            // ЗАПИСВАМЕ В ИСТОРИЯТА (Дори да е бил пуснат, маркираме, че задачата е изпълнена)
            await pool.query("UPDATE bookings SET power_on_time = NOW() WHERE id = $1", [booking.id]);
            console.log(`📝 История: Маркирано включване за резервация #${booking.id}`);
        }
    } catch (err) { console.error('Cron error:', err); }
});

// --- АВТОПИЛОТ (ИЗКЛЮЧВАНЕ) ---
cron.schedule('*/10 * * * *', async () => {
    try {
        // Търсим резервации, които са приключили преди повече от 1 час (но по-малко от 2 часа, за да не пращаме команди постоянно)
        const query = `
            SELECT * FROM bookings 
            WHERE check_out::timestamp < (NOW() AT TIME ZONE 'UTC' - INTERVAL '1 hour') 
            AND check_out::timestamp > (NOW() AT TIME ZONE 'UTC' - INTERVAL '2 hours')
        `;
        const result = await pool.query(query);
        
        for (const booking of result.rows) {
            // Ако вече сме отбелязали изключване, пропускаме
            if (booking.power_off_time) continue;

            console.log("🌑 Автопилот: Изключвам тока след напускане.");
            await tuya.request({
                path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
                method: 'POST',
                body: { commands: [{ code: 'switch', value: false }] }
            });
            // 1. Проверяваме дали вече не е изключен (през кеша)
            const isStillOn = await getSmartStatus();

            if (isStillOn) {
                console.log("🌑 Автопилот: Изключвам тока след напускане.");
                await tuya.request({
                    path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
                    method: 'POST',
                    body: { commands: [{ code: 'switch', value: false }] }
                });
                // Обновяваме кеша ръчно
                deviceCache.isOn = false;
                deviceCache.lastUpdated = Date.now();
            } else { console.log("✅ Автопилот: Токът вече е спрян. Няма нужда от действие."); }
            
            // ЗАПИСВАМЕ В ИСТОРИЯТА
            await pool.query("UPDATE bookings SET power_off_time = NOW() WHERE id = $1", [booking.id]);
            console.log(`📝 История: Маркирано изключване за резервация #${booking.id}`);
        }
    } catch (err) { console.error('Cron OFF error:', err); }
});

// --- AIRBNB SYNC (На всеки 30 минути) ---
const syncAirbnb = async () => {
    console.log("🔄 Airbnb Sync: Проверка за нови резервации...");
    const icalUrl = process.env.AIRBNB_ICAL_URL;
    if (!icalUrl) return console.log("⚠️ Няма зададен AIRBNB_ICAL_URL в .env");

    try {
        const events = await ical.async.fromURL(icalUrl);
        
        for (const k in events) {
            const ev = events[k];
            if (ev.type !== 'VEVENT') continue;

            // Airbnb дати
            const checkIn = new Date(ev.start);
            const checkOut = new Date(ev.end);
            
            // Опит за намиране на код (Airbnb често го слага в описанието или UID)
            // UID формат: 123456789-12345@airbnb.com -> ползваме го за уникалност
            // Ако намерим "HM..." код в описанието, е супер, иначе ползваме UID
            let resCode = ev.uid; 
            const desc = ev.description || "";
            const codeMatch = desc.match(/(HM[A-Z0-9]{8})/); // Търсим стандартен Airbnb код
            if (codeMatch) resCode = codeMatch[1];

            // Име на госта (Airbnb често го крие като "Reserved", но понякога го има)
            const guestName = ev.summary || "Airbnb Guest";

            // Проверка дали вече съществува в базата
            const exists = await pool.query("SELECT id FROM bookings WHERE reservation_code = $1", [resCode]);
            
            if (exists.rows.length === 0) {
                console.log(`🆕 Нова резервация от Airbnb: ${guestName} (${resCode})`);
                const pin = Math.floor(100000 + Math.random() * 900000).toString();
                await pool.query(
                    "INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES ($1, $2, $3, $4, $5, 'paid')",
                    [guestName, checkIn, checkOut, resCode, pin]
                );
            }
        }
    } catch (err) { console.error("❌ Airbnb Sync Error:", err.message); }
};

// Стартираме синхронизацията по график И веднага при старт на сървъра
cron.schedule('*/30 * * * *', syncAirbnb);
syncAirbnb();

app.get('/status', basicAuth, async (req, res) => {
    try {
        const isOn = await getSmartStatus();
        res.json({ is_on: isOn });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/toggle', basicAuth, async (req, res) => {
    try {
        const currentStatus = await getSmartStatus();
        const newVal = !currentStatus;
        await tuya.request({
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            method: 'POST',
            body: { commands: [{ code: 'switch', value: newVal }] }
        });
        // Веднага обновяваме кеша, за да реагира интерфейсът мигновено
        deviceCache.isOn = newVal;
        deviceCache.lastUpdated = Date.now();
        res.send(`OK: ${newVal}`);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/chat', async (req, res) => {
    const userMessage = req.body.message;
    const systemInstruction = "Ти си Smart Stay Асистент. Ако видиш код, отговори само: CHECK_CODE: [кода]. Ако получиш данни, ги кажи любезно на БЪЛГАРСКИ. Ако няма данни, кажи че не намираш такава резервация.";

    // Помощна функция за изпълнение на заявката с конкретен модел
    const runAI = async (modelName) => {
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
        let result = await model.generateContent(userMessage);
        let botResponse = result.response.text().trim();

        if (botResponse.includes("CHECK_CODE:")) {
            const code = botResponse.split(":")[1].trim().replace(/[\[\]]/g, "");
            const dbRes = await pool.query("SELECT * FROM bookings WHERE reservation_code = $1", [code]);
            const dbData = dbRes.rows.length > 0 ? dbRes.rows[0] : { error: "not_found" };
            const finalResult = await model.generateContent(`ДАННИ: ${JSON.stringify(dbData)}. Отговори любезно.`);
            botResponse = finalResult.response.text();
        }
        return botResponse;
    };

    try {
        // 1. Опит с основния модел (Gemini 3.0 Preview)
        const reply = await runAI("gemini-3.0-flash-preview");
        res.json({ reply });
    } catch (err) {
        console.warn("⚠️ Gemini 3.0 failed, switching to fallback (2.5 Flash)...", err.message);
        try {
            // 2. Fallback към по-стабилен модел (Gemini 2.5)
            const reply = await runAI("gemini-2.5-flash");
            res.json({ reply });
        } catch (fallbackErr) {
            console.error("❌ All models failed:", fallbackErr);
            res.json({ reply: "Опитай пак. (Грешка в AI модула)" });
        }
    }
});

app.post('/add-booking', basicAuth, async (req, res) => {
    const { guest_name, check_in, check_out, reservation_code } = req.body;

    // 1. ВАЛИДАЦИЯ: Не позволяваме запис, ако липсват данни
    if (!guest_name || !check_in || !check_out || !reservation_code) {
        return res.status(400).json({ error: "Моля попълнете всички полета (вкл. код на резервация)!" });
    }

    // 2. ВАЛИДАЦИЯ НА ДАТИ: Проверка за минало време и логика
    const startDate = new Date(check_in);
    const endDate = new Date(check_out);
    const now = new Date();

    if (startDate < now) {
        return res.status(400).json({ error: "Грешка: Датата на настаняване е в миналото!" });
    }
    if (endDate <= startDate) {
        return res.status(400).json({ error: "Грешка: Датата на напускане трябва да е след настаняването!" });
    }

    // 2.1. ПРОВЕРКА ЗА ДУБЛИРАН КОД (Преди датите)
    const codeCheck = await pool.query("SELECT id FROM bookings WHERE reservation_code = $1", [reservation_code]);
    if (codeCheck.rows.length > 0) {
        return res.status(400).json({ error: "Вече има резервация с този код!" });
    }

    // 3. ПРОВЕРКА ЗА ЗАСТЪПВАНЕ (Overlap)
    // Търсим дали има резервация, която започва преди новата да свърши И свършва след като новата започне
    const overlapCheck = await pool.query(
        "SELECT * FROM bookings WHERE check_in < $2 AND check_out > $1",
        [check_in, check_out]
    );

    if (overlapCheck.rows.length > 0) {
        return res.status(400).json({ error: "Грешка: Има застъпване с друга резервация за тези дати!" });
    }

    try {
        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const result = await pool.query(
            "INSERT INTO bookings (guest_name, check_in, check_out, reservation_code, lock_pin, payment_status) VALUES ($1, $2, $3, $4, $5, 'paid') RETURNING lock_pin",
            [guest_name, check_in, check_out, reservation_code, pin]
        );
        res.json({ success: true, pin: result.rows[0].lock_pin });
    } catch (err) {
        console.error("Booking Error:", err);
        // Ако базата върне грешка за дублиран код (код 23505 в Postgres)
        if (err.code === '23505') return res.status(400).json({ error: "Вече има резервация с този код!" });
        res.status(500).json({ error: "Грешка при запис в базата." });
    }
});

app.get('/bookings', basicAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    res.json(result.rows);
});

app.delete('/bookings/:id', basicAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
        console.log(`🗑️ Изтрита резервация ID: ${req.params.id}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 10000);