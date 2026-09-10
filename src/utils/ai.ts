import { useProfileStore } from '@/stores/useProfileStore';
import { useCycleStore, CYCLE_PHASES } from '@/stores/useCycleStore';
import { useFoodStore } from '@/stores/useFoodStore';
import { useWaterStore } from '@/stores/useWaterStore';
import { useWeightStore } from '@/stores/useWeightStore';
import { useHistoryStore } from '@/stores/useHistoryStore';
import { useCustomWorkoutStore } from '@/stores/useCustomWorkoutStore';
import { useHealthIntegrationStore } from '@/stores/useHealthIntegrationStore';
import { getAIConfigPrompt, SCIENCE_GUARDRAILS } from '@/stores/useAIConfigStore';
import { calculateTDEE, calculateMacros } from '@/utils/calories';
import { buildEvidenceContext, extractSourceIds, getEvidenceByIds, getEvidenceForQuery, isScientificQuery } from '@/utils/evidence';
import { calculateWaterIntake } from '@/utils/water';
import { buildProfilePromptLines } from '@/utils/promptContext';
import { buildKnowledgeContextForAI } from '@/utils/aiKnowledge';
import type { Profile, WorkoutType } from '@/types';
import { EXERCISE_CATALOG } from '@/constants/exerciseCatalog';
import { supabase } from '@/lib/supabase';
import { getUpgradeMessage, isAIFeatureEnabled, resolveAIPlan, type AIFeature } from '@/constants/aiPlan';

const BASE_SYSTEM_PROMPT = `Você é a GymPilot AI, assistente fitness pessoal integrada ao app GymPilot.
Você é direta, motivadora e científica. Responde em português brasileiro.
Seu tom é como uma personal trainer amiga: próxima, encorajadora, mas embasada.

Você recebeu um snapshot recente dos dados do aluno:
- Perfil completo (peso, altura, idade, objetivo, nível)
- Alimentação do dia (tudo que comeu, calorias, macros)
- Hidratação do dia (copos de água)
- Programa de treino atual (exercícios por treino)
- Histórico de treinos (frequência, sequência)
- Evolução de peso
- Fase do ciclo menstrual (se aplicável)

USE ESSES DADOS ATIVAMENTE nas respostas. Se perguntarem sobre mal-estar, trate alimentação e hidratação apenas como possíveis fatores.
Se perguntarem sobre desempenho, correlacione com nutrição e hidratação.
Dê alertas proativos (ex: "você só tomou 500ml de água, beba mais antes do treino").

Regras:
- Respostas curtas e práticas: no chat, responda em no máximo 2 parágrafos curtos ou 4 bullets.
- Quando falar de nutrição/treino, seja baseada em evidências
- Use emojis com moderação
- Nunca invente dados ou números sem base — use os dados reais fornecidos
- Se não souber algo, diga que não sabe
- Adapte conselhos ao perfil do aluno
- Se a fase do ciclo menstrual estiver informada, use como contexto e não como regra automática
- Quando o aluno reportar sintomas (mal-estar, dor de cabeça, fraqueza), analise os dados para contexto sem afirmar diagnóstico ou causalidade como certeza`;

function getSystemPrompt(): string {
  const { assistantName, personalityPrompt, personality } = getAIConfigPrompt();
  const toneLine = personality === 'tough'
    ? 'Seu tom é de bronca forte, cobrança prática e energia de acordar o aluno para agir agora. Mesmo dando bronca, seja curto: 1 chamada de atenção + 2 passos práticos.'
    : 'Seu tom é como uma personal trainer amiga: próxima, encorajadora, mas embasada.';
  return BASE_SYSTEM_PROMPT
    .replace('GymPilot AI', assistantName)
    .replace('Você é direta, motivadora e científica.', `Personalidade configurada: ${personalityPrompt}`)
    .replace('Seu tom é como uma personal trainer amiga: próxima, encorajadora, mas embasada.', toneLine)
    + `\n- Sempre que precisar falar seu nome, use exatamente: ${assistantName}.\n`
    + SCIENCE_GUARDRAILS;
}

