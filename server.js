const express = require('express');
const TuyaDevice = require('tuyapi');
const app = express();

app.get('/toggle-power', async (req, res) => {
    const device = new TuyaDevice({
        id: process.env.TUYA_DEVICE_ID,
        key: process.env.TUYA_LOCAL_KEY,
        ip: process.env.TUYA_DEVICE_IP
    });
    // Тук ще добавим логиката за превключване
    res.send('Сигналът е изпратен успешно!');
});

app.listen(process.env.PORT || 3000);
