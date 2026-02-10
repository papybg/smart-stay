# ⚡ SESSION TOKEN - QUICK REFERENCE CARD

## 🎯 What Changed?

```
OLD (Bad):  User password → Every message
            "спри тока" sent as password each time ❌

NEW (Good): User password → Login once
            Token generated → All messages use token ✅
            Token expires after 30 minutes
```

---

## 🔄 User Flow

```
┌─────────────┐
│  App Opens  │
└──────┬──────┘
       │
       ├─ Token in localStorage? 
       │   YES → Show Chat ✅
       │   NO → Show Login Modal
       │
┌──────▼──────┐
│ LOGIN MODAL │  [Password field] [Вход button]
└──────┬──────┘
       │ User enters password
       │
┌──────▼──────────────┐
│ POST /api/login     │  {password: "MySecret"}
│ Server validates    │
│ Returns token       │  {token: "a3f8b2...", expiresIn: 1800}
└──────┬──────────────┘
       │
┌──────▼──────────────────┐
│ localStorage Updated    │  smart-stay-token: "a3f8b2..."
│ Chat Interface Shows    │  smart-stay-expiry: 1708790500000
└──────┬──────────────────┘
       │
┌──────▼──────────────┐
│ User sends messages │  Token checked automatically
│ (30 min window)     │  No password needed ✅
└──────┬──────────────┘
       │
       ├─ Within 30 min?
       │   YES → Message sent with token ✅
       │   NO → Login modal appears (token expired)
       │
┌──────▼──────────────┐
│ User clicks logout  │  Token invalidated
│                     │  localStorage cleared
└──────┬──────────────┘
       │
       └─ Back to Login Modal
```

---

## 📝 API Endpoints

### POST /api/login
```javascript
// REQUEST
{ password: "MyHostCode123" }

// RESPONSE (Success)
{
  success: true,
  token: "a3f8b2c1e9d4f7a6b3e2d8c1f4a7b2e9d3c6f1a4e7b0d2c5f8a1b3d6e9f2a",
  expiresIn: 1800,  // seconds (30 minutes)
  role: "host",
  message: "Разбрах! Влезте успешно."
}

// RESPONSE (Error)
{ error: "Невалидна парола" }  // Status 401
```

### POST /api/chat (Updated)
```javascript
// OLD: PASSWORD WITH EVERY REQUEST ❌
{ message: "спри тока", history: [], authCode: "спри тока" }

// NEW: TOKEN WITH EVERY REQUEST ✅
{ message: "спри тока", history: [], token: "a3f8b2..." }

// RESPONSE
{ response: "AI response text..." }
```

### POST /api/logout
```javascript
// REQUEST
{ token: "a3f8b2..." }

// RESPONSE
{ success: true }
```

---

## 💾 localStorage Keys

```javascript
// After successful login, browser stores:

localStorage['smart-stay-token']
// Value: "a3f8b2c1e9d4f7a6b3e2d8c1f4a7b2e9d3c6f1a4e7b0d2c5f8a1b3d6e9f2a"
// Type: 64 hex characters (cryptographically random)

localStorage['smart-stay-expiry']
// Value: "1708790500000"
// Type: Timestamp in milliseconds (when token expires)
```

---

## 🔐 Token Details

| Property | Value | Notes |
|----------|-------|-------|
| Format | Hex string | 64 characters (32 bytes) |
| Length | 64 chars | crypto.randomBytes(32).toString('hex') |
| Expiration | 30 minutes | From generation time |
| Storage | localStorage | Persists across page refresh |
| Transport | HTTP POST body | As `token` parameter |
| Encryption | None | Token itself is random (no password) |
| Validation | Server-side Map | Checked on every request |

---

## 🧪 Quick Tests

### Test 1: Login
```bash
# Browser console:
fetch('https://smart-stay.onrender.com/api/login', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({password: 'YOUR_CODE'})
})
.then(r => r.json())
.then(d => {
  console.log('Token:', d.token)
  console.log('Expires:', d.expiresIn, 'seconds')
})
```

### Test 2: Check Token
```bash
# Browser console:
console.log('Token:', localStorage.getItem('smart-stay-token'))
console.log('Expires at:', new Date(parseInt(localStorage.getItem('smart-stay-expiry'))))
console.log('Valid:', Date.now() < parseInt(localStorage.getItem('smart-stay-expiry')) ? 'YES' : 'NO')
```

### Test 3: Clear Everything
```bash
# Browser console:
localStorage.clear()
location.reload()
```

---

## ✅ Success Indicators

### UI Should Show:
- [ ] Login modal on first visit
- [ ] Password input field
- [ ] "Вход" button
- [ ] Chat interface after login
- [ ] "Logout" button in header (top-right)
- [ ] No password prompt for subsequent messages
- [ ] Error message on wrong password

### localStorage Should Have:
- [ ] `smart-stay-token` key (64 hex chars)
- [ ] `smart-stay-expiry` key (future timestamp)
- [ ] Both keys cleared after logout

### Server Logs Should Show:
- [ ] `[SESSION] ✅ Генериран token за host`
- [ ] `[LOGIN] ✅ Успешна аутентификация`
- [ ] `[SECURITY] ✅ SESSION TOKEN валиден за host`

---

## ❌ Common Problems & Fixes

| Problem | Cause | Fix |
|---------|-------|-----|
| "Невалидна парола" | Wrong password | Check HOST_CODE in Render env |
| Every message needs password | Token not stored | Clear localStorage, login again |
| No logout button | Token wasn't created | Check /api/login response |
| Can't logout | Server issue | Reload page, try again |
| Chat history stays after logout | Bug in HTML | localStorage not cleared |
| Login modal never appears | Stale token in localStorage | `localStorage.clear()` |

