const express = require('express');
const TuyaDevice = require('tuyapi');
const cors = require('cors');
const app = express();

app.use(cors());

// Това ще оправи "Cannot GET /"
app.get('/', (req, res) => {
    res.send('<h1>BGM Design Smart Stay: ONLINE</h1>');
});

// Увери се, че ТУК името е точно такова
app.get('/toggle-power', async (req, res) => {
    console.log("Получена команда за превключване...");
    
    const device = new TuyaDevice({
        id: process.env.TUYA_DEVICE_ID,
        key: process.env.TUYA_ACCESS_SECRET,
        issueRefresh: true
    });

    try {
        await device.find();
        await device.connect();
        let status = await device.get();
        await device.set({set: !status});
        device.disconnect();
        res.send('Успешно превключване!');
    } catch (error) {
        console.error("Грешка:", error.message);
        res.status(500).send('Грешка: ' + error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Сървърът работи на порт ${PORT}`));
