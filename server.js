const express = require('express');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const cors = require('cors');
const app = express();

app.use(cors());

const tuya = new TuyaContext({
  baseUrl: 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_ACCESS_SECRET,
});

app.get('/', (req, res) => res.send('<h1>Smart Stay: Ready</h1>'));

app.get('/toggle', async (req, res) => {
  const deviceId = process.env.TUYA_DEVICE_ID;

  if (!process.env.TUYA_ACCESS_ID) return res.send('<h1>Липсва Access ID!</h1>');

  try {
    // 1. Взимаме статуса
    const statusData = await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/status`,
      method: 'GET',
    });

    if (!statusData.success) throw new Error(statusData.msg);

    const allFunctions = statusData.result;
    console.log("Всички функции:", JSON.stringify(allFunctions));

    // 2. Търсим КОНКРЕТНО шалтера за тока (приоритет на switch_1)
    let mainSwitch = allFunctions.find(item => item.code === 'switch_1');
    
    // Ако няма switch_1, търсим просто switch (без 1)
    if (!mainSwitch) {
        mainSwitch = allFunctions.find(item => item.code === 'switch');
    }

    // Ако пак не го намираме, показваме списъка на екрана, за да го видим
    if (!mainSwitch) {
        return res.send(`
            <h1>Не намирам главен ключ!</h1>
            <p>Ето какво има в това устройство (копирай ми това):</p>
            <pre>${JSON.stringify(allFunctions, null, 2)}</pre>
        `);
    }

    // 3. Ако сме го намерили - ДЕЙСТВАМЕ!
    const correctCode = mainSwitch.code;
    const currentVal = mainSwitch.value;
    const newVal = !currentVal; // Обръщаме стойността

    const commandResult = await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/commands`,
      method: 'POST',
      body: {
        commands: [{ code: correctCode, value: newVal }]
      }
    });

    if (commandResult.success) {
        res.send(`<h1>ЦЪК! Успешно превключихме ${correctCode} на ${newVal}.</h1>`);
    } else {
        res.send(`<h1>Грешка при командата: ${commandResult.msg}</h1>`);
    }

  } catch (error) {
    console.error(error);
    res.send('<h1>Грешка: ' + error.message + '</h1>');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Server Ready'));
