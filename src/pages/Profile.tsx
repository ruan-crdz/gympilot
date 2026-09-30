import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProfileStore, WEEKDAY_OPTIONS, GOAL_OPTIONS, EXPERIENCE_OPTIONS } from '@/stores/useProfileStore';
import { useAIStore } from '@/stores/useAIStore';
import { useAIConfigStore, AI_PERSONALITIES, type AIPersonality } from '@/stores/useAIConfigStore';
import { useToastStore } from '@/stores/useToastStore';
import { planLabel, resolveAIPlan } from '@/constants/aiPlan';
import { useThemeStore, THEMES } from '@/stores/useThemeStore';
import { useAccessibilityStore, type FontScale } from '@/stores/useAccessibilityStore';
import { useCycleStore, CYCLE_PHASES } from '@/stores/useCycleStore';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { TrainingContextFields } from '@/components/profile/TrainingContextFields';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { supabase } from '@/lib/supabase';
import { createUltimateCheckout, syncLatestPayment, syncPlanFromBackend } from '@/lib/billing';
import { calculateTDEE, calculateMacros, calculateBMI } from '@/utils/calories';
import { calculateWaterIntake } from '@/utils/water';
import { clearGymPilotLocalData } from '@/utils/resetAppData';
import { toPositiveIntOrFallback } from '@/utils/profileMapping';
import type { WeekDay, Goal, BiologicalSex, ExperienceLevel, TrainingLocation } from '@/types';

const PENDING_BILLING_KEY = 'gympilot-pending-billing';

