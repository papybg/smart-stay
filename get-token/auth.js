const { google } = require('googleapis');
const readline = require('readline');

// 👇 КОПИРАЙ ТВОИТЕ КОДОВЕ ТУК 👇
const CLIENT_ID = '107361259414-l4cr2ub6f4nh8ihnvo86u75pvhanp705.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

// Това не го пипай
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // ВАЖНО: За да получим Refresh Token
  scope: ['https://www.googleapis.com/auth/gmail.readonly'], // Само за четене
});

console.log('------------------------------------------------');
console.log('1. Копирай този линк и го отвори в браузъра:');
console.log('\n', authUrl, '\n');
console.log('------------------------------------------------');
console.log('2. Разреши достъпа (ако пита, че е опасно -> Advanced -> Go to Bobo App).');
console.log('3. Ще получиш код. Копирай го.');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('4. Постави кода тук и натисни Enter: ', async (code) => {
  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n✅ УСПЕХ! ЕТО ГО ТВОЯ REFRESH TOKEN (Запиши си го!):');
    console.log('------------------------------------------------');
    console.log(tokens.refresh_token);
    console.log('------------------------------------------------');
  } catch (error) {
    console.error('❌ Грешка:', error.message);
  }
  process.exit();
});