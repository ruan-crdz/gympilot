import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type AIPlan = 'free' | 'ultimate';

type AIFeature =
  | 'chat'
  | 'dashboard_insight'
  | 'workout_tip'
  | 'meal_calc'
  | 'workout_builder'
  | 'weekly_report'
  | 'post_workout_feedback'
  | 'meal_photo'
  | 'plan_reeval';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FREE_FEATURES = new Set<AIFeature>([
  'workout_builder',
]);

const FREE_WORKOUT_TRIAL_MAX_CALLS = 6;
const FREE_WORKOUT_TRIAL_WINDOW_MINUTES = 30;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: { message: 'Método não permitido.' } }, 405);
  }

  const openAiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openAiKey) {
    return jsonResponse({ error: { message: 'OPENAI_API_KEY não configurada nos secrets do Supabase.' } }, 500);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return jsonResponse({ error: { message: 'Secrets do Supabase não configurados.' } }, 500);
  }

  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return jsonResponse({ error: { message: 'Token de autenticação ausente.' } }, 401);
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData.user) {
    return jsonResponse({ error: { message: 'Sessão inválida.' } }, 401);
  }

  let body: {
    feature?: AIFeature;
    payload?: Record<string, unknown>;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: { message: 'Payload inválido.' } }, 400);
  }

  const { data: entitlement } = await serviceClient
    .from('user_ai_subscriptions')
    .select('plan, status, current_period_end')
    .eq('user_id', userData.user.id)
    .eq('status', 'active')
    .order('current_period_end', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const nowIso = new Date().toISOString();
  const hasUltimate = entitlement
    && entitlement.plan === 'ultimate'
    && (!entitlement.current_period_end || entitlement.current_period_end > nowIso);

  const plan: AIPlan = hasUltimate ? 'ultimate' : 'free';
  const feature = body.feature || 'chat';

  if (plan === 'free' && !FREE_FEATURES.has(feature)) {
    return jsonResponse({
      error: {
        message: 'Esse recurso faz parte do GymPilot Ultimate.',
      },
    });
  }

  const payload = body.payload || {};
  const trialSessionId = typeof payload.trial_session_id === 'string'
    ? payload.trial_session_id.trim()
    : '';
  let trialCallCount = 0;

  if (plan === 'free' && feature === 'workout_builder') {
    const now = new Date();

    const { data: trialRow } = await serviceClient
      .from('user_ai_free_trials')
      .select('trial_session_id, trial_call_count, trial_expires_at')
      .eq('user_id', userData.user.id)
      .maybeSingle();

    if (!trialRow) {
      if (!trialSessionId) {
        return jsonResponse({
          error: {
            message: 'Não conseguimos iniciar seu teste grátis de IA. Tente novamente pelo app.',
          },
        }, 400);
      }

      const trialExpiresAt = new Date(now.getTime() + FREE_WORKOUT_TRIAL_WINDOW_MINUTES * 60_000).toISOString();
      await serviceClient
        .from('user_ai_free_trials')
        .insert({
          user_id: userData.user.id,
          trial_session_id: trialSessionId,
          trial_call_count: 0,
          trial_expires_at: trialExpiresAt,
        });
      trialCallCount = 0;
    } else {
      const isExpired = trialRow.trial_expires_at
        ? new Date(trialRow.trial_expires_at).getTime() < now.getTime()
        : true;

      const sessionMatches = !!trialSessionId && trialRow.trial_session_id === trialSessionId;
      trialCallCount = Number(trialRow.trial_call_count || 0);
      const callsExceeded = trialCallCount >= FREE_WORKOUT_TRIAL_MAX_CALLS;

      if (isExpired || !sessionMatches || callsExceeded) {
        return jsonResponse({
          error: {
            message: 'Você já usou seu treino grátis com IA. Para continuar, assine o GymPilot Ultimate.',
          },
        }, 402);
      }
    }
  }

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: { message: 'Mensagens não informadas.' } }, 400);
  }

  const modelFree = Deno.env.get('OPENAI_MODEL_FREE') || 'gpt-4o-mini';
  const modelUltimate = Deno.env.get('OPENAI_MODEL_ULTIMATE') || 'gpt-4o';
  const workoutBuilderModel = Deno.env.get('OPENAI_MODEL_WORKOUT_BUILDER') || modelUltimate;
  const model = feature === 'workout_builder'
    ? workoutBuilderModel
    : (plan === 'ultimate' ? modelUltimate : modelFree);
  const maxTokensCap = feature === 'workout_builder'
    ? 4000
    : (plan === 'ultimate' ? 4000 : 1200);

  const requestedTokens = typeof payload.max_tokens === 'number'
    ? payload.max_tokens
    : undefined;

  const { trial_session_id: _trialSessionId, ...providerPayload } = payload;

  const safePayload: Record<string, unknown> = {
    ...providerPayload,
    model,
    stream: false,
  };

  if (feature === 'workout_builder') {
    const requestedTemperature = typeof payload.temperature === 'number'
      ? payload.temperature
      : 0.35;
    safePayload.temperature = Math.max(0, Math.min(requestedTemperature, 0.4));
  }

  if (typeof requestedTokens === 'number') {
    safePayload.max_tokens = Math.min(requestedTokens, maxTokensCap);
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(safePayload),
    });

    const raw = await response.text();
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: { message: 'Resposta inválida do provedor de IA.' } });
    }

    if (!response.ok) {
      const providerError = (parsed.error as { message?: string } | undefined)?.message;
      return jsonResponse({
        error: {
          message: providerError || `Falha no provedor de IA (${response.status}).`,
        },
      });
    }

    if (plan === 'free' && feature === 'workout_builder') {
      await serviceClient
        .from('user_ai_free_trials')
        .update({
          trial_call_count: trialCallCount + 1,
        })
        .eq('user_id', userData.user.id);
    }

    return jsonResponse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao chamar provedor de IA.';
    return jsonResponse({ error: { message } });
  }
});
