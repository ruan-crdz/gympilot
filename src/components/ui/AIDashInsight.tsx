import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useAIStore } from '@/stores/useAIStore';
import { useProfileStore } from '@/stores/useProfileStore';
import { useHistoryStore } from '@/stores/useHistoryStore';
import { useWeightStore } from '@/stores/useWeightStore';
import { getAIConfigPrompt, SCIENCE_GUARDRAILS, useAIConfigStore } from '@/stores/useAIConfigStore';
import { getToday } from '@/utils/date';
import { invokeAI } from '@/utils/ai';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { RichText } from '@/components/ui/RichText';
import { resolveAIPlan } from '@/constants/aiPlan';

export function AIDashInsight() {
  const isEnabled = useAIStore((s) => s.isEnabled);
  const profile = useProfileStore((s) => s.profile);
  const assistantName = useAIConfigStore((s) => s.assistantName);
  const personality = useAIConfigStore((s) => s.personality);
  const aiPlan = resolveAIPlan(profile);
  const sessions = useHistoryStore((s) => s.sessions);
  const weightEntries = useWeightStore((s) => s.entries);
  const [insight, setInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isEnabled || !profile || aiPlan !== 'ultimate') return;

    const completedSessions = sessions.filter((s) => s.completedAt);
    if (completedSessions.length === 0) return;

    const storageKey = `fitflow-ai-insight-${assistantName}-${personality}-${getToday()}`;
    const cached = sessionStorage.getItem(storageKey);
    if (cached) {
      setInsight(cached);
      return;
    }

    setLoading(true);

    const recentWeight = weightEntries.slice(-7);
    const weightTrend = recentWeight.length >= 2
      ? `Peso: de ${recentWeight[0].weight}kg para ${recentWeight[recentWeight.length - 1].weight}kg nos últimos ${recentWeight.length} dias`
      : 'Sem dados de peso suficientes';
    const aiConfig = getAIConfigPrompt();

    invokeAI({
      messages: [
        {
          role: 'system',
          content: `Você é ${aiConfig.assistantName}. Sempre use esse nome se falar de você. ${aiConfig.personalityPrompt} Dê UM insight personalizado e motivador, máximo 2 frases curtas, baseado apenas nos dados reais. ${SCIENCE_GUARDRAILS}`,
        },
        {
          role: 'user',
          content: `Perfil: ${profile.name}, ${profile.age} anos, ${profile.weight}kg, objetivo: ${profile.goal === 'lose' ? 'emagrecer' : profile.goal === 'gain' ? 'hipertrofia' : 'manter'}. Treinos completos: ${completedSessions.length} total. ${weightTrend}`,
        },
      ],
      max_tokens: 100,
      temperature: 0.75,
    }, { feature: 'dashboard_insight' })
      .then((data) => {
        const text = data.choices?.[0]?.message?.content?.trim() || '';
        if (text) {
          setInsight(text);
          sessionStorage.setItem(storageKey, text);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isEnabled, profile, sessions, weightEntries, assistantName, personality, aiPlan]);

  if (!isEnabled) return null;

  if (aiPlan === 'free') {
    return (
      <motion.button
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={() => { window.location.hash = '#/profile'; }}
        className="card w-full text-left bg-gradient-to-br from-primary-500/10 to-primary-900/10 border-primary-500/20 space-y-2"
      >
        <div className="flex items-center gap-2">
          <MaterialIcon name="workspace_premium" className="text-primary-300" />
          <span className="text-xs font-semibold text-primary-300">Insight diário completo no Ultimate</span>
        </div>
        <p className="text-sm text-white/70 leading-relaxed">Desbloqueie insights personalizados com IA, reavaliação inteligente e relatórios semanais.</p>
      </motion.button>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="card bg-gradient-to-br from-primary-500/10 to-primary-900/10 border-primary-500/20 space-y-2"
    >
      <div className="flex items-center gap-2">
        <MaterialIcon name="smart_toy" className="text-primary-300" />
        <span className="text-xs font-semibold text-primary-300">{assistantName} Insight</span>
      </div>
      <p className="text-sm text-white/70 leading-relaxed">
        {loading ? (
          <span className="animate-pulse">Analisando seus dados...</span>
        ) : insight ? (
          <RichText text={insight} />
        ) : (
          'Continue treinando para receber insights personalizados!'
        )}
      </p>
    </motion.div>
  );
}
