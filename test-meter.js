require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

// НАСТРОЙКИ
const TUYA_URL = 'https://openapi.tuyaeu.com'; // Европейски сървър
const CLIENT_ID = process.env.TUYA_ACCESS_ID;
const SECRET = process.env.TUYA_ACCESS_SECRET;
const DEVICE_ID = process.env.TUYA_DEVICE_ID;

// 1. Функция за подписване (Signature)
function sign(str) {
    return crypto.createHmac('sha256', SECRET).update(str, 'utf8').digest('hex').toUpperCase();
}

// 2. Взимане на Токен
async function getToken() {
    const t = Date.now().toString();
    const method = 'GET';
    const path = '/v1.0/token?grant_type=1';
    
    // За токен подписът е: CLIENT_ID + t
    const signStr = sign(CLIENT_ID + t);

    try {
        const res = await axios({
            method: method,
            url: TUYA_URL + path,
            headers: {
                'client_id': CLIENT_ID,
                'sign': signStr,
                't': t,
                'sign_method': 'HMAC-SHA256'
            }
        });
        
        if (res.data.success) {
            return res.data.result.access_token;
        } else {
            console.error("❌ Грешка при Token:", res.data);
            return null;
        }
    } catch (e) {
        console.error("❌ Грешка връзка (Token):", e.message);
        return null;
    }
}

// 3. Взимане на данни от електромера
async function getMeterStatus() {
    console.log("🔌 Опит за връзка с електромера...");
    
    const token = await getToken();
    if (!token) return;

    const t = Date.now().toString();
    const path = `/v1.0/devices/${DEVICE_ID}/status`;
    
    // За заявка подписът е: CLIENT_ID + ACCESS_TOKEN + t
    const signStr = sign(CLIENT_ID + token + t);

    try {
        const res = await axios({
            method: 'GET',
            url: TUYA_URL + path,
            headers: {
                'client_id': CLIENT_ID,
                'access_token': token,
                'sign': signStr,
                't': t,
                'sign_method': 'HMAC-SHA256'
            }
        });

        if (res.data.success) {
            console.log("\n✅ УСПЕШНА ВРЪЗКА!");
            console.log("-----------------------------------");
            
            // Превеждаме данните в човешки вид
            res.data.result.forEach(item => {
                let val = item.value;
                let unit = '';
                
                // Tuya често праща данните умножени по 10 или 1000
                if (item.code.includes('cur_voltage') || item.code === 'va') { 
                    val = val / 10; unit = 'V'; 
                }
                else if (item.code.includes('cur_power') || item.code === 'p') { 
                    val = val / 1; unit = 'W'; // Понякога е /10, ще видим
                }
                else if (item.code.includes('cur_current') || item.code === 'c') { 
                    val = val / 1000; unit = 'A'; 
                }
                
                console.log(`📊 ${item.code}: ${val}${unit} (raw: ${item.value})`);
            });
            console.log("-----------------------------------");
        } else {
            console.log("❌ Грешка при данни:", res.data);
        }

    } catch (e) {
        console.error("❌ Грешка заявка:", e.message);
    }
}

getMeterStatus();