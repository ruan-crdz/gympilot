import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useProfileStore } from '@/stores/useProfileStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useHistoryStore } from '@/stores/useHistoryStore';
import { useToastStore } from '@/stores/useToastStore';
import { useWeightStore } from '@/stores/useWeightStore';
import { useWaterStore } from '@/stores/useWaterStore';
import { MotivationalQuote } from '@/components/ui/MotivationalQuote';
import { WeightChart } from '@/components/ui/WeightChart';
import { WeightPrompt } from '@/components/ui/WeightPrompt';
import { AIDashInsight } from '@/components/ui/AIDashInsight';
import { AIWeeklyReport } from '@/components/ui/AIWeeklyReport';
import { StreakHeatmap } from '@/components/ui/StreakHeatmap';
import { LoadProgression } from '@/components/ui/LoadProgression';
import { calculateTDEE, calculateMacros, calculateBMI, bmiCategory } from '@/utils/calories';
import { calculateWaterIntake } from '@/utils/water';
import { getTodayWorkoutType, isTrainingDay, getToday, formatDateBR } from '@/utils/date';
import { useTrainingReminder } from '@/hooks/useTrainingReminder';
import { WORKOUT_MAP } from '@/constants/workouts';
import { useCustomWorkoutStore } from '@/stores/useCustomWorkoutStore';
import { useFoodStore } from '@/stores/useFoodStore';
import { DASHBOARD_WIDGET_LABELS, DEFAULT_DASHBOARD_WIDGETS, useDashboardStore } from '@/stores/useDashboardStore';
import { useHealthIntegrationStore } from '@/stores/useHealthIntegrationStore';
import { useNotesStore } from '@/stores/useNotesStore';
import { useRecoveryStore } from '@/stores/useRecoveryStore';
import { computeReadiness, READINESS_WEIGHTS } from '@/utils/readiness';
import type { Exercise, WorkoutType } from '@/types';
import type { ActivityIntensity, ActivityLocation } from '@/types';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { CustomSelect } from '@/components/ui/CustomSelect';
import { CustomDatePicker } from '@/components/ui/CustomDatePicker';

type DashboardHistory = 'consistency' | 'load' | 'calories' | 'water' | 'bmi' | 'weight' | null;

function isWorkoutType(value: string): value is WorkoutType {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D' || value === 'E';
}

function deriveFocusFromExercises(exercises: Exercise[]): string {
  if (!Array.isArray(exercises) || exercises.length === 0) return 'Treino personalizado';
  const groups = exercises
    .map((e) => e.muscleGroup?.toLowerCase().trim())
    .filter((group): group is string => Boolean(group));

  const upper = ['costas', 'peitoral', 'ombro', 'bíceps', 'biceps', 'tríceps', 'triceps'];
  const lower = ['quadríceps', 'quadriceps', 'posterior', 'glúte', 'glute', 'panturrilha'];
  const upperCount = groups.filter((g) => upper.some((u) => g.includes(u))).length;
  const lowerCount = groups.filter((g) => lower.some((l) => g.includes(l))).length;
  const total = groups.length;

  if (total === 0) return 'Treino personalizado';
  if (upperCount >= total * 0.7) return 'Superior';
  if (lowerCount >= total * 0.7) return 'Inferior';
  if (upperCount > 0 && lowerCount > 0) return 'Full Body';

  const frequency: Record<string, number> = {};
  groups.forEach((group) => {
    frequency[group] = (frequency[group] || 0) + 1;
  });
  const top = Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([group]) => group.charAt(0).toUpperCase() + group.slice(1));

  return top.join(' + ') || 'Treino personalizado';
}

