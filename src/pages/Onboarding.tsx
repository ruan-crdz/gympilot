import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useProfileStore, WEEKDAY_OPTIONS, GOAL_OPTIONS, EXPERIENCE_OPTIONS, FOCUS_OPTIONS } from '@/stores/useProfileStore';
import { useCustomWorkoutStore } from '@/stores/useCustomWorkoutStore';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { supabase } from '@/lib/supabase';
import type { WeekDay, Goal, BiologicalSex, ExperienceLevel, TrainingFocus, TrainingLocation } from '@/types';
import { parseCsvList, toPositiveIntOrFallback } from '@/utils/profileMapping';

type Step = 'welcome' | 'tour1' | 'tour2' | 'tour3' | 'sex' | 'name' | 'body' | 'goal' | 'experience' | 'days' | 'personalization' | 'focus' | 'customSplit' | 'setup';

function isStepValue(value: string | null): value is Step {
  return value === 'welcome'
    || value === 'tour1'
    || value === 'tour2'
    || value === 'tour3'
    || value === 'sex'
    || value === 'name'
    || value === 'body'
    || value === 'goal'
    || value === 'experience'
    || value === 'days'
    || value === 'personalization'
    || value === 'focus'
    || value === 'customSplit'
    || value === 'setup';
}

interface OnboardingProps {
  onBack?: () => void;
}

function PrivacyHint({ text }: { text: string }) {
  return (
    <p className="mt-1 text-[11px] text-white/35 flex items-start gap-1.5">
      <MaterialIcon name="info" className="text-[14px] text-primary-300 mt-[1px]" />
      <span>{text}</span>
    </p>
  );
}

