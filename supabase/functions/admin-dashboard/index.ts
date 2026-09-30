import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

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

serve(async (req) => {
 try {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: { message: 'Metodo nao permitido.' } }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: { message: 'Configuracao administrativa incompleta.' } }, 500);
  }

  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData.user) return jsonResponse({ error: { message: 'Sessao invalida.' } }, 401);

  const { data: admin } = await serviceClient.from('app_admins').select('user_id').eq('user_id', userData.user.id).maybeSingle();
  if (!admin) return jsonResponse({ error: { message: 'Acesso exclusivo para administradores.' } }, 403);

  const now = Date.now();
  const isoDaysAgo = (days: number) => new Date(now - days * 86400000).toISOString();
  const users = [] as Array<{ id: string; created_at: string; last_sign_in_at?: string | null }>;
  let page = 1;
  while (true) {
    const { data, error } = await serviceClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return jsonResponse({ error: { message: 'Falha ao carregar usuarios.' } }, 500);
    users.push(...data.users.map((user) => ({ id: user.id, created_at: user.created_at, last_sign_in_at: user.last_sign_in_at })));
    if (data.users.length < 1000) break;
    page += 1;
  }

  const [snapshotsResult, subscriptionsResult, checkoutsResult, programsResult, postsResult, commentsResult] = await Promise.all([
    serviceClient.from('user_app_snapshots').select('user_id, updated_at'),
    serviceClient.from('user_ai_subscriptions').select('user_id, status, current_period_end, provider, provider_payment_id, billing_cycle'),
    serviceClient.from('billing_checkout_sessions').select('id, user_id, status, amount_cents, billing_cycle, provider_payment_id, created_at'),
    serviceClient.from('user_workout_programs').select('user_id').eq('status', 'active'),
    serviceClient.from('social_posts').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    serviceClient.from('social_post_comments').select('id', { count: 'exact', head: true }).is('deleted_at', null),
  ]);

  const queryError = snapshotsResult.error || subscriptionsResult.error || checkoutsResult.error || programsResult.error || postsResult.error || commentsResult.error;
  if (queryError) {
    console.error('admin-dashboard query failed', queryError);
    return jsonResponse({ error: { message: `Falha ao calcular métricas: ${queryError.message}` } }, 500);
  }

  const snapshots = snapshotsResult.data || [];
  const subscriptions = subscriptionsResult.data || [];
  const checkouts = checkoutsResult.data || [];
  const onboardedIds = new Set(snapshots.map((row) => row.user_id));
  const active7Ids = new Set(snapshots.filter((row) => row.updated_at >= isoDaysAgo(7)).map((row) => row.user_id));
  const active30Ids = new Set(snapshots.filter((row) => row.updated_at >= isoDaysAgo(30)).map((row) => row.user_id));
  const ultimateIds = new Set(subscriptions
    .filter((row) => row.status === 'active' && (!row.current_period_end || row.current_period_end > new Date().toISOString()))
    .map((row) => row.user_id));
  const paymentSubscriptions = subscriptions.filter((row) => row.provider === 'mercadopago' && row.provider_payment_id);
  const representedPaymentIds = new Set(paymentSubscriptions.map((row) => row.provider_payment_id));
  const matchedCheckoutIds = new Set<string>();
  let approvedRevenueCents = 0;

  // A provider payment id on a subscription is only persisted after Mercado Pago
  // confirms approval. Use it as the source of truth if a checkout status lagged.
  for (const subscription of paymentSubscriptions) {
    const checkout = checkouts.find((row) => row.provider_payment_id === subscription.provider_payment_id)
      || checkouts
        .filter((row) => row.user_id === subscription.user_id && row.billing_cycle === subscription.billing_cycle)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (checkout && !matchedCheckoutIds.has(checkout.id)) {
      approvedRevenueCents += Number(checkout.amount_cents || 0);
      matchedCheckoutIds.add(checkout.id);
    }
  }

  const approvedCheckouts = checkouts.filter((row) => row.status === 'approved');
  for (const checkout of approvedCheckouts) {
    const alreadyRepresented = matchedCheckoutIds.has(checkout.id)
      || Boolean(checkout.provider_payment_id && representedPaymentIds.has(checkout.provider_payment_id));
    if (!alreadyRepresented) approvedRevenueCents += Number(checkout.amount_cents || 0);
  }
  const checkoutUserIds = new Set(checkouts.map((row) => row.user_id));
  const approvedUserIds = new Set([
    ...approvedCheckouts.map((row) => row.user_id),
    ...paymentSubscriptions.map((row) => row.user_id),
  ]);
  const totalUsers = users.length;

  return jsonResponse({
    success: true,
    generatedAt: new Date().toISOString(),
    users: {
      total: totalUsers,
      new7d: users.filter((user) => user.created_at >= isoDaysAgo(7)).length,
      new30d: users.filter((user) => user.created_at >= isoDaysAgo(30)).length,
      onboarded: onboardedIds.size,
      incomplete: Math.max(0, totalUsers - onboardedIds.size),
      active7d: active7Ids.size,
      active30d: active30Ids.size,
      dormant30d: Math.max(0, onboardedIds.size - active30Ids.size),
    },
    business: {
      ultimate: ultimateIds.size,
      conversionPercent: totalUsers ? Math.round((ultimateIds.size / totalUsers) * 1000) / 10 : 0,
      checkoutUsers: checkoutUserIds.size,
      approvedUsers: approvedUserIds.size,
      checkoutConversionPercent: checkoutUserIds.size ? Math.round((approvedUserIds.size / checkoutUserIds.size) * 1000) / 10 : 0,
      approvedRevenueBrl: approvedRevenueCents / 100,
    },
    product: {
      activeWorkoutPrograms: new Set((programsResult.data || []).map((row) => row.user_id)).size,
      posts: postsResult.count || 0,
      comments: commentsResult.count || 0,
    },
  });
 } catch (error) {
   console.error('admin-dashboard unexpected failure', error);
   const detail = error instanceof Error ? error.message : 'erro desconhecido';
   return jsonResponse({ error: { message: `Falha inesperada no painel: ${detail}` } }, 500);
 }
});
