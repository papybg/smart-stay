const express = require('express');
const TuyaDevice = require('tuyapi');
const cors = require('cors');
const app = express();

app.use(cors());

// Начална страница
app.get('/', (req, res) => {
    res.send('<h1>BGM Design Smart Stay: ONLINE</h1><p>Опитайте /toggle</p>');
});

// Промених името на по-кратко за тест
app.get('/toggle', async (req, res) => {
    console.log(">>> Сигналът е приет от сървъра!");
    
    const device = new TuyaDevice({
        id: process.env.TUYA_DEVICE_ID,
        key: process.env.TUYA_ACCESS_SECRET,
        issueRefresh: true
    });

    try {
        // Засега само ще връщаме потвърждение, за да сме сигурни, че пътят работи
        res.send('<h1>Сървърът чу командата!</h1>');
    } catch (error) {
        res.status(500).send('Грешка: ' + error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server is running`));
