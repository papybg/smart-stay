const express = require('express');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const cors = require('cors');
const app = express();

app.use(cors());

// Настройки за връзка с облака
const tuya = new TuyaContext({
  baseUrl: 'https://openapi.tuyaeu.com', // Сървър за Европа
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_ACCESS_SECRET,
});

app.get('/', (req, res) => res.send('<h1>BGM Design: Cloud Engine Online</h1>'));

app.get('/toggle', async (req, res) => {
  const deviceId = process.env.TUYA_DEVICE_ID;

  if (!process.env.TUYA_ACCESS_ID || !process.env.TUYA_ACCESS_SECRET) {
      return res.send('<h1>Грешка: Липсват ключове в Render!</h1>');
  }

  try {
    console.log("Питаме облака за статус...");
    // 1. Взимаме текущия статус
    const statusData = await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/status`,
      method: 'GET',
    });

    if (!statusData.success) throw new Error(statusData.msg);

    // Намираме дали ключът е включен (кодът обикновено е 'switch_1')
    const switchStatus = statusData.result.find(item => item.code === 'switch_1');
    const currentVal = switchStatus ? switchStatus.value : false;
    const newVal = !currentVal;

    console.log(`Превключване от ${currentVal} към ${newVal}`);

    // 2. Изпращаме команда за превключване
    const commandResult = await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/commands`,
      method: 'POST',
      body: {
        commands: [{ code: 'switch_1', value: newVal }]
      }
    });

    if (commandResult.success) {
        res.send(`<h1>УСПЕХ! Токът е ${newVal ? 'ПУСНАТ' : 'СПРЯН'}.</h1>`);
    } else {
        res.send('<h1>Грешка при командата: ' + commandResult.msg + '</h1>');
    }

  } catch (error) {
    console.error(error);
    res.send('<h1>Грешка: ' + error.message + '</h1>');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Cloud Server Ready'));