export function Profile() {
  const navigate = useNavigate();
  const toast = useToastStore((s) => s.show);
  const { profile, updateProfile } = useProfileStore();
  const { isEnabled, hasSeenIntro } = useAIStore();
  const { assistantName, personality, setAssistantName, setPersonality, resetAIConfig } = useAIConfigStore();
  const aiPlan = resolveAIPlan(profile);
  const { themeId, setTheme } = useThemeStore();
  const {
    fontScale,
    highContrast,
    reduceMotion,
    screenReaderMode,
    setFontScale,
    toggleHighContrast,
    toggleReduceMotion,
    toggleScreenReaderMode,
    resetAccessibility,
  } = useAccessibilityStore();
  const { phase, setPhase } = useCycleStore();
  const [editing, setEditing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'health' | 'appearance' | 'ai' | 'account' | null>(null);
  const [showAccountManagement, setShowAccountManagement] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [accountAction, setAccountAction] = useState<'delete' | null>(null);
  const [processingAccountAction, setProcessingAccountAction] = useState(false);
  const [upgradingPlan, setUpgradingPlan] = useState(false);
  const [assistantNameInput, setAssistantNameInput] = useState(assistantName);

  const [name, setName] = useState(profile?.name || '');
  const [sex, setSex] = useState<BiologicalSex>(profile?.sex || 'undisclosed');
  const [age, setAge] = useState(String(profile?.age || ''));
  const [weight, setWeight] = useState(String(profile?.weight || ''));
  const [height, setHeight] = useState(String(profile?.height || ''));
  const [goal, setGoal] = useState<Goal>(profile?.goal || 'lose');
  const [experience, setExperience] = useState<ExperienceLevel>(profile?.experienceLevel || 'beginner');
  const [days, setDays] = useState<WeekDay[]>(profile?.trainingDays || []);
  const [sessionDurationMin, setSessionDurationMin] = useState(String(profile?.sessionDurationMin || 60));
  const [trainingLocation, setTrainingLocation] = useState<TrainingLocation>(profile?.trainingLocation || 'academia');
  const [equipmentAccess, setEquipmentAccess] = useState<string[]>(profile?.equipmentAccess || []);
  const [preferredExercises, setPreferredExercises] = useState<string[]>(profile?.preferredExercises || []);
  const [dislikedExercises, setDislikedExercises] = useState<string[]>(profile?.dislikedExercises || []);
  const [limitations, setLimitations] = useState<string[]>(profile?.limitations || []);

  useEffect(() => {
    void syncPlanFromBackend().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let cancelled = false;
    void client.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const { data: admin } = await client
        .from('app_admins')
        .select('user_id')
        .eq('user_id', data.user.id)
        .maybeSingle();
      if (!cancelled) setIsAdmin(Boolean(admin));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const hash = window.location.hash || '';
    const query = hash.includes('?') ? new URLSearchParams(hash.slice(hash.indexOf('?') + 1)) : new URLSearchParams();
    const billingResult = query.get('billing');

    const clearBillingQuery = () => {
      window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}#/profile`);
    };

    if (billingResult === 'success') {
      localStorage.setItem(PENDING_BILLING_KEY, String(Date.now()));
      toast('Pagamento recebido. Atualizando seu plano...', 'success');
      clearBillingQuery();
      return;
    }

    if (billingResult === 'pending') {
      localStorage.setItem(PENDING_BILLING_KEY, String(Date.now()));
      toast('Confirmando pagamento. O Ultimate será liberado automaticamente.', 'info');
      clearBillingQuery();
      return;
    }

    if (billingResult === 'failure') {
      toast('Pagamento não concluído. Tente novamente.', 'error');
      clearBillingQuery();
    }
  }, [toast]);

  useEffect(() => {
    if (aiPlan === 'ultimate') {
      localStorage.removeItem(PENDING_BILLING_KEY);
      return;
    }

    const shouldKeepPolling = Boolean(localStorage.getItem(PENDING_BILLING_KEY));

    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;

    const checkPayment = async () => {
      if (cancelled || document.hidden) return;
      attempts += 1;

      try {
        const status = await syncLatestPayment();
        if (status === 'approved') {
          const plan = await syncPlanFromBackend();
          if (!cancelled && plan === 'ultimate') {
            localStorage.removeItem(PENDING_BILLING_KEY);
            toast('Pagamento aprovado. Ultimate liberado!', 'success');
            return;
          }
        }
      } catch {
        // The provider may still be processing the payment. Retry briefly.
      }

      if (!cancelled && shouldKeepPolling && attempts < 40) {
        timer = window.setTimeout(checkPayment, 3000);
      }
    };

    const checkWhenVisible = () => {
      if (!document.hidden) void checkPayment();
    };

    void checkPayment();
    if (shouldKeepPolling) {
      window.addEventListener('focus', checkWhenVisible);
      document.addEventListener('visibilitychange', checkWhenVisible);
    }

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('focus', checkWhenVisible);
      document.removeEventListener('visibilitychange', checkWhenVisible);
    };
  }, [aiPlan, toast]);

  if (!profile) return null;

  const calories = calculateTDEE(profile);
  const macros = calculateMacros(calories, profile.goal);
  const bmi = calculateBMI(profile.weight, profile.height);
  const water = calculateWaterIntake(profile.weight);

  const toggleDay = (day: WeekDay) => {
    setDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  };

  const handleSave = () => {
    updateProfile({
      name,
      sex,
      age: Number(age),
      weight: Number(weight),
      height: Number(height),
      goal,
      experienceLevel: experience,
      trainingDays: days,
      sessionDurationMin: toPositiveIntOrFallback(sessionDurationMin, 60),
      trainingLocation,
      equipmentAccess,
      preferredExercises,
      dislikedExercises,
      limitations,
    });
    setEditing(false);
  };

  const openEditor = () => {
    setName(profile.name);
    setSex(profile.sex || 'undisclosed');
    setAge(String(profile.age || ''));
    setWeight(String(profile.weight || ''));
    setHeight(String(profile.height || ''));
    setGoal(profile.goal);
    setExperience(profile.experienceLevel || 'beginner');
    setDays(profile.trainingDays || []);
    setSessionDurationMin(String(profile.sessionDurationMin || 60));
    setTrainingLocation(profile.trainingLocation || 'academia');
    setEquipmentAccess([...(profile.equipmentAccess || [])]);
    setPreferredExercises([...(profile.preferredExercises || [])]);
    setDislikedExercises([...(profile.dislikedExercises || [])]);
    setLimitations([...(profile.limitations || [])]);
    setShowSettings(false);
    setEditing(true);
  };

  const redirectToAppRoot = () => {
    window.location.href = import.meta.env.BASE_URL || '/';
  };

  const handleDeleteAccount = async () => {
    if (!supabase) {
      toast('Supabase não configurado neste ambiente.', 'error');
      return;
    }

    setProcessingAccountAction(true);
    try {
      const { data, error } = await supabase.rpc('delete_my_account');
      if (error) throw error;

      const payload = (data && typeof data === 'object' ? data : {}) as { success?: boolean; error?: string };
      if (payload.success !== true) {
        throw new Error(payload.error || 'Não foi possível excluir sua conta.');
      }

      clearGymPilotLocalData();
      redirectToAppRoot();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao excluir conta.';
      if (message.includes('delete_my_account')) {
        toast('A função delete_my_account ainda não existe no banco. Rode o setup-all.sql no Supabase.', 'error');
      } else {
        toast(message, 'error');
      }
    } finally {
      setProcessingAccountAction(false);
      setAccountAction(null);
    }
  };

  const handleUpgradeToUltimate = async (cycle: 'monthly' | 'annual') => {
    if (upgradingPlan) return;

    setUpgradingPlan(true);
    try {
      const { checkoutUrl } = await createUltimateCheckout(cycle);
      localStorage.setItem(PENDING_BILLING_KEY, String(Date.now()));
      window.location.href = checkoutUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não consegui iniciar o checkout agora.';
      toast(message, 'error');
    } finally {
      setUpgradingPlan(false);
    }
  };

  if (!editing && !showSettings) {
    const goalOption = GOAL_OPTIONS.find((option) => option.value === profile.goal);

    return (
      <div className="gym-page">
        <div className="flex items-center justify-between">
          <div>
            <p className="gym-kicker">Sua conta</p>
            <h1 className="gym-title mt-1">Perfil</h1>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="gym-icon-tile"
            aria-label="Abrir configurações"
          >
            <MaterialIcon name="settings" className="text-xl" />
          </button>
        </div>

        <section className="relative overflow-hidden rounded-2xl border border-primary-500/20 bg-[rgb(var(--color-bg-card-rgb))] p-5">
          <div className="absolute inset-x-0 top-0 h-1 bg-primary-500" />
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary-500 text-2xl font-black text-black">
              {profile.name.trim().charAt(0).toUpperCase() || 'G'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-xl font-black text-white">{profile.name}</h2>
                <span className={`rounded-full border px-2 py-1 text-[10px] font-black ${
                  aiPlan === 'ultimate'
                    ? 'border-primary-500/40 bg-primary-500/15 text-primary-300'
                    : 'border-white/10 bg-white/5 text-white/45'
                }`}>
                  {planLabel(aiPlan)}
                </span>
              </div>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-white/50">
                <MaterialIcon name={goalOption?.icon || 'track_changes'} className="text-base text-primary-300" />
                {goalOption?.label}
              </p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-3 divide-x divide-white/10 border-t border-white/10 pt-4 text-center">
            <ProfileMetric label="Peso" value={`${profile.weight} kg`} />
            <ProfileMetric label="IMC" value={String(bmi)} />
            <ProfileMetric label="Treinos" value={`${profile.trainingDays.length}x`} />
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={openEditor}
            className="flex min-h-24 flex-col items-start justify-between rounded-xl border border-white/10 bg-[rgb(var(--color-bg-card-rgb))] p-4 text-left"
          >
            <MaterialIcon name="edit" className="text-2xl text-primary-300" />
            <span className="text-sm font-bold text-white/80">Editar perfil</span>
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="flex min-h-24 flex-col items-start justify-between rounded-xl border border-white/10 bg-[rgb(var(--color-bg-card-rgb))] p-4 text-left"
          >
            <MaterialIcon name="tune" className="text-2xl text-primary-300" />
            <span className="text-sm font-bold text-white/80">Configurações</span>
          </button>
        </div>

        {isAdmin && (
          <button
            onClick={() => navigate('/admin')}
            className="flex w-full items-center justify-between rounded-xl border border-primary-500/25 bg-primary-500/10 px-4 py-4 text-left"
          >
            <span className="flex items-center gap-3">
              <MaterialIcon name="admin_panel_settings" className="text-2xl text-primary-300" />
              <span>
                <span className="block text-sm font-black text-white/85">Dashboard administrativo</span>
                <span className="block text-xs text-white/40">Usuários, retenção, receita e produto</span>
              </span>
            </span>
            <MaterialIcon name="chevron_right" className="text-primary-300" />
          </button>
        )}

        <section className="card space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase text-white/35">Metas diárias</p>
              <p className="mt-1 text-sm text-white/60">Calculadas a partir do seu perfil</p>
            </div>
            <MaterialIcon name="track_changes" className="text-2xl text-primary-300" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <CompactGoal label="Calorias" value={`${calories}`} unit="kcal" />
            <CompactGoal label="Proteína" value={`${macros.protein}`} unit="g" />
            <CompactGoal label="Água" value={`${water}`} unit="L" />
          </div>
        </section>

        <button
          onClick={() => setShowSettings(true)}
          className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-4 py-4 text-left"
        >
          <span className="flex items-center gap-3">
            <MaterialIcon name="workspace_premium" className="text-xl text-primary-300" />
            <span>
              <span className="block text-sm font-bold text-white/80">GymPilot {planLabel(aiPlan)}</span>
              <span className="block text-xs text-white/35">Plano, IA e preferências</span>
            </span>
          </span>
          <MaterialIcon name="chevron_right" className="text-white/30" />
        </button>
      </div>
    );
  }

  return (
    <div className="gym-page">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              if (!editing && settingsSection) {
                setSettingsSection(null);
              } else {
                setEditing(false);
                setShowSettings(false);
                setSettingsSection(null);
              }
            }}
            className="gym-icon-tile"
            aria-label="Voltar para o perfil"
          >
            <MaterialIcon name="arrow_back" className="text-xl" />
          </button>
          <div>
            <p className="gym-kicker">Perfil</p>
            <h1 className="text-xl font-black">
              {editing
                ? 'Editar perfil'
                : settingsSection === 'health'
                  ? 'Saúde'
                  : settingsSection === 'appearance'
                    ? 'Aparência e acesso'
                    : settingsSection === 'ai'
                      ? 'IA e plano'
                      : settingsSection === 'account'
                        ? 'Conta'
                        : 'Configurações'}
            </h1>
          </div>
        </div>
        {editing && (
          <button
            onClick={handleSave}
            className="rounded-xl bg-primary-500 px-4 py-2 text-sm font-black text-black shadow-lg shadow-primary-500/20"
          >
            Salvar
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-4">
          <div>
            <label className="text-sm text-white/40 mb-1 block">Nome</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-field"
            />
          </div>
          <div>
            <label className="text-sm text-white/40 mb-2 block">Sexo biológico</label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button onClick={() => setSex('female')} className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${sex === 'female' ? 'bg-primary-500 text-black' : 'bg-dark-200 text-white/50'}`}>
                <MaterialIcon name="female" className="text-primary-300" /> Feminino
              </button>
              <button onClick={() => setSex('male')} className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${sex === 'male' ? 'bg-primary-500 text-black' : 'bg-dark-200 text-white/50'}`}>
                <MaterialIcon name="male" className="text-primary-300" /> Masculino
              </button>
              <button onClick={() => setSex('undisclosed')} className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${sex === 'undisclosed' ? 'bg-primary-500 text-black' : 'bg-dark-200 text-white/50'}`}>
                <MaterialIcon name="shield" className="text-primary-300" /> Não informar
              </button>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-sm text-white/40 mb-1 block">Idade</label>
              <input
                type="number"
                inputMode="numeric"
                min="10"
                max="100"
                value={age}
                onChange={(e) => setAge(e.target.value)}
                className="input-field"
              />
            </div>
            <div>
              <label className="text-sm text-white/40 mb-1 block">Peso (kg)</label>
              <input
                type="number"
                inputMode="decimal"
                min="30"
                max="300"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                className="input-field"
                step="0.1"
              />
            </div>
            <div>
              <label className="text-sm text-white/40 mb-1 block">Altura (cm)</label>
              <input
                type="number"
                inputMode="numeric"
                min="100"
                max="250"
                value={height}
                onChange={(e) => setHeight(e.target.value)}
                className="input-field"
              />
            </div>
          </div>

          <div>
            <label className="text-sm text-white/40 mb-2 block">Objetivo</label>
            <div className="space-y-2">
              {GOAL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setGoal(opt.value)}
                  className={`w-full p-3 rounded-xl border text-left flex items-center gap-2 transition-all text-sm ${
                    goal === opt.value
                      ? 'border-primary-500 bg-primary-500/10'
                      : 'border-white/10 bg-dark-200'
                  }`}
                >
                  <MaterialIcon name={opt.icon} className="text-lg text-primary-300" />
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm text-white/40 mb-2 block">Nível de experiência</label>
            <div className="space-y-2">
              {EXPERIENCE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setExperience(opt.value)}
                  className={`w-full p-3 rounded-xl border text-left flex items-center gap-2 transition-all text-sm ${
                    experience === opt.value
                      ? 'border-primary-500 bg-primary-500/10'
                      : 'border-white/10 bg-dark-200'
                  }`}
                >
                  <MaterialIcon name={opt.icon} className="text-lg text-primary-300" />
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm text-white/40 mb-2 block">Dias de treino</label>
            <div className="grid grid-cols-7 gap-2">
              {WEEKDAY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => toggleDay(opt.value)}
                  className={`py-3 rounded-lg text-center text-xs font-semibold transition-all ${
                    days.includes(opt.value)
                      ? 'bg-primary-500 text-white'
                      : 'bg-dark-200 text-white/40'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="card space-y-4">
            <h2 className="font-semibold text-white/80">Contexto de treino</h2>
            <TrainingContextFields
              sessionDurationMin={sessionDurationMin}
              onSessionDurationChange={setSessionDurationMin}
              trainingLocation={trainingLocation}
              onTrainingLocationChange={setTrainingLocation}
              equipmentAccess={equipmentAccess}
              onEquipmentAccessChange={setEquipmentAccess}
              preferredExercises={preferredExercises}
              onPreferredExercisesChange={setPreferredExercises}
              dislikedExercises={dislikedExercises}
              onDislikedExercisesChange={setDislikedExercises}
              limitations={limitations}
              onLimitationsChange={setLimitations}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {settingsSection === null && (
            <div className="card overflow-hidden p-0">
              <SettingsRow icon="health_and_safety" title="Saúde" description="Ciclo e preferências pessoais" onClick={() => setSettingsSection('health')} />
              <SettingsRow icon="palette" title="Aparência e acessibilidade" description="Tema, fonte, contraste e movimento" onClick={() => setSettingsSection('appearance')} />
              <SettingsRow icon="smart_toy" title="IA e plano" description={`${assistantName}, personalidade e ${planLabel(aiPlan)}`} onClick={() => setSettingsSection('ai')} />
              <SettingsRow icon="manage_accounts" title="Conta" description="Dados e ações avançadas" onClick={() => setSettingsSection('account')} last />
            </div>
          )}

          {/* Cycle Phase */}
          {settingsSection === 'health' && (
          <div className="card space-y-3">
            <h2 className="font-semibold text-white/80 flex items-center gap-2"><MaterialIcon name="autorenew" className="text-primary-300" /> Fase do ciclo</h2>
            <div className="grid grid-cols-2 gap-2">
              {CYCLE_PHASES.map((cp) => (
                <button
                  key={cp.value}
                  onClick={() => setPhase(cp.value)}
                  className={`flex items-center gap-2 p-3 rounded-xl border text-left transition-all text-xs ${
                    phase === cp.value ? 'border-primary-500 bg-primary-500/10' : 'border-white/5'
                  }`}
                >
                  <MaterialIcon name={cp.icon} className="text-lg text-primary-300" />
                  <span className="font-medium text-white/70">{cp.label}</span>
                </button>
              ))}
            </div>
            {phase !== 'none' && (
              <p className="text-xs text-white/40 italic flex items-start gap-1">
                <MaterialIcon name="lightbulb" className="text-primary-300 mt-0.5" />
                <span>{CYCLE_PHASES.find((c) => c.value === phase)?.tip}</span>
              </p>
            )}
          </div>
          )}

          {/* Theme Section */}
          {settingsSection === 'appearance' && (
          <>
          <div className="card space-y-3">
            <h2 className="font-semibold text-white/80 flex items-center gap-2"><MaterialIcon name="palette" className="text-primary-300" /> Tema</h2>
            <div className="grid grid-cols-5 gap-2">
              {THEMES.filter((t) => !t.special).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                  aria-pressed={themeId === t.id}
                  className={`relative flex items-center justify-center p-2 rounded-xl border transition-all ${
                    themeId === t.id ? 'border-primary-500 bg-primary-500/10 scale-105 shadow-[0_0_0_1px_rgba(var(--color-primary-rgb),0.35)]' : 'border-white/5'
                  }`}
                >
                  <div className="w-6 h-6 rounded-full" style={{ backgroundColor: t.colors.primary }} />
                </button>
              ))}
            </div>
            <div className="space-y-2 pt-2 border-t border-white/5">
              <p className="text-xs text-white/30">Temas especiais</p>
              <div className="grid grid-cols-2 gap-2">
                {THEMES.filter((t) => t.special).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    aria-pressed={themeId === t.id}
                    className={`flex items-center gap-2 p-3 rounded-xl border text-left transition-all ${
                      themeId === t.id ? 'border-primary-500 bg-primary-500/10 shadow-[0_0_0_1px_rgba(var(--color-primary-rgb),0.35)]' : 'border-white/5'
                    }`}
                  >
                    <MaterialIcon name={themeId === t.id ? 'check_circle' : t.icon} className="text-lg text-primary-300" />
                    <span className="text-xs font-medium text-white/70">{t.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Accessibility Section */}
          <div className="card space-y-4">
            <div>
              <h2 className="font-semibold text-white/80">Acessibilidade</h2>
              <p className="text-xs text-white/35 mt-1">Ajustes para leitura, contraste, movimento e uso com leitor de tela.</p>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-white/40 font-semibold">Tamanho da fonte</p>
              <div className="grid grid-cols-3 gap-2">
                {([
                  ['normal', 'Normal'],
                  ['large', 'Grande'],
                  ['extra-large', 'Maior'],
                ] as [FontScale, string][]).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setFontScale(value)}
                    className={`py-3 rounded-xl border text-sm font-semibold transition-all ${
                      fontScale === value
                        ? 'bg-primary-500 text-white border-primary-400'
                        : 'bg-white/5 text-white/60 border-white/10'
                    }`}
                    aria-pressed={fontScale === value}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <AccessibilityToggle
                title="Alto contraste"
                description="Deixa fundos mais escuros, bordas mais fortes e textos apagados mais legiveis."
                enabled={highContrast}
                onToggle={toggleHighContrast}
              />
              <AccessibilityToggle
                title="Reduzir animações"
                description="Diminui transições e movimentos para evitar desconforto."
                enabled={reduceMotion}
                onToggle={toggleReduceMotion}
              />
              <AccessibilityToggle
                title="Modo leitor de tela"
                description="Aumenta áreas de toque, foco visual e espaçamento para navegação assistiva."
                enabled={screenReaderMode}
                onToggle={toggleScreenReaderMode}
              />
            </div>

            <button
              onClick={resetAccessibility}
              className="w-full py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/50 text-xs font-semibold"
            >
              Restaurar acessibilidade padrão
            </button>
          </div>
          </>
          )}

          {/* AI Section */}
          {settingsSection === 'ai' && (
          <div className="card space-y-3 border border-primary-500/20">
            <div className="flex items-center gap-2">
              <MaterialIcon name="smart_toy" className="text-xl text-primary-300" />
              <h2 className="font-semibold text-white/80">{assistantName}</h2>
            </div>
            <div className="space-y-3 rounded-xl bg-white/5 border border-white/10 p-3">
              <label className="block">
                <span className="text-xs text-white/40 font-semibold">Nome da IA</span>
                <input
                  value={assistantNameInput}
                  onChange={(e) => setAssistantNameInput(e.target.value)}
                  onBlur={() => setAssistantName(assistantNameInput)}
                  className="input-field text-sm mt-1"
                  placeholder="Ex: Terraformer"
                />
              </label>
              <div className="space-y-2">
                <p className="text-xs text-white/40 font-semibold">Personalidade</p>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(AI_PERSONALITIES) as AIPersonality[]).map((key) => (
                    <button
                      key={key}
                      onClick={() => setPersonality(key)}
                      className={`rounded-xl border p-3 text-left transition-all ${
                        personality === key ? 'bg-primary-500/10 border-primary-500/30' : 'bg-dark-200 border-white/10'
                      }`}
                    >
                      <span className="block text-xs font-bold text-white/80">{AI_PERSONALITIES[key].label}</span>
                      <span className="block text-[10px] text-white/35 mt-1 leading-relaxed">{AI_PERSONALITIES[key].description}</span>
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[10px] text-white/35 leading-relaxed">
                Os prompts exigem base científica para treino e dieta. O preset Coach BR técnico não imita pessoa real; usa comunicação forte, técnica e motivadora.
              </p>
              <button
                onClick={() => {
                  resetAIConfig();
                  setAssistantNameInput('GymPilot AI');
                }}
                className="w-full py-2 rounded-xl bg-white/5 text-white/40 text-xs font-semibold"
              >
                Restaurar IA padrão
              </button>
            </div>
            <div className="space-y-3">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-2">
                <p className="text-xs text-white/45">Plano atual de IA</p>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-white/85">{planLabel(aiPlan)}</p>
                  {aiPlan === 'ultimate' ? (
                    <span className="text-[10px] px-2 py-1 rounded-full bg-primary-500/20 text-primary-300 border border-primary-500/30">
                      Ultimate ativo
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-1 rounded-full bg-white/10 text-white/60 border border-white/15">
                      Free
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-white/40 leading-relaxed">
                  No Free, você tem 1 montagem de treino com IA. Depois disso, os recursos de IA ficam exclusivos do Ultimate.
                </p>
                {aiPlan === 'free' && (
                  <div className="space-y-2">
                    <button
                      onClick={() => { void handleUpgradeToUltimate('monthly'); }}
                      disabled={upgradingPlan}
                      className="btn-primary py-2.5 text-xs disabled:opacity-50"
                    >
                      <MaterialIcon name="workspace_premium" />
                      {upgradingPlan ? 'Abrindo checkout...' : 'Assinar Ultimate mensal'}
                    </button>
                    <button
                      onClick={() => { void handleUpgradeToUltimate('annual'); }}
                      disabled={upgradingPlan}
                      className="w-full py-2.5 rounded-xl bg-primary-500/15 border border-primary-500/35 text-primary-200 text-xs font-semibold disabled:opacity-50"
                    >
                      Assinar Ultimate anual (desconto)
                    </button>
                  </div>
                )}
              </div>

              {isEnabled && (
                <button
                  onClick={() => navigate(hasSeenIntro ? '/ai' : '/ai/intro')}
                  className="btn-primary py-3 text-sm"
                >
                  <MaterialIcon name="smart_toy" /> Abrir assistente
                </button>
              )}
            </div>
          </div>
          )}

          {settingsSection === 'account' && (
          <div className="card p-0 overflow-hidden">
            <button
              onClick={() => setShowAccountManagement((current) => !current)}
              className="flex w-full items-center justify-between px-4 py-4 text-left"
              aria-expanded={showAccountManagement}
            >
              <span className="flex items-center gap-3">
                <MaterialIcon name="manage_accounts" className="text-xl text-white/45" />
                <span>
                  <span className="block text-sm font-semibold text-white/75">Gerenciar conta</span>
                  <span className="block text-xs text-white/30">Ações avançadas da conta</span>
                </span>
              </span>
              <MaterialIcon name={showAccountManagement ? 'expand_less' : 'expand_more'} className="text-white/30" />
            </button>

            {showAccountManagement && (
              <div className="space-y-3 border-t border-white/10 px-4 py-4">
                <div className="rounded-xl border border-red-500/15 bg-red-500/[0.04] p-3">
                  <p className="text-xs font-semibold text-white/65">Zona de risco</p>
                  <p className="mt-1 text-xs leading-relaxed text-white/35">
                    A exclusão remove sua conta e os dados vinculados no Supabase. Essa ação não pode ser desfeita.
                  </p>
                </div>
                <button
                  onClick={() => setAccountAction('delete')}
                  disabled={processingAccountAction}
                  className="w-full rounded-xl border border-red-500/25 bg-transparent py-3 text-sm font-semibold text-red-300/80 disabled:opacity-50"
                >
                  Excluir minha conta
                </button>
              </div>
            )}
          </div>
          )}

          <ConfirmModal
            open={accountAction !== null}
            title="Excluir conta permanentemente?"
            message="Isso remove seu usuário e dados vinculados no Supabase. Essa ação é irreversível."
            confirmText={processingAccountAction ? 'Processando...' : 'Excluir conta'}
            cancelText="Cancelar"
            danger
            onCancel={() => {
              if (!processingAccountAction) setAccountAction(null);
            }}
            onConfirm={() => {
              if (processingAccountAction) return;
              void handleDeleteAccount();
            }}
          />

        </div>
      )}
    </div>
  );
}