export function Dashboard() {
  useTrainingReminder();
  const navigate = useNavigate();
  const profile = useProfileStore((s) => s.profile)!;
  const activeSession = useSessionStore((s) => s.activeSession);
  const startSession = useSessionStore((s) => s.startSession);
  const endSession = useSessionStore((s) => s.endSession);
  const sessions = useHistoryStore((s) => s.sessions);
  const weightEntries = useWeightStore((s) => s.entries);
  const hasTodayWeight = useWeightStore((s) => s.hasTodayEntry());
  const waterGlasses = useWaterStore((s) => s.getToday());
  const addGlass = useWaterStore((s) => s.addGlass);
  const removeGlass = useWaterStore((s) => s.removeGlass);
  const waterLogs = useWaterStore((s) => s.logs);
  const foodLogs = useFoodStore((s) => s.logs);
  const healthDaily = useHealthIntegrationStore((s) => s.daily);
  const notes = useNotesStore((s) => s.notes);
  const activeSlots = useCustomWorkoutStore((s) => s.activeSlots);
  const getExercises = useCustomWorkoutStore((s) => s.getExercises);
  const checkins = useRecoveryStore((s) => s.checkins);
  const widgets = useDashboardStore((s) => s.widgets);
  const toggleWidget = useDashboardStore((s) => s.toggleWidget);
  const resetWidgets = useDashboardStore((s) => s.resetWidgets);
  const [showWeightPrompt, setShowWeightPrompt] = useState(!hasTodayWeight);
  const [showConfetti, setShowConfetti] = useState(false);
  const [editingDashboard, setEditingDashboard] = useState(false);
  const [historyView, setHistoryView] = useState<DashboardHistory>(null);
  const [showActivityModal, setShowActivityModal] = useState(false);

  const today = getToday();
  const todayFoodEntries = foodLogs[today] || [];
  const totals = todayFoodEntries.reduce(
    (acc, entry) => ({
      calories: acc.calories + entry.calories,
      protein: acc.protein + entry.protein,
      carbs: acc.carbs + entry.carbs,
      fat: acc.fat + entry.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const healthSummary = healthDaily[today] || {
    date: today,
    steps: 0,
    activeCalories: 0,
    source: 'none' as const,
    syncedAt: 0,
  };
  const totalWorkouts = sessions.filter((s) => s.completedAt).length;
  const structuredSessions = sessions.filter((s) => s.completedAt && s.workoutType);
  const todayCompleted = sessions.filter((s) => s.date === today && s.completedAt);
  const todayAlreadyDone = todayCompleted.length > 0;

  const uniqueWeeks = [...new Set(sessions.filter((s) => s.completedAt).map((s) => s.date))].sort().reverse();
  let streak = 0;
  if (uniqueWeeks.length > 0) {
    streak = 1;
    for (let i = 1; i < uniqueWeeks.length; i++) {
      const prev = new Date(uniqueWeeks[i - 1]).getTime();
      const curr = new Date(uniqueWeeks[i]).getTime();
      if ((prev - curr) / (1000 * 60 * 60 * 24) <= 7) streak++;
      else break;
    }
  }

  const todayWorkoutFromCalendar = getTodayWorkoutType(profile.trainingDays);
  const todayWorkoutIndex = todayWorkoutFromCalendar
    ? ['A', 'B', 'C', 'D', 'E'].indexOf(todayWorkoutFromCalendar)
    : -1;
  const todayWorkout = todayWorkoutIndex >= 0
    ? activeSlots[todayWorkoutIndex % Math.max(activeSlots.length, 1)] || activeSlots[0] || null
    : null;
  const isTodayTraining = isTrainingDay(profile.trainingDays);
  const targetWeeklySessions = Math.max(3, profile.trainingDays.length);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weeklyCompleted = sessions.filter((session) => session.completedAt && new Date(session.date) >= weekAgo).length;
  const weeklyProgress = Math.min(weeklyCompleted / targetWeeklySessions, 1);
  const nextWorkoutType = activeSlots[structuredSessions.length % Math.max(activeSlots.length, 1)] || 'A';
  const isActiveSessionValid = Boolean(activeSession && activeSlots.includes(activeSession.workoutType));
  const workoutMetaByType = useMemo<Record<WorkoutType, { label: string; focus: string }>>(() => {
    const types: WorkoutType[] = ['A', 'B', 'C', 'D', 'E'];
    const entries = types.map((type) => {
      const mapped = WORKOUT_MAP[type];
      const customLabel = profile.customSplit?.[type]?.trim();
      const exercises = getExercises(type);
      const derivedFocus = deriveFocusFromExercises(exercises);
      return [
        type,
        {
          label: customLabel || mapped?.label || `Treino ${type}`,
          focus: derivedFocus || mapped?.focus || 'Treino personalizado',
        },
      ] as const;
    });

    return Object.fromEntries(entries) as Record<WorkoutType, { label: string; focus: string }>;
  }, [getExercises, profile.customSplit]);

  const getWorkoutMeta = (type?: string | null): { label: string; focus: string } => {
    const normalized = typeof type === 'string' ? type.toUpperCase() : '';
    if (isWorkoutType(normalized)) {
      return workoutMetaByType[normalized];
    }
    return { label: 'Treino', focus: 'Treino personalizado' };
  };

  const activeWorkoutMeta = getWorkoutMeta(isActiveSessionValid ? activeSession?.workoutType : null);
  const todayWorkoutMeta = getWorkoutMeta(todayWorkout);
  const todayCheckin = checkins[today];
  const readiness = computeReadiness(todayCheckin || null);
  const readinessScore = readiness?.score ?? null;
  const readinessLabel = readinessScore === null
    ? 'Sem check-in hoje'
    : readinessScore >= 70
      ? 'Alta: pode treinar forte'
      : readinessScore >= 45
        ? 'Média: mantenha volume'
        : 'Baixa: reduza carga e foco em técnica';

  const calories = calculateTDEE(profile);
  const macros = calculateMacros(calories, profile.goal);
  const bmi = calculateBMI(profile.weight, profile.height);
  const water = calculateWaterIntake(profile.weight);
  const burned = healthSummary.activeCalories;
  const remaining = calories - (totals.calories - burned);
  const progressCalories = Math.min(totals.calories / calories, 1);
  const isWidgetVisible = (widget: typeof DEFAULT_DASHBOARD_WIDGETS[number]) => widgets.includes(widget);

  const handleStartWorkout = (type: WorkoutType) => {
    startSession(type);
    navigate('/workout');
  };

  const handleResumeWorkout = () => {
    if (!isActiveSessionValid) {
      endSession();
      return;
    }
    navigate('/workout');
  };

  useEffect(() => {
    if (activeSession && !isActiveSessionValid) {
      endSession();
    }
  }, [activeSession, isActiveSessionValid, endSession]);

  return (
    <div className="gym-page">
      {/* Header - cleaner, bigger touch target */}
      <div className="flex items-center justify-between">
        <div>
          <p className="gym-kicker">
            {new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' })}
          </p>
          <h1 className="gym-title mt-1">{profile.name} <MaterialIcon name={profile.sex === 'male' ? 'fitness_center' : profile.sex === 'female' ? 'favorite' : 'bolt'} className="inline-flex text-primary-300 text-[24px]" /></h1>
        </div>
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={() => navigate('/profile')}
          className="gym-icon-tile"
        >
          <MaterialIcon name="star" className="text-primary-300" />
        </motion.button>
      </div>

      {isWidgetVisible('quote') && <MotivationalQuote />}

      {/* AI Insight */}
      {isWidgetVisible('aiInsight') && <AIDashInsight />}

      {/* Weekly Report (Sundays) */}
      {isWidgetVisible('weeklyReport') && <AIWeeklyReport />}

      {/* Active Session Banner */}
      {isActiveSessionValid && (
        <motion.button
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          whileTap={{ scale: 0.97 }}
          onClick={handleResumeWorkout}
          className="w-full p-4 rounded-xl bg-primary-500 text-black text-left shadow-[0_16px_42px_rgba(var(--color-primary-rgb),0.22)]"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-black/60 font-bold">Treino em andamento</p>
              <p className="text-xl font-bold mt-1">
                Continuar {activeWorkoutMeta.label}
              </p>
            </div>
            <motion.span
              animate={{ x: [0, 5, 0] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              className="text-2xl"
            ><MaterialIcon name="arrow_forward" /></motion.span>
          </div>
        </motion.button>
      )}

      {/* Today's Training */}
      {!isActiveSessionValid && isWidgetVisible('todayWorkout') && (
        <div className="card space-y-4 border-primary-500/20">
          {isTodayTraining && !todayAlreadyDone ? (
            <>
              <div className="flex items-center gap-4">
                <div className="gym-icon-tile w-14 h-14"><MaterialIcon name="fitness_center" className="text-primary-300" /></div>
                <div className="flex-1">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider font-bold">Treino de hoje</p>
                  <p className="text-lg font-bold mt-0.5">
                    {todayWorkout && todayWorkoutMeta.label}
                  </p>
                  <p className="text-sm text-primary-400">{todayWorkout && todayWorkoutMeta.focus}</p>
                </div>
              </div>
              <motion.button
                whileTap={{ scale: 0.96 }}
                className="btn-primary"
                onClick={() => todayWorkout && handleStartWorkout(todayWorkout)}
              >
                Iniciar Treino
              </motion.button>
            </>
          ) : todayAlreadyDone ? (
            <motion.div
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              className="text-center py-6"
            >
              <MaterialIcon name="check_circle" className="text-5xl text-primary-300" />
              <p className="text-lg font-semibold mt-3">Treino concluído!</p>
              <p className="text-white/40 text-sm mt-1">Descanse e se recupere</p>
            </motion.div>
          ) : (
            <div className="text-center py-6">
              <MaterialIcon name="bedtime" className="text-5xl text-primary-300" />
              <p className="text-lg font-semibold mt-3">Dia de descanso</p>
              <p className="text-white/40 text-sm mt-1">Aproveite para se recuperar</p>
            </div>
          )}
        </div>
      )}

      {/* Quick Start */}
      {!isActiveSessionValid && !todayAlreadyDone && isWidgetVisible('quickStart') && (
        <div className="space-y-2">
          <p className="text-xs text-white/25 font-semibold uppercase tracking-wider flex items-center gap-1.5">
            <MaterialIcon name="fitness_center" className="text-primary-300" />
            Ou escolha um treino
          </p>
          <div className="grid grid-cols-3 gap-3">
            {activeSlots.map((type) => (
              <motion.button
                key={type}
                whileTap={{ scale: 0.92 }}
                onClick={() => handleStartWorkout(type)}
                className="card text-center py-4 hover:border-primary-400/40 transition-colors active:bg-primary-500/5"
              >
                <MaterialIcon name="fitness_center" className="text-lg text-primary-300 mx-auto mb-1" />
                <span className="text-2xl font-bold text-primary-400">{type}</span>
                <p className="text-[10px] text-white/40 mt-1">{workoutMetaByType[type].label}</p>
                <p className="text-[10px] text-primary-400/70 mt-0.5">{workoutMetaByType[type].focus}</p>
              </motion.button>
            ))}
          </div>
          <button
            onClick={() => setShowActivityModal(true)}
            className="btn-secondary w-full py-3 text-sm"
          >
            + Registrar atividade avulsa
          </button>
        </div>
      )}

      {/* Stats */}
      {isWidgetVisible('stats') && <div className="grid grid-cols-2 gap-3">
        <div className="card text-center">
          <MaterialIcon name="fitness_center" className="text-2xl text-primary-300 mx-auto mb-1" />
          <p className="text-3xl font-bold text-primary-400">{totalWorkouts}</p>
          <p className="text-xs text-white/40 mt-1">Treinos feitos</p>
        </div>
        <div className="card text-center">
          <MaterialIcon name="whatshot" className="text-2xl text-primary-300 mx-auto mb-1" />
          <p className="text-3xl font-bold text-primary-300">{streak}</p>
          <p className="text-xs text-white/40 mt-1">Semanas seguidas</p>
        </div>
      </div>}

      {isWidgetVisible('readiness') && <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-white/80 flex items-center gap-2">
            <MaterialIcon name="monitor_heart" className="text-primary-300" />
            Prontidão de treino
          </h2>
          {readinessScore !== null && <span className="gym-pill">{readinessScore}/100</span>}
        </div>
        <p className="text-sm text-white/60">{readinessLabel}</p>
        <div className="h-2 bg-dark-300 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-primary-500"
            animate={{ width: `${readinessScore ?? 0}%` }}
            transition={{ type: 'spring', stiffness: 90 }}
          />
        </div>
        <p className="text-xs text-white/40">Fórmula: energia {Math.round(READINESS_WEIGHTS.energy * 100)}% + dor invertida {Math.round(READINESS_WEIGHTS.soreness * 100)}% + estresse invertido {Math.round(READINESS_WEIGHTS.stress * 100)}% + sono {Math.round(READINESS_WEIGHTS.sleep * 100)}%.</p>
        {readiness && todayCheckin && (
          <div className="grid grid-cols-2 gap-2 text-[11px] text-white/45">
            <p>Energia: {todayCheckin.energy}/5 ({Math.round(readiness.energy)} pts)</p>
            <p>Dor: {todayCheckin.soreness}/10 ({Math.round(readiness.soreness)} pts)</p>
            <p>Estresse: {todayCheckin.stress}/5 ({Math.round(readiness.stress)} pts)</p>
            <p>Sono: {todayCheckin.sleepHours}h ({Math.round(readiness.sleep)} pts)</p>
          </div>
        )}
      </div>}

      {isWidgetVisible('weeklyGoal') && <div className="card space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-white/80 flex items-center gap-2">
            <MaterialIcon name="event_repeat" className="text-primary-300" />
            Meta semanal
          </h2>
          <span className="text-xs text-white/40">{weeklyCompleted}/{targetWeeklySessions} treinos</span>
        </div>
        <div className="h-2 bg-dark-300 rounded-full overflow-hidden">
          <motion.div className="h-full bg-primary-500" animate={{ width: `${weeklyProgress * 100}%` }} />
        </div>
        <p className="text-xs text-white/45">
          {weeklyCompleted >= targetWeeklySessions
            ? 'Meta batida. Mantenha consistência e foque em progressão de carga.'
            : `Faltam ${targetWeeklySessions - weeklyCompleted} treino(s) para bater a meta desta semana.`}
        </p>
        {!isActiveSessionValid && !todayAlreadyDone && (
          <button onClick={() => handleStartWorkout(nextWorkoutType)} className="btn-secondary text-sm">
            Próximo treino recomendado: {nextWorkoutType}
          </button>
        )}
      </div>}

      {/* Streak Heatmap */}
      {isWidgetVisible('streak') && <StreakHeatmap onHistory={() => setHistoryView('consistency')} />}

      {/* Load Progression */}
      {isWidgetVisible('load') && <LoadProgression onHistory={() => setHistoryView('load')} />}

      {/* Calories */}
      {isWidgetVisible('calories') && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold text-white/80 flex items-center gap-2">
              <MaterialIcon name="whatshot" className="text-primary-300" />
              Calorias do dia
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/40">Meta: {calories} kcal</span>
              <HistoryButton onClick={() => setHistoryView('calories')} label="Histórico de calorias" />
            </div>
          </div>
          <div className="relative h-4 bg-dark-300 rounded-full overflow-hidden">
            <motion.div
              className={`h-full rounded-full ${progressCalories >= 1 ? 'bg-red-500' : 'bg-primary-500'}`}
              initial={{ width: 0 }}
              animate={{ width: `${progressCalories * 100}%` }}
              transition={{ type: 'spring', stiffness: 80 }}
            />
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-lg font-bold text-primary-300">{totals.calories}</p>
              <p className="text-[10px] text-white/40">Consumidas</p>
            </div>
            <div>
              <p className="text-lg font-bold text-primary-300">{burned}</p>
              <p className="text-[10px] text-white/40">Queimadas</p>
            </div>
            <div>
              <p className="text-lg font-bold text-primary-300">{remaining}</p>
              <p className="text-[10px] text-white/40">{remaining > 0 ? 'Restantes' : 'Excedido'}</p>
            </div>
          </div>
          <div className="space-y-2 pt-2 border-t border-white/5">
            <MacroBar label="Proteína" current={totals.protein} goal={macros.protein} color="bg-primary-500" />
            <MacroBar label="Carboidratos" current={totals.carbs} goal={macros.carbs} color="bg-primary-500" />
            <MacroBar label="Gorduras" current={totals.fat} goal={macros.fat} color="bg-primary-500" />
          </div>
        </div>
      )}

      {/* Nutrition */}
      {false && (
      <div className="card space-y-4">
        <h2 className="font-semibold text-white/80">Nutrição diária</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-2xl font-bold">{calories}</p>
            <p className="text-xs text-white/40">kcal/dia</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-primary-300">{water}L</p>
            <p className="text-xs text-white/40">meta de água</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/5">
          <div className="text-center">
            <p className="text-lg font-semibold text-primary-300">{macros.protein}g</p>
            <p className="text-[10px] text-white/30">Proteína</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold text-primary-300">{macros.carbs}g</p>
            <p className="text-[10px] text-white/30">Carboidratos</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold text-primary-300">{macros.fat}g</p>
            <p className="text-[10px] text-white/30">Gorduras</p>
          </div>
        </div>
      </div>
      )}

      {/* Water Tracker */}
      {isWidgetVisible('water') && <WaterTracker
        glasses={waterGlasses}
        goal={Math.round(water * 4)}
        onAdd={() => {
          addGlass();
          const newCount = waterGlasses + 1;
          const goal = Math.round(water * 4);
          if (newCount >= goal && waterGlasses < goal) setShowConfetti(true);
        }}
        onRemove={removeGlass}
        showConfetti={showConfetti}
        onConfettiDone={() => setShowConfetti(false)}
        onHistory={() => setHistoryView('water')}
      />}

      {/* BMI */}
      {isWidgetVisible('bmi') && <div className="card space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-white/80 flex items-center gap-2">
            <MaterialIcon name="straighten" className="text-primary-300" />
            IMC
          </h2>
          <HistoryButton onClick={() => setHistoryView('bmi')} label="Histórico de IMC" />
        </div>
        <div className="flex items-end justify-between gap-3">
          <p className="text-3xl font-bold">{bmi}</p>
          <span className="text-sm px-3 py-1 rounded-full bg-primary-500/10 text-primary-300">
            {bmiCategory(bmi)}
          </span>
        </div>
      </div>}

      {/* Weight Chart */}
      {isWidgetVisible('weight') && <div className="card space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-white/80 flex items-center gap-2">
            <MaterialIcon name="show_chart" className="text-primary-300" />
            Evolução do peso
          </h2>
          <div className="flex items-center gap-2">
            <HistoryButton onClick={() => setHistoryView('weight')} label="Histórico de peso" />
            <button
              onClick={() => setShowWeightPrompt(true)}
              className="text-xs text-primary-400 font-medium"
            >
              + Registrar
            </button>
          </div>
        </div>
        <WeightChart entries={weightEntries} />
      </div>}

      {editingDashboard && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-white/80 flex items-center gap-2">
              <MaterialIcon name="widgets" className="text-primary-300" />
              Editar dashboard
            </h2>
            <button onClick={resetWidgets} className="text-xs text-primary-400 font-medium">Restaurar</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {DEFAULT_DASHBOARD_WIDGETS.map((widget) => (
              <button
                key={widget}
                onClick={() => toggleWidget(widget)}
                className={`px-3 py-2 rounded-xl border text-left text-xs font-medium transition-colors ${
                  widgets.includes(widget)
                    ? 'bg-primary-500/15 border-primary-500/30 text-primary-200'
                    : 'bg-white/5 border-white/10 text-white/35'
                }`}
              >
 {widgets.includes(widget) ? ' ' : '+ '}{DASHBOARD_WIDGET_LABELS[widget]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-center pb-2">
        <button
          onClick={() => setEditingDashboard((value) => !value)}
          className={`px-5 py-3 rounded-full text-sm font-semibold border transition-colors ${
            editingDashboard
              ? 'bg-primary-500 text-black border-primary-400'
              : 'bg-dark-100 text-white/70 border-white/10'
          }`}
        >
          {editingDashboard ? 'Concluir' : 'Editar dashboard'}
        </button>
      </div>

      {/* Weight Prompt */}
      {historyView && (
        <DashboardHistoryModal
          view={historyView}
          onClose={() => setHistoryView(null)}
          sessions={sessions}
          foodLogs={foodLogs}
          waterLogs={waterLogs}
          weightEntries={weightEntries}
          profileHeight={profile.height}
          notes={notes}
        />
      )}
      {showWeightPrompt && <WeightPrompt onClose={() => setShowWeightPrompt(false)} />}
      {showActivityModal && <FreeActivityModal onClose={() => setShowActivityModal(false)} />}
    </div>
  );
}

const LOCATION_LABELS: Record<ActivityLocation, string> = {
  academia: 'Academia',
  casa: 'Casa',
  rua: 'Rua',
  outro: 'Outro',
};

const INTENSITY_LABELS: Record<ActivityIntensity, string> = {
  leve: 'Leve',
  moderada: 'Moderada',
  forte: 'Forte',
};

function FreeActivityModal({ onClose }: { onClose: () => void }) {
  const addFreeSession = useHistoryStore((s) => s.addFreeSession);
  const toast = useToastStore((s) => s.show);
  const [activityName, setActivityName] = useState('Caminhada');
  const [location, setLocation] = useState<ActivityLocation>('rua');
  const [intensity, setIntensity] = useState<ActivityIntensity>('moderada');
  const [date, setDate] = useState(getToday());
  const [duration, setDuration] = useState('40');
  const [distance, setDistance] = useState('');
  const [notes, setNotes] = useState('');

  const durationMinutes = Number(duration);
  const distanceKm = distance ? Number(distance.replace(',', '.')) : undefined;
  const validDuration = Number.isFinite(durationMinutes) && durationMinutes > 0;
  const validDistance = distanceKm === undefined || (Number.isFinite(distanceKm) && distanceKm > 0);
  const canSave = activityName.trim().length > 0 && validDuration && validDistance;

  const save = () => {
    if (!canSave) return;
    addFreeSession({
      activityName,
      activityLocation: location,
      activityIntensity: intensity,
      date,
      durationMinutes,
      distanceKm,
      notes,
    });
    toast('Atividade registrada no histórico de consistência!', 'success');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[90] bg-black/70 flex items-end px-4 pb-4" onClick={onClose}>
      <div className="w-full max-w-md mx-auto rounded-3xl border border-white/10 bg-[rgb(var(--color-bg-card-rgb))] p-4 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Registrar atividade</h2>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-white/5 text-white/40">X</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 col-span-2">
            <span className="text-xs text-white/45">Tipo</span>
            <input
              value={activityName}
              onChange={(e) => setActivityName(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-3 text-sm outline-none focus:border-primary-400"
              placeholder="Ex: Caminhada"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-white/45">Data</span>
            <CustomDatePicker value={date} onChange={setDate} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-white/45">Duração (min)</span>
            <input
              value={duration}
              onChange={(e) => setDuration(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-3 text-sm outline-none focus:border-primary-400"
              placeholder="40"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-white/45">Distância (km, opcional)</span>
            <input
              value={distance}
              onChange={(e) => setDistance(e.target.value.replace(/[^\d.,]/g, ''))}
              inputMode="decimal"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-3 text-sm outline-none focus:border-primary-400"
              placeholder="5,2"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-white/45">Local</span>
            <CustomSelect
              value={location}
              onChange={(value) => setLocation(value as ActivityLocation)}
              options={Object.entries(LOCATION_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-white/45">Intensidade</span>
            <CustomSelect
              value={intensity}
              onChange={(value) => setIntensity(value as ActivityIntensity)}
              options={Object.entries(INTENSITY_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </label>
          <label className="space-y-1 col-span-2">
            <span className="text-xs text-white/45">Observações (opcional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-3 text-sm outline-none resize-none focus:border-primary-400"
              placeholder="Ex: caminhada leve após almoço"
            />
          </label>
        </div>

        <button
          onClick={save}
          disabled={!canSave}
          className="w-full py-3 rounded-xl bg-primary-500 text-black font-bold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Salvar atividade
        </button>
      </div>
    </div>
  );
}

function HistoryButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className="w-8 h-8 rounded-full bg-white/5 text-white/45 flex items-center justify-center shrink-0" aria-label={label}>
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l3 2" />
      </svg>
    </button>
  );
}

function DashboardHistoryModal({
  view,
  onClose,
  sessions,
  foodLogs,
  waterLogs,
  weightEntries,
  profileHeight,
  notes,
}: {
  view: Exclude<DashboardHistory, null>;
  onClose: () => void;
  sessions: ReturnType<typeof useHistoryStore.getState>['sessions'];
  foodLogs: ReturnType<typeof useFoodStore.getState>['logs'];
  waterLogs: ReturnType<typeof useWaterStore.getState>['logs'];
  weightEntries: ReturnType<typeof useWeightStore.getState>['entries'];
  profileHeight: number;
  notes: ReturnType<typeof useNotesStore.getState>['notes'];
}) {
  const completed = sessions.filter((s) => s.completedAt);
  const titleMap: Record<Exclude<DashboardHistory, null>, string> = {
    consistency: 'Histórico de consistência',
    load: 'Histórico de carga',
    calories: 'Histórico de calorias',
    water: 'Histórico de água',
    bmi: 'Histórico de IMC',
    weight: 'Histórico de peso',
  };

  const calorieRows = Object.entries(foodLogs)
    .map(([date, entries]) => ({ date, value: entries.reduce((sum, item) => sum + item.calories, 0) }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const waterRows = Object.entries(waterLogs)
    .map(([date, glasses]) => ({ date, value: glasses * 250, detail: `${glasses} copos` }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const bmiRows = weightEntries
    .map((entry) => ({ date: entry.date, value: calculateBMI(entry.weight, profileHeight), detail: `${entry.weight}kg` }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const loadRows = Object.entries(notes)
    .map(([id, note]) => {
      const exercise = Object.values(WORKOUT_MAP).flatMap((workout) => workout.exercises).find((item) => item.id === id);
      return { date: 'Atual', label: exercise?.name || 'Exercício', value: note };
    })
    .filter((row) => row.value)
    .slice(0, 20);

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 px-4" onClick={onClose}>
      <div className="w-full max-w-md max-h-[78vh] overflow-y-auto rounded-t-[28px] bg-[rgb(var(--color-bg-card-rgb))] border border-white/10 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] space-y-4" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black">{titleMap[view]}</h2>
          <button onClick={onClose} className="w-10 h-10 rounded-full bg-white/5 text-white/60">X</button>
        </div>

        {view === 'consistency' && (
          <div className="space-y-2">
            {completed.slice(0, 30).map((session) => (
              <HistoryRow key={session.id} title={session.workoutType ? `Treino ${session.workoutType}` : session.activityName || 'Atividade avulsa'} value={formatDateBR(session.date)} detail={formatMinutes(session.durationMs)} />
            ))}
            {completed.length === 0 && <EmptyHistory />}
          </div>
        )}

        {view === 'load' && (
          <div className="space-y-2">
            {loadRows.map((row) => <HistoryRow key={row.label} title={row.label} value={row.value} detail={row.date} />)}
            {loadRows.length === 0 && <EmptyHistory />}
          </div>
        )}

        {view === 'calories' && (
          <div className="space-y-2">
            {calorieRows.slice(0, 30).map((row) => <HistoryRow key={row.date} title={formatDateBR(row.date)} value={`${row.value} kcal`} />)}
            {calorieRows.length === 0 && <EmptyHistory />}
          </div>
        )}

        {view === 'water' && (
          <div className="space-y-2">
            {waterRows.slice(0, 30).map((row) => <HistoryRow key={row.date} title={formatDateBR(row.date)} value={`${row.value} ml`} detail={row.detail} />)}
            {waterRows.length === 0 && <EmptyHistory />}
          </div>
        )}

        {view === 'bmi' && (
          <div className="space-y-2">
            {bmiRows.slice(0, 30).map((row) => <HistoryRow key={row.date} title={formatDateBR(row.date)} value={String(row.value)} detail={row.detail} />)}
            {bmiRows.length === 0 && <EmptyHistory />}
          </div>
        )}

        {view === 'weight' && (
          <div className="space-y-2">
            {weightEntries.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30).map((row) => <HistoryRow key={row.date} title={formatDateBR(row.date)} value={`${row.weight}kg`} />)}
            {weightEntries.length === 0 && <EmptyHistory />}
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return (
    <div className="rounded-2xl bg-white/5 border border-white/5 p-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-bold truncate">{title}</p>
        {detail && <p className="text-xs text-white/35 truncate">{detail}</p>}
      </div>
      <p className="text-sm font-black text-primary-300">{value}</p>
    </div>
  );
}

function EmptyHistory() {
  return <p className="rounded-2xl bg-white/5 p-4 text-sm text-white/40 text-center">Nenhum registro ainda.</p>;
}

function formatMinutes(durationMs?: number) {
  if (!durationMs) return 'Sem duração';
  return `${Math.round(durationMs / 60000)} min`;
}

function MacroBar({ label, current, goal, color }: { label: string; current: number; goal: number; color: string }) {
  const progress = Math.min(current / goal, 1);
  return (
    <div className="flex items-center gap-3">
      <span className="text-[10px] text-white/40 w-20">{label}</span>
      <div className="flex-1 h-2 bg-dark-300 rounded-full overflow-hidden">
        <motion.div
          className={`h-full rounded-full ${color}`}
          animate={{ width: `${progress * 100}%` }}
          transition={{ type: 'spring', stiffness: 100 }}
        />
      </div>
      <span className="text-[10px] text-white/50 w-16 text-right">{current}/{goal}g</span>
    </div>
  );
}

function WaterTracker({ glasses, goal, onAdd, onRemove, showConfetti, onConfettiDone, onHistory }: {
  glasses: number; goal: number; onAdd: () => void; onRemove: () => void;
  showConfetti: boolean; onConfettiDone: () => void; onHistory?: () => void;
}) {
  const progress = Math.min(glasses / goal, 1);
  const ml = glasses * 250;

  useEffect(() => {
    if (showConfetti) {
      const t = setTimeout(onConfettiDone, 3000);
      return () => clearTimeout(t);
    }
  }, [showConfetti]);

  return (
    <div className="card space-y-3 relative overflow-hidden">
      {showConfetti && (
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-10"
        >
          <MaterialIcon name="celebration" className="text-5xl animate-bounce text-primary-300" />
        </motion.div>
      )}
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-white/80 flex items-center gap-2">
          <MaterialIcon name="opacity" className="text-primary-300" />
          Água
        </h2>
        <div className="flex items-center gap-2">
          <p className="text-xs text-white/40 font-mono">{ml}ml / {goal * 250}ml</p>
          {onHistory && <HistoryButton onClick={onHistory} label="Histórico de água" />}
        </div>
      </div>
      <div className="h-3 bg-dark-300 rounded-full overflow-hidden">
        <motion.div
          className="h-full rounded-full bg-primary-500"
          initial={{ width: 0 }}
          animate={{ width: `${progress * 100}%` }}
          transition={{ type: 'spring', stiffness: 100 }}
        />
      </div>
      <div className="flex items-center justify-between">
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={onRemove}
          disabled={glasses <= 0}
          className="w-12 h-12 rounded-full bg-dark-300 flex items-center justify-center text-white/50 text-xl disabled:opacity-30"
        >
          −
        </motion.button>
        <div className="flex gap-1 flex-wrap justify-center max-w-[200px]">
          {Array.from({ length: goal }).map((_, i) => (
            <motion.div
              key={i}
              animate={{ scale: i < glasses ? 1.2 : 1, backgroundColor: i < glasses ? 'rgb(96 165 250)' : 'rgb(var(--color-bg-rgb))' }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className={`w-2.5 h-2.5 rounded-full border border-white/10 ${i < glasses ? '' : 'bg-dark-300'}`}
            />
          ))}
        </div>
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={onAdd}
          className="w-12 h-12 rounded-full bg-primary-500/20 border border-primary-500/30 flex items-center justify-center text-primary-300 font-bold text-xl"
        >
          +
        </motion.button>
      </div>
      {glasses >= goal && (
 <p className="text-center text-xs text-primary-300 font-medium"> Meta atingida! Parabéns!</p>
      )}
    </div>
  );
}
