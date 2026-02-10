# 🧪 SESSION TOKEN SYSTEM - QUICK TEST GUIDE

## What Changed?

Before: Users had to provide password with **every** message
After: Users log in **once**, then token expires in **30 minutes**

---

## Testing Checklist

### ✅ Test 1: Login Flow
```
1. Open https://smart-stay.onrender.com in browser
2. You should see LOGIN MODAL (not chat)
3. Enter your HOST_CODE password
4. Click "Вход" (Login)
5. ✅ Expected: Chat interface appears, "Logout" button visible
```

### ✅ Test 2: Send Messages (Token Valid)
```
1. After login, chat interface is visible
2. Type any message: "Как е тока?" or "спри тока"
3. Click send button
4. ✅ Expected: AI responds immediately (uses token, not password)
5. Verify in browser console: localStorage['smart-stay-token'] contains hex string
```

### ✅ Test 3: Refresh Page (Token Persists)
```
1. After login, with valid token
2. Type a message and get AI response
3. Press F5 to refresh page
4. ✅ Expected: Chat interface appears immediately (token still valid in localStorage)
5. No login modal should appear
6. Message history should be preserved
```

### ✅ Test 4: Logout
```
1. After login, you see "Logout" button in top-right
2. Click "Logout" button
3. ✅ Expected: Login modal appears
4. Chat history is cleared
5. localStorage token is removed
```

### ✅ Test 5: Token Expiration
```
1. After login, open browser console
2. Run: localStorage.setItem('smart-stay-expiry', '0')
3. Refresh page with F5
4. ✅ Expected: Login modal appears (token detected as expired)
```

### ✅ Test 6: Wrong Password
```
1. Open the app (shows login modal)
2. Enter wrong password (anything except HOST_CODE)
3. Click "Вход"
4. ✅ Expected: Error message appears "Невалидна парола"
5. Login modal stays open
```

### ✅ Test 7: Multiple Messages in Session
```
1. Login with correct password
2. Send 3-4 messages: "Какво е WiFi?", "спри тока", "Когато се върна гостта?"
3. ✅ Expected: Each message gets response without asking for password again
4. Each request uses same token from localStorage
```

### ✅ Test 8: Session Timeout (30 min simulation)
```
1. Note the time you logged in
2. Wait 30 minutes OR manually expire token (see Test 5)
3. Try to send a message
4. ✅ Expected: Token detected as expired
5. Login modal appears automatically
6. Must re-enter password
```

---

## Browser Console Debugging

### Check Token Status
```javascript
// In browser console (F12 > Console tab)
const token = localStorage.getItem('smart-stay-token');
const expiry = localStorage.getItem('smart-stay-expiry');
console.log('Token:', token ? 'EXISTS' : 'MISSING');
console.log('Expiry:', expiry ? new Date(parseInt(expiry)) : 'N/A');
console.log('Valid:', Date.now() < parseInt(expiry) ? 'YES' : 'EXPIRED');
```

### Clear Everything (Hard Reset)
```javascript
localStorage.clear();
location.reload(); // Page will show login modal
```

### Check API Response
```javascript
// Test login endpoint
fetch('https://smart-stay.onrender.com/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'YOUR_HOST_CODE' })
})
.then(r => r.json())
.then(d => console.log(d))
// Expected output: {success: true, token: "a3f8b2...", expiresIn: 1800, role: "host", message: "Разбрах! Влезте успешно."}
```

### Test Chat with Token
```javascript
// Get token first (from login or localStorage)
const token = localStorage.getItem('smart-stay-token');

// Send message with token
fetch('https://smart-stay.onrender.com/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
        message: 'Как е времето?',
        history: [],
        token: token
    })
})
.then(r => r.json())
.then(d => console.log('AI Response:', d.response))
```

---

## What to Look For

### ✅ Good Signs
- Login modal appears on first visit
- After password entry, chat interface loads
- "Logout" button visible in top-right
- Messages send without password prompt
- localStorage contains 'smart-stay-token' key
- Token is 64 hexadecimal characters (random bytes)
- Token expires timestamp is ~30 minutes in future

### ❌ Problem Signs
- Chat interface shows without login modal (auth bypass!)
- Every message requires password entry (token not being used)
- Logout button never appears (session not created)
- Error "Невалидна парола" even with correct password
- Token never stored in localStorage
- "Ико пише..." indicator stays forever (API error)

---

## Common Issues & Solutions

