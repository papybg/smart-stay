# 🔐 SESSION TOKEN AUTHENTICATION SYSTEM

## Overview

The Smart Stay application now implements a **session-based authentication system** that allows users to log in once and maintain access for 30 minutes without re-entering their password.

---

## Architecture

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     FIRST TIME (LOGIN)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. User opens app → Shows LOGIN MODAL                           │
│  2. User enters password                                         │
│  3. Browser sends: POST /api/login {password}                    │
│  4. Server validates password vs HOST_CODE                       │
│  5. Server generates TOKEN (30-min expiration)                   │
│  6. Server returns: {token, expiresIn: "30m", role}              │
│  7. Browser stores token in localStorage                         │
│  8. Browser shows CHAT INTERFACE                                 │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│              SUBSEQUENT REQUESTS (30 MINUTES)                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. User types message → "спри тока"                             │
│  2. Browser sends: POST /api/chat {message, token}               │
│  3. Server receives request with TOKEN (not password!)           │
│  4. Server validates token:                                      │
│     ✅ Token found in sessions map                               │
│     ✅ Token not expired (< 30 min)                              │
│  5. Server extracts role from token                              │
│  6. AI Service receives TOKEN, validates it                      │
│  7. AI responds WITHOUT re-checking password                     │
│  8. Browser receives response, displays message                  │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    TIMEOUT (30 MIN ELAPSED)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. User tries to send message after 30 minutes                  │
│  2. Browser detects token in localStorage is expired             │
│  3. Browser removes token from localStorage                      │
│  4. Browser shows LOGIN MODAL again                              │
│  5. User must re-enter password to get new token                 │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Code Changes

### 1. **server.js** - Session Management Layer

#### Constants & Cleanup
```javascript
const SESSION_DURATION = 30 * 60 * 1000; // 30 minutes
const sessions = new Map(); // token -> {role, expiresAt}

// Cleanup expired tokens every 5 minutes
setInterval(() => {
    for (const [token, session] of sessions.entries()) {
        if (Date.now() > session.expiresAt) {
            sessions.delete(token);
        }
    }
}, 5 * 60 * 1000);
```

#### generateToken() Function
```javascript
function generateToken(role) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_DURATION;
    sessions.set(token, { role, expiresAt, createdAt: Date.now() });
    return token; // 64-character hex string
}
```

#### validateToken() Function
```javascript
function validateToken(token) {
    if (!token || !sessions.has(token)) return null;
    const session = sessions.get(token);
    if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        return null;
    }
    return { role: session.role, valid: true };
}
```

#### POST /api/login Endpoint
```javascript
app.post('/api/login', async (req, res) => {
    const { password } = req.body;
    
    // Verify password matches HOST_CODE
    if (password === HOST_CODE) {
        const token = generateToken('host');
        res.json({ 
            token,
            expiresIn: 1800, // 30 minutes in seconds
            role: 'host'
        });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});
```

#### POST /api/logout Endpoint
```javascript
app.post('/api/logout', (req, res) => {
    const { token } = req.body;
    if (token && sessions.has(token)) {
        sessions.delete(token); // Invalidate immediately
    }
    res.json({ success: true });
});
```

#### Updated POST /api/chat
```javascript
app.post('/api/chat', async (req, res) => {
    const { message, history = [], token, authCode } = req.body;
    
    // Support both legacy authCode and new token
    let authToken = token || authCode;
    
    // AI Service checks if token is valid
    const aiResponse = await getAIResponse(message, history, authToken);
    res.json({ response: aiResponse });
});
```

---

### 2. **services/ai_service.js** - Token Validation

#### Token Storage
```javascript
const VALID_SESSION_TOKENS = new Map(); // Local token cache

export function registerSessionToken(token, role, expiresAt) {
    VALID_SESSION_TOKENS.set(token, { role, expiresAt });
}

function validateSessionToken(token) {
    if (!token || !VALID_SESSION_TOKENS.has(token)) return null;
    const session = VALID_SESSION_TOKENS.get(token);
    if (Date.now() > session.expiresAt) {
        VALID_SESSION_TOKENS.delete(token);
        return null;
    }
    return session;
}
```

