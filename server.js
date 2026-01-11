const express = require('express');
const TuyaDevice = require('tuyapi');
const cors = require('cors');
const app = express();

app.use(cors());

app.get('/', (req, res) => {
    res.send('<h1>BGM Design Smart Stay: ONLINE</h1>');
});

app.get('/toggle', async (req, res) => {
    console.log("Изпращане на команда към Tuya...");
    
    const device = new TuyaDevice({
        id: process.env.TUYA_DEVICE_ID,
        key: process.env.TUYA_ACCESS_SECRET, // Използваме твоя Secret като ключ
        issueRefresh: true
    });

    try {
        await device.find();
        await device.connect();
        let status = await device.get();
        await device.set({set: !status}); // Това реално ЦЪКА релето
        device.disconnect();
        res.send('<h1>Електромерът беше превключен успешно!</h1>');
    } catch (error) {
        console.error("Грешка:", error.message);
        res.status(500).send('Грешка при връзка с уреда: ' + error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server is running`));
