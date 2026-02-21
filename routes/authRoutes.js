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
