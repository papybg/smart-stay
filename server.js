import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs';
import nodemailer from 'nodemailer';
import { syncBookingsFromGmail } from './services/detective.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import { TuyaContext } from '@tuya/tuya-connector-nodejs';

// --- НАСТРОЙКИ ---
const app = express();
const PORT = process.env.PORT || 10000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- 1. НАСТРОЙКА НА ПОЩА ---
const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

async function sendNotification(subject, text) {
    try {
        await mailer.sendMail({
            from: `"Smart Stay Bot" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `⚡ ${subject}`,
            text: text
        });
        console.log(`📧 Изпратен имейл: ${subject}`);
    } catch (e) { console.error("Mail Error:", e.message); }
}

// --- 2. ЗАРЕЖДАНЕ НА НАРЪЧНИКА ---
let manualContent = "Липсва файл manual.txt.";
try {
    if (fs.existsSync('manual.txt')) {
        manualContent = fs.readFileSync('manual.txt', 'utf8');
    }
} catch (err) { console.error(err); }

// --- 3. TUYA ВРЪЗКА ---
const tuya = new TuyaContext({
    baseUrl: 'https://openapi.tuyaeu.com',
    accessKey: process.env.TUYA_ACCESS_ID,
    secretKey: process.env.TUYA_ACCESS_SECRET,
});

async function controlDevice(state) {
    try {
        await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/commands`,
            body: { commands: [{ code: 'switch', value: state }] }
        });
        return true;
    } catch (e) { console.error('Tuya Error:', e.message); return false; }
}

async function getTuyaStatus() {
    try {
        const res = await tuya.request({ method: 'GET', path: `/v1.0/iot-03/devices/${process.env.TUYA_DEVICE_ID}/status` });
        return res.result.find(s => s.code === 'switch');
    } catch (e) { return null; }
}

// --- ФУНКЦИЯ ЗА ПАРОЛИ (3 МЕТОДА) ---
async function createLockPin(pin, name, checkInDate, checkOutDate) {
    console.log(`🛠️ Старт на процедура с 3 метода за ${name}...`);
    
    // Времена в секунди (Unix)
    const startSec = Math.floor((new Date(checkInDate).getTime() - 5 * 60000) / 1000);
    const endSec = Math.floor(new Date(checkOutDate).getTime() / 1000);
    
    // Времена в милисекунди (за някои endpoints)
    const startMs = new Date(checkInDate).getTime() - 5 * 60000;
    const endMs = new Date(checkOutDate).getTime();

    let report = [];
    let success = false;

    // МЕТОД 1: Smart Lock Online (Gateway)
    try {
        await tuya.request({
            method: 'POST',
            path: `/v1.0/smart-lock/devices/${process.env.LOCK_DEVICE_ID}/password/temp`,
            body: { name, password: pin.toString(), effective_time: startSec, invalid_time: endSec, type: 2 }
        });
        report.push("✅ Метод 1 (Online): УСПЕХ");
        success = true;
    } catch (e) { report.push(`❌ Метод 1 (Online): Грешка (${e.message})`); }

    // МЕТОД 2: Bluetooth Ticket (За G30)
    try {
        await tuya.request({
            method: 'POST',
            path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}/door-lock/temp-password`,
            body: { name, password: pin.toString(), start_time: startMs, expire_time: endMs, password_type: "ticket" }
        });
        report.push("✅ Метод 2 (Ticket): УСПЕХ");
        success = true;
    } catch (e) { report.push(`❌ Метод 2 (Ticket): Грешка (${e.message})`); }

    // МЕТОД 3: Offline Algorithm (Резервен)
    try {
        // Опитваме създаване на офлайн парола (понякога иска друг път)
        await tuya.request({
            method: 'POST',
            path: `/v1.0/devices/${process.env.LOCK_DEVICE_ID}/door-lock/temp-password`,
            body: { name, password: pin.toString(), start_time: startMs, expire_time: endMs, password_type: "offline" }
        });
        report.push("✅ Метод 3 (Offline): УСПЕХ");
        success = true;
    } catch (e) { report.push(`❌ Метод 3 (Offline): Грешка (${e.message})`); }

    console.log("📝 Доклад:", report);
    return { success, report };
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- 4. АВТОПИЛОТ (CRON) ---
cron.schedule('*/1 * * * *', async () => {
    try {
        const bookings = await sql`SELECT * FROM bookings`;
        const currentStatus = await getTuyaStatus();
        const isDeviceOn = currentStatus ? currentStatus.value : false;
        const now = new Date();

        for (const b of bookings) {