const express = require('express');
const TuyaDevice = require('tuyapi');
const cors = require('cors');
const app = express();

app.use(cors());

app.get('/', (req, res) => res.send('<h1>BGM Design: Сървърът е онлайн!</h1>'));

app.get('/toggle', async (req, res) => {
    console.log("Старт на командата...");
    
    const device = new TuyaDevice({
        id: process.env.TUYA_DEVICE_ID,
        key: process.env.TUYA_ACCESS_SECRET,
        issueRefresh: true
    });

    try {
        // Поставяме кратък таймаут, за да не увисва сървърът
        await device.find({timeout: 5}); 
        await device.connect();
        
        const status = await device.get();
        await device.set({set: !status});
        
        device.disconnect();
        res.send('<h1>УСПЕХ! Електромерът превключи.</h1>');
    } catch (error) {
        console.log("Грешка при връзка:", error.message);
        // Вместо да убиваме сървъра, връщаме приятелско съобщение
        res.send(`<h1>Сървърът работи, но уредът не отговаря.</h1><p>Грешка: ${error.message}</p>`);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Сървърът е готов на порт ' + PORT));
