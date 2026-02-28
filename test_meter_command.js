import { controlMeterByAction } from './services/autoremote.js';

(async () => {
    const res = await controlMeterByAction('on');
    console.log('controlMeterByAction result', res);
})();
