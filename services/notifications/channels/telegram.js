import axios from 'axios';

export async function sendTelegram({ token, chatId, text }) {
    if (!token || !chatId) {
        throw new Error('Telegram credentials are missing');
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await axios.post(url, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    }, {
        timeout: 10000
    });

    if (!response?.data?.ok) {
        throw new Error(response?.data?.description || 'Telegram send failed');
    }

    return response.data;
}