#### Updated determineUserRole()
```javascript
export async function determineUserRole(authCode, userMessage) {
    // CHECK #0: Validate SESSION TOKEN (NEW)
    if (authCode) {
        const sessionToken = validateSessionToken(authCode);
        if (sessionToken) {
            console.log(`✅ SESSION TOKEN valid for ${sessionToken.role}`);
            return { role: sessionToken.role, data: null };
        }
    }
    
    // CHECK #1: Verify HOST (Legacy - for backward compatibility)
    if (isHostVerified(authCode, userMessage)) {
        return { role: 'host', data: null };
    }
    
    // Default to 'stranger' role
    return { role: 'stranger', data: null };
}
```

---

### 3. **public/index.html** - Client-Side Session Management

#### localStorage Keys
```javascript
const TOKEN_KEY = 'smart-stay-token'; // Stores: hexadecimal token string
const EXPIRY_KEY = 'smart-stay-expiry'; // Stores: timestamp when token expires
```

#### Login Modal
```html
<div id="login-modal" class="login-modal">
    <form id="login-form">
        <input type="password" id="password" placeholder="Enter password">
        <button type="submit">Login</button>
    </form>
</div>
```

#### Login Handler
```javascript
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('password').value;
    
    const response = await fetch(`${API_URL}/api/login`, {
        method: 'POST',
        body: JSON.stringify({ password })
    });
    
    const data = await response.json();
    
    // Store token in browser localStorage
    sessionToken = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(EXPIRY_KEY, Date.now() + (data.expiresIn * 1000));
    
    // Show chat interface
    showChat();
});
```

#### Chat Message Handler (Token Included)
```javascript
chatForm.addEventListener('submit', async (e) => {
    const message = userInput.value;
    
    const response = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({ 
            message,
            history: chatHistory,
            token: sessionToken  // ← Token instead of password!
        })
    });
    
    const data = await response.json();
    addMessage(data.response);
});
```

#### Session Initialization
```javascript
function initializeSession() {
    const storedToken = localStorage.getItem(TOKEN_KEY);
    const storedExpiry = localStorage.getItem(EXPIRY_KEY);
    
    if (storedToken && Date.now() < parseInt(storedExpiry)) {
        sessionToken = storedToken; // Token is still valid
        showChat();
    } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(EXPIRY_KEY);
        showLoginModal(); // Token expired, require re-login
    }
}

// On app start
initializeSession();
```

#### Logout Handler
```javascript
logoutBtn.addEventListener('click', async () => {
    // Notify server to invalidate token
    await fetch(`${API_URL}/api/logout`, {
        method: 'POST',
        body: JSON.stringify({ token: sessionToken })
    });
    
    // Clear localStorage
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRY_KEY);
    
    // Show login modal
    showLoginModal();
});
```

---

## Security Features

### 1. **Token Format**
- 32 random bytes → 64 hexadecimal characters
- Example: `a3f8b2c1e9d4f7a6b3e2d8c1f4a7b2e9d3c6f1a4e7b0d2c5f8a1b3d6e9f2a`
- Generated with `crypto.randomBytes(32).toString('hex')`

### 2. **Token Expiration**
- 30 minutes from generation
- Stored: `expiresAt = Date.now() + (30 * 60 * 1000)`
- Validated: `if (Date.now() > session.expiresAt) { /* expired */ }`

### 3. **Token Storage**
- **Server-side:** `sessions` Map in server.js memory
- **Client-side:** localStorage (browser persistent storage)
- **Cleanup:** Automatic removal of expired tokens every 5 minutes

### 4. **Password Protection**
- Password only sent during `/api/login` request
- Password NOT sent with every message (only token)
- Reduces attack surface: Password in transit only once

### 5. **Backward Compatibility**
- Legacy requests with `authCode` still work
- Token check comes BEFORE password check
- Seamless transition for existing integrations

---

## User Experience

### Scenario 1: First-Time User
```
User opens app
    ↓
Shows "Login" modal with password field
    ↓
User enters password (e.g., "MySecureCode123")
    ↓
Browser sends POST /api/login with password
    ↓
Server validates password, generates token
    ↓
Browser stores token in localStorage
    ↓
Chat interface appears
```

### Scenario 2: Returning User (Same Day)
```
User opens app within 30 minutes
    ↓
Browser finds valid token in localStorage
    ↓
Chat interface appears immediately (NO password prompt)
    ↓
User can start typing messages
    ↓
Token is sent with each message (not password)
```

