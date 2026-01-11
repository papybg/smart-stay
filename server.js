const express = require('express');
const TuyaDevice = require('tuyapi');
const cors = require('cors');
const app = express();

app.use(cors());

app.get('/', (req, res) => res.send('<h1>Сървърът е жив!</h1>'));

app.get('/toggle', async (req, res) => {
    const devId = process.env.TUYA_DEVICE_ID;
    const devKey = process.env.TUYA_ACCESS_SECRET;

    if (!devId || !devKey) {
        return res.send("<h1>Грешка: Липсват ключове!</h1>");
    }

    const device = new TuyaDevice({
        id: devId,
        key: devKey,
        issueRefresh: true
    });

    try {
        // Търсим устройството в облака
        await device.find({timeout: 10});
        await device.connect();
        let status = await device.get();
        await device.set({set: !status});
        device.disconnect();
        res.send('<h1>УСПЕХ! Електромерът превключи.</h1>');
    } catch (error) {
        console.error("Грешка:", error.message);
        res.send("<h1>Ключовете са ОК, но уредът не отговаря.</h1><p>Провери дали е онлайн в Tuya App.</p>");
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Ready'));