---

## 🚀 Deployment Checklist

```
SERVER (server.js):
☑ Import crypto module
☑ SESSION_DURATION = 30*60*1000
☑ generateToken() function
☑ validateToken() function
☑ Cleanup job every 5 minutes
☑ POST /api/login endpoint
☑ POST /api/logout endpoint
☑ POST /api/chat accepts token

AI SERVICE (ai_service.js):
☑ validateSessionToken() function
☑ Check token FIRST in determineUserRole()
☑ Fall back to password if no token

FRONTEND (public/index.html):
☑ Login modal HTML
☑ Logout button HTML
☑ localStorage keys correct
☑ initializeSession() on page load
☑ Chat sends token (not password)
☑ Logout clears localStorage

ENVIRONMENT:
☑ HOST_CODE set in Render
☑ DATABASE_URL available
☑ GEMINI_API_KEY available

TESTING:
☑ Login successful with correct password
☑ Login fails with wrong password
☑ Messages send without password prompt
☑ Page refresh keeps session
☑ Logout button works
☑ Token expires after 30 minutes
```

---

## 📊 Session Timeline Example

```
10:00 AM
  ├─ User opens app
  ├─ Shows login modal
  └─ User enters password, clicks "Вход"

10:00:15 AM
  ├─ POST /api/login received
  ├─ Token generated: "a3f8b2c1..."
  ├─ Token stored: sessions Map + localStorage
  ├─ Expires at: 10:30 AM (1800 seconds)
  └─ Chat interface appears

10:05 AM
  ├─ User: "спри тока"
  ├─ POST /api/chat with token
  ├─ Token validated (5 min < 30 min) ✅
  ├─ Power off executed
  └─ AI response returned

10:15 AM
  ├─ User: "Как е WiFi?"
  ├─ POST /api/chat with token
  ├─ Token validated (15 min < 30 min) ✅
  └─ AI response returned

10:25 AM
  ├─ User: "Логин не е нужен"
  ├─ POST /api/chat with token
  ├─ Token validated (25 min < 30 min) ✅
  └─ AI response returned

10:30 AM
  ├─ Token EXPIRES (10:30 AM = 1800 seconds after 10:00)
  └─ localStorage expiry timestamp reached

10:31 AM
  ├─ User tries: "Още един тест"
  ├─ Browser checks: Date.now() > localStorage expiry
  ├─ Result: TRUE (token expired)
  ├─ Browser removes token from localStorage
  ├─ Login modal appears
  └─ User must re-enter password

10:32 AM
  ├─ User enters password
  ├─ New token generated
  ├─ Expires at: 11:02 AM
  └─ Session continues for another 30 min
```

---

## 🔍 Code Locations (Quick Reference)

| Feature | File | Location |
|---------|------|----------|
| Token generation | server.js | generateToken() |
| Token validation | server.js | validateToken() |
| Session storage | server.js | sessions Map |
| Cleanup job | server.js | setInterval() 5min |
| Login endpoint | server.js | POST /api/login |
| Logout endpoint | server.js | POST /api/logout |
| Token check in AI | ai_service.js | validateSessionToken() |
| Role determination | ai_service.js | determineUserRole() |
| Login modal | index.html | `<div id="login-modal">` |
| Logout button | index.html | `<button id="logout-btn">` |
| localStorage logic | index.html | JavaScript functions |

---

## 📞 Support Scenarios

### User: "Why do I need to login every 30 minutes?"
**Answer:** This is intentional security. Token expires after 30 minutes to protect your account. Just login again - it takes 5 seconds.

### User: "The login modal won't go away"
**Answer:** Either:
1. Password incorrect (check for typos)
2. Browser localStorage broken (clear cache and try again)
3. Server error (check Render logs)

### User: "I logged out but back button shows chat"
**Answer:** Browser cached the page. This is normal - the cached chat can't access data without a valid token, so you can't harm anything.

### User: "Can I change my password?"
**Answer:** No, currently password is only HOST_CODE. To change it, update HOST_CODE in Render environment variables.

---

## 🎓 Key Concepts

### Session
- Server-side: Token stored in `sessions` Map with expiry
- Client-side: Token stored in localStorage
- Both must be valid for request to process

### Token
- Random 64-character hex string
- Generated once at login
- Same token used for all messages (30 min)
- Not the password - just a temporary session key

### Expiration
- Server: Token removed from Map at expiry time
- Client: localStorage checked before sending message
- Manual removal: POST /api/logout endpoint

### Backward Compatibility
- Old system used `authCode` parameter
- New system uses `token` parameter
- Both still work (token checked first)

---

## 🎉 Success Criteria

Your implementation is successful if:

1. ✅ Password entered only ONCE per 30 minutes
2. ✅ Token used for all subsequent messages
3. ✅ No "Вход" modal appears after successful login (within 30 min)
4. ✅ Page refresh keeps you logged in
5. ✅ Logout button clears everything
6. ✅ Token expires automatically at 30 min
7. ✅ Error message shows for wrong password
8. ✅ Server logs show token generation/validation
9. ✅ localStorage has token key after login
10. ✅ Both authCode (old) and token (new) work

**If all 10 are TRUE → Implementation is 100% successful! 🎉**

---

## 📚 Related Documentation

- **SESSION_TOKEN_GUIDE.md** - Complete technical details
- **SESSION_TOKEN_TEST_GUIDE.md** - Testing & debugging
- **BEFORE_AFTER_COMPARISON.md** - Visual flow diagrams
- **IMPLEMENTATION_COMPLETE.md** - Full implementation report

---

**Version:** 1.0  
**Status:** ✅ Complete & Ready for Production  
**Last Updated:** February 10, 2026  
**Language:** Bulgarian UI / English Documentation  