const ACTION_PROMPT = `

AÇÕES NO APP:
- Se o aluno pedir para trocar, substituir ou renomear exercício no treino, confirme a intenção em texto curto e inclua no FINAL um bloco de ação oculto.
- Formato exato: [ACTION:{"type":"replace_exercise","scope":"all|workout","workoutType":"A|B|C|D|E","fromName":"nome atual","toName":"nome exato do catálogo"}]
- Use scope "workout" quando o aluno citar treino A/B/C/D/E; use scope "all" quando pedir troca geral.
- O toName deve existir exatamente no catálogo. Não inclua ACTION se não houver pedido claro de alteração.`;

function buildContext(profile: Profile): string {
  const cycle = useCycleStore.getState();
  const cycleInfo = cycle.phase !== 'none'
    ? `\n- Fase do ciclo: ${CYCLE_PHASES.find((c) => c.value === cycle.phase)?.label} (${CYCLE_PHASES.find((c) => c.value === cycle.phase)?.tip})`
    : '';

  const levelLabel = profile.experienceLevel === 'advanced' ? 'avançado'
    : profile.experienceLevel === 'intermediate' ? 'intermediário' : 'iniciante';
  const goalLabel = profile.goal === 'lose' ? 'perder gordura'
    : profile.goal === 'gain' ? 'ganhar massa' : 'manter peso';
  const profileLines = buildProfilePromptLines(profile);

  // Nutrition context
  const foodStore = useFoodStore.getState();
  const todayEntries = foodStore.getTodayEntries();
  const todayTotals = foodStore.getTodayTotals();
  const tdee = calculateTDEE(profile);
  const macroGoals = calculateMacros(tdee, profile.goal);
  const foodList = todayEntries.length > 0
    ? todayEntries.map((e) => `  • ${e.time} — ${e.name} (${e.calories}kcal, P:${e.protein}g C:${e.carbs}g G:${e.fat}g)`).join('\n')
    : '  Nenhuma refeição registrada hoje';

  // Water context
  const waterGlasses = useWaterStore.getState().getToday();
  const waterGoalGlasses = Math.round(calculateWaterIntake(profile.weight) * 4);
  const waterMl = waterGlasses * 250;
  const waterGoalMl = waterGoalGlasses * 250;
  const health = useHealthIntegrationStore.getState().getTodaySummary();

  // Weight trend
  const weightEntries = useWeightStore.getState().entries;
  const recentWeights = weightEntries.slice(-5);
  const weightTrend = recentWeights.length > 1
    ? `Últimos pesos: ${recentWeights.map((w) => `${w.date.slice(5)}: ${w.weight}kg`).join(', ')}`
    : '';

  // Workout history
  const history = useHistoryStore.getState();
  const totalWorkouts = history.getTotalWorkouts();
  const streak = history.getCurrentStreak();
  const lastSessions = history.sessions.slice(0, 3);
  const historyText = lastSessions.length > 0
    ? lastSessions.map((s) => {
      const label = s.workoutType ? `Treino ${s.workoutType}` : s.activityName || 'Atividade avulsa';
      return `  • ${s.date} — ${label} (${s.durationMs ? Math.round(s.durationMs / 60000) + 'min' : '?'}${s.completedAt ? ', completo' : ', incompleto'})`;
    }).join('\n')
    : '  Nenhum treino registrado';

  // Current program
  const customStore = useCustomWorkoutStore.getState();
  const activeSlots = customStore.activeSlots;
  const programText = activeSlots.map((type) => {
    const exs = customStore.getExercises(type);
    return `  Treino ${type}: ${exs.length} exercícios (${exs.map((e) => e.name).join(', ')})`;
  }).join('\n');

  return `
Dados do aluno:
- Objetivo: ${goalLabel}
- Nível: ${levelLabel}${cycleInfo}
${profileLines.map((line) => `- ${line}`).join('\n')}
- TDEE estimado: ${tdee} kcal/dia
- Atividade hoje: ${health.steps} passos, ${health.activeCalories} kcal ativas, fonte ${health.source}
${weightTrend ? `- ${weightTrend}` : ''}

ALIMENTAÇÃO HOJE:
${foodList}
  TOTAL: ${todayTotals.calories}kcal consumidas (meta: ${tdee}kcal) | P:${todayTotals.protein}g/${macroGoals.protein}g | C:${todayTotals.carbs}g/${macroGoals.carbs}g | G:${todayTotals.fat}g/${macroGoals.fat}g
  Restante: ${tdee - todayTotals.calories}kcal

HIDRATAÇÃO HOJE:
  ${waterMl}ml / ${waterGoalMl}ml (${waterGlasses}/${waterGoalGlasses} copos)${waterGlasses >= waterGoalGlasses ? '  Meta atingida' : ` — faltam ${waterGoalMl - waterMl}ml`}

PROGRAMA DE TREINO ATUAL:
${programText}

HISTÓRICO RECENTE:
${historyText}
  Total: ${totalWorkouts} treinos | Sequência atual: ${streak} semanas`;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ReplaceExerciseAction {
  type: 'replace_exercise';
  scope: 'all' | 'workout';
  workoutType?: WorkoutType;
  fromName: string;
  toName: string;
}

export interface WorkoutPlanExerciseAction {
  name: string;
  sets: number;
  repsMin: number;
  repsMax: number;
  muscleGroup: string;
}

export interface ApplyWorkoutPlanAction {
  type: 'apply_workout_plan';
  split: 'ABC' | 'ABCD' | 'ABCDE';
  workouts: Array<{
    type: WorkoutType;
    focus?: string;
    exercises: WorkoutPlanExerciseAction[];
  }>;
  recommendation?: string;
}

export type ChatAction = ReplaceExerciseAction | ApplyWorkoutPlanAction;

const MIN_EXERCISES_PER_WORKOUT = 5;
const TARGET_EXERCISES_PER_WORKOUT = 6;
const TARGET_EXERCISES_FOR_FOCUSED_SPLIT = 7;
const MIN_EXERCISES_PER_FOCUSED_GROUP = 2;

function normalizeName(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function splitToSlots(split: 'ABC' | 'ABCD' | 'ABCDE'): WorkoutType[] {
  if (split === 'ABCDE') return ['A', 'B', 'C', 'D', 'E'];
  if (split === 'ABCD') return ['A', 'B', 'C', 'D'];
  return ['A', 'B', 'C'];
}

function extractGroupsFromText(text: string): string[] {
  const normalized = normalizeName(text);
  const groups: string[] = [];

  const map: Array<{ keys: string[]; group: string }> = [
    { keys: ['peito', 'peitoral'], group: 'Peitoral' },
    { keys: ['costa', 'costas', 'dorsal'], group: 'Costas' },
    { keys: ['biceps', 'bíceps', 'antebraco', 'antebraço'], group: 'Bíceps' },
    { keys: ['triceps', 'tríceps'], group: 'Tríceps' },
    { keys: ['ombro', 'ombros', 'deltoide'], group: 'Ombros' },
    { keys: ['quadriceps', 'quadríceps'], group: 'Quadríceps' },
    { keys: ['posterior', 'femoral', 'isquiotibiais'], group: 'Posterior de Coxa' },
    { keys: ['gluteo', 'glúteo', 'gluteos', 'glúteos'], group: 'Glúteos' },
    { keys: ['panturrilha', 'panturrilhas', 'gemeos', 'gêmeos'], group: 'Panturrilhas' },
    { keys: ['abdomen', 'abdômen', 'core'], group: 'Abdômen' },
    { keys: ['perna', 'pernas', 'membros inferiores'], group: 'Quadríceps' },
  ];

  for (const item of map) {
    if (item.keys.some((key) => normalized.includes(key))) {
      groups.push(item.group);
    }
  }

  return Array.from(new Set(groups));
}

function completeWorkoutExercises(
  exercises: WorkoutPlanExerciseAction[],
  desiredGroups: string[],
  usedGlobal: Set<string>,
): WorkoutPlanExerciseAction[] {
  const unique: WorkoutPlanExerciseAction[] = [];
  const local = new Set<string>();
  const normalizedDesired = Array.from(new Set(desiredGroups.filter(Boolean)));
  const isFocusedSplit = normalizedDesired.length > 0 && normalizedDesired.length <= 3;
  const targetExercises = isFocusedSplit ? TARGET_EXERCISES_FOR_FOCUSED_SPLIT : TARGET_EXERCISES_PER_WORKOUT;

  const countByGroup = (group: string) => unique.filter((exercise) => exercise.muscleGroup === group).length;

  for (const exercise of exercises) {
    if (!exercise.name?.trim()) continue;
    const key = normalizeName(exercise.name);
    if (local.has(key)) continue;
    local.add(key);
    usedGlobal.add(key);
    unique.push({
      ...exercise,
      sets: Number.isFinite(exercise.sets) ? Math.max(1, Math.min(8, exercise.sets)) : 3,
      repsMin: Number.isFinite(exercise.repsMin) ? Math.max(1, exercise.repsMin) : 8,
      repsMax: Number.isFinite(exercise.repsMax) ? Math.max(Math.max(1, exercise.repsMin || 8), exercise.repsMax) : 12,
      muscleGroup: exercise.muscleGroup || 'Geral',
    });
  }

  const addFromCatalog = (groupFilter?: string, limit = Number.POSITIVE_INFINITY): number => {
    let added = 0;
    for (const catalog of EXERCISE_CATALOG) {
      const key = normalizeName(catalog.name);
      if (groupFilter && catalog.muscleGroup !== groupFilter) continue;
      if (local.has(key) || usedGlobal.has(key)) continue;
      local.add(key);
      usedGlobal.add(key);
      unique.push({
        name: catalog.name,
        sets: 3,
        repsMin: catalog.muscleGroup === 'Abdômen' ? 12 : 8,
        repsMax: catalog.muscleGroup === 'Abdômen' ? 20 : 12,
        muscleGroup: catalog.muscleGroup,
      });
      added += 1;
      if (unique.length >= targetExercises || added >= limit) return added;
    }
    return added;
  };

  const minPerGroup = isFocusedSplit ? MIN_EXERCISES_PER_FOCUSED_GROUP : 1;

  for (const group of normalizedDesired) {
    while (countByGroup(group) < minPerGroup && unique.length < targetExercises) {
      const added = addFromCatalog(group, 1);
      if (added === 0) break;
    }
  }

  if (normalizedDesired.length > 0) {
    let progressed = true;
    while (unique.length < targetExercises && progressed) {
      progressed = false;
      for (const group of normalizedDesired) {
        if (unique.length >= targetExercises) break;
        const added = addFromCatalog(group, 1);
        if (added > 0) progressed = true;
      }
    }
  }

  if (unique.length < targetExercises) {
    addFromCatalog();
  }

  return unique;
}

function ensureCompleteWorkouts(
  split: 'ABC' | 'ABCD' | 'ABCDE',
  workouts: Array<{
    type: WorkoutType;
    focus?: string;
    exercises: WorkoutPlanExerciseAction[];
  }>,
  userMessages: ChatMessage[],
): Array<{
  type: WorkoutType;
  focus?: string;
  exercises: WorkoutPlanExerciseAction[];
}> {
  const slotOrder = splitToSlots(split);
  const byType = new Map<WorkoutType, { type: WorkoutType; focus?: string; exercises: WorkoutPlanExerciseAction[] }>();
  workouts.forEach((workout) => byType.set(workout.type, workout));

  const userText = userMessages.filter((message) => message.role === 'user').map((message) => message.content).join(' ');
  const globalGroups = extractGroupsFromText(userText);
  const usedGlobal = new Set<string>();

  return slotOrder.map((slot) => {
    const current = byType.get(slot);
    const focusGroups = extractGroupsFromText(current?.focus || '');
    const currentGroups = Array.from(new Set((current?.exercises || []).map((exercise) => exercise.muscleGroup).filter(Boolean)));
    const desiredGroups = Array.from(new Set([...focusGroups, ...currentGroups, ...globalGroups]));

    const completed = completeWorkoutExercises(current?.exercises || [], desiredGroups, usedGlobal);

    return {
      type: slot,
      focus: current?.focus,
      exercises: completed,
    };
  });
}

function pickExercisesByGroups(
  groups: string[],
  used: Set<string>,
  amount: number,
): WorkoutPlanExerciseAction[] {
  const out: WorkoutPlanExerciseAction[] = [];

  const orderedGroups = Array.from(new Set(groups.filter(Boolean)));
  const groupEntries = orderedGroups.map((group) => ({
    group,
    cursor: 0,
    matches: EXERCISE_CATALOG.filter((exercise) => exercise.muscleGroup === group),
  }));

  let progressed = true;
  while (out.length < amount && progressed && groupEntries.length > 0) {
    progressed = false;
    for (const entry of groupEntries) {
      while (entry.cursor < entry.matches.length && used.has(entry.matches[entry.cursor].name)) {
        entry.cursor += 1;
      }

      const match = entry.matches[entry.cursor];
      if (!match) continue;

      used.add(match.name);
      out.push({
        name: match.name,
        sets: 3,
        repsMin: entry.group === 'Abdômen' ? 12 : 8,
        repsMax: entry.group === 'Abdômen' ? 20 : 12,
        muscleGroup: entry.group,
      });
      entry.cursor += 1;
      progressed = true;
      if (out.length >= amount) return out;
    }
  }

  if (out.length < amount) {
    for (const exercise of EXERCISE_CATALOG) {
      if (used.has(exercise.name)) continue;
      used.add(exercise.name);
      out.push({
        name: exercise.name,
        sets: 3,
        repsMin: 8,
        repsMax: 12,
        muscleGroup: exercise.muscleGroup,
      });
      if (out.length >= amount) break;
    }
  }

  return out;
}

function buildFallbackPlan(
  split: 'ABC' | 'ABCD' | 'ABCDE',
  userMessages: ChatMessage[],
): ApplyWorkoutPlanAction {
  const slots = splitToSlots(split);
  const userText = normalizeName(userMessages.map((message) => message.content).join(' '));
  const classicABC = userText.includes('peito') && userText.includes('costa') && userText.includes('perna');

  const templateBySplit: Record<'ABC' | 'ABCD' | 'ABCDE', Record<WorkoutType, string[]>> = {
    ABC: classicABC
      ? {
          A: ['Peitoral', 'Ombros', 'Tríceps'],
          B: ['Costas', 'Bíceps', 'Abdômen'],
          C: ['Quadríceps', 'Posterior de Coxa', 'Glúteos', 'Panturrilhas'],
          D: ['Abdômen'],
          E: ['Abdômen'],
        }
      : {
          A: ['Peitoral', 'Tríceps', 'Ombros'],
          B: ['Costas', 'Bíceps', 'Abdômen'],
          C: ['Quadríceps', 'Posterior de Coxa', 'Glúteos', 'Panturrilhas'],
          D: ['Abdômen'],
          E: ['Abdômen'],
        },
    ABCD: {
      A: ['Peitoral', 'Tríceps'],
      B: ['Costas', 'Bíceps'],
      C: ['Quadríceps', 'Posterior de Coxa'],
      D: ['Ombros', 'Glúteos', 'Panturrilhas', 'Abdômen'],
      E: ['Abdômen'],
    },
    ABCDE: {
      A: ['Peitoral', 'Tríceps'],
      B: ['Costas', 'Bíceps'],
      C: ['Quadríceps'],
      D: ['Posterior de Coxa', 'Glúteos'],
      E: ['Ombros', 'Panturrilhas', 'Abdômen'],
    },
  };

  const template = templateBySplit[split];
  const used = new Set<string>();

  const workouts = slots.map((slot) => {
    const groups = template[slot] || ['Peitoral', 'Costas', 'Quadríceps'];
    const exercises = pickExercisesByGroups(groups, used, split === 'ABCDE' ? 5 : 6);
    return {
      type: slot,
      focus: groups.slice(0, 2).join(' + '),
      exercises,
    };
  });

  return {
    type: 'apply_workout_plan',
    split,
    workouts,
    recommendation: `Montei um plano ${split} com base no seu perfil e no catálogo disponível.`,
  };
}

export interface AskAIOptions {
  jsonSchema?: Record<string, unknown>;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
}

type AIMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AIMessage {
  role: AIMessageRole;
  content: string | Array<Record<string, unknown>>;
  name?: string;
  tool_call_id?: string;
}

export interface InvokeAIParams {
  messages: AIMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: 'none' | 'auto' | Record<string, unknown>;
  response_format?: Record<string, unknown>;
}

interface InvokeAIOptions {
  feature?: AIFeature;
}

const FREE_WORKOUT_TRIAL_SESSION_KEY = 'gympilot-free-workout-trial-session-id';

function getFreeWorkoutTrialSessionId(): string {
  try {
    const existing = window.localStorage.getItem(FREE_WORKOUT_TRIAL_SESSION_KEY);
    if (existing) return existing;
    const generated = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `trial_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(FREE_WORKOUT_TRIAL_SESSION_KEY, generated);
    return generated;
  } catch {
    return `trial_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

interface OpenAIChoice {
  finish_reason?: string;
  message?: {
    content?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  };
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  error?: { message?: string };
}

export async function invokeAI(
  payload: InvokeAIParams,
  options: InvokeAIOptions = {},
): Promise<OpenAIResponse> {
  if (!supabase) {
    throw new Error('Integração IA indisponível: configure Supabase no ambiente.');
  }

  const profile = useProfileStore.getState().profile;
  const plan = resolveAIPlan(profile);
  const feature = options.feature || 'chat';

  if (!isAIFeatureEnabled(plan, feature)) {
    throw new Error(getUpgradeMessage(feature));
  }

  const payloadWithTrial = plan === 'free' && feature === 'workout_builder'
    ? {
      ...payload,
      trial_session_id: getFreeWorkoutTrialSessionId(),
    }
    : payload;

  const { data, error } = await supabase.functions.invoke('ai-gateway', {
    body: {
      feature,
      payload: payloadWithTrial,
    },
  });

  if (error) {
    throw new Error(error.message || 'Erro ao chamar o gateway de IA.');
  }

  const response = data as OpenAIResponse | null;
  if (!response) {
    throw new Error('Gateway de IA retornou vazio.');
  }

  if (response.error?.message) {
    throw new Error(response.error.message);
  }

  return response;
}

export async function sendMessage(
  _apiKey: string | null,
  messages: ChatMessage[],
): Promise<string> {
  const profile = useProfileStore.getState().profile;
  if (!profile) throw new Error('Perfil não encontrado');

  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
  const { context: knowledgeContext } = await buildKnowledgeContextForAI(profile, 'chat', latestUserMessage);
  const knowledgeInstruction = knowledgeContext
    ? '\n\nINSTRUCOES DO PLAYBOOK:\n- Trate PLAYBOOK_SUPABASE como fonte primaria de recomendacao neste app.\n- Em caso de conflito, priorize as regras do playbook interno antes de conhecimento geral.'
    : '';

  const systemMessage = `${getSystemPrompt()}${knowledgeContext ? `\n\n${knowledgeContext}` : ''}${knowledgeInstruction}${ACTION_PROMPT}\n${buildContext(profile)}`;

  const requestChat = (chatMessages: ChatMessage[], maxTokens: number) => invokeAI({
    messages: [
      { role: 'system', content: systemMessage },
      ...chatMessages,
    ],
    max_tokens: maxTokens,
    temperature: 0.7,
  }, { feature: 'chat' });

  const data = await requestChat(messages, 700);
  if (data.choices?.[0]?.finish_reason === 'length') {
    const retryData = await requestChat([
      ...messages,
      {
        role: 'user',
        content: 'Sua resposta anterior ficou grande e foi cortada. Refaça em ate 500 caracteres, sem markdown quebrado, com no maximo 2 paragrafos curtos.',
      },
    ], 300);

    return retryData.choices?.[0]?.message?.content || '';
  }
  return data.choices?.[0]?.message?.content || '';
}

export async function sendMessageWithActions(
  _apiKey: string | null,
  messages: ChatMessage[],
  feature: AIFeature = 'chat',
): Promise<{ reply: string; action: ChatAction | null }> {
  const profile = useProfileStore.getState().profile;
  if (!profile) throw new Error('Perfil não encontrado');

  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
  const { context: knowledgeContext } = await buildKnowledgeContextForAI(profile, feature, latestUserMessage);
  const scientificQuery = isScientificQuery(latestUserMessage);
  const evidenceItems = scientificQuery ? getEvidenceForQuery(latestUserMessage) : [];
  const evidenceContext = scientificQuery ? buildEvidenceContext(evidenceItems) : '';
  const scientificInstruction = scientificQuery
    ? `\n\nINSTRUÇÕES DE EVIDÊNCIA:\n- Para recomendações científicas/prescritivas, cite apenas IDs do EVIDENCE_CONTEXT no formato [SRC:ID1,ID2].\n- Não invente fontes.\n- Se não houver evidência suficiente no contexto, responda explicitamente: "Não encontrei evidência suficiente para afirmar isso com segurança."`
    : '';
  const knowledgeInstruction = knowledgeContext
    ? '\n\nINSTRUCOES DO PLAYBOOK:\n- Trate PLAYBOOK_SUPABASE como fonte primaria de recomendacao neste app.\n- Em caso de conflito, priorize as regras do playbook interno antes de conhecimento geral.'
    : '';

  const systemMessage = `${getSystemPrompt()}\n${buildContext(profile)}${knowledgeContext ? `\n\n${knowledgeContext}` : ''}${knowledgeInstruction}${evidenceContext ? `\n\n${evidenceContext}` : ''}${scientificInstruction}\n\nREGRAS DE AÇÕES NO APP:\n- Se o usuário pedir para trocar/substituir exercício, use replace_exercise.\n- Se o usuário pedir para montar/mudar treino completo (ex: "quero treino ABC"), use apply_workout_plan com split + workouts + exercises completos.\n- Em apply_workout_plan, inclua obrigatoriamente 6-10 exercícios por treino, com variação por grupamento e séries/reps válidas.\n- Se o foco do treino tiver até 3 grupamentos principais (ex.: peito, tríceps e ombros), inclua no mínimo 2 exercícios por grupamento.\n- Nunca retorne apenas split sem lista de exercícios.\n- Quando o treino estiver pronto, faça apenas UMA pergunta de confirmação para substituir.\n- Depois da confirmação do usuário, não repita perguntas.\n- Se não houver pedido claro de alteração, responda em texto.`;

  const requestChat = (chatMessages: ChatMessage[], maxTokens: number) => invokeAI({
    messages: [
      { role: 'system', content: systemMessage },
      ...chatMessages,
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'replace_exercise',
          description: 'Solicita substituição de exercício no app quando o usuário pede para trocar/substituir exercício.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['scope', 'fromName', 'toName'],
            properties: {
              scope: { type: 'string', enum: ['all', 'workout'] },
              workoutType: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'] },
              fromName: { type: 'string' },
              toName: { type: 'string' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'apply_workout_plan',
          description: 'Substitui o treino completo do usuário com uma nova divisão e exercícios completos.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['split', 'workouts'],
            properties: {
              split: { type: 'string', enum: ['ABC', 'ABCD', 'ABCDE'] },
              recommendation: { type: 'string' },
              workouts: {
                type: 'array',
                minItems: 2,
                maxItems: 5,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'exercises'],
                  properties: {
                    type: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'] },
                    focus: { type: 'string' },
                    exercises: {
                      type: 'array',
                      minItems: 6,
                      maxItems: 10,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['name', 'sets', 'repsMin', 'repsMax', 'muscleGroup'],
                        properties: {
                          name: { type: 'string' },
                          sets: { type: 'number' },
                          repsMin: { type: 'number' },
                          repsMax: { type: 'number' },
                          muscleGroup: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
    tool_choice: 'auto',
    max_tokens: maxTokens,
    temperature: 0.7,
  }, { feature });

  const data = await requestChat(messages, 700);
  if (data.choices?.[0]?.finish_reason === 'length') {
    const retryData = await requestChat([
      ...messages,
      {
        role: 'user',
        content: 'Sua resposta anterior ficou grande e foi cortada. Refaça em ate 500 caracteres, com objetividade.',
      },
    ], 300);

    const retryContent = retryData.choices?.[0]?.message?.content?.trim() || '';
    return { reply: retryContent, action: null };
  }

  const choice = data.choices?.[0];
  const content = choice?.message?.content?.trim() || '';
  const toolCalls = choice?.message?.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined;

  let action: ChatAction | null = null;
  if (toolCalls?.length) {
    const planCall = toolCalls.find((toolCall) => toolCall.function?.name === 'apply_workout_plan');
    if (planCall?.function?.arguments) {
      try {
        const args = JSON.parse(planCall.function.arguments) as {
          split?: 'ABC' | 'ABCD' | 'ABCDE';
          recommendation?: string;
          workouts?: Array<{
            type?: WorkoutType;
            focus?: string;
            exercises?: WorkoutPlanExerciseAction[];
          }>;
        };

        const workouts = (args.workouts || [])
          .filter((workout) => ['A', 'B', 'C', 'D', 'E'].includes(String(workout.type)) && Array.isArray(workout.exercises) && workout.exercises.length > 0)
          .map((workout) => ({
            type: workout.type as WorkoutType,
            focus: workout.focus,
            exercises: (workout.exercises || []).map((exercise) => ({
              name: exercise.name,
              sets: exercise.sets,
              repsMin: exercise.repsMin,
              repsMax: exercise.repsMax,
              muscleGroup: exercise.muscleGroup,
            })),
          }));

        if (args.split && workouts.length > 0) {
          const slots = splitToSlots(args.split);
          const hasMissingSlots = slots.some((slot) => !workouts.find((workout) => workout.type === slot));

          if (hasMissingSlots) {
            action = buildFallbackPlan(args.split, messages);
          } else {
            const completed = ensureCompleteWorkouts(args.split, workouts, messages);
            const invalidAfterComplete = completed.some((workout) => workout.exercises.length < MIN_EXERCISES_PER_WORKOUT);

            action = invalidAfterComplete
              ? buildFallbackPlan(args.split, messages)
              : {
                  type: 'apply_workout_plan',
                  split: args.split,
                  workouts: completed,
                  recommendation: args.recommendation,
                };
          }
        } else if (args.split) {
          action = buildFallbackPlan(args.split, messages);
        }
      } catch {
        action = null;
      }
    }

    if (!action) {
    const replaceCall = toolCalls.find((toolCall) => toolCall.function?.name === 'replace_exercise');
    if (replaceCall?.function?.arguments) {
      try {
        const args = JSON.parse(replaceCall.function.arguments) as {
          scope?: 'all' | 'workout';
          workoutType?: WorkoutType;
          fromName?: string;
          toName?: string;
        };
        if (args.scope && args.fromName && args.toName) {
          action = {
            type: 'replace_exercise',
            scope: args.scope,
            workoutType: args.workoutType,
            fromName: args.fromName,
            toName: args.toName,
          };
        }
      } catch {
        action = null;
      }
    }
    }
  }

  let reply = content || (action
    ? action.type === 'apply_workout_plan'
      ? 'Montei seu plano. Quer que eu substitua seu treino completo por esse agora?'
      : 'Posso aplicar essa substituição no app. Quer que eu confirme agora?'
    : 'Não consegui responder com clareza. Tente reformular.');

  if (scientificQuery) {
    if (!evidenceItems.length) {
      reply = `${reply}\n\nNão encontrei evidência suficiente para afirmar isso com segurança.`;
    } else {
      const citedIds = extractSourceIds(reply);
      const validEvidence = getEvidenceByIds(citedIds);
      if (!validEvidence.length) {
        reply = `${reply}\n\nNão encontrei evidência suficiente para afirmar isso com segurança.`;
      } else {
        const refs = validEvidence.map((item) => `${item.sourceId} (${item.year})`).join(', ');
        if (!reply.includes('Fontes usadas:')) {
          reply = `${reply}\n\nFontes usadas: ${refs}`;
        }
      }
    }
  }

  return { reply, action };
}

export async function askAI(
  _apiKey: string | null,
  profile: Profile,
  question: string,
  jsonModeOrOptions: boolean | AskAIOptions = false,
  feature: AIFeature = 'chat',
): Promise<string> {
  const options: AskAIOptions = typeof jsonModeOrOptions === 'boolean' ? {} : jsonModeOrOptions;
  const useStructuredOutput = typeof jsonModeOrOptions === 'boolean' ? jsonModeOrOptions : Boolean(options.jsonSchema);

  const responseFormat = useStructuredOutput
    ? {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: options.schemaName || 'fitflow_structured_response',
          strict: true,
          schema: options.jsonSchema || {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    }
    : {};

  const { context: knowledgeContext } = await buildKnowledgeContextForAI(profile, feature, question);
  const knowledgeInstruction = knowledgeContext
    ? '\n\nINSTRUCOES DO PLAYBOOK:\n- Trate PLAYBOOK_SUPABASE como fonte primaria de recomendacao neste app.\n- Em caso de conflito, priorize as regras do playbook interno antes de conhecimento geral.'
    : '';
  const systemMessage = `${getSystemPrompt()}${knowledgeContext ? `\n\n${knowledgeContext}` : ''}${knowledgeInstruction}${ACTION_PROMPT}\n${buildContext(profile)}`;
  const data = await invokeAI({
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: question },
    ],
    max_tokens: options.maxTokens ?? 4000,
    temperature: options.temperature ?? 0.7,
    ...responseFormat,
  }, { feature });

  if (data.choices?.[0]?.finish_reason === 'length') {
    throw new Error('Resposta cortada — tente novamente');
  }
  return data.choices?.[0]?.message?.content || '';
}
