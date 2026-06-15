const SUPABASE_URL  = 'https://otyvkolsfbipzmonpwzf.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90eXZrb2xzZmJpcHptb25wd3pmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MDQ3MDksImV4cCI6MjA5MzI4MDcwOX0.5OTfTnAqOjtZegi9IcSyRRCZppMrtSOwgGOEnvyj47o'
const TLDR_FN       = `${SUPABASE_URL}/functions/v1/tldr`
const AUTH_URL      = `${SUPABASE_URL}/auth/v1`

// ── Token storage ──────────────────────────────────────────────

async function getSession() {
  return new Promise(resolve =>
    chrome.storage.local.get(['kani_access_token', 'kani_refresh_token', 'kani_expires_at'], resolve)
  )
}

async function setSession({ access_token, refresh_token, expires_in }) {
  await chrome.storage.local.set({
    kani_access_token:  access_token,
    kani_refresh_token: refresh_token,
    kani_expires_at:    Date.now() + (expires_in * 1000)
  })
}

async function clearSession() {
  await chrome.storage.local.remove(['kani_access_token', 'kani_refresh_token', 'kani_expires_at'])
}

// ── Token refresh ──────────────────────────────────────────────

async function refreshToken(refresh_token) {
  const res = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token })
  })
  if (!res.ok) { await clearSession(); return null }
  const data = await res.json()
  await setSession(data)
  return data.access_token
}

// ── Get valid access token (refreshes if needed) ───────────────

async function getValidToken() {
  const s = await getSession()
  if (!s.kani_access_token) return null
  if (Date.now() < s.kani_expires_at - 60000) return s.kani_access_token
  return refreshToken(s.kani_refresh_token)
}

// ── Google sign-in via Supabase OAuth ──────────────────────────

async function signIn() {
  const redirectURL = chrome.identity.getRedirectURL('auth')
  const authURL = `${AUTH_URL}/authorize?provider=google` +
    `&redirect_to=${encodeURIComponent(redirectURL)}&flow_type=implicit`

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authURL, interactive: true }, async (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        reject(chrome.runtime.lastError?.message || 'Auth cancelled')
        return
      }
      const hash = new URL(responseUrl).hash.slice(1)
      const params = Object.fromEntries(new URLSearchParams(hash))
      if (!params.access_token) { reject('No token in response'); return }
      await setSession(params)
      resolve({ success: true })
    })
  })
}

// ── TLDR fetch ─────────────────────────────────────────────────

async function fetchTldr(text) {
  const token = await getValidToken()
  if (!token) return { error: 'AUTH_REQUIRED' }

  const res = await fetch(TLDR_FN, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text })
  })

  if (res.status === 401) { await clearSession(); return { error: 'AUTH_REQUIRED' } }
  if (res.status === 403) return { error: 'TRIAL_EXHAUSTED' }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}))
    if (body.error === 'rate_limited') return { error: 'RATE_LIMITED' }
    return { error: 'DAILY_LIMIT_REACHED' }
  }
  if (!res.ok) return { error: 'SERVER_ERROR' }
  return { data: await res.json() }
}

// ── Message handler ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_TLDR') {
    fetchTldr(msg.text).then(sendResponse)
    return true
  }
  if (msg.type === 'SIGN_IN') {
    signIn().then(sendResponse).catch(err => sendResponse({ error: err }))
    return true
  }
  if (msg.type === 'SIGN_OUT') {
    clearSession().then(() => sendResponse({ success: true }))
    return true
  }
  if (msg.type === 'GET_AUTH_STATE') {
    getValidToken().then(token => sendResponse({ isSignedIn: !!token }))
    return true
  }
})
