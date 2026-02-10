# 🏗️ SYSTEM ARCHITECTURE - SESSION TOKEN IMPLEMENTATION

## Complete System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SMART STAY - COMPLETE SYSTEM                        │
└─────────────────────────────────────────────────────────────────────────────┘

                            ┌──────────────────────┐
                            │   USER BROWSER       │
                            │  (public/index.html) │
                            └──────────┬───────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
            ┌───────▼────────┐ ┌──────▼──────┐  ┌──────▼─────────┐
            │  LOGIN MODAL   │ │ Chat Form   │  │localStorage    │
            │  Password      │ │ Messages    │  │ smart-stay-    │
            │  Input Field   │ │ Send Button │  │ token:         │
            │  "Вход" Button │ │             │  │ smart-stay-    │
            │  Error Msg     │ │             │  │ expiry:        │
            └───────┬────────┘ └──────┬──────┘  └──────┬─────────┘
                    │                  │                 │
                    │                  │     ┌───────────┴──────────┐
                    │         ┌────────┼─────▼──────────┐           │
                    │         │   JavaScript Functions   │           │
                    │         │ ┌─────────────────────┐  │           │
                    │         │ │initializeSession()  │  │           │
                    │         │ │loginHandler()       │  │           │
                    │         │ │logoutHandler()      │  │           │
                    │         │ │chatSubmit()         │  │           │
                    │         │ │validateToken()      │  │           │
                    │         │ └─────────────────────┘  │           │
                    │         └──────┬──────┬─────────────┘           │
                    │                │      │                         │
        ┌───────────▼─────────┐      │      │    ┌────────────────────┘
        │  API REQUESTS        │      │      │    │
        │ POST /api/login      │──────┘      │    │
        │ POST /api/chat       │─────────────┘    │
        │ POST /api/logout     │──────────────────┘
        └───────────┬──────────┘
                    │
        ┌───────────▼──────────────────────────────────────────────────┐
        │                      RENDER CLOUD SERVER                      │
        │                      (Node.js + Express)                      │
        └───────────┬──────────────────────────────────────────────────┘
                    │
    ┌───────────────┼───────────────┐
    │               │               │
┌───▼───────────────┐  ┌───────────▼────────┐  ┌──────────────┐
│  server.js        │  │ services/          │  │ Background   │
│ (Express routes)  │  │ ai_service.js      │  │ Jobs         │
│                   │  │ (AI Logic)         │  │              │
│ POST /api/login   │  │                    │  │ • Cleanup    │
│ ├─ Verify password│  │ AI Generation      │  │   every 5min │
│ ├─ Generate token │  │ ├─ check token 1st │  │              │
│ ├─ Store session  │  │ ├─ validate token  │  │ • Remove     │
│ └─ Return token   │  │ ├─ determine role  │  │   expired    │
│                   │  │ └─ build response  │  │   tokens     │
│ POST /api/chat    │  │                    │  │              │
│ ├─ Accept message │  │ Manual.txt         │  │              │
│ ├─ Get token      │  │ ├─ Property info   │  │              │
│ └─ Call AI svc    │  │ ├─ WiFi details    │  │              │
│                   │  │ ├─ House rules     │  │              │
│ POST /api/logout  │  │ ├─ Contacts        │  │              │
│ ├─ Remove token   │  │ └─ Emergency       │  │              │
│ └─ Clear session  │  │                    │  │              │
│                   │  │ Database           │  │              │
│ Sessions Map      │  │ ├─ Bookings        │  │              │
│ ├─ token: {       │  │ ├─ Power history   │  │              │
│ │   role,        │  │ ├─ Pin depot       │  │              │
│ │   expiresAt    │  │ └─ User sessions   │  │              │
│ │ }              │  │                    │  │              │
│ └─ ...          │  │ AutoRemote API     │  │              │
│                   │  │ └─ Tasker commands│  │              │
└───────────────────┘  └────────────────────┘  └──────────────┘
    │                      │                         │
    │                      └──────────────┬──────────┘
    │                                     │
┌───▼─────────────────────────────────────▼──────────────┐
│              PostgreSQL Database (Neon)                 │
│                                                         │
│  Tables:                                               │
│  • bookings (guest reservations)                      │
│  • power_history (meter on/off records)               │
│  • pin_depot (lock codes)                             │
│  • users (authentication)                             │
│                                                         │
│  Query Examples:                                       │
│  • SELECT * FROM bookings WHERE id = ?                │
│  • INSERT INTO power_history (is_on, source) ...      │
│  • SELECT * FROM pin_depot WHERE status = 'available' │
└────────────────────────────────────────────────────────┘
```

---

## Authentication Flow Diagram

```
                         AUTHENTICATION SYSTEM
                         
