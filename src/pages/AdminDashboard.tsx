import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { supabase } from '@/lib/supabase';

interface AdminMetrics {
  generatedAt: string;
  users: { total: number; new7d: number; new30d: number; onboarded: number; incomplete: number; active7d: number; active30d: number; dormant30d: number };
  business: { ultimate: number; conversionPercent: number; checkoutUsers: number; approvedUsers: number; checkoutConversionPercent: number; approvedRevenueBrl: number };
  product: { activeWorkoutPrograms: number; posts: number; comments: number };
}

export function AdminDashboard() {
  const navigate = useNavigate();
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadMetrics = async () => {
    if (!supabase) return;
    setLoading(true);
    setError('');
    const { data, error: requestError } = await supabase.functions.invoke('admin-dashboard', { body: {} });
    if (requestError || !data?.success) {
      let message = data?.error?.message || '';
      const context = requestError && 'context' in requestError ? requestError.context : null;
      if (!message && context instanceof Response) {
        const payload = await context.clone().json().catch(() => null);
        message = payload?.error?.message || '';
      }
      setError(message || 'Não foi possível carregar o painel administrativo. Entre novamente e tente de novo.');
      setLoading(false);
      return;
    }
    setMetrics(data as AdminMetrics & { success: true });
    setLoading(false);
  };

  useEffect(() => {
    void loadMetrics();
  }, []);

  return (
    <div className="gym-page">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/profile')} className="gym-icon-tile" aria-label="Voltar"><MaterialIcon name="arrow_back" /></button>
          <div><p className="gym-kicker">Administração</p><h1 className="text-xl font-black">Desempenho do app</h1></div>
        </div>
        <button onClick={() => void loadMetrics()} disabled={loading} className="gym-icon-tile" aria-label="Atualizar métricas">
          <MaterialIcon name="refresh" className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && !metrics && <div className="card py-12 text-center text-sm text-white/40">Calculando métricas...</div>}
      {error && <div className="card border-red-500/25 text-sm text-red-300">{error}</div>}

      {metrics && (
        <>
          <section className="grid grid-cols-2 gap-3">
            <AdminMetric icon="group" label="Usuários" value={metrics.users.total} detail={`+${metrics.users.new7d} nos últimos 7 dias`} />
            <AdminMetric icon="bolt" label="Ativos em 7 dias" value={metrics.users.active7d} detail={`${metrics.users.active30d} ativos em 30 dias`} />
            <AdminMetric icon="workspace_premium" label="Ultimate" value={metrics.business.ultimate} detail={`${metrics.business.conversionPercent}% da base`} />
            <AdminMetric icon="payments" label="Receita aprovada" value={metrics.business.approvedRevenueBrl.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} detail={`${metrics.business.approvedUsers} compradores`} />
          </section>

          <AdminSection title="Funil de usuários" icon="filter_alt">
            <ProgressRow label="Contas criadas" value={metrics.users.total} total={metrics.users.total} />
            <ProgressRow label="Cadastro concluído" value={metrics.users.onboarded} total={metrics.users.total} />
            <ProgressRow label="Ativos em 30 dias" value={metrics.users.active30d} total={metrics.users.total} />
            <ProgressRow label="Ultimate" value={metrics.business.ultimate} total={metrics.users.total} />
          </AdminSection>

          <AdminSection title="Retenção e risco" icon="monitoring">
            <DataRow label="Novos usuários em 30 dias" value={metrics.users.new30d} />
            <DataRow label="Cadastros incompletos" value={metrics.users.incomplete} />
            <DataRow label="Sem atividade há 30 dias" value={metrics.users.dormant30d} />
            <p className="pt-2 text-[10px] leading-relaxed text-white/30">Inatividade é estimada pela última sincronização do app. Não significa cancelamento confirmado.</p>
          </AdminSection>

          <AdminSection title="Produto e comunidade" icon="fitness_center">
            <DataRow label="Usuários com treino ativo" value={metrics.product.activeWorkoutPrograms} />
            <DataRow label="Publicações" value={metrics.product.posts} />
            <DataRow label="Comentários" value={metrics.product.comments} />
            <DataRow label="Conversão do checkout" value={`${metrics.business.checkoutConversionPercent}%`} />
          </AdminSection>

          <p className="text-center text-[10px] text-white/25">Atualizado em {new Date(metrics.generatedAt).toLocaleString('pt-BR')}</p>
        </>
      )}
    </div>
  );
}

function AdminMetric({ icon, label, value, detail }: { icon: string; label: string; value: string | number; detail: string }) {
  return <div className="card min-h-32"><MaterialIcon name={icon} className="text-2xl text-primary-300" /><p className="mt-4 text-2xl font-black">{value}</p><p className="text-xs font-bold text-white/55">{label}</p><p className="mt-1 text-[10px] text-white/30">{detail}</p></div>;
}

function AdminSection({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return <section className="card space-y-3"><h2 className="flex items-center gap-2 text-sm font-black text-white/80"><MaterialIcon name={icon} className="text-xl text-primary-300" />{title}</h2>{children}</section>;
}

function DataRow({ label, value }: { label: string; value: string | number }) {
  return <div className="flex items-center justify-between border-b border-white/5 py-2 last:border-0"><span className="text-xs text-white/45">{label}</span><span className="text-sm font-black text-white/85">{value}</span></div>;
}

function ProgressRow({ label, value, total }: { label: string; value: number; total: number }) {
  const percent = total ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return <div><div className="mb-1.5 flex justify-between text-xs"><span className="text-white/50">{label}</span><span className="font-bold text-white/75">{value} · {percent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-primary-500" style={{ width: `${percent}%` }} /></div></div>;
}
