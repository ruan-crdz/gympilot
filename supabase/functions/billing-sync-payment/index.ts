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
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function periodEndForCycle(cycle: BillingCycle) {
  const days = cycle === 'annual' ? 365 : 30;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: { message: 'Metodo nao permitido.' } }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const mercadoPagoToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !mercadoPagoToken) {
    return jsonResponse({ error: { message: 'Configuracao de pagamento incompleta.' } }, 500);
  }

  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return jsonResponse({ error: { message: 'Sessao ausente.' } }, 401);

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData.user) return jsonResponse({ error: { message: 'Sessao invalida.' } }, 401);

  const { data: checkout, error: checkoutError } = await serviceClient
    .from('billing_checkout_sessions')
    .select('id, provider_reference, billing_cycle')
    .eq('user_id', userData.user.id)
    .eq('provider', 'mercadopago')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (checkoutError) return jsonResponse({ error: { message: 'Falha ao localizar o checkout.' } }, 500);
  if (!checkout?.provider_reference) return jsonResponse({ success: true, status: 'not_found' });

  const searchUrl = new URL('https://api.mercadopago.com/v1/payments/search');
  searchUrl.searchParams.set('external_reference', checkout.provider_reference);
  searchUrl.searchParams.set('sort', 'date_created');
  searchUrl.searchParams.set('criteria', 'desc');

  const paymentResponse = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${mercadoPagoToken}` },
  });
  const paymentPayload = await paymentResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!paymentResponse.ok) return jsonResponse({ error: { message: 'Falha ao consultar o Mercado Pago.' } }, 502);

  const results = Array.isArray(paymentPayload.results) ? paymentPayload.results as Record<string, unknown>[] : [];
  const payment = results[0];
  if (!payment) return jsonResponse({ success: true, status: 'pending' });

  const metadata = (payment.metadata as Record<string, unknown> | undefined) || {};
  if (metadata.user_id !== userData.user.id || payment.external_reference !== checkout.provider_reference) {
    return jsonResponse({ error: { message: 'Pagamento nao pertence a este usuario.' } }, 403);
  }

  const paymentId = String(payment.id || '');
  const status = typeof payment.status === 'string' ? payment.status : 'pending';
  const { error: checkoutUpdateError } = await serviceClient
    .from('billing_checkout_sessions')
    .update({
      status: status === 'approved' ? 'approved' : status,
      provider_payment_id: paymentId || null,
      provider_payload: payment,
    })
    .eq('id', checkout.id);

  if (checkoutUpdateError) {
    return jsonResponse({ error: { message: 'Falha ao atualizar o status do pagamento.' } }, 500);
  }

  if (status !== 'approved' || !paymentId) return jsonResponse({ success: true, status: 'pending' });

  const { data: existing, error: existingError } = await serviceClient
    .from('user_ai_subscriptions')
    .select('id')
    .eq('provider_payment_id', paymentId)
    .maybeSingle();
  if (existingError) return jsonResponse({ error: { message: 'Falha ao verificar a assinatura.' } }, 500);

  if (!existing) {
    const cycle: BillingCycle = checkout.billing_cycle === 'annual' ? 'annual' : 'monthly';
    const { error: insertError } = await serviceClient.from('user_ai_subscriptions').insert({
      user_id: userData.user.id,
      plan: 'ultimate',
      status: 'active',
      billing_cycle: cycle,
      provider: 'mercadopago',
      source: 'webhook',
      provider_payment_id: paymentId,
      started_at: new Date().toISOString(),
      current_period_end: periodEndForCycle(cycle),
      note: `Pagamento reconciliado (${cycle})`,
    });
    if (insertError) return jsonResponse({ error: { message: 'Pagamento aprovado, mas falhou ao liberar o Ultimate.' } }, 500);
  }

  return jsonResponse({ success: true, status: 'approved' });
});