┌──────────────────────────────────────────────────────────────────┐
│ STEP 1: INITIALIZATION                                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Browser loads index.html                                         │
         ↓                                                           │
│  JavaScript runs initializeSession()                              │
         ↓                                                           │
│  Check localStorage for token + expiry                           │
         ↓                                                           │
│  if (token exists && Date.now() < expiry) {                       │
│      sessionToken = token                                         │
│      showChat()  // Token still valid                             │
│  } else {                                                         │
│      showLoginModal()  // Token missing or expired                │
│  }                                                                │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘

                    ↓ USER ACTION: ENTERS PASSWORD

┌──────────────────────────────────────────────────────────────────┐
│ STEP 2: LOGIN REQUEST                                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  User clicks "Вход" button                                       │
         ↓                                                           │
│  Browser sends: POST /api/login                                   │
│  {                                                                │
│      password: "user_entered_password"                           │
│  }                                                                │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘

                         ↓ SERVER PROCESSING

┌──────────────────────────────────────────────────────────────────┐
│ STEP 3: PASSWORD VERIFICATION (SERVER)                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Server receives password                                        │
│         ↓                                                         │
│  Normalize: trim(), lowercase()                                  │
│         ↓                                                         │
│  Compare with HOST_CODE environment variable                    │
│         ↓                                                         │
│  if (password === HOST_CODE) {                                    │
│      ✅ PASSWORD CORRECT - Continue to Step 4                    │
│  } else {                                                         │
│      ❌ PASSWORD WRONG - Return error 401                        │
│      Response: {error: "Невалидна парола"}                      │
│  }                                                                │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘

                    ↓ (Only if password correct)

┌──────────────────────────────────────────────────────────────────┐
│ STEP 4: TOKEN GENERATION (SERVER)                                │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Generate token:                                                 │
│    token = crypto.randomBytes(32).toString('hex')               │
│    token = "a3f8b2c1e9d4f7a6b3e2d8c1f4a7b2e9d3c6f1a4..."        │
│         ↓                                                         │
│  Calculate expiration:                                           │
│    expiresAt = Date.now() + (30 * 60 * 1000)  // 30 min        │
│         ↓                                                         │
│  Store in sessions Map:                                         │
│    sessions.set(token, {                                        │
│        role: 'host',                                            │
│        expiresAt: 1708790500000,                                │
│        createdAt: 1708788700000                                 │
│    })                                                            │
│         ↓                                                         │
│  Return response:                                               │
│    {                                                            │
│        success: true,                                           │
│        token: "a3f8b2c1...",                                    │
│        expiresIn: 1800,  // seconds                             │
│        role: "host",                                            │
│        message: "Разбрах! Влезте успешно."                     │
│    }                                                            │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘

                    ↓ (Response received by browser)

┌──────────────────────────────────────────────────────────────────┐
│ STEP 5: TOKEN STORAGE (BROWSER)                                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Save token to localStorage:                                    │
│    localStorage['smart-stay-token'] = "a3f8b2c1..."            │
│    localStorage['smart-stay-expiry'] = Date.now() + 1800000    │
│         ↓                                                         │
│  Update JavaScript variable:                                   │
│    sessionToken = "a3f8b2c1..."                                │
│         ↓                                                         │
│  Update UI:                                                     │
│    Hide login modal                                             │
│    Show chat interface                                          │
│    Show logout button                                           │
│         ↓                                                         │
│  User can now type messages ✅                                   │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘

           ↓ USER ACTION: TYPES MESSAGE ("спри тока")

┌──────────────────────────────────────────────────────────────────┐
│ STEP 6: MESSAGE WITH TOKEN (BROWSER)                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  User types message and clicks send                             │
│         ↓                                                         │
│  Browser reads token from localStorage:                        │
│    token = localStorage.getItem('smart-stay-token')            │
│         ↓                                                         │
│  Browser sends: POST /api/chat                                  │
│  {                                                              │
│      message: "спри тока",                                     │
│      history: [...],                                           │
│      token: "a3f8b2c1..."   ← ONLY ONCE RECEIVED TOKEN!        │
│  }                                                              │
│         ↓                                                         │
│  NO PASSWORD SENT! ✅                                           │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘

                    ↓ SERVER PROCESSING