export function Onboarding({ onBack }: OnboardingProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const existingProfile = useProfileStore((s) => s.profile);
  const setProfile = useProfileStore((s) => s.setProfile);
  const setCustomWorkoutState = useCustomWorkoutStore.setState;

  const requestedStep = new URLSearchParams(location.search).get('step');
  const initialStep: Step = isStepValue(requestedStep)
    ? requestedStep
    : (existingProfile ? 'setup' : 'welcome');

  const [step, setStep] = useState<Step>(initialStep);
  const [sex, setSex] = useState<BiologicalSex>(existingProfile?.sex || 'undisclosed');
  const [name, setName] = useState(existingProfile?.name || '');
  const [age, setAge] = useState(existingProfile?.age ? String(existingProfile.age) : '');
  const [weight, setWeight] = useState(existingProfile?.weight ? String(existingProfile.weight) : '');
  const [height, setHeight] = useState(existingProfile?.height ? String(existingProfile.height) : '');
  const [goal, setGoal] = useState<Goal>(existingProfile?.goal || 'lose');
  const [experience, setExperience] = useState<ExperienceLevel>(existingProfile?.experienceLevel || 'beginner');
  const [days, setDays] = useState<WeekDay[]>(existingProfile?.trainingDays || []);
  const [sessionDurationMin, setSessionDurationMin] = useState(String(existingProfile?.sessionDurationMin || 60));
  const [trainingLocation, setTrainingLocation] = useState<TrainingLocation>(existingProfile?.trainingLocation || 'academia');
  const [equipmentText, setEquipmentText] = useState((existingProfile?.equipmentAccess || []).join(', '));
  const [trainingAgeMonths, setTrainingAgeMonths] = useState(existingProfile?.trainingAgeMonths ? String(existingProfile.trainingAgeMonths) : '');
  const [preferredExercisesText, setPreferredExercisesText] = useState((existingProfile?.preferredExercises || []).join(', '));
  const [dislikedExercisesText, setDislikedExercisesText] = useState((existingProfile?.dislikedExercises || []).join(', '));
  const [limitationsText, setLimitationsText] = useState((existingProfile?.limitations || []).join(', '));
  const [focus, setFocus] = useState<TrainingFocus>(existingProfile?.trainingFocus || 'balanced');
  const [customSplit, setCustomSplit] = useState<Record<string, string>>(existingProfile?.customSplit || {});

  useEffect(() => {
    if (existingProfile?.name?.trim() || name.trim() || !supabase) return;

    void supabase.auth.getSession().then(({ data }) => {
      const sessionName = typeof data.session?.user?.user_metadata?.display_name === 'string'
        ? data.session.user.user_metadata.display_name.trim()
        : '';

      if (sessionName) {
        setName(sessionName);
      }
    });
  }, [existingProfile?.name, name]);

  const getPreviousStep = (): Step | null => {
    if (step === 'tour1') return 'welcome';
    if (step === 'tour2') return 'tour1';
    if (step === 'tour3') return 'tour2';
    if (step === 'sex') return 'tour3';
    if (step === 'name') return 'sex';
    if (step === 'body') return 'name';
    if (step === 'goal') return 'body';
    if (step === 'experience') return 'goal';
    if (step === 'days') return 'experience';
    if (step === 'personalization') return 'days';
    if (step === 'focus') return 'personalization';
    if (step === 'customSplit') return 'focus';
    if (step === 'setup') return focus === 'custom' ? 'customSplit' : 'focus';
    return null;
  };

  const handleBack = () => {
    const previous = getPreviousStep();
    if (previous) {
      setStep(previous);
      return;
    }
    if (onBack) {
      onBack();
      return;
    }
    if (existingProfile) {
      navigate('/dashboard');
    }
  };

  const toggleDay = (day: WeekDay) => {
    setDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  };

  const onlyInteger = (value: string) => value.replace(/\D/g, '');
  const onlyDecimal = (value: string) => {
    const clean = value.replace(/[^\d.,]/g, '').replace(',', '.');
    const [whole, decimal = ''] = clean.split('.');
    return decimal ? `${whole}.${decimal.slice(0, 1)}` : whole;
  };

  const ageNumber = Number(age);
  const weightNumber = Number(weight);
  const heightNumber = Number(height);
  const sessionDurationNumber = Number(sessionDurationMin);
  const trainingAgeNumber = trainingAgeMonths ? Number(trainingAgeMonths) : undefined;
  const bodyValid = ageNumber >= 10 && ageNumber <= 100
    && weightNumber >= 30 && weightNumber <= 300
    && heightNumber >= 100 && heightNumber <= 250;

  const saveProfile = () => {
    setProfile({
      name, age: Number(age), weight: Number(weight), height: Number(height),
      goal, trainingDays: days, sex, experienceLevel: experience,
      trainingFocus: focus,
      aiPlan: 'free',
      sessionDurationMin: toPositiveIntOrFallback(sessionDurationNumber, 60),
      trainingLocation,
      equipmentAccess: parseCsvList(equipmentText),
      trainingAgeMonths: Number.isFinite(trainingAgeNumber || NaN) ? trainingAgeNumber : undefined,
      preferredExercises: parseCsvList(preferredExercisesText),
      dislikedExercises: parseCsvList(dislikedExercisesText),
      limitations: parseCsvList(limitationsText),
      ...(focus === 'custom' && Object.keys(customSplit).length > 0 ? { customSplit } : {}),
    });
  };

  const handleFinishManual = () => {
    saveProfile();
    setCustomWorkoutState({
      activeSlots: ['A', 'B', 'C'],
      customWorkouts: {
        A: [],
        B: [],
        C: [],
        D: null,
        E: null,
      },
    });
    navigate('/dashboard');
  };

  const handleFinishAI = () => {
    saveProfile();
    navigate('/setup-ai');
  };

  return (
    <div className="min-h-[100dvh] flex flex-col justify-center px-6 py-12 relative">
      {step !== 'welcome' && (
        <button
          onClick={handleBack}
          className="absolute left-5 top-12 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-white/50 text-xs font-semibold"
        >
          ← Voltar
        </button>
      )}
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -30 }}
          transition={{ duration: 0.25 }}
        >
          {/* Welcome */}
          {step === 'welcome' && (
            <div className="space-y-8 text-center">
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', delay: 0.2 }}
                className="text-7xl block"
              ><MaterialIcon name="fitness_center" className="text-7xl text-primary-300" /></motion.span>
              <div>
                <h1 className="text-3xl font-bold mb-2">GymPilot</h1>
                <p className="text-white/50">Seu treino inteligente e personalizado</p>
              </div>
              <button className="btn-primary" onClick={() => setStep('tour1')}>
                Começar →
              </button>
            </div>
          )}

          {/* Tour 1 */}
          {step === 'tour1' && (
            <div className="space-y-8 text-center">
              <MaterialIcon name="fitness_center" className="text-6xl text-primary-300 mx-auto" />
              <div>
                <h2 className="text-2xl font-bold mb-2">Treinos Personalizados</h2>
                <p className="text-white/50 leading-relaxed">
                  Treinos montados com base na ciência, adaptados pro seu corpo e objetivo.
                  Cada exercício tem motivo de estar ali.
                </p>
              </div>
              <button className="btn-primary" onClick={() => setStep('tour2')}>
                Próximo →
              </button>
            </div>
          )}

          {/* Tour 2 */}
          {step === 'tour2' && (
            <div className="space-y-8 text-center">
              <MaterialIcon name="smart_toy" className="text-6xl text-primary-300 mx-auto" />
              <div>
                <h2 className="text-2xl font-bold mb-2">IA que te entende</h2>
                <p className="text-white/50 leading-relaxed">
                  A inteligência artificial analisa seu treino, sugere substituições,
                  responde dúvidas e adapta tudo pra você.
                </p>
              </div>
              <button className="btn-primary" onClick={() => setStep('tour3')}>
                Próximo →
              </button>
            </div>
          )}

          {/* Tour 3 */}
          {step === 'tour3' && (
            <div className="space-y-8 text-center">
              <MaterialIcon name="show_chart" className="text-6xl text-primary-300 mx-auto" />
              <div>
                <h2 className="text-2xl font-bold mb-2">Acompanhe tudo</h2>
                <p className="text-white/50 leading-relaxed">
                  Histórico completo, progressão de carga, controle de peso,
                  e relatórios semanais da IA sobre seu desempenho.
                </p>
              </div>
              <button className="btn-primary" onClick={() => setStep('sex')}>
                Vamos lá! →
              </button>
            </div>
          )}

          {/* Biological Sex */}
          {step === 'sex' && (
            <div className="space-y-8">
              <div>
                <h1 className="text-3xl font-bold mb-2"><MaterialIcon name="star" className="text-primary-300" /> Sobre você </h1>
                <p className="text-white/50">Se quiser, você pode não informar agora</p>
              </div>
              <div className="space-y-3">
                <button
                  onClick={() => setSex('female')}
                  className={`w-full p-5 rounded-2xl border text-left flex items-center gap-4 transition-all ${
                    sex === 'female' ? 'border-primary-500 bg-primary-500/10' : 'border-white/10 bg-dark-200'
                  }`}
                >
                  <MaterialIcon name="female" className="text-3xl text-primary-300" />
                  <div>
                    <span className="font-semibold text-lg">Feminino</span>
                    <p className="text-white/40 text-xs">Corpo biologicamente feminino</p>
                  </div>
                </button>
                <button
                  onClick={() => setSex('male')}
                  className={`w-full p-5 rounded-2xl border text-left flex items-center gap-4 transition-all ${
                    sex === 'male' ? 'border-primary-500 bg-primary-500/10' : 'border-white/10 bg-dark-200'
                  }`}
                >
                  <MaterialIcon name="male" className="text-3xl text-primary-300" />
                  <div>
                    <span className="font-semibold text-lg">Masculino</span>
                    <p className="text-white/40 text-xs">Corpo biologicamente masculino</p>
                  </div>
                </button>
                <button
                  onClick={() => setSex('undisclosed')}
                  className={`w-full p-5 rounded-2xl border text-left flex items-center gap-4 transition-all ${
                    sex === 'undisclosed' ? 'border-primary-500 bg-primary-500/10' : 'border-white/10 bg-dark-200'
                  }`}
                >
                  <MaterialIcon name="shield" className="text-3xl text-primary-300" />
                  <div>
                    <span className="font-semibold text-lg">Prefiro não informar</span>
                    <p className="text-white/40 text-xs">Você pode alterar depois no Perfil</p>
                  </div>
                </button>
              </div>
              <p className="text-[11px] text-white/30 text-center">
                Esse dado é opcional e usado apenas para estimativas fisiológicas.
              </p>
              <PrivacyHint text="Seu sexo biológico só influencia estimativas fisiológicas e pode ficar como não informado." />
              <button className="btn-primary" onClick={() => setStep('name')}>
                Continuar
              </button>
            </div>
          )}

          {/* Name */}
          {step === 'name' && (
            <div className="space-y-8">
              <div>
                <h1 className="text-3xl font-bold mb-2"><MaterialIcon name="star" className="text-primary-300" /> Olá! </h1>
                <p className="text-white/50">Como posso te chamar?</p>
              </div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Seu nome"
                className="input-field text-2xl py-4"
                autoFocus
              />
              <button
                className="btn-primary"
                disabled={!name.trim()}
                onClick={() => setStep('body')}
              >
                Continuar
              </button>
            </div>
          )}

          {/* Body */}
          {step === 'body' && (
            <div className="space-y-6">
              <div>
                <h1 className="text-3xl font-bold mb-2 flex items-center gap-2 justify-center"><MaterialIcon name="straighten" className="text-primary-300" /> Seus dados</h1>
                <p className="text-white/50">Para calcular suas necessidades</p>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-white/40 mb-1 block">Idade</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="10"
                    max="100"
                    value={age}
                    onChange={(e) => setAge(onlyInteger(e.target.value).slice(0, 3))}
                    placeholder="25"
                    className="input-field"
                  />
                  <PrivacyHint text="Idade ajusta volume, recuperação e faixa de intensidade sugerida." />
                </div>
                <div>
                  <label className="text-sm text-white/40 mb-1 block">Peso (kg)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="30"
                    max="300"
                    value={weight}
                    onChange={(e) => setWeight(onlyDecimal(e.target.value).slice(0, 5))}
                    placeholder="70"
                    className="input-field"
                    step="0.1"
                  />
                  <PrivacyHint text="Peso entra em estimativas de calorias, hidratação e acompanhamento de progresso." />
                </div>
                <div>
                  <label className="text-sm text-white/40 mb-1 block">Altura (cm)</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="100"
                    max="250"
                    value={height}
                    onChange={(e) => setHeight(onlyInteger(e.target.value).slice(0, 3))}
                    placeholder="170"
                    className="input-field"
                  />
                  <PrivacyHint text="Altura ajuda no cálculo de métricas corporais e metas diárias." />
                </div>
              </div>
              <button className="btn-primary" disabled={!bodyValid} onClick={() => setStep('goal')}>
                Continuar
              </button>
            </div>
          )}

          {/* Goal */}
          {step === 'goal' && (
            <div className="space-y-8">
              <div>
                <h1 className="text-3xl font-bold mb-2 flex items-center gap-2 justify-center"><MaterialIcon name="track_changes" className="text-primary-300" /> Seu objetivo</h1>
                <p className="text-white/50">O que você quer alcançar?</p>
              </div>
              <div className="space-y-3">
                {GOAL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setGoal(opt.value)}
                    className={`w-full p-4 rounded-2xl border text-left flex items-center gap-3 transition-all ${
                      goal === opt.value ? 'border-primary-500 bg-primary-500/10' : 'border-white/10 bg-dark-200'
                    }`}
                  >
                    <MaterialIcon name={opt.icon} className="text-2xl text-primary-300" />
                    <span className="font-medium text-lg">{opt.label}</span>
                  </button>
                ))}
              </div>
              <PrivacyHint text="Seu objetivo define estratégia de treino e distribuição de macros sugerida." />
              <button className="btn-primary" onClick={() => setStep('experience')}>
                Continuar
              </button>
            </div>
          )}

          {/* Experience Level */}
          {step === 'experience' && (
            <div className="space-y-8">
              <div>
                <h1 className="text-3xl font-bold mb-2"><MaterialIcon name="star" className="text-primary-300" /> Sua experiência </h1>
                <p className="text-white/50">Qual seu nível de intimidade com a academia?</p>
              </div>
              <div className="space-y-3">
                {EXPERIENCE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setExperience(opt.value)}
                    className={`w-full p-4 rounded-2xl border text-left flex items-center gap-3 transition-all ${
                      experience === opt.value ? 'border-primary-500 bg-primary-500/10' : 'border-white/10 bg-dark-200'
                    }`}
                  >
                    <MaterialIcon name={opt.icon} className="text-2xl text-primary-300" />
                    <div>
                      <span className="font-medium text-lg">{opt.label}</span>
                      <p className="text-white/40 text-xs">{opt.description}</p>
                    </div>
                  </button>
                ))}
              </div>
              <PrivacyHint text="Seu nível evita prescrição agressiva demais e melhora segurança da progressão." />
              <button className="btn-primary" onClick={() => setStep('days')}>
                Continuar
              </button>
            </div>
          )}

          {/* Days */}
          {step === 'days' && (
            <div className="space-y-8">
              <div>
                <h1 className="text-3xl font-bold mb-2 flex items-center gap-2 justify-center"><MaterialIcon name="calendar_month" className="text-primary-300" /> Dias de treino</h1>
                <p className="text-white/50">Quantos dias por semana você consegue treinar?</p>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {WEEKDAY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => toggleDay(opt.value)}
                    className={`py-4 px-2 rounded-xl text-center font-semibold transition-all ${
                      days.includes(opt.value) ? 'bg-primary-500 text-white scale-105' : 'bg-dark-200 text-white/50'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-center text-sm text-white/30">
                {days.length} {days.length === 1 ? 'dia' : 'dias'} selecionado{days.length !== 1 ? 's' : ''}
              </p>
              <PrivacyHint text="Dias disponíveis orientam frequência semanal e rotação entre treinos." />
              <button
                className="btn-primary"
                disabled={days.length < 1}
                onClick={() => setStep('personalization')}
              >
                Continuar
              </button>
            </div>
          )}

          {/* Personalization */}
          {step === 'personalization' && (
            <div className="space-y-6">
              <div>
                <h1 className="text-3xl font-bold mb-2"><MaterialIcon name="tune" className="text-primary-300" /> Personalização real </h1>
                <p className="text-white/50">Esses dados ajudam a IA montar um plano mais preciso.</p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-sm text-white/40 mb-1 block">Tempo disponível por sessão (min)</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="20"
                    max="180"
                    value={sessionDurationMin}
                    onChange={(e) => setSessionDurationMin(onlyInteger(e.target.value).slice(0, 3))}
                    placeholder="60"
                    className="input-field"
                  />
                  <PrivacyHint text="Tempo por sessão controla quantos exercícios/séries entram em cada treino." />
                </div>

                <div>
                  <label className="text-sm text-white/40 mb-2 block">Onde você treina?</label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { value: 'academia', label: 'Academia' },
                      { value: 'casa', label: 'Casa' },
                      { value: 'hibrido', label: 'Híbrido' },
                    ].map((option) => (
                      <button
                        key={option.value}
                        onClick={() => setTrainingLocation(option.value as TrainingLocation)}
                        className={`py-3 rounded-xl text-sm font-semibold transition-all ${
                          trainingLocation === option.value ? 'bg-primary-500 text-white' : 'bg-dark-200 text-white/50'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-sm text-white/40 mb-1 block">Equipamentos disponíveis (separe por vírgula)</label>
                  <input
                    type="text"
                    value={equipmentText}
                    onChange={(e) => setEquipmentText(e.target.value)}
                    placeholder="halteres, banco, barra, elástico"
                    className="input-field"
                  />
                  <PrivacyHint text="Equipamentos evitam sugestões inviáveis para seu ambiente real." />
                </div>

                <div>
                  <label className="text-sm text-white/40 mb-1 block">Há quantos meses você treina de forma consistente?</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="600"
                    value={trainingAgeMonths}
                    onChange={(e) => setTrainingAgeMonths(onlyInteger(e.target.value).slice(0, 3))}
                    placeholder="Ex: 8"
                    className="input-field"
                  />
                </div>

                <div>
                  <label className="text-sm text-white/40 mb-1 block">Exercícios que você gosta (vírgula)</label>
                  <input
                    type="text"
                    value={preferredExercisesText}
                    onChange={(e) => setPreferredExercisesText(e.target.value)}
                    placeholder="supino, remada, agachamento"
                    className="input-field"
                  />
                </div>

                <div>
                  <label className="text-sm text-white/40 mb-1 block">Exercícios que você não gosta (vírgula)</label>
                  <input
                    type="text"
                    value={dislikedExercisesText}
                    onChange={(e) => setDislikedExercisesText(e.target.value)}
                    placeholder="afundo, burpee"
                    className="input-field"
                  />
                </div>

                <div>
                  <label className="text-sm text-white/40 mb-1 block">Dores, lesões ou limitações (vírgula)</label>
                  <textarea
                    value={limitationsText}
                    onChange={(e) => setLimitationsText(e.target.value)}
                    placeholder="dor no ombro, lombar sensível"
                    className="input-field min-h-20 resize-none"
                  />
                  <PrivacyHint text="Limitações físicas são usadas para bloquear exercícios de maior risco." />
                </div>
              </div>

              <button className="btn-primary" onClick={() => setStep('focus')}>
                Continuar
              </button>
            </div>
          )}

          {/* Training Focus */}
          {step === 'focus' && (
            <div className="space-y-8">
              <div>
                <h1 className="text-3xl font-bold mb-2"><MaterialIcon name="fitness_center" className="text-primary-300" /> Preferência de treino </h1>
                <p className="text-white/50">Onde você quer dar mais ênfase?</p>
              </div>
              <div className="space-y-3">
                {FOCUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setFocus(opt.value)}
                    className={`w-full p-4 rounded-2xl border text-left flex items-center gap-3 transition-all ${
                      focus === opt.value ? 'border-primary-500 bg-primary-500/10' : 'border-white/10 bg-dark-200'
                    }`}
                  >
                    <MaterialIcon name={opt.icon} className="text-2xl text-primary-300" />
                    <div>
                      <span className="font-medium text-lg">{opt.label}</span>
                      <p className="text-white/40 text-xs">{opt.description}</p>
                    </div>
                  </button>
                ))}
              </div>
              <button className="btn-primary" onClick={() => focus === 'custom' ? setStep('customSplit') : setStep('setup')}>
                Continuar
              </button>
            </div>
          )}

          {/* Custom Split */}
          {step === 'customSplit' && (
            <div className="space-y-6">
              <div>
                <h1 className="text-3xl font-bold mb-2"><MaterialIcon name="star" className="text-primary-300" /> Monte sua divisão </h1>
                <p className="text-white/50">O que você quer treinar em cada dia?</p>
              </div>
              <div className="space-y-3">
                {['A', 'B', 'C', 'D', 'E'].slice(0, Math.min(days.length, 5)).map((letter) => (
                  <div key={letter} className="flex items-center gap-3">
                    <span className="text-lg font-bold text-primary-400 w-8">Dia {letter}</span>
                    <input
                      type="text"
                      value={customSplit[letter] || ''}
                      onChange={(e) => setCustomSplit((prev) => ({ ...prev, [letter]: e.target.value }))}
                      placeholder="Ex: Peito e Tríceps"
                      className="input-field flex-1 text-sm"
                    />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-white/30 text-center">
                Exemplos: "Peito e Tríceps", "Costas e Bíceps", "Perna completa", "Ombros e Braços"
              </p>
              <button className="btn-primary" onClick={() => setStep('setup')}>
                Continuar
              </button>
            </div>
          )}

          {/* Setup Choice */}
          {step === 'setup' && (
            <div className="space-y-8 text-center">
              <div>
                <h1 className="text-3xl font-bold mb-2 flex items-center gap-2 justify-center"><MaterialIcon name="construction" className="text-primary-300" /> Montar seu treino</h1>
                <p className="text-white/50">Como quer começar?</p>
              </div>
              <div className="space-y-4">
                <button
                  onClick={handleFinishAI}
                  className="w-full p-5 rounded-2xl bg-primary-500/10 border border-primary-500/30 text-left transition-all active:scale-[0.98]"
                >
                  <div className="flex items-center gap-3">
                    <MaterialIcon name="smart_toy" className="text-3xl text-primary-300" />
                    <div>
                      <p className="font-bold text-lg">Montar com IA</p>
                      <p className="text-white/50 text-sm">A inteligência artificial monta o treino ideal pra você com justificativa científica</p>
                      <p className="text-amber-300/90 text-xs mt-1">Teste grátis: você tem 1 montagem de treino com IA no plano Free.</p>
                    </div>
                  </div>
                </button>
                <button
                  onClick={handleFinishManual}
                  className="w-full p-5 rounded-2xl bg-dark-200 border border-white/10 text-left transition-all active:scale-[0.98]"
                >
                  <div className="flex items-center gap-3">
                    <MaterialIcon name="edit" className="text-3xl text-primary-300" />
                    <div>
                      <p className="font-bold text-lg">Usar treino padrão</p>
                      <p className="text-white/50 text-sm">Começar com o treino base e personalizar depois manualmente</p>
                    </div>
                  </div>
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
