const express = require('express');
const cors = require('cors');
const TuyaCloud = require('tuyapi'); // Ще ползваме облачния метод
const app = express();

app.use(cors());

app.get('/', (req, res) => res.send('<h1>BGM Design: Online</h1>'));

app.get('/toggle', async (req, res) => {
    console.log("Опит за облачно превключване...");
    
    // Проверка дали ключовете съществуват
    if (!process.env.TUYA_DEVICE_ID || !process.env.TUYA_ACCESS_SECRET) {
        return res.status(500).send("Липсват ключове в Environment Variables!");
    }

    const device = new TuyaCloud({
        id: process.env.TUYA_DEVICE_ID,
        key: process.env.TUYA_ACCESS_SECRET,
        version: '3.3',
        issueRefresh: true
    });

    try {
        // Директна команда без търсене на IP
        await device.find(); 
        await device.connect();
        let status = await device.get();
        await device.set({set: !status});
        device.disconnect();
        res.send('Успех!');
    } catch (error) {
        console.error("Грешка:", error.message);
        res.status(500).send("Грешка при връзка: " + error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Server is running'));
