import axios from 'axios';

export function registerAuthRoutes(app, {
    getAIResponse,
    generateToken,
    invalidateToken,
    sessionDuration
}) {
    app.post('/api/login', async (req, res) => {
        try {
            const { password } = req.body;
            if (!password || !password.trim()) {
                return res.status(400).json({ error: 'Паролата е задължителна' });
            }

            const HOST_CODE = process.env.HOST_CODE || '';
            const normalizedPassword = password.trim().toLowerCase();
            const normalizedHostCode = HOST_CODE.trim().toLowerCase();

            if (normalizedPassword !== normalizedHostCode && !normalizedPassword.includes(normalizedHostCode)) {
                console.log('[LOGIN] ❌ Невалидна парола');
                return res.status(401).json({ error: 'Невалидна парола' });
            }

            const token = generateToken('host');
            const expiresIn = Math.floor(sessionDuration / 1000);
            console.log('[LOGIN] ✅ Успешна аутентификация за host');

            return res.json({
                success: true,
                token,
                expiresIn,
                role: 'host',
                message: 'Разбрах! Влезте успешно.'
            });
        } catch (error) {
            console.error('[LOGIN] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: 'Грешка при вход' });
        }
    });

    app.post('/api/logout', (req, res) => {
        try {
            const { token } = req.body;
            if (invalidateToken(token)) {
                console.log('[LOGOUT] ✅ Излязъл успешно, token изтрит');
            }
            return res.json({ success: true });
        } catch (error) {
            console.error('[LOGOUT] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: 'Грешка при изход' });
        }
    });

    app.post('/api/chat', async (req, res) => {
        try {
            const { message, history = [], token, authCode } = req.body;
            if (!message?.trim()) {
                return res.status(400).json({ error: 'Съобщението е празно' });
            }

            const authToken = token || authCode;
            console.log('[CHAT] 🤖 Викам AI асистент...');

            const aiResponse = await getAIResponse(message, history, authToken);
            return res.json({ response: aiResponse });
        } catch (error) {
            console.error('[CHAT] 🔴 Грешка:', error.message);
            return res.status(500).json({ error: 'AI грешка' });
        }
    });
}

/**
 * 🔧 SmartThings OAuth2 Callback Handler
 * Слуша на GET /callback, размена authorization code за tokens
 */
export function registerSmartThingsCallbackRoute(app) {
    app.get('/callback', async (req, res) => {
        try {
            const { code, state } = req.query;
            const expectedState = (process.env.ST_OAUTH_STATE || '').trim();

            // Валидиране на параметри
            if (!code) {
                console.error('[ST-CALLBACK] ❌ Отсъства code от SmartThings');
                return res.status(400).send(`
                    <h1>❌ OAuth Грешка</h1>
                    <p>Отсъства authorization code. Моля, опитайте отново от SmartThings.</p>
                `);
            }

            if (expectedState && String(state || '').trim() !== expectedState) {
                console.error('[ST-CALLBACK] ❌ Невалиден state параметър');
                return res.status(403).send(`
                    <h1>❌ OAuth State Грешка</h1>
                    <p>Невалиден state параметър. Прекъсване за сигурност.</p>
                `);
            }

            // Проверка на необходими env променливи
            const { ST_CLIENT_ID, ST_CLIENT_SECRET } = process.env;
            if (!ST_CLIENT_ID || !ST_CLIENT_SECRET) {
                console.error('[ST-CALLBACK] ❌ Липсват ST_CLIENT_ID или ST_CLIENT_SECRET в env');
                return res.status(500).send(`
                    <h1>⚙️ Конфигурационна Грешка</h1>
                    <p>Сървърът не е конфигуриран със SmartThings OAuth credentials.</p>
                `);
            }

            // Подробно логване на параметрите за token exchange
            const redirectUri = `${process.env.APP_BASE_URL || 'https://smart-stay.onrender.com'}/callback`;
            console.log('[ST-CALLBACK] Token exchange params:', {
                grant_type: 'authorization_code',
                client_id: ST_CLIENT_ID,
                client_secret: ST_CLIENT_SECRET ? '***' : undefined,
                code,
                redirect_uri: redirectUri
            });

            let tokenResponse;
            try {
                // Basic Auth header
                const basicAuth = Buffer.from(`${ST_CLIENT_ID}:${ST_CLIENT_SECRET}`).toString('base64');
                const params = new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri
                });
                tokenResponse = await axios.post('https://api.smartthings.com/oauth/token', 
                    params.toString(),
                    {
                        headers: {
                            'Authorization': 'Basic ' + basicAuth,
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        timeout: 10000
                    }
                );

                if (!tokenResponse.data?.access_token || !tokenResponse.data?.refresh_token) {
                    console.error('[ST-CALLBACK] ❌ SmartThings не върна tokens:', tokenResponse.data);
                    return res.status(400).send(`
                        <h1>❌ OAuth Token Грешка</h1>
                        <p>SmartThings не върна валидни токени.</p>
                    `);
                }
                // ...existing code for success (всички използвания на tokenResponse трябва да са тук)...
            } catch (error) {
                if (error.response) {
                    console.error('[ST-CALLBACK] ❌ Token exchange failed:', {
                        status: error.response.status,
                        headers: error.response.headers,
                        data: error.response.data
                    });
                } else {
                    console.error('[ST-CALLBACK] ❌ Token exchange error:', error.message);
                }
                return res.status(400).send(`
                    <h1>❌ Грешка при Размена</h1>
                    <p>SmartThings не върна валидни tokens. Проверете логовете на сървъра.</p>
                `);
            }

            const accessToken = tokenResponse.data.access_token;
            const refreshToken = tokenResponse.data.refresh_token;

            console.log('[ST-CALLBACK] ✅ Токени получени успешно');

            // ⚠️ ВАЖНО: Безопасна персистиране на tokens
            // Вариант 1: Излез в console за копиране в .env (ВРЕМЕННО за dev/test)
            console.log('\n');
            console.log('╔════════════════════════════════════════════════════════════╗');
            console.log('║ 📋 КОПИРАЙ ТЕЗИ СТОЙНОСТИ В ТВОЯ .env ФАЙЛ:               ║');
            console.log('╚════════════════════════════════════════════════════════════╝');
            console.log(`ST_ACCESS_TOKEN=${accessToken.slice(0, 12)}...`);
            console.log(`ST_REFRESH_TOKEN=${refreshToken.slice(0, 12)}...`);
            console.log('');

            // Вариант 2: Праву се потребител да го направи вручно (по-безопасно)
            // В реален сценарий, можеш да запазиш в DB или секретен store
            // await saveSmartThingsTokensToDB(accessToken, refreshToken);

            // Успешен отговор
            return res.send(`
                <!DOCTYPE html>
                <html lang="bg">
                <head>
                    <meta charset="UTF-8">
                    <style>
                        body { font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 40px; background: #f5f5f5; }
                        .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                        h1 { color: #27ae60; }
                        .success-box { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 15px; border-radius: 4px; margin: 20px 0; }
                        code { background: #f4f4f4; padding: 8px 12px; border-radius: 4px; font-size: 14px; display: block; margin: 10px 0; word-break: break-all; }
                        .step { text-align: left; margin: 15px 0; }
                        .step-num { background: #27ae60; color: white; border-radius: 50%; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; margin-right: 10px; font-weight: bold; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>✅ OAuth2 Проверка Завършена!</h1>
                        
                        <div class="success-box">
                            <p><strong>Токените са получени успешно от SmartThings.</strong></p>
                        </div>

                        <div style="text-align: left; background: #f9f9f9; padding: 20px; border-radius: 4px;">
                            <h3>📋 Следващи стъпки:</h3>
                            
                            <div class="step">
                                <span class="step-num">1</span>
                                <strong>Копирай токините от логовете на сървъра:</strong>
                                <code>ST_ACCESS_TOKEN=...</code>
                                <code>ST_REFRESH_TOKEN=...</code>
                            </div>

                            <div class="step">
                                <span class="step-num">2</span>
                                <strong>Добави ги в твоя .env файл (заедно с ST_CLIENT_ID и ST_CLIENT_SECRET):</strong>
                                <code>ST_CLIENT_ID=ххх</code>
                                <code>ST_CLIENT_SECRET=ххх</code>
                                <code>ST_ACCESS_TOKEN=${accessToken.slice(0, 30)}...</code>
                                <code>ST_REFRESH_TOKEN=${refreshToken.slice(0, 30)}...</code>
                            </div>

                            <div class="step">
                                <span class="step-num">3</span>
                                <strong>Рестартирай приложението в Render</strong>
                            </div>
                        </div>

                        <p style="margin-top: 30px; color: #666;">
                            Системата е готова да управлява SmartThings устройства! 🎉
                        </p>
                    </div>
                </body>
                </html>
            `);
        } catch (error) {
            console.error('[ST-CALLBACK] 🔴 Грешка при callback:', error.message);
            return res.status(500).send(`
                <h1>❌ Грешка!</h1>
                <p>${error.message}</p>
                <p><a href="/">Назад</a></p>
            `);
        }
    });
}
