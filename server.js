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

app.get('/', (req, res) => res.send('<h1>Smart Stay Cloud: Ready</h1>'));

app.get('/toggle', async (req, res) => {
  const deviceId = process.env.TUYA_DEVICE_ID;

  if (!process.env.TUYA_ACCESS_ID) {
      return res.send('<h1>Липсва TUYA_ACCESS_ID в Render!</h1>');
  }

  try {
    // 1. Питаме устройството какво е текущото му състояние
    const statusData = await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/status`,
      method: 'GET',
    });

    if (!statusData.success) throw new Error(statusData.msg);

    console.log("Открити функции:", JSON.stringify(statusData.result));

    // 2. Търсим кое е копчето (търсим нещо, което е true/false или съдържа 'switch')
    const switchControl = statusData.result.find(item => 
        (item.code.includes('switch') || item.code === 'switch' || typeof item.value === 'boolean')
    );

    if (!switchControl) {
        return res.send(`<h1>Грешка: Не мога да намеря копче за включване! Виждам само: ${JSON.stringify(statusData.result)}</h1>`);
    }

    const correctCode = switchControl.code; // Ето го истинското име!
    const currentVal = switchControl.value;
    const newVal = !currentVal;

    console.log(`Ще превключим "${correctCode}" от ${currentVal} към ${newVal}`);

    // 3. Изпращаме команда с ПРАВИЛНОТО име
    const commandResult = await tuya.request({
      path: `/v1.0/iot-03/devices/${deviceId}/commands`,
      method: 'POST',
      body: {
        commands: [{ code: correctCode, value: newVal }]
      }
    });

    if (commandResult.success) {
        res.send(`<h1>УСПЕХ! Уредът (${correctCode}) е превключен на ${newVal}.</h1>`);
    } else {
        res.send(`<h1>Tuya върна грешка: ${commandResult.msg}</h1>`);
    }

  } catch (error) {
    console.error(error);
    res.send('<h1>Грешка: ' + error.message + '</h1>');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Server Ready'));
