const express = require('express');
const TuyaDevice = require('tuyapi'); // Връщаме правилното име на библиотеката
const cors = require('cors');
const app = express();

app.use(cors());

app.get('/', (req, res) => res.send('<h1>BGM Design: Online</h1>'));

app.get('/toggle', async (req, res) => {
    console.log("Опит за превключване...");
    
    // Проверка за наличие на ключове
    const devId = process.env.TUYA_DEVICE_ID;
    const devKey = process.env.TUYA_ACCESS_SECRET;

    if (!devId || !devKey) {
        return res.send("Грешка: Липсват ключове в Render Environment!");
    }

    const device = new TuyaDevice({
        id: devId,
        key: devKey,
        issueRefresh: true
    });

    try {
        await device.find({timeout: 10}); // Търси устройството за 10 секунди
        await device.connect();
        let status = await device.get();
        await device.set({set: !status});
        device.disconnect();
        res.send('<h1>Успех! Електромерът превключи.</h1>');
    } catch (error) {
        console.error("Детайли на грешката:", error.message);
        res.send("Връзката е направена, но устройството не отговаря. Проверете дали е онлайн в Tuya App.");
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Сървърът е готов!'));
