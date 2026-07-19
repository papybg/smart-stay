import fs from 'fs/promises';
import path from 'path';

const API_BASE_URL = (process.env.EVAL_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const CHAT_URL = `${API_BASE_URL}/api/chat`;
const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY || '';
const EVAL_CHAT_TOKEN = process.env.EVAL_CHAT_TOKEN || '';
const EVAL_AUTH_CODE = process.env.EVAL_AUTH_CODE || '';
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_DIRECTIONS_API_KEY || '';
const EVAL_FETCH_RETRIES = Math.max(0, Number(process.env.EVAL_FETCH_RETRIES || 2));
const EVAL_CASE_ATTEMPTS = Math.max(1, Number(process.env.EVAL_CASE_ATTEMPTS || 2));

const REFUSAL_RE = /не мога да отговоря|нужна оторизация|requires authorization|cannot answer/i;
const CLARIFICATION_RE = /посочете\s+град\s+или\s+гкпп|specify a city or border checkpoint/i;

function parseLatLng(value = '') {
  const m = String(value).trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { lat: Number(m[1]), lng: Number(m[2]) };
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

async function fetchWithRetry(url, options = {}, retries = EVAL_FETCH_RETRIES) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if (res.ok || !isRetryableStatus(res.status) || attempt === retries) {
        return res;
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      if (attempt === retries) throw e;
    }
  }
  throw lastError || new Error('fetch failed');
}

async function geocode(place) {
  if (!GOOGLE_API_KEY) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place)}&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  const data = await res.json();
  const loc = data?.results?.[0]?.geometry?.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
  return { lat: loc.lat, lng: loc.lng };
}

function extractMapsDestination(responseText = '') {
  const urlMatch = responseText.match(/https?:\/\/www\.google\.com\/maps\/dir\/\?[^\s]+/i);
  if (!urlMatch) return null;
  const url = new URL(urlMatch[0]);
  return url.searchParams.get('destination');
}

function extractCandidates(responseText = '') {
  const lines = String(responseText)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const items = [];
  for (const line of lines) {
    if (!/^([•\-*]|\d+\.)\s+/.test(line)) continue;
    let item = line.replace(/^([•\-*]|\d+\.)\s+/, '');
    item = item.split('—')[0].split('-')[0].trim();
    if (item.length >= 3 && item.length <= 80) items.push(item);
  }
  return [...new Set(items)].slice(0, 8);
}

function cleanCandidate(raw = '') {
  let value = String(raw).trim();
  value = value.replace(/^(["'`*_]+)|(["'`*_]+)$/g, '').trim();

  // Drop obvious non-place fragments and formatting leftovers.
  if (!value) return null;
  if (/^(http|www\.)/i.test(value)) return null;
  if (/:$/.test(value)) return null;
  if (/[{}<>\[\]]/.test(value)) return null;
  if (/\b(tripadvisor|start\.bg|google|maps|подобно на|също предлага)\b/i.test(value)) return null;
  if (/^(банско|разлог|добринище|българия)\s*:?$/i.test(value)) return null;
  if (value.length < 3 || value.length > 80) return null;
  return value;
}

async function verifyPlace(name, areaHint = '', radiusKm = 35) {
  if (!GOOGLE_API_KEY) return null;
  const input = `${name} ${areaHint}`.trim();
  const areaCenter = areaHint ? await geocode(areaHint) : null;
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(input)}&inputtype=textquery&fields=place_id,name,formatted_address,geometry&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  const data = await res.json();
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  if (!candidate?.place_id) return null;

  const loc = candidate?.geometry?.location;
  if (areaCenter && loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
    const km = haversineKm(areaCenter, { lat: loc.lat, lng: loc.lng });
    if (km > radiusKm) return null;
  }

  return {
    inputName: name,
    placeId: candidate.place_id,
    name: candidate.name || name,
    address: candidate.formatted_address || ''
  };
}

async function askChat(prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (DASHBOARD_API_KEY) headers['x-api-key'] = DASHBOARD_API_KEY;

  const body = {
    message: prompt,
    history: []
  };

  if (EVAL_CHAT_TOKEN) body.token = EVAL_CHAT_TOKEN;
  if (EVAL_AUTH_CODE) body.authCode = EVAL_AUTH_CODE;

  const res = await fetchWithRetry(CHAT_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${t}`);
  }

  const data = await res.json();
  return String(data?.response || '').trim();
}

async function ensureApiReachable() {
  try {
    const res = await fetchWithRetry(`${API_BASE_URL}/health`);
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status} ${res.statusText}`);
    }
  } catch (e) {
    const detail = e?.cause?.message || e?.message || String(e);
    throw new Error(`API is not reachable at ${API_BASE_URL}. Start the server or set EVAL_API_BASE_URL. Details: ${detail}`);
  }
}

async function evalRoute(test, reply) {
  const result = { pass: false, reason: '', details: {} };
  if (REFUSAL_RE.test(reply)) {
    result.reason = 'refusal';
    return result;
  }

  if (test.allowClarification && CLARIFICATION_RE.test(reply)) {
    result.pass = true;
    result.reason = 'clarification_ok';
    return result;
  }

  const destRaw = extractMapsDestination(reply);
  if (!destRaw) {
    result.reason = 'no_maps_destination';
    return result;
  }

  const expected = test.expectedLatLng || await geocode(test.expectedDestination);
  const actual = parseLatLng(destRaw) || await geocode(destRaw);

  if (!expected || !actual) {
    result.reason = 'could_not_geocode';
    result.details = { expected: Boolean(expected), actual: Boolean(actual), destRaw };
    return result;
  }

  const km = haversineKm(expected, actual);
  const maxKm = Number(test.maxDistanceKm || 20);
  result.pass = km <= maxKm;
  result.reason = result.pass ? 'ok' : 'destination_too_far';
  result.details = { km: Number(km.toFixed(2)), maxKm, destRaw };
  return result;
}

