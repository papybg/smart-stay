const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());

app.get('/', (req, res) => res.send('<h1>Сървърът е жив!</h1>'));

app.get('/toggle', (req, res) => {
    const devId = process.env.TUYA_DEVICE_ID;
    const devKey = process.env.TUYA_ACCESS_SECRET;

    if (!devId || !devKey) {
        return res.send("<h1>СТОП! Трябва да добавиш ключовете в Render Environment!</h1>");
    }
    
    res.send("<h1>Ключовете са намерени! Сега можем да свържем Tuya.</h1>");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Ready'));