┌──────────────────────────────────────────────────────────────────┐
│ STEP 7: TOKEN VALIDATION (SERVER)                                │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Server receives token from request                             │
│         ↓                                                         │
│  Call validateToken(token):                                     │
│    if (!sessions.has(token)) {                                  │
│        return null  // Token not found                          │
│    }                                                            │
│    session = sessions.get(token)                               │
│    if (Date.now() > session.expiresAt) {                        │
│        sessions.delete(token)  // Expired                      │
│        return null                                             │
│    }                                                            │
│    return {role: session.role, valid: true}  ✅ VALID         │
│         ↓                                                         │
│  Pass token to AI service for processing                       │
│         ↓                                                         │
│  AI service calls determineUserRole(token):                    │
│    Check #0: Validate SESSION TOKEN                            │
│      sessionToken = validateSessionToken(token)                │
│      if (sessionToken) {                                        │
│          return {role: sessionToken.role}  ← SKIP PASSWORD!   │
│      }                                                          │
│    (Fall back to password check if no token)                  │
│         ↓                                                         │
│  Role determined: 'host'                                       │
│  Can execute power commands ✅                                  │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘

                    ↓ PROCESS MESSAGE & GENERATE RESPONSE

┌──────────────────────────────────────────────────────────────────┐
│ STEP 8: AI RESPONSE (SERVER)                                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Get power status from Tasker/Smart Life                        │
│         ↓                                                         │
│  Load manual.txt (based on role: 'host' → full access)        │
│         ↓                                                         │
│  Check for power command: "спри тока" matches /изключ/          │
│         ↓                                                         │
│  Execute power command:                                         │
│    automationClient.controlPower(false)  ← Meter off            │
│         ↓                                                         │
│  Build AI instruction with role + manual + power status         │
│         ↓                                                         │
│  Call Gemini API with instruction                               │
│         ↓                                                         │
│  Receive AI response from Gemini                               │
│         ↓                                                         │
│  Return response:                                              │
│    {response: "Токът е прекъснат. Сега мерачът е изключен."}   │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘

                    ↓ (Response sent to browser)

┌──────────────────────────────────────────────────────────────────┐
│ STEP 9: DISPLAY RESPONSE (BROWSER)                               │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Browser receives response                                      │
│         ↓                                                         │
│  Display AI message in chat                                    │
│         ↓                                                         │
│  User can type another message                                 │
│         ↓                                                         │
│  Same token still valid (within 30 min)                        │
│         ↓                                                         │
│  Go back to STEP 6 ↩️ (repeat for each message)                 │
│         ↓                                                         │
│  User can send messages for entire 30 minutes!                 │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘

        ↓ (After 30 minutes OR user clicks logout)

┌──────────────────────────────────────────────────────────────────┐
│ STEP 10: SESSION TIMEOUT OR LOGOUT                               │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  SCENARIO A: TOKEN EXPIRES (30 min elapsed)                      │
│    Browser checks: Date.now() > localStorage['expiry']          │
│    Result: TRUE (token expired)                                │
│    Browser removes token from localStorage                      │
│    Browser shows login modal                                   │
│    User must re-enter password ✓                               │
│                                                                    │
│  SCENARIO B: USER CLICKS LOGOUT BUTTON                           │
│    Browser sends: POST /api/logout                              │
│    {token: "a3f8b2c1..."}                                       │
│         ↓                                                         │
│    Server removes token from sessions Map                       │
│    Token is INVALID (even if re-sent)                          │
│    Browser removes token from localStorage                      │
│    Browser clears chat history                                 │
│    Browser shows login modal                                   │
│    User must re-enter password ✓                               │
│                                                                    │
│  Result in both cases: CLEAN SESSION LOGOUT ✅                  │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        REQUEST/RESPONSE FLOW                      │
└─────────────────────────────────────────────────────────────────┘

REQUEST #1: Login with Password
═══════════════════════════════

Browser                              Server              Database
  │                                    │                    │
  │  POST /api/login                   │                    │
  │  {password: "secret"}──────────────>                    │
  │                                    │                    │
  │                     Verify password            N/A      │
  │                     (HOST_CODE check)                    │
  │                                    │                    │
  │                     Generate token │                    │
  │                                    │                    │
  │                   Store in sessions│                    │
  │                                    │  INSERT session    │
  │                                    │─────────────────>│ │
  │                                    │                  │ │
  │  200 OK                            │                  │ │
  │  {token, expiresIn, role} <────────                    │
  │                                    │                    │
  localStorage.setItem(token, expiry)  │                    │
  │                                    │                    │


