import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type BillingCycle = 'monthly' | 'annual';

type CheckoutRequest = {
  cycle?: BillingCycle;
};

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

function priceForCycle(cycle: BillingCycle): number {
  const monthly = Number(Deno.env.get('BILLING_MONTHLY_BRL') || '19.9');
  const annual = Number(Deno.env.get('BILLING_ANNUAL_BRL') || '199');
  return cycle === 'annual' ? annual : monthly;
}

function titleForCycle(cycle: BillingCycle): string {
  return cycle === 'annual' ? 'GymPilot Ultimate - Anual' : 'GymPilot Ultimate - Mensal';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: { message: 'Método não permitido.' } }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const mercadoPagoToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  const appBaseUrl = Deno.env.get('APP_BASE_URL');

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return jsonResponse({ error: { message: 'Secrets do Supabase não configurados.' } }, 500);
  }

  if (!mercadoPagoToken) {
    return jsonResponse({ error: { message: 'MERCADOPAGO_ACCESS_TOKEN não configurado.' } }, 500);
  }

  if (!appBaseUrl) {
    return jsonResponse({ error: { message: 'APP_BASE_URL não configurado.' } }, 500);
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

  let body: CheckoutRequest;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const cycle: BillingCycle = body.cycle === 'annual' ? 'annual' : 'monthly';
  const unitPrice = priceForCycle(cycle);
  const amountCents = Math.round(unitPrice * 100);
  const user = userData.user;

  const externalReference = `${user.id}:${cycle}:${Date.now()}`;
  const notificationUrl = `${supabaseUrl}/functions/v1/billing-webhook`;

  const prefPayload = {
    items: [
      {
        title: titleForCycle(cycle),
        quantity: 1,
        currency_id: 'BRL',
        unit_price: unitPrice,
      },
    ],
    payer: {
      email: user.email,
    },
    back_urls: {
      success: `${appBaseUrl}#/profile?billing=success`,
      pending: `${appBaseUrl}#/profile?billing=pending`,
      failure: `${appBaseUrl}#/profile?billing=failure`,
    },
    auto_return: 'approved',
    external_reference: externalReference,
    notification_url: notificationUrl,
    metadata: {
      user_id: user.id,
      cycle,
      plan: 'ultimate',
    },
  };

  const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mercadoPagoToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(prefPayload),
  });

  const mpText = await mpResp.text();
  let mpData: Record<string, unknown> = {};
  try {
    mpData = mpText ? JSON.parse(mpText) as Record<string, unknown> : {};
  } catch {
    return jsonResponse({ error: { message: 'Resposta inválida do Mercado Pago.' } }, 502);
  }

  if (!mpResp.ok) {
    const cause = typeof mpData.message === 'string' ? mpData.message : `Falha no checkout (${mpResp.status}).`;
    return jsonResponse({ error: { message: cause } }, 502);
  }

  const checkoutUrl = (mpData.init_point as string | undefined)
    || (mpData.sandbox_init_point as string | undefined)
    || null;

  if (!checkoutUrl) {
    return jsonResponse({
      error: {
        message: 'Mercado Pago não retornou URL de checkout válida para este pagamento.',
      },
    }, 502);
  }

  const providerReference = externalReference;

  await serviceClient.from('billing_checkout_sessions').insert({
    user_id: user.id,
    provider: 'mercadopago',
    plan: 'ultimate',
    billing_cycle: cycle,
    amount_cents: amountCents,
    currency: 'BRL',
    status: 'created',
    checkout_url: checkoutUrl,
    provider_reference: providerReference,
    provider_payload: mpData,
  });

  return jsonResponse({
    success: true,
    checkoutUrl,
    providerReference,
    cycle,
    amount: unitPrice,
    currency: 'BRL',
  });
});
