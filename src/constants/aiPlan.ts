import type { Profile } from '@/types';

export type AIPlan = 'free' | 'ultimate';

export type AIFeature =
  | 'chat'
  | 'dashboard_insight'
  | 'workout_tip'
  | 'meal_calc'
  | 'workout_builder'
  | 'weekly_report'
  | 'post_workout_feedback'
  | 'meal_photo'
  | 'plan_reeval';

const FREE_FEATURES = new Set<AIFeature>([
  'workout_builder',
]);

const FEATURE_LABELS: Record<AIFeature, string> = {
  chat: 'Chat com IA',
  dashboard_insight: 'Insight diário',
  workout_tip: 'Dica rápida de exercício',
  meal_calc: 'Cálculo de refeição',
  workout_builder: 'Montagem de treino',
  weekly_report: 'Relatório semanal de performance',
  post_workout_feedback: 'Feedback pós-treino avançado',
  meal_photo: 'Leitura de refeição por foto',
  plan_reeval: 'Reavaliação inteligente de treino',
};

export function resolveAIPlan(profile: Profile | null | undefined): AIPlan {
  return profile?.aiPlan === 'ultimate' ? 'ultimate' : 'free';
}

export function isAIFeatureEnabled(plan: AIPlan, feature: AIFeature): boolean {
  return plan === 'ultimate' || FREE_FEATURES.has(feature);
}

export function getUpgradeMessage(feature: AIFeature): string {
  if (feature === 'workout_builder') {
    return 'Você já usou seu treino grátis com IA. Para continuar com IA, assine o GymPilot Ultimate.';
  }
  return `${FEATURE_LABELS[feature]} faz parte do GymPilot Ultimate.`;
}

export function planLabel(plan: AIPlan): string {
  return plan === 'ultimate' ? 'Ultimate' : 'Free';
}