### Issue: "Невалидна парола" even with correct code
**Solution:**
1. Check: Is HOST_CODE set in environment? (Check .env or Render dashboard)
2. Try: Copy-paste password carefully (no spaces)
3. Try: Clear localStorage first - `localStorage.clear()`

### Issue: Every message asks for password
**Solution:**
1. Token not being stored: Check localStorage - `localStorage.getItem('smart-stay-token')`
2. If empty: Check browser console for errors (F12)
3. Check: Server returning token? Look at network tab (F12 > Network > api/login)

### Issue: Login modal never appears
**Solution:**
1. Check: Is there a token in localStorage? `localStorage.getItem('smart-stay-token')`
2. If yes: Clear it - `localStorage.clear()`
3. Refresh page

### Issue: "Разбрах! Влезте успешно." doesn't appear after login
**Solution:**
1. Check server logs on Render dashboard
2. Verify HOST_CODE is correct
3. Check browser console for JavaScript errors

### Issue: Logout button doesn't appear
**Solution:**
1. Token wasn't generated: Check network tab for /api/login response
2. Check server logs for "SESSION Token registered"
3. Verify response includes `token` field

---

## Performance Notes

- **First load:** ~500ms (includes login modal)
- **After login:** ~1-2s per message (AI generation)
- **Token validation:** <1ms per request (Map lookup)
- **localStorage write:** <1ms

---

## Security Verification

Run this in console to verify secure practices:

```javascript
// ✅ Check 1: Password not in localStorage
localStorage.getItem('password') === null // Should be TRUE

// ✅ Check 2: Token is different from password
const token = localStorage.getItem('smart-stay-token');
token.length === 64 && /^[0-9a-f]+$/.test(token) // Should be TRUE

// ✅ Check 3: Expiry is future timestamp
const expiry = parseInt(localStorage.getItem('smart-stay-expiry'));
expiry > Date.now() // Should be TRUE

// ✅ Check 4: Password not sent to /api/chat
// Open F12 > Network tab, send message
// Look for POST to /api/chat, click it
// In Request > Payload, should see: {message, history, token}
// Should NOT see: {message, history, password}
```

---

## Render Deployment Checklist

Before deploying to Render, verify:

- [ ] `crypto` module imported in server.js
- [ ] SESSION_DURATION constant set (30 * 60 * 1000)
- [ ] generateToken() function exists
- [ ] validateToken() function exists
- [ ] POST /api/login endpoint working
- [ ] POST /api/logout endpoint working
- [ ] POST /api/chat accepts `token` parameter
- [ ] ai_service.js validates tokens first
- [ ] index.html has login modal HTML
- [ ] localStorage keys match: 'smart-stay-token', 'smart-stay-expiry'
- [ ] Cleanup job removes expired tokens every 5 minutes
- [ ] All JavaScript files pass `node --check`

---

## Expected Console Output (Server Logs)

### On successful login:
```
[SESSION] ✅ Генериран token за host, валиден до 2:45:30 PM
[LOGIN] ✅ Успешна аутентификация за host
```

### On first chat message with token:
```
[SECURITY] authCode/token предоставен: true
[SECURITY] ✅ SESSION TOKEN валиден за host
[SECURITY] Определена роля: ДОМАКИН
[CHAT] 🤖 Викам AI асистент...
```

### On token expiration:
```
[SESSION] ⏰ Token изтекъл, изтривам от сесии
[CLEANUP] 🧹 Изтрити X изтекли token
```

---

## Quick Video Test Steps (3 minutes)

1. **0:00** - Open app in fresh browser
   - See login modal ✓
2. **0:15** - Enter HOST_CODE password
   - Click "Вход" ✓
3. **0:30** - Chat interface appears
   - See "Logout" button ✓
4. **0:45** - Type "Как е тока?"
   - Gets response without password ✓
5. **1:00** - Type "спри тока"
   - Power command executes ✓
6. **1:15** - Refresh page with F5
   - Chat still works, no re-login ✓
7. **1:30** - Click "Logout" button
   - Login modal reappears ✓
8. **2:00** - Test wrong password
   - Error message appears ✓
9. **2:30** - Enter correct password
   - Chat works again ✓

---

## Summary

The system is working correctly if:
1. ✅ First visit shows login modal
2. ✅ After login, chat is visible
3. ✅ Messages send without password
4. ✅ Page refresh keeps you logged in
5. ✅ Logout clears everything
6. ✅ Token expires after 30 minutes
7. ✅ Server logs show "SESSION TOKEN валиден"

**If all 7 checks pass, the implementation is successful! 🎉**