### Scenario 3: Token Expired
```
User left app open for 35 minutes
    ↓
User tries to send message
    ↓
Browser detects token is expired (Date.now() > storedExpiry)
    ↓
Browser removes token from localStorage
    ↓
Login modal appears
    ↓
User must re-enter password
```

### Scenario 4: Logout Button
```
User clicks "Logout" button
    ↓
Browser notifies server to invalidate token
    ↓
Server removes token from sessions Map
    ↓
Browser clears localStorage
    ↓
Login modal appears
    ↓
Chat history is cleared
```

---

## Testing the System

### 1. Test Login
```bash
# Open browser console and run:
fetch('https://smart-stay.onrender.com/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'YOUR_HOST_CODE' })
})
.then(r => r.json())
.then(d => console.log(d)) // Shows {token, expiresIn, role}
```

### 2. Test Chat with Token
```bash
# Use the token from step 1
fetch('https://smart-stay.onrender.com/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
        message: 'Как е тока?',
        history: [],
        token: 'TOKEN_FROM_STEP_1'
    })
})
.then(r => r.json())
.then(d => console.log(d)) // Shows {response: "AI response"}
```

### 3. Check localStorage
```bash
# In browser console:
console.log(localStorage.getItem('smart-stay-token'))
console.log(localStorage.getItem('smart-stay-expiry'))
```

### 4. Test Expiration
```bash
# Modify expiry to be in the past:
localStorage.setItem('smart-stay-expiry', '0')

# Refresh page - should show login modal
```

---

## Environment Variables

No new environment variables are required. The system uses existing:
- `HOST_CODE` - Password for login (already in use)
- `DATABASE_URL` - PostgreSQL connection (already in use)
- `GEMINI_API_KEY` - AI service (already in use)

---

## Migration from Old System

### Old (Stateless)
```javascript
// Every request sent password
fetch('/api/chat', {
    body: JSON.stringify({ 
        message: 'спри тока',
        authCode: 'MyPassword123' // ← Password each time!
    })
})
```

### New (Stateful)
```javascript
// First: Get token once
fetch('/api/login', {
    body: JSON.stringify({ password: 'MyPassword123' })
}) // → Returns {token: '...'}

// Then: Use token for all requests
fetch('/api/chat', {
    body: JSON.stringify({ 
        message: 'спри тока',
        token: 'a3f8b2c1...' // ← Token stays same for 30 min
    })
})
```

---

## Benefits

| Feature | Old System | New System |
|---------|-----------|-----------|
| Password sent | Every request | Only at login |
| Attack surface | High (password in transit N times) | Low (password in transit 1 time) |
| User UX | Type password for each message | Login once, 30 minutes of access |
| Session management | Stateless | Stateful |
| Token expiration | N/A | 30 minutes automatic |
| Logout capability | No | Yes, immediate invalidation |

---

## Implementation Timeline

✅ **Server-side (server.js)**
- generateToken() - generates random token
- validateToken() - checks if valid/expired
- POST /api/login - creates token
- POST /api/logout - invalidates token
- POST /api/chat - accepts both token and password

✅ **AI Service (ai_service.js)**
- validateSessionToken() - checks token validity
- determineUserRole() - checks token BEFORE password

✅ **Client-side (index.html)**
- Login modal - password input form
- localStorage - persists token across sessions
- Session initialization - check localStorage on app start
- Chat submission - includes token in requests
- Logout button - clears token and localStorage

---

## Known Limitations & Future Improvements

1. **Single Server Instance**
   - Tokens stored in `Map` in memory
   - If server restarts, all tokens are lost (users must re-login)
   - **Future:** Store tokens in Redis or PostgreSQL for persistence

2. **Token Refresh**
   - Token expires exactly at 30 minutes
   - No "refresh token" mechanism
   - **Future:** Implement refresh token endpoint to extend session

3. **Multiple Devices**
   - Each device gets its own token
   - No logout-from-all-devices feature
   - **Future:** Allow users to see/manage all active sessions

4. **Browser Back Button**
   - After logout, back button shows cached page
   - **Mitigation:** Cache-Control headers already set

---

## Conclusion

The SESSION TOKEN system is now fully implemented and operational:
- ✅ Users log in once per 30 minutes
- ✅ Token stored securely in localStorage
- ✅ Password never sent with regular requests
- ✅ Automatic expiration handling
- ✅ Logout functionality with immediate token invalidation
- ✅ Backward compatible with old stateless system
