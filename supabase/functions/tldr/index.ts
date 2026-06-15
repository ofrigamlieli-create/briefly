import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_KEY  = Deno.env.get('ANTHROPIC_API_KEY')!
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const FREE_LIMIT  = 30   // lifetime requests for free plan
const DAILY_LIMIT = 200  // requests per day for pro plan
const RATE_WINDOW = 60   // seconds
const RATE_MAX    = 10   // max requests within RATE_WINDOW

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // Validate auth token
  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return new Response('Unauthorized', { status: 401, headers: corsHeaders })

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return new Response('Unauthorized', { status: 401, headers: corsHeaders })

  const { text } = await req.json()
  if (!text || text.trim().length < 20) {
    return new Response('Text too short', { status: 400, headers: corsHeaders })
  }

  // ── Per-minute rate limit (uses existing usage_logs) ───────────
  const windowStart = new Date(Date.now() - RATE_WINDOW * 1000).toISOString()
  const { count: recentCount } = await supabase
    .from('usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('created_at', windowStart)

  if ((recentCount ?? 0) >= RATE_MAX) {
    return json({ error: 'rate_limited' }, 429)
  }

  // ── Quota check ────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  // Upsert quota row so every user has one
  await supabase.from('user_quotas').upsert(
    { user_id: user.id },
    { onConflict: 'user_id', ignoreDuplicates: true }
  )

  const { data: quota } = await supabase
    .from('user_quotas')
    .select('plan, requests_today, requests_total, last_reset_date')
    .eq('user_id', user.id)
    .single()

  if (!quota) return json({ error: 'server_error' }, 500)

  // Reset daily counter if the date rolled over
  let requestsToday = quota.requests_today
  if (quota.last_reset_date !== today) {
    requestsToday = 0
    await supabase.from('user_quotas')
      .update({ requests_today: 0, last_reset_date: today })
      .eq('user_id', user.id)
  }

  if (quota.plan === 'free' && quota.requests_total >= FREE_LIMIT) {
    return json({ error: 'trial_exhausted' }, 403)
  }

  if (quota.plan === 'pro' && requestsToday >= DAILY_LIMIT) {
    return json({ error: 'daily_limit_reached' }, 429)
  }

  // ── Claude API call ────────────────────────────────────────────
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Summarize the following text in three ways. Return only valid JSON with keys "short" (1-2 sentences), "bullets" (array of 3-5 strings), and "simple" (plain-language explanation, 2-3 sentences).

Text:
${text.slice(0, 4000)}`
      }]
    })
  })

  const claude = await response.json()
  const raw = claude.content?.[0]?.text?.trim()

  // ── Increment counters + log usage (fire and forget) ───────────
  supabase.from('user_quotas')
    .update({
      requests_today: requestsToday + 1,
      requests_total: quota.requests_total + 1,
    })
    .eq('user_id', user.id)
    .then(() => {})

  supabase.from('usage_logs').insert({
    user_id: user.id,
    feature: 'tldr',
    input_word_count: text.split(/\s+/).length,
    model: 'claude-haiku-4-5-20251001',
  }).then(() => {})

  let result
  try {
    const jsonStr = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '')
    result = JSON.parse(jsonStr)
  } catch {
    return new Response('Parse error', { status: 500, headers: corsHeaders })
  }

  return json(result)
})