function AccessibilityToggle({
  title,
  description,
  enabled,
  onToggle,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`w-full rounded-xl border p-3 text-left flex items-center justify-between gap-3 transition-all ${
        enabled ? 'bg-primary-500/10 border-primary-500/30' : 'bg-white/5 border-white/10'
      }`}
      aria-pressed={enabled}
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-white/80">{title}</span>
        <span className="block text-xs text-white/40 mt-0.5 leading-relaxed">{description}</span>
      </span>
      <span
        className={`relative w-12 h-7 rounded-full shrink-0 border transition-colors ${
          enabled ? 'bg-primary-500 border-primary-400' : 'bg-dark-300 border-white/10'
        }`}
      >
        <span
          className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white transition-transform ${
            enabled ? 'translate-x-5' : ''
          }`}
        />
      </span>
    </button>
  );
}

function SettingsRow({
  icon,
  title,
  description,
  onClick,
  last = false,
}: {
  icon: string;
  title: string;
  description: string;
  onClick: () => void;
  last?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-4 text-left active:bg-white/5 ${last ? '' : 'border-b border-white/[0.07]'}`}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-300">
        <MaterialIcon name={icon} className="text-xl" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-white/80">{title}</span>
        <span className="mt-0.5 block truncate text-xs text-white/35">{description}</span>
      </span>
      <MaterialIcon name="chevron_right" className="text-white/25" />
    </button>
  );
}

function ProfileMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-2">
      <p className="truncate text-base font-black text-white/90">{value}</p>
      <p className="mt-0.5 text-[10px] font-bold uppercase text-white/30">{label}</p>
    </div>
  );
}

function CompactGoal({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-lg bg-white/[0.04] px-2 py-3 text-center">
      <p className="text-base font-black text-primary-300">
        {value}<span className="ml-0.5 text-[10px] font-bold text-primary-300/70">{unit}</span>
      </p>
      <p className="mt-1 truncate text-[9px] font-bold uppercase text-white/30">{label}</p>
    </div>
  );
}
