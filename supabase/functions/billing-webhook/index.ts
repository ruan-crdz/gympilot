import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type BillingCycle = 'monthly' | 'annual';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

function parseCycle(metadata: Record<string, unknown>): BillingCycle {
  return metadata.cycle === 'annual' ? 'annual' : 'monthly';
}

function periodEndForCycle(cycle: BillingCycle) {
  const days = cycle === 'annual' ? 365 : 30;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: { message: 'Método não permitido.' } }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const mercadoPagoToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');

  if (!supabaseUrl || !supabaseServiceRoleKey || !mercadoPagoToken) {
    return jsonResponse({ error: { message: 'Secrets obrigatórios não configurados.' } }, 500);
  }

  const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const url = new URL(req.url);
  const queryType = url.searchParams.get('type') || url.searchParams.get('topic') || '';
  const queryId = url.searchParams.get('data.id') || url.searchParams.get('id') || '';

  const bodyType = typeof payload.type === 'string' ? payload.type : '';
  const bodyData = payload.data as Record<string, unknown> | undefined;
  const bodyId = bodyData && typeof bodyData.id === 'string'
    ? bodyData.id
    : (bodyData && typeof bodyData.id === 'number' ? String(bodyData.id) : '');

  const eventType = queryType || bodyType;
  const paymentId = queryId || bodyId;

  if (!eventType || !paymentId || (eventType !== 'payment' && eventType !== 'topic')) {
    return jsonResponse({ success: true, ignored: true });
  }

  const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: {
      Authorization: `Bearer ${mercadoPagoToken}`,
    },
  });

  const mpText = await mpResp.text();
  let payment: Record<string, unknown> = {};
  try {
    payment = mpText ? JSON.parse(mpText) as Record<string, unknown> : {};
  } catch {
    return jsonResponse({ error: { message: 'Resposta inválida de pagamento.' } }, 502);
  }

  if (!mpResp.ok) {
    return jsonResponse({ error: { message: 'Falha ao consultar pagamento no provedor.' } }, 502);
  }

  const status = typeof payment.status === 'string' ? payment.status : 'unknown';
  const metadata = (payment.metadata as Record<string, unknown> | undefined) || {};
  const userId = typeof metadata.user_id === 'string' ? metadata.user_id : '';
  const cycle = parseCycle(metadata);
  const externalReference = typeof payment.external_reference === 'string' ? payment.external_reference : null;

  if (!userId) {
    return jsonResponse({ success: true, ignored: true, reason: 'missing_user_id' });
  }

  const checkoutUpdate: Record<string, unknown> = {
    status: status === 'approved' ? 'approved' : (status === 'pending' ? 'pending' : 'rejected'),
    provider_payload: payment,
  };

  if (externalReference) {
    const { error: checkoutUpdateError } = await serviceClient
      .from('billing_checkout_sessions')
      .update(checkoutUpdate)
      .eq('provider_reference', externalReference);

    if (checkoutUpdateError) {
      return jsonResponse({ error: { message: 'Falha ao atualizar a sessao de checkout.' } }, 500);
    }
  }

  if (status !== 'approved') {
    return jsonResponse({ success: true, status });
  }

  const periodEnd = periodEndForCycle(cycle);

  const { data: existingSubscription, error: existingSubscriptionError } = await serviceClient
    .from('user_ai_subscriptions')
    .select('id')
    .eq('provider_payment_id', String(paymentId))
    .maybeSingle();

  if (existingSubscriptionError) {
    return jsonResponse({ error: { message: 'Falha ao verificar pagamento processado.' } }, 500);
  }

  if (!existingSubscription) {
    const { error: subscriptionError } = await serviceClient
      .from('user_ai_subscriptions')
      .insert({
      user_id: userId,
      plan: 'ultimate',
      status: 'active',
      billing_cycle: cycle,
      provider: 'mercadopago',
      source: 'webhook',
      provider_payment_id: String(paymentId),
      started_at: new Date().toISOString(),
      current_period_end: periodEnd,
      note: `Pagamento aprovado (${cycle})`,
    });

    if (subscriptionError) {
      return jsonResponse({ error: { message: 'Pagamento aprovado, mas houve falha ao liberar o Ultimate.' } }, 500);
    }
  }

  return jsonResponse({ success: true, status: 'approved', userId, cycle, periodEnd });
});
