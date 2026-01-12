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

  try {
    // 1. Взимаме статуса на устройството
    const statusData = await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/status`,
      method: 'GET',
    });

    if (!statusData.success) throw new Error(statusData.msg);

    // 2. Намираме ТОЧНИЯ шалтер (switch)
    const switchStatus = statusData.result.find(item => item.code === 'switch');
    
    if (!switchStatus) {
        return res.send('<h1>Грешка: Не намирам команда "switch"!</h1>');
    }

    const currentVal = switchStatus.value;
    const newVal = !currentVal; // Обръщаме: ако е било true става false и обратно

    console.log(`Превключване на тока (switch) към ${newVal}`);

    // 3. Изпращаме команда само към 'switch'
    // ВАЖНО: Този код никога няма да пипне 'switch_prepayment'
    const commandResult = await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/commands`,
      method: 'POST',
      body: {
        commands: [{ code: 'switch', value: newVal }]
      }
    });

    if (commandResult.success) {
        res.send(`<h1>УСПЕХ! Токът е ${newVal ? 'ПУСНАТ' : 'СПРЯН'}.</h1>`);
    } else {
        res.send(`<h1>Грешка: ${commandResult.msg}</h1>`);
    }

  } catch (error) {
    console.error(error);
    res.send('<h1>Грешка: ' + error.message + '</h1>');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Fixed Server Ready'));