async function evalPoi(test, reply) {
  const result = { pass: false, reason: '', details: {} };
  if (REFUSAL_RE.test(reply)) {
    result.reason = 'refusal';
    return result;
  }

  const strictMode = test.strict !== false;
  const rawCandidates = extractCandidates(reply);
  const candidates = rawCandidates
    .map(cleanCandidate)
    .filter(Boolean);

  const minCandidates = Number(test.minCandidates || 3);
  if (candidates.length < minCandidates) {
    result.reason = strictMode ? 'too_few_clean_candidates' : 'too_few_candidates';
    result.details = { candidates, rawCandidates };
    return result;
  }

  const checks = await Promise.all(candidates.map(name => verifyPlace(name, test.areaHint || '', Number(test.maxRadiusKm || 35))));
  const verifiedRecords = checks.filter(Boolean);
  const verified = verifiedRecords.map(x => x.name);
  const minVerified = Number(test.minVerified || 2);

  result.pass = verified.length >= minVerified;
  result.reason = result.pass ? 'ok' : (strictMode ? 'too_few_verified_place_ids' : 'too_few_verified');
  result.details = { candidates, rawCandidates, verified, verifiedRecords };
  return result;
}

async function main() {
  const authMode = EVAL_CHAT_TOKEN
    ? 'token'
    : (EVAL_AUTH_CODE ? 'authCode' : 'none');
  const hasAuth = authMode !== 'none';
  console.log(`[EVAL] Base URL: ${API_BASE_URL}`);
  console.log(`[EVAL] Auth mode: ${authMode}`);

  await ensureApiReachable();

  const casesPath = process.argv[2] || path.join(process.cwd(), 'tools', 'auto-eval', 'cases.json');
  const raw = await fs.readFile(casesPath, 'utf-8');
  const cases = JSON.parse(raw);

  const rows = [];
  for (const t of cases) {
    try {
      const requiresAuth = t.requiresAuth !== false;
      if (requiresAuth && !hasAuth) {
        rows.push({
          id: t.id,
          type: t.type,
          pass: true,
          skipped: true,
          reason: 'auth_required',
          details: { authMode }
        });
        console.log(`[SKIP] ${t.id} -> auth_required`);
        continue;
      }

      let bestResult = null;
      let reply = '';
      for (let attempt = 1; attempt <= EVAL_CASE_ATTEMPTS; attempt += 1) {
        reply = await askChat(t.prompt);
        const evalResult = t.type === 'route'
          ? await evalRoute(t, reply)
          : await evalPoi(t, reply);

        if (!bestResult || evalResult.pass || bestResult.reason === 'refusal') {
          bestResult = evalResult;
        }

        if (evalResult.pass) break;
        if (!['refusal', 'no_maps_destination', 'too_few_clean_candidates'].includes(evalResult.reason)) break;
      }

      const details = { ...(bestResult?.details || {}), attempts: EVAL_CASE_ATTEMPTS };
      rows.push({ id: t.id, type: t.type, pass: Boolean(bestResult?.pass), skipped: false, reason: bestResult?.reason || 'runtime_error', details });
      console.log(`[${bestResult?.pass ? 'PASS' : 'FAIL'}] ${t.id} -> ${bestResult?.reason || 'runtime_error'}`);
    } catch (e) {
      rows.push({ id: t.id, type: t.type, pass: false, skipped: false, reason: 'runtime_error', details: { error: e?.cause?.message || e.message } });
      console.log(`[FAIL] ${t.id} -> runtime_error`);
    }
  }

  const skipped = rows.filter(r => r.skipped).length;
  const evaluatedRows = rows.filter(r => !r.skipped);
  const passed = evaluatedRows.filter(r => r.pass === true).length;
  const failed = evaluatedRows.filter(r => r.pass === false).length;
  const evaluableTotal = evaluatedRows.length;
  const total = rows.length;
  const isSkipOnly = evaluableTotal === 0 && skipped > 0;
  const passRate = isSkipOnly
    ? 100
    : Number(((passed / Math.max(evaluableTotal, 1)) * 100).toFixed(1));
  const status = failed > 0 ? 'FAIL' : (isSkipOnly ? 'SKIPPED' : 'PASS');
  const summary = {
    status,
    total,
    evaluated: evaluableTotal,
    skipped,
    passed,
    failed,
    passRate,
    rows
  };

  const outPath = path.join(process.cwd(), 'tools', 'auto-eval', 'result.json');
  await fs.writeFile(outPath, JSON.stringify(summary, null, 2), 'utf-8');

  console.log('\n=== SUMMARY ===');
  console.log(`Status: ${summary.status}`);
  console.log(`Total: ${summary.total}`);
  console.log(`Evaluated: ${summary.evaluated}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Passed: ${summary.passed}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Pass rate: ${summary.passRate}%`);
  if (isSkipOnly) {
    console.log('Note: All tests were skipped because auth is missing.');
  }
  console.log(`Saved: ${outPath}`);

  if (summary.failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