REQUEST #2-N: Send Message with Token
═════════════════════════════════════

Browser                              Server              Tasker/AI
  │                                    │                    │
  │  POST /api/chat                    │                    │
  │  {message, token}──────────────────>                    │
  │                                    │                    │
  │                     Validate token │                    │
  │                     Get role from  │                    │
  │                     token          │                    │
  │                                    │                    │
  │                     Call AI service│                    │
  │                     Check for power│                    │
  │                     command        │                    │
  │                                    │  meter_off/meter_on>
  │                                    │                    │
  │                                    │ Call Gemini API    │
  │                                    │ Generate response  │
  │                                    │ Return to browser  │
  │                                    │                    │
  │  200 OK                            │                    │
  │  {response: "AI message"} <────────                    │
  │                                    │                    │
  Display message in chat              │                    │
  │                                    │                    │
  [User types another message]         │                    │
  │                                    │                    │
  └──────────── Go to REQUEST #2 ──────┘                    │


REQUEST N+1: Logout
═══════════════════

Browser                              Server
  │                                    │
  │  POST /api/logout                  │
  │  {token}──────────────────────────>
  │                                    │
  │                   Remove token from│
  │                   sessions Map      │
  │                                    │
  │  200 OK                            │
  │  {success: true} <─────────────────
  │                                    │
  localStorage.removeItem(token)       │
  localStorage.removeItem(expiry)      │
  │                                    │
  Clear chat history                   │
  Show login modal                     │
  │                                    │
```

---

## Security Model Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│              AUTHENTICATION & AUTHORIZATION MODEL                 │
└─────────────────────────────────────────────────────────────────┘

LAYER 1: PASSWORD VERIFICATION
═════════════════════════════

  User Password Input
         │
         ├─ Normalize (trim, lowercase)
         │
         ├─ Compare with HOST_CODE
         │
         ├─ ✅ MATCH → Generate Token
         │
         └─ ❌ NO MATCH → Return Error 401


LAYER 2: TOKEN STORAGE
══════════════════════

  Server-Side:
    sessions Map {
      "a3f8b2c1...": {
        role: "host",
        expiresAt: 1708790500000,
        createdAt: 1708788700000
      }
    }
  
  Client-Side:
    localStorage {
      "smart-stay-token": "a3f8b2c1...",
      "smart-stay-expiry": 1708790500000
    }


LAYER 3: TOKEN VALIDATION
═════════════════════════

  On Each Request:
    
    ├─ Extract token from request
    │
    ├─ Check: Does token exist in sessions Map?
    │  └─ ❌ NOT FOUND → REJECT
    │  └─ ✅ FOUND → Continue
    │
    ├─ Check: Has token expired?
    │  └─ ✅ EXPIRED (now > expiresAt) → DELETE & REJECT
    │  └─ ❌ NOT EXPIRED → ACCEPT
    │
    └─ ✅ TOKEN VALID → Extract role & process request


LAYER 4: AUTHORIZATION
══════════════════════

  Based on Token Role:
  
    role: "host" {
      ✅ Full access to property info (manual.txt)
      ✅ Can execute power commands
      ✅ Can see all house details
      ✅ Can access emergency features
    }
    
    role: "guest" {
      ✅ Limited access (guest manual only)
      ✅ Can ask about property (read-only)
      ❌ Cannot execute power commands
      ❌ Cannot see sensitive data
    }
    
    role: "stranger" {
      ✅ Minimal access (public info only)
      ❌ Cannot control anything
      ❌ Cannot see property details
      ❌ Cannot access emergency features
    }


LAYER 5: EXPIRATION & CLEANUP
══════════════════════════════

  Automatic Cleanup (Every 5 minutes):
    
    for each token in sessions Map {
      if (Date.now() > token.expiresAt) {
        sessions.delete(token)  // Remove from memory
      }
    }
  
  Prevents: Memory leaks, orphaned sessions


LAYER 6: LOGOUT
═══════════════

  Manual Invalidation:
    
    ├─ User clicks Logout button
    │
    ├─ Browser: POST /api/logout {token}
    │
    ├─ Server: sessions.delete(token)
    │  └─ Token is IMMEDIATELY INVALID
    │  └─ Even if somehow resent, will be rejected
    │
    ├─ Browser: localStorage.removeItem(token)
    │
    └─ Browser: Show login modal again
```

