import os
import sys
import time
import requests

TOKEN = os.getenv("SMARTTHINGS_PAT", "").strip()
URL = os.getenv("SMARTTHINGS_REDIRECT_URI", "https://smart-stay.onrender.com/callback").strip()

if not TOKEN:
    print("❌ Липсва SMARTTHINGS_PAT в env")
    print("   Пример (PowerShell): $env:SMARTTHINGS_PAT='your_pat_here'")
    sys.exit(1)

headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
payload = {
    "appName": f"smartstay_{int(time.time())}",
    "displayName": "Smart Stay Control",
    "description": "Smart Stay AI Automation",
    "appType": "API_ONLY",
    "apiOnly": {},
    "oauth": {
        "clientName": "Smart Stay",
        "scope": ["r:devices:*", "w:devices:*", "x:devices:*"],
        "redirectUris": [URL]
    }
}
response = requests.post("https://api.smartthings.com/v1/apps", headers=headers, json=payload)
res = response.json()
if "oauth" in res and "clientId" in res["oauth"]:
    print(f"✅ Client ID: {res['oauth']['clientId']}\n✅ Client Secret: {res['oauth']['clientSecret']}")
else:
    print(f"❌ Грешка: {res}")