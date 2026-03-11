/**
 * config.js — Всички константи, env vars и глобални инстанции за AI системата.
 * НЕ импортира от другите ai/ модули.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';

// ── Gemini модели ──────────────────────────────────────────────────────────
export const MODELS = [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3-pro-preview"
];
export const MODEL_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_MODEL_TIMEOUT_MS || 12000);
export const MODEL_COOLDOWN_MS = Number(process.env.GEMINI_MODEL_COOLDOWN_MS || 60000);
/** Mutable Map — споделено между config и gemini модулите */
export const modelCooldownUntil = new Map();

// ── Groq Router ────────────────────────────────────────────────────────────
export const GROQ_ROUTER_ENABLED = (process.env.GROQ_ROUTER_ENABLED || 'true').toLowerCase() !== 'false';
export const GROQ_API_KEY = process.env.GROQ_API_KEY || null;
export const GROQ_API_URL = (process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
export const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
export const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 8000);
export const GROQ_DELEGATE_TOKEN = '[[DELEGATE_TO_GEMINI]]';

// ── Backup LLM ─────────────────────────────────────────────────────────────
export const BACKUP_API_KEY = process.env.BACKUP_API_KEY || null;
export const BACKUP_API_URL = (process.env.BACKUP_API_URL || '').replace(/\/$/, '');
export const BACKUP_MODEL = process.env.BACKUP_MODEL || '';
export const BACKUP_TIMEOUT_MS = Number(process.env.BACKUP_TIMEOUT_MS || 15000);

// ── Достъп / Времеви прозорец ──────────────────────────────────────────────
export const ACCESS_START_BEFORE_CHECKIN_HOURS = Number(process.env.ACCESS_START_BEFORE_CHECKIN_HOURS || 2);
export const ACCESS_END_AFTER_CHECKOUT_HOURS = Number(process.env.ACCESS_END_AFTER_CHECKOUT_HOURS || 1);

// ── Google Places ──────────────────────────────────────────────────────────
export const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || null;
export const GOOGLE_PLACES_MAX_RESULTS = Number(process.env.GOOGLE_PLACES_MAX_RESULTS || 3);
export const GOOGLE_PLACES_STRICT_MODE = (process.env.GOOGLE_PLACES_STRICT_MODE || 'false').toLowerCase() !== 'false';
export const GOOGLE_PLACES_TIMEOUT_MS = Number(process.env.GOOGLE_PLACES_TIMEOUT_MS || 5000);
export const GOOGLE_PLACES_BLOCK_COOLDOWN_MS = Number(process.env.GOOGLE_PLACES_BLOCK_COOLDOWN_MS || 3600000);

// ── Google Directions ──────────────────────────────────────────────────────
export const GOOGLE_DIRECTIONS_API_KEY = process.env.GOOGLE_DIRECTIONS_API_KEY || GOOGLE_PLACES_API_KEY;
export const GOOGLE_DIRECTIONS_TIMEOUT_MS = Number(process.env.GOOGLE_DIRECTIONS_TIMEOUT_MS || 6000);
export const GOOGLE_DIRECTIONS_DEFAULT_ORIGIN = process.env.GOOGLE_DIRECTIONS_DEFAULT_ORIGIN || 'Aspen Valley Golf, Ski and Spa Resort, Razlog';

// ── Brave Search ───────────────────────────────────────────────────────────
export const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || null;
export const BRAVE_SEARCH_TIMEOUT_MS = Number(process.env.BRAVE_SEARCH_TIMEOUT_MS || 6000);
export const BRAVE_SEARCH_MONTHLY_QUOTA = Number(process.env.BRAVE_SEARCH_MONTHLY_QUOTA || 1000);
export const BRAVE_SEARCH_WARNING_LEVELS = [70, 85, 95];

// ── Сигурност ──────────────────────────────────────────────────────────────
export const HOST_CODE = process.env.HOST_CODE;

// ── Клиенти (инстанции) ────────────────────────────────────────────────────
export const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
export const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
export const AUTOMATION_URL = process.env.AUTOMATION_SERVICE_URL || 'http://localhost:10000';

// ── Публичен fallback текст (за непознати) ─────────────────────────────────
export const PUBLIC_INFO_FALLBACK = `
🏠 ASPEN VALLEY - АПАРТАМЕНТ D106

🔑 РЕЗЕРВАЦИЯ:
- За регистрирани гости: въведете вашия код на резервация
- За нови резервации: посетете нашия уебсайт

⚠️ ВАЖНО:
- Паролите и кодовете не се дават на непознати
- За достъп до услуги е необходима регистрирана резервация
`;