---

## Session Timeline Example

```
TIME        EVENT                          STATE
════════════════════════════════════════════════════════════════════

10:00:00    User opens app                 Login modal appears
            

10:00:15    User enters password           Password verified ✅
            & clicks "Вход"                Token generated
                                          Token stored in localStorage
                                          Chat interface shows
                                          

10:00:30    User: "Как е тока?"           Message sent with token
                                          Token validated (0.5 min)
                                          AI responds
                                          

10:05:00    User: "спри тока"             Message sent with token
                                          Token validated (5 min)
                                          Power off executed
                                          AI responds
                                          

10:15:00    User: "Какво е WiFi?"         Message sent with token
                                          Token validated (15 min)
                                          AI responds
                                          

10:25:00    User: "Еще един тест"         Message sent with token
                                          Token validated (25 min)
                                          AI responds
                                          

10:30:00    Token EXPIRES                 localStorage expiry time reached
            (30 min elapsed)               
                                          

10:30:30    User tries new message        Browser detects: Date.now() > expiry
                                          Browser removes token
                                          Login modal appears
                                          User must re-enter password
                                          

10:31:00    User re-enters password       New token generated
                                          Expires at 11:01:00 AM
                                          Chat continues
                                          
                                          
          OR                               (Alternative timeline)


10:30:15    User clicks "Logout"          POST /api/logout sent
            button                        Token removed from server Map
                                          Token removed from localStorage
                                          Chat history cleared
                                          Login modal appears
                                          User can login again if needed
```

---

## Component Interaction Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                     COMPONENT INTERACTIONS                       │
└────────────────────────────────────────────────────────────────┘

index.html (Browser)
  │
  ├─ Login Modal
  │  ├─ Password Input
  │  ├─ "Вход" Button ──────┐
  │  └─ Error Display        │
  │                          │ Calls loginHandler()
  │ Chat Interface           │
  │  ├─ Messages Display     │
  │  ├─ Chat Form            │
  │  └─ Send Button ────┐    │
  │                     │    │
  │ localStorage        │    │ Calls chatSubmit()
  │  ├─ smart-stay-token │   │
  │  └─ smart-stay-expiry │  │
  │                      │    │
  └──────────┬───────────┼────┤
             │           │    │
             │     ┌─────▼────▼──────────────────┐
             │     │  Fetch Requests to Server    │
             │     │                              │
             │     ├─ POST /api/login             │
             │     │  {password: ...}             │
             │     │  Returns: {token, ...}       │
             │     │                              │
             │     ├─ POST /api/chat              │
             │     │  {message, token}            │
             │     │  Returns: {response: ...}    │
             │     │                              │
             │     └─ POST /api/logout            │
             │        {token: ...}                │
             │        Returns: {success: true}    │
             │                                    │
             └────────────────┬──────────────────┘
                              │
             ┌────────────────┴──────────────────┐
             │                                   │
             │      server.js (Render Cloud)     │
             │                                   │
             ├─ generateToken()                  │
             ├─ validateToken()                  │
             ├─ sessions Map {                   │
             │    token: {role, expiresAt}       │
             │  }                                │
             ├─ Cleanup job (every 5 min)        │
             │                                   │
             └────────────────┬──────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │                    │
             ┌──────▼────────┐    ┌─────▼──────────┐
             │ ai_service.js │    │ autoremote.js  │
             │               │    │                │
             │ • tokenValidate│   │ • controlPower │
             │ • determineRole│   │ • getPowerStatus│
             │ • buildInstruct│   │ • sendCommand   │
             │ • generateResp │   │                │
             │ • checkPower   │   │                │
             │ • checkEmergency│  │ Tasker API     │
             │                │   │                │
             └────────┬───────┘   └────────┬───────┘
                      │                     │
                      │                     │
             ┌────────▼───────────────────▼─┐
             │   PostgreSQL Database        │
             │   (Neon Cloud)               │
             │                              │
             │ • bookings                   │
             │ • power_history              │
             │ • pin_depot                  │
             │ • user_sessions              │
             │                              │
             └──────────────────────────────┘
```

This comprehensive architecture ensures secure, efficient token-based authentication while maintaining backward compatibility with the existing system.
