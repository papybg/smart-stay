require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

// Взимаме ключовете и махаме евентуални празни места (trim)
const CLIENT_ID = process.env.TUYA_ACCESS_ID ? process.env.TUYA_ACCESS_ID.trim() : "";
const SECRET = process.env.TUYA_ACCESS_SECRET ? process.env.TUYA_ACCESS_SECRET.trim() : "";
const DEVICE_ID = process.env.TUYA_DEVICE_ID ? process.env.TUYA_DEVICE_ID.trim() : "";

console.log("🔑 Проверка на ключове:");
console.log(`ID: ${CLIENT_ID.slice(0, 4)}... (Дължина: ${CLIENT_ID.length})`);
console.log(`Secret: ${SECRET.slice(0, 4)}... (Дължина: ${SECRET.length})`);
console.log(`Device: ${DEVICE_ID}`);
console.log("------------------------------------------------");

const REGIONS = {
    "🇪🇺 EUROPE (tuyaeu.com)": "https://openapi.tuyaeu.com",
    "🇺🇸 USA (tuyaus.com)": "https://openapi.tuyaus.com",
    "🇨🇳 CHINA (tuyacn.com)": "https://openapi.tuyacn.com",
    "🇮🇳 INDIA (tuyain.com)": "https://openapi.tuyain.com"
};

function sign(str) {
    return crypto.createHmac('sha256', SECRET).update(str, 'utf8').digest('hex').toUpperCase();
}

async function tryRegion(name, url) {
    const t = Date.now().toString();
    const method = 'GET';
    const path = '/v1.0/token?grant_type=1';
    
    // Подпис за Токен: CLIENT_ID + t
    const signStr = sign(CLIENT_ID + t);

    try {
        console.log(`⏳ Пробвам регион: ${name}...`);
        const res = await axios({
            method: method,
            url: url + path,
            headers: {
                'client_id': CLIENT_ID,
                'sign': signStr,
                't': t,
                'sign_method': 'HMAC-SHA256'
            },
            timeout: 5000 // 5 секунди таймаут
        });
        
        if (res.data.success) {
            console.log(`✅ УСПЕХ! Твоят регион е: ${name}`);
            return { success: true, url: url, token: res.data.result.access_token };
        } else {
            console.log(`❌ Грешка (${res.data.code}): ${res.data.msg}`);
            return { success: false };
        }
    } catch (e) {
        console.log(`❌ Грешка връзка: ${e.message}`);
        return { success: false };
    }
}

async function scanAndConnect() {
    let validUrl = null;
    let token = null;

    // 1. Търсим правилния регион
    for (const [name, url] of Object.entries(REGIONS)) {
        const result = await tryRegion(name, url);
        if (result.success) {
            validUrl = result.url;
            token = result.token;
            break; // Намерихме го, спираме търсенето
        }
    }

    if (!validUrl) {
        console.log("\n📛 НЕ МОГА ДА СЕ СВЪРЖА. Провери дали ключовете са верни!");
        return;
    }

    // 2. Ако сме намерили регион, дърпаме данните от електромера
    console.log("\n🔌 Свързване с електромера...");
    const t = Date.now().toString();
    const path = `/v1.0/devices/${DEVICE_ID}/status`;
    const signStr = sign(CLIENT_ID + token + t);

    try {
        const res = await axios({
            method: 'GET',
            url: validUrl + path,
            headers: {
                'client_id': CLIENT_ID,
                'access_token': token,
                'sign': signStr,
                't': t,
                'sign_method': 'HMAC-SHA256'
            }
        });

        if (res.data.success) {
            console.log("📊 ДАННИ ОТ УРЕДА:");
            console.log(JSON.stringify(res.data.result, null, 2));
        } else {
            console.log("❌ Грешка при данни:", res.data);
        }
    } catch (e) {
        console.error("Грешка:", e.message);
    }
}

scanAndConnect();