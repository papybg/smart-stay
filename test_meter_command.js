import { controlMeterByAction } from './services/homeassistant.js';

(async () => {
    const res = await controlMeterByAction('on');
    console.log('controlMeterByAction result', res);
})();
