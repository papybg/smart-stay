import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { syncBookingsFromGmail } from './services/detective.js';

const app = express();
const PORT = process.env.PORT || 10000;

// --- Middleware Configuration ---

// 1. CORS: Whitelist specific domains for better security.
const allowedOrigins = [
  'https://stay.bgm-design.com', // As mentioned in your original code comment
  // Add other domains or localhost ports for development if needed
  // e.g., 'http://localhost:5500', 'http://127.0.0.1:5500'
];

app.use(cors({ origin: allowedOrigins }));

// 2. Body Parser: To handle JSON payloads in POST requests.
app.use(express.json());

// 3. Static Files: Serve all frontend files from the 'public' directory.
// This correctly handles requests for '/', '/index.html', '/admin.html', etc.
app.use(express.static('public'));


// --- API Routes ---

// API for the chat functionality
app.post('/chat', async (req, res) => {
  // Your chat logic here...
  res.json({ reply: "Здравейте! Аз съм Бобо." });
});


// --- Server Startup ---

app.listen(PORT, () => {
  console.log(`🚀 Bobo is live on port ${PORT}!`);
  
  // Start the Gmail sync process on startup and then schedule it
  console.log('Starting initial Gmail sync...');
  syncBookingsFromGmail();
  setInterval(syncBookingsFromGmail, 15 * 60 * 1000); // Every 15 minutes
});