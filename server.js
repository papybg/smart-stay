const express = require('express');
const TuyaDevice = require('tuyapi');
const app = express();

// Позволява на сайта ти да говори със сървъра
const cors = require('cors');
app.use(cors());

app.get('/toggle-power', async (req, res) => {
    const device = new TuyaDevice({
        id: process.env.TUYA_DEVICE_ID,
        key: process.env.TUYA_ACCESS_SECRET, // Тук ползваме твоя Secret
        issueRefresh: true
    });

    try {
        await device.find();
        await device.connect();
        let status = await device.get();
        await device.set({set: !status}); // Обръща статуса (ако е вкл -> изкл)
        device.disconnect();
        res.send('Командата е изпълнена успешно!');
    } catch (error) {
        res.status(500).send('Грешка при връзка с Tuya: ' + error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
