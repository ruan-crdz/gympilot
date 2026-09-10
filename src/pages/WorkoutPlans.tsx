import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useCustomWorkoutStore, type CustomExercise, type WorkoutImportItem, type WorkoutImportPreview } from '@/stores/useCustomWorkoutStore';
import { useAIStore } from '@/stores/useAIStore';
import { useProfileStore } from '@/stores/useProfileStore';
import { useToastStore } from '@/stores/useToastStore';
import { EXERCISE_CATALOG, MUSCLE_GROUPS } from '@/constants/exerciseCatalog';
import { WORKOUTS } from '@/constants/workouts';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { askAI } from '@/utils/ai';
import { buildTrainingCalendarIcs, downloadTextFile } from '@/utils/webIntegrations';
import type { Exercise, WorkoutType } from '@/types';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { CustomSelect } from '@/components/ui/CustomSelect';
import { WORKOUT_BUILDER_SCHEMA, WORKOUT_SWAP_SCHEMA } from '@/constants/aiSchemas';
import { resolveAIPlan } from '@/constants/aiPlan';

interface CatalogItem {
  name: string;
  muscleGroup: string;
  image: string;
}

interface SetRow {
  reps: number;
}

interface CardioBlock {
  minutes: string;
  intensity: string;
}

interface StoredCardioBlock {
  minutes: number;
  intensity: string;
}

interface SwapSuggestion {
  currentId: string;
  currentName: string;
  suggestion: CatalogItem;
  reason: string;
}

const WORKOUT_TYPES: WorkoutType[] = ['A', 'B', 'C', 'D', 'E'];
const EMPTY_CUSTOM_WORKOUTS: Record<WorkoutType, CustomExercise[] | null> = { A: null, B: null, C: null, D: null, E: null };
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => {
  const value = String(hour).padStart(2, '0');
  return { value, label: `${value}h` };
});
const MINUTE_OPTIONS = ['00', '15', '30', '45'].map((minute) => ({ value: minute, label: `${minute} min` }));

interface EditBaseline {
  slots: WorkoutType[];
  workouts: Record<WorkoutType, CustomExercise[] | null>;
}

export function WorkoutPlans() {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<WorkoutType>('A');
  const [editing, setEditing] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState<string>('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [calendarHour, setCalendarHour] = useState('19');
  const [calendarMinute, setCalendarMinute] = useState('00');
  const [importInput, setImportInput] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importPreview, setImportPreview] = useState<WorkoutImportPreview | null>(null);
  const [selectedImportIndex, setSelectedImportIndex] = useState(0);
  const [removeTarget, setRemoveTarget] = useState<WorkoutType | null>(null);

  // AI Builder states
  const [showAIBuilder, setShowAIBuilder] = useState(false);
  const [aiLoading, setAILoading] = useState(false);
  const [aiMode, setAIMode] = useState<'add' | 'swap'>('add');
  const [aiAddSuggestion, setAIAddSuggestion] = useState<CatalogItem | null>(null);
  const [aiSwapList, setAISwapList] = useState<SwapSuggestion[]>([]);
  const [aiSwapIndex, setAISwapIndex] = useState(0);
  const [aiMessage, setAIMessage] = useState('');

  // Per-exercise swap
  const [swapTargetId, setSwapTargetId] = useState<string | null>(null);
  const [swapTargetSuggestion, setSwapTargetSuggestion] = useState<CatalogItem | null>(null);
  const [swapTargetLoading, setSwapTargetLoading] = useState(false);
  const [manualSwapTargetId, setManualSwapTargetId] = useState<string | null>(null);
  const [configureItem, setConfigureItem] = useState<CatalogItem | null>(null);
  const [setRows, setSetRows] = useState<SetRow[]>([{ reps: 12 }, { reps: 12 }, { reps: 12 }]);
  const [simpleRepsMin, setSimpleRepsMin] = useState(10);
  const [simpleRepsMax, setSimpleRepsMax] = useState(12);
  const [customSets, setCustomSets] = useState(false);
  const [activeStrengthPreset, setActiveStrengthPreset] = useState('3x12');
  const [activeCardioPreset, setActiveCardioPreset] = useState('Moderado');
  const [cardioBlocks, setCardioBlocks] = useState<CardioBlock[]>([{ minutes: '20', intensity: 'Moderado' }]);
  const [editingExerciseId, setEditingExerciseId] = useState<string | null>(null);
  const [draftSlots, setDraftSlots] = useState<WorkoutType[]>([]);
  const [editBaseline, setEditBaseline] = useState<EditBaseline | null>(null);

  const { setExercises, reorderExercises, resetWorkout, swapExercise, activeSlots, addSlot, removeSlot, applySlotOrder, exportWorkout, exportAll, previewImport, importSingleWorkout, importAllWorkouts } = useCustomWorkoutStore();
  const customWorkouts = useCustomWorkoutStore((s) => s.customWorkouts);
  const aiEnabled = useAIStore((s) => s.isEnabled);
  const profile = useProfileStore((s) => s.profile);
  const toast = useToastStore((s) => s.show);
  const aiPlan = resolveAIPlan(profile);

  const activeTypes = editing ? draftSlots : activeSlots;

  const cloneWorkouts = (workouts: Record<WorkoutType, CustomExercise[] | null>) =>
    Object.fromEntries(
      WORKOUT_TYPES.map((type) => [
        type,
        workouts[type]?.map((exercise) => ({ ...exercise })) || null,
      ]),
    ) as Record<WorkoutType, CustomExercise[] | null>;

  const hasDraftSlotChanges = draftSlots.join('|') !== activeSlots.join('|');

  const selectWorkoutDay = (type: WorkoutType) => {
    setSelected(type);
  };

  useEffect(() => {
    if (!editing) setDraftSlots(activeSlots);
  }, [activeSlots, editing]);

  const enterEditMode = () => {
    setDraftSlots(activeSlots);
    setEditBaseline({
      slots: [...activeSlots],
      workouts: cloneWorkouts(customWorkouts || EMPTY_CUSTOM_WORKOUTS),
    });
    setEditing(true);
  };

  const saveEditMode = () => {
    const nextSelectedIndex = draftSlots.indexOf(selected);
    if (hasDraftSlotChanges) {
      applySlotOrder(draftSlots);
      selectWorkoutDay(WORKOUT_TYPES[nextSelectedIndex] || 'A');
    }
    setEditing(false);
    setEditBaseline(null);
  };

  const resetEditChanges = () => {
    if (!editBaseline) return;
    useCustomWorkoutStore.setState({
      activeSlots: [...editBaseline.slots],
      customWorkouts: cloneWorkouts(editBaseline.workouts),
    });
    setDraftSlots([...editBaseline.slots]);
    if (!editBaseline.slots.includes(selected)) selectWorkoutDay(editBaseline.slots[0] || 'A');
    toast('Alterações redefinidas', 'info');
  };

  const getVisibleExercises = (type: WorkoutType): Exercise[] => {
    const custom = customWorkouts?.[type];
    if (custom && custom.length > 0) {
      return custom.map((exercise) => ({
        ...exercise,
        info: '',
        source: '',
      }));
    }
    const fallback = WORKOUTS.find((workout) => workout.type === type)?.exercises || [];
    return fallback.map((exercise) => ({ ...exercise }));
  };

  const exercises = getVisibleExercises(selected);

  const summarizeWorkout = (workout: WorkoutImportItem | WorkoutType) => {
    const list = typeof workout === 'string' ? getVisibleExercises(workout) : workout.exercises;
    const sets = list.reduce((acc, e) => acc + e.sets, 0);
    return `${list.length} exercícios • ${sets} séries`;
  };

  const listWorkoutNames = (workout: WorkoutImportItem | WorkoutType) => {
    const list = typeof workout === 'string' ? getVisibleExercises(workout) : workout.exercises;
    return list.slice(0, 4).map((e) => e.name).join(', ') + (list.length > 4 ? '...' : '');
  };

  const formatExerciseConfig = (exercise: { sets: number; repsMin: number; repsMax: number; muscleGroup: string; setRows?: SetRow[]; cardioBlocks?: StoredCardioBlock[] }) => {
    if (exercise.muscleGroup === 'Cardio') {
      const total = exercise.cardioBlocks?.reduce((acc, block) => acc + Number(block.minutes || 0), 0) || exercise.sets;
      const intensities = [...new Set(exercise.cardioBlocks?.map((block) => block.intensity) || [])].join(' + ') || 'Moderado';
      return `${total} min • ${intensities}`;
    }
    if (exercise.setRows?.length) {
      return exercise.setRows.map((row, index) => `${index + 1}ª ${row.reps}`).join(' / ') + ' reps';
    }
    return `${exercise.sets}×${exercise.repsMin}-${exercise.repsMax}`;
  };

  const closeImportModal = () => {
    setShowImport(false);
    setImportInput('');
    setImportPreview(null);
    setSelectedImportIndex(0);
  };

  const handlePreviewImport = () => {
    const preview = previewImport(importInput.trim());
    if (!preview) {
      toast('Código inválido. Verifique e tente novamente.', 'error');
      return;
    }
    setImportPreview(preview);
    setSelectedImportIndex(0);
  };

  const handleImportSingle = (target: WorkoutType | 'new') => {
    const workout = importPreview?.workouts[selectedImportIndex];
    if (!workout) return;
    const importedType = importSingleWorkout(workout, target);
    if (!importedType) {
      toast('Você já chegou ao limite de 5 treinos.', 'error');
      return;
    }
    const fresh = useCustomWorkoutStore.getState();
    useCustomWorkoutStore.setState({
      activeSlots: [...fresh.activeSlots],
      customWorkouts: cloneWorkouts(fresh.customWorkouts || EMPTY_CUSTOM_WORKOUTS),
    });
    setDraftSlots([...fresh.activeSlots]);
    setEditing(false);
    setEditBaseline(null);
    selectWorkoutDay(importedType);
    toast(`Treino importado em ${importedType}!`, 'success');
    closeImportModal();
  };

  const handleImportAll = () => {
    if (!importPreview?.workouts.length) return;
    if (importAllWorkouts(importPreview.workouts)) {
      const fresh = useCustomWorkoutStore.getState();
      useCustomWorkoutStore.setState({
        activeSlots: [...fresh.activeSlots],
        customWorkouts: cloneWorkouts(fresh.customWorkouts || EMPTY_CUSTOM_WORKOUTS),
      });
      setDraftSlots([...fresh.activeSlots]);
      setEditing(false);
      setEditBaseline(null);
      selectWorkoutDay(fresh.activeSlots[0] || 'A');
      toast('Todos os treinos foram importados!', 'success');
      closeImportModal();
    }
  };

  // Derive focus label from actual muscle groups in the workout
  const deriveFocus = (): string => {
    if (exercises.length === 0) return 'Vazio';
    const groups = exercises.map((e) => e.muscleGroup.toLowerCase());
    const upper = ['costas', 'peitoral', 'ombros', 'bíceps', 'tríceps', 'costas / bíceps'];
    const lower = ['quadríceps', 'posterior de coxa', 'glúteos', 'panturrilhas', 'panturrilha'];
    const upperCount = groups.filter((g) => upper.some((u) => g.includes(u))).length;
    const lowerCount = groups.filter((g) => lower.some((l) => g.includes(l))).length;
    const total = exercises.length;

    if (upperCount >= total * 0.7) return 'Superior';
    if (lowerCount >= total * 0.7) return 'Inferior';
    if (upperCount > 0 && lowerCount > 0) return 'Full Body';

    // Find the most common group
    const freq: Record<string, number> = {};
    groups.forEach((g) => { freq[g] = (freq[g] || 0) + 1; });
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 2);
    return top.map(([g]) => g.charAt(0).toUpperCase() + g.slice(1)).join(' + ');
  };

  const workoutFocus = deriveFocus();

  // Maps compound muscle groups from workouts to catalog filter names
  const toCatalogGroups = (mg: string): string[] => {
    const lower = mg.toLowerCase();
    const matched: string[] = [];
    if (lower.includes('peito') || lower.includes('peitoral')) matched.push('Peitoral');
    if (lower.includes('costas')) matched.push('Costas');
    if (lower.includes('bíceps') || lower.includes('biceps')) matched.push('Bíceps');
    if (lower.includes('tríceps') || lower.includes('triceps')) matched.push('Tríceps');
    if (lower.includes('ombro')) matched.push('Ombros');
    if (lower.includes('abdômen') || lower.includes('abdomen')) matched.push('Abdômen');
    if (lower.includes('quadríceps') || lower.includes('quadriceps')) matched.push('Quadríceps');
    if (lower.includes('posterior') || lower.includes('isquio')) matched.push('Posterior de Coxa');
    if (lower.includes('glúte') || lower.includes('glute')) matched.push('Glúteos');
    if (lower.includes('panturrilha')) matched.push('Panturrilhas');
    if (matched.length === 0) {
      const direct = MUSCLE_GROUPS.find((g) => g.toLowerCase() === lower);
      if (direct) matched.push(direct);
    }
    return matched.length > 0 ? matched : [mg];
  };

  const toPrimaryCatalogGroup = (mg: string): string => toCatalogGroups(mg)[0];

  const toCustom = () => exercises.map((e) => ({
    id: e.id, name: e.name, sets: e.sets, repsMin: e.repsMin,
    repsMax: e.repsMax, muscleGroup: e.muscleGroup, image: e.image,
  }));

  const handleMoveUp = (index: number) => {
    if (index > 0) reorderExercises(selected, index, index - 1);
  };

  const handleMoveDown = (index: number) => {
    if (index < exercises.length - 1) reorderExercises(selected, index, index + 1);
  };

  const handleMoveSlot = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= activeTypes.length) return;
    const next = [...draftSlots];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    setDraftSlots(next);
    selectWorkoutDay(moved);
  };

  const handleDelete = (id: string) => setDeleteTarget(id);

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const list = toCustom().filter((e) => e.id !== deleteTarget);
    setExercises(selected, list);
    setDeleteTarget(null);
  };

  const openExerciseConfig = (item: CatalogItem, existingId?: string) => {
    setConfigureItem(item);
    setEditingExerciseId(existingId || null);
    const existing = existingId ? exercises.find((exercise) => exercise.id === existingId) : null;
    const isCardio = item.muscleGroup === 'Cardio';
    const currentRows = existing?.setRows?.length
      ? existing.setRows
      : Array.from({ length: existing?.sets || 3 }, () => ({ reps: existing?.repsMax || 12 }));
    setCustomSets(Boolean(existing?.setRows?.length));
    setActiveStrengthPreset(existing?.setRows?.length ? 'custom' : existing?.sets === 3 && existing.repsMin === 10 && existing.repsMax === 10 ? '3x10' : existing?.sets === 4 && existing.repsMin === 8 && existing.repsMax === 10 ? '4x8-10' : '3x12');
    setActiveCardioPreset('Moderado');
    setSimpleRepsMin(isCardio ? 0 : existing?.repsMin || 10);
    setSimpleRepsMax(isCardio ? 0 : existing?.repsMax || 12);
    setSetRows(currentRows);
    setCardioBlocks(existing?.cardioBlocks?.length ? existing.cardioBlocks.map((block) => ({ ...block, minutes: String(block.minutes) })) : [{ minutes: '20', intensity: 'Moderado' }]);
  };

  const handleAddFromCatalog = (item: CatalogItem) => {
    openExerciseConfig(item);
  };

  const handleConfirmConfiguredExercise = () => {
    if (!configureItem) return;
    const isCardio = configureItem.muscleGroup === 'Cardio';
    const configuredSets = isCardio ? cardioBlocks.length : setRows.length;
    const configuredRepsMin = isCardio ? 0 : customSets ? Math.min(...setRows.map((row) => row.reps)) : simpleRepsMin;
    const configuredRepsMax = isCardio ? 0 : customSets ? Math.max(...setRows.map((row) => row.reps)) : simpleRepsMax;
    const payload = {
      id: editingExerciseId || `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: configureItem.name,
      sets: configuredSets,
      repsMin: configuredRepsMin,
      repsMax: configuredRepsMax,
      muscleGroup: configureItem.muscleGroup,
      image: configureItem.image,
      setRows: isCardio ? undefined : customSets ? setRows : undefined,
      cardioBlocks: isCardio ? cardioBlocks.map((block) => ({ ...block, minutes: Number(block.minutes) })) : undefined,
    };

    if (editingExerciseId) {
      const list = toCustom().map((exercise) => (exercise.id === editingExerciseId ? payload : exercise));
      setExercises(selected, list);
    } else if (manualSwapTargetId) {
      const ex = exercises.find((e) => e.id === manualSwapTargetId);
      swapExercise(selected, manualSwapTargetId, {
        ...payload,
        id: `swap_${Date.now()}`,
        sets: isCardio ? payload.sets : payload.sets || ex?.sets || 3,
        repsMin: isCardio ? 0 : payload.repsMin || ex?.repsMin || 10,
        repsMax: isCardio ? 0 : payload.repsMax || ex?.repsMax || 15,
      });
      setManualSwapTargetId(null);
    } else {
      const list = toCustom();
      list.push(payload);
      setExercises(selected, list);
    }
    setConfigureItem(null);
    setEditingExerciseId(null);
    setShowCatalog(false);
  };

  const addSetRow = () => setSetRows((rows) => [...rows, { reps: rows[rows.length - 1]?.reps || 12 }]);
  const addCardioBlock = () => {
    setActiveCardioPreset('custom');
    setCardioBlocks((blocks) => [...blocks, { minutes: '1', intensity: 'Forte' }]);
  };

  const hasInvalidConfig = configureItem?.muscleGroup === 'Cardio'
    ? cardioBlocks.some((block) => !block.minutes || Number(block.minutes) <= 0 || !block.intensity)
    : customSets
      ? setRows.some((row) => !row.reps || row.reps <= 0)
      : setRows.length <= 0 || simpleRepsMin <= 0 || simpleRepsMax <= 0;

  const handleManualSwap = (exerciseId: string, muscleGroup: string) => {
    setManualSwapTargetId(exerciseId);
    setCatalogFilter(toPrimaryCatalogGroup(muscleGroup));
    setShowCatalog(true);
  };

  const workoutGuide: Record<string, string> = {
    A: `Treino A é SUPERIOR COMPLETO. Ideal: 2-3 de Costas, 2 de Peitoral, 1-2 de Ombros, 1 de Bíceps, 1 de Tríceps, 1 de Abdômen.`,
    B: `Treino B é POSTERIOR + GLÚTEOS. Ideal: 2-3 de Posterior de Coxa, 2-3 de Glúteos, 1 de Panturrilhas, 1 de Abdômen.`,
    C: `Treino C é QUADRÍCEPS + GLÚTEOS. Ideal: 2-3 de Quadríceps, 1-2 de Glúteos, 1-2 de Posterior de Coxa, 1 de Panturrilhas, 1 de Abdômen.`,
    D: `Treino D é ${workoutFocus}. Analise os exercícios atuais e sugira melhorias mantendo o foco do treino.`,
    E: `Treino E é ${workoutFocus}. Analise os exercícios atuais e sugira melhorias mantendo o foco do treino.`,
  };

  const handleAIBuild = async () => {
    if (!profile) return;
    setAILoading(true);
    setShowAIBuilder(true);
    setAIAddSuggestion(null);
    setAISwapList([]);
    setAISwapIndex(0);
    setAIMessage('');
    setAIMode('add');

    try {
      const currentList = exercises.map((e) => `- ${e.name} (${e.muscleGroup})`).join('\n');
      const availableNames = EXERCISE_CATALOG
        .filter((e) => !exercises.some((ex) => ex.name.toLowerCase() === e.name.toLowerCase()))
        .map((e) => `${e.name} (${e.muscleGroup})`)
        .join(', ');

      const context = 'Você é um assistente de prescrição de treino baseado em evidências. Priorize decisões por objetivo, limitações, recuperação, aderência e disponibilidade real de equipamentos. Nunca inferir preferência muscular pelo sexo biológico.';

      const prompt = `${context} Analise este treino:

${workoutGuide[selected]}

TREINO ATUAL (${selected} — ${workoutFocus}):
${currentList}

OBJETIVO: ${profile.goal === 'lose' ? 'emagrecer' : profile.goal === 'gain' ? 'hipertrofia' : 'manter'}

Analise se algum grupo muscular está faltando ou com volume insuficiente para o objetivo desse treino.

Se FALTA algum grupo muscular, responda:
{"action":"add","name":"NOME EXATO","muscleGroup":"grupo","reason":"frase curta"}

Se o treino JÁ ESTÁ COMPLETO e não falta nenhum grupo, sugira SUBSTITUIÇÕES para melhorar. Responda:
{"action":"swap","swaps":[{"currentName":"nome do exercício atual","name":"NOME EXATO substituto","muscleGroup":"grupo","reason":"frase curta biomecânica"}]}

REGRA BIOMECÂNICA CRÍTICA para substituições:
- RESPEITE o padrão de movimento! Puxada vertical (graviton, puxada, barra fixa) só troca por OUTRA puxada vertical.
- Remada (horizontal) só troca por OUTRA remada. Supino só por outro empurrar horizontal.
- Stiff/RDL (extensão de quadril) só por outro exercício de extensão de quadril.
- Flexora (flexão de joelho) só por outra flexão de joelho.
- NÃO troque movimentos compostos por isolamentos (ou vice-versa) sem justificativa forte.

Máximo 4 substituições. Cada substituto DEVE ser da lista abaixo e NÃO pode ser um que já está no treino.
Exercícios disponíveis: ${availableNames}

Responda APENAS JSON puro (sem markdown, sem \`\`\`).`;

      const response = await askAI(null, profile, prompt, {
        schemaName: 'workout_builder_action',
        jsonSchema: WORKOUT_BUILDER_SCHEMA,
      }, 'workout_builder');
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);

        if (parsed.action === 'add') {
          setAIMode('add');
          const catalogItem = EXERCISE_CATALOG.find(
            (e) => e.name.toLowerCase() === parsed.name?.toLowerCase()
              || e.name.toLowerCase().includes(parsed.name?.toLowerCase().slice(0, 12)),
          );
          if (catalogItem && !exercises.some((ex) => ex.name.toLowerCase() === catalogItem.name.toLowerCase())) {
            setAIAddSuggestion(catalogItem);
            setAIMessage(parsed.reason || '');
          } else {
            setAIMessage('Não encontrei exercício adequado no catálogo. Tente manualmente!');
          }
        } else if (parsed.action === 'swap' && parsed.swaps?.length > 0) {
          setAIMode('swap');
          setAIMessage('Treino já está completo! Veja sugestões de melhoria:');
          const validSwaps: SwapSuggestion[] = [];
          for (const s of parsed.swaps) {
            const catalogItem = EXERCISE_CATALOG.find(
              (e) => e.name.toLowerCase() === s.name?.toLowerCase()
                || e.name.toLowerCase().includes(s.name?.toLowerCase().slice(0, 12)),
            );
            const currentEx = exercises.find(
              (e) => e.name.toLowerCase() === s.currentName?.toLowerCase()
                || e.name.toLowerCase().includes(s.currentName?.toLowerCase().slice(0, 8)),
            );
            if (catalogItem && currentEx && !exercises.some((ex) => ex.name.toLowerCase() === catalogItem.name.toLowerCase())) {
              validSwaps.push({
                currentId: currentEx.id,
                currentName: currentEx.name,
                suggestion: catalogItem,
                reason: s.reason || '',
              });
            }
          }
          if (validSwaps.length > 0) {
            setAISwapList(validSwaps);
            setAISwapIndex(0);
          } else {
 setAIMessage('Seu treino já está ótimo! Nenhuma substituição necessária. ');
          }
        } else if (parsed.action === 'no_change') {
          setAIMode('swap');
          setAIMessage('Treino coerente com o objetivo atual. Nenhuma alteração obrigatória agora.');
        }
      }
    } catch { /* ignore */ }
    setAILoading(false);
  };

  const handleAcceptAdd = () => {
    if (aiAddSuggestion) {
      handleAddFromCatalog(aiAddSuggestion);
      setShowAIBuilder(false);
    }
  };

  const handleAcceptSwap = () => {
    const current = aiSwapList[aiSwapIndex];
    if (!current) return;
    const existingEx = exercises.find((e) => e.id === current.currentId);
    swapExercise(selected, current.currentId, {
      id: `swap_${Date.now()}`, name: current.suggestion.name,
      sets: existingEx?.sets || 3, repsMin: existingEx?.repsMin || 10,
      repsMax: existingEx?.repsMax || 15,
      muscleGroup: current.suggestion.muscleGroup, image: current.suggestion.image,
    });
    goNextSwap();
  };

  const handleRejectSwap = () => goNextSwap();

  const goNextSwap = () => {
    if (aiSwapIndex < aiSwapList.length - 1) {
      setAISwapIndex(aiSwapIndex + 1);
    } else {
 setAIMessage('Pronto! Todas as sugestões foram avaliadas. ');
      setAISwapList([]);
    }
  };

  const handleExerciseAISwap = async (exerciseId: string) => {
    if (!profile) return;
    setSwapTargetId(exerciseId);
    setSwapTargetLoading(true);
    setSwapTargetSuggestion(null);

    const ex = exercises.find((e) => e.id === exerciseId);
    if (!ex) return;

    try {
      const catalogGroups = toCatalogGroups(ex.muscleGroup);
      const available = EXERCISE_CATALOG
        .filter((e) => catalogGroups.includes(e.muscleGroup) && !exercises.some((ex2) => ex2.name.toLowerCase() === e.name.toLowerCase()))
        .map((e) => e.name);

      if (available.length === 0) {
        setSwapTargetLoading(false);
        return;
      }

      const prompt = `Você é um biomecânico esportivo. Sugira UM substituto para "${ex.name}" no treino ${selected} (${workoutFocus}).

REGRA CRÍTICA: O substituto deve ter o MESMO PADRÃO DE MOVIMENTO, não apenas o mesmo grupo muscular.
Exemplos de padrões:
- Puxada vertical (graviton, puxada frontal, barra fixa) → substituir por OUTRA puxada vertical
- Puxada horizontal (remada sentada, remada curvada) → substituir por OUTRA puxada horizontal
- Empurrar vertical (desenvolvimento) → substituir por OUTRO empurrar vertical
- Empurrar horizontal (supino) → substituir por OUTRO empurrar horizontal
- Extensão de quadril (stiff, levantamento romeno) → substituir por OUTRA extensão de quadril
- Flexão de joelho (mesa flexora, cadeira flexora) → substituir por OUTRA flexão de joelho
- Extensão de joelho (cadeira extensora, agachamento) → substituir por OUTRA extensão de joelho
- Abdução de quadril (abdutora, kickback lateral) → substituir por OUTRA abdução
- Isolamento (rosca, tríceps) → substituir por OUTRO isolamento do mesmo músculo

NÃO troque puxada vertical por horizontal ou vice-versa. NÃO troque empurrar por puxar.

Responda APENAS JSON: {"name":"NOME EXATO da lista","reason":"frase curta biomecânica"}
ESCOLHA OBRIGATORIAMENTE um destes: ${available.join(', ')}`;

      const response = await askAI(null, profile, prompt, {
        schemaName: 'workout_single_swap',
        jsonSchema: WORKOUT_SWAP_SCHEMA,
      }, 'workout_builder');
      const match = response.match(/\{[^}]+\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const catalogItem = EXERCISE_CATALOG.find(
          (e) => e.name.toLowerCase() === parsed.name?.toLowerCase()
            || e.name.toLowerCase().includes(parsed.name?.toLowerCase().slice(0, 12)),
        );
        if (catalogItem) {
          setSwapTargetSuggestion(catalogItem);
        } else {
          // Fallback: pick the first available from catalog
          const fallback = EXERCISE_CATALOG.find((e) => available.includes(e.name));
          if (fallback) setSwapTargetSuggestion(fallback);
        }
      }
    } catch { /* ignore */ }
    setSwapTargetLoading(false);
  };

  const confirmExerciseSwap = () => {
    if (!swapTargetId || !swapTargetSuggestion) return;
    const ex = exercises.find((e) => e.id === swapTargetId);
    swapExercise(selected, swapTargetId, {
      id: `swap_${Date.now()}`, name: swapTargetSuggestion.name,
      sets: ex?.sets || 3, repsMin: ex?.repsMin || 10, repsMax: ex?.repsMax || 15,
      muscleGroup: swapTargetSuggestion.muscleGroup, image: swapTargetSuggestion.image,
    });
    setSwapTargetId(null);
    setSwapTargetSuggestion(null);
  };

  const normalizeSearch = (value: string) => value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const catalogSearchTerm = normalizeSearch(catalogSearch.trim());
  const filteredCatalog = EXERCISE_CATALOG.filter((exercise) => {
    const matchesGroup = !catalogFilter || exercise.muscleGroup === catalogFilter;
    const matchesSearch = !catalogSearchTerm || normalizeSearch(exercise.name).includes(catalogSearchTerm);
    return matchesGroup && matchesSearch;
  });

  const downloadTrainingCalendar = () => {
    if (!profile) {
      toast('Complete seu perfil antes de exportar o calendário.', 'error');
      return;
    }

    const startHour = Math.max(0, Math.min(23, Number(calendarHour) || 19));
    const startMinute = Math.max(0, Math.min(59, Number(calendarMinute) || 0));

    const ics = buildTrainingCalendarIcs(profile, {
      weeks: 8,
      startHour,
      startMinute,
    });

    if (!ics) {
      toast('Defina seus dias de treino no perfil para gerar o calendário.', 'error');
      return;
    }

    downloadTextFile('fitflow-treinos.ics', ics);
    toast(`Calendário baixado para ${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}.`, 'success');
  };

  return (
    <div className="gym-page">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="gym-kicker">Rotina semanal</p>
          <h1 className="gym-title mt-1">Seus Treinos</h1>
        </div>
        <div className="flex items-center gap-2">
        {editing && (
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={resetEditChanges}
            className="px-3 py-2 rounded-xl text-sm font-semibold bg-white/5 text-white/55 border border-white/10 flex items-center gap-1.5"
          >
            <MaterialIcon name="restart_alt" className="text-base" /> Redefinir
          </motion.button>
        )}
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={editing ? saveEditMode : enterEditMode}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all flex items-center gap-1.5 ${
            editing ? 'bg-primary-500 text-black shadow-lg shadow-primary-500/20' : 'bg-white/5 text-white/60 border border-white/10'
          }`}
        >
          <MaterialIcon name={editing ? 'check' : 'edit'} className="text-base" /> {editing ? 'Salvar' : 'Editar'}
        </motion.button>
        </div>
      </div>

      {/* Action toolbar */}
      <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar">
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={() => setShowShareMenu(true)}
          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/50 text-[11px] font-medium flex items-center gap-1 shrink-0"
        >
 <MaterialIcon name="ios_share" /> Exportar
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={() => setShowImport(true)}
          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/50 text-[11px] font-medium flex items-center gap-1 shrink-0"
        >
 <MaterialIcon name="file_download" /> Importar
        </motion.button>
        {aiEnabled && (
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => navigate('/plans/reeval')}
            className="px-3 py-1.5 rounded-lg bg-primary-500/10 border border-primary-500/20 text-primary-300 text-[11px] font-medium flex items-center gap-1 shrink-0"
          >
            <MaterialIcon name="psychology" /> Reavaliação IA
          </motion.button>
        )}
      </div>

      {/* Tabs + Add Day */}
      {editing && (
        <p className="mb-2 text-[11px] text-white/35">
          Enquanto edita, a ordem mostra os nomes atuais. Ao salvar, 1º vira A, 2º vira B, 3º vira C.
        </p>
      )}
      <div className="flex gap-2 mb-6 overflow-x-auto no-scrollbar">
        {activeTypes.map((type, index) => {
          const positionType = WORKOUT_TYPES[index];
          const previousType = WORKOUT_TYPES[index - 1];
          const nextType = WORKOUT_TYPES[index + 1];

          return (
            <div key={type} className={`${editing ? 'min-w-[126px]' : 'flex-1 min-w-[52px]'}`}>
              <motion.button
                whileTap={{ scale: 0.92 }}
                onClick={() => selectWorkoutDay(type)}
                className={`w-full h-12 rounded-xl font-semibold transition-all ${
                  selected === type ? 'bg-primary-500 text-black shadow-md shadow-primary-500/20' : 'bg-dark-200 text-white/40'
                }`}
              >
                {editing ? (
                  <span className="flex flex-col items-center leading-tight">
                    <span className="text-[10px] font-semibold opacity-60">{index + 1}º lugar</span>
                    <span className="text-base">Treino {type}</span>
                    <span className="text-[10px] opacity-50">vira {positionType} ao salvar</span>
                  </span>
                ) : (
                  type
                )}
              </motion.button>
              {editing && (
                <div className="grid grid-cols-2 gap-1 mt-1">
                  <button
                    onClick={(event) => { event.stopPropagation(); handleMoveSlot(index, -1); }}
                    disabled={index === 0}
                    className="h-10 rounded-xl bg-white/5 border border-white/10 text-white/60 disabled:opacity-20 flex items-center justify-center gap-1 text-[10px] font-semibold"
                    aria-label={`Mover treino ${type} para virar treino ${previousType || type}`}
                  >
                    <MaterialIcon name="arrow_back" className="text-base" />
                    {previousType || type}
                  </button>
                  <button
                    onClick={(event) => { event.stopPropagation(); handleMoveSlot(index, 1); }}
                    disabled={index === activeTypes.length - 1}
                    className="h-10 rounded-xl bg-white/5 border border-white/10 text-white/60 disabled:opacity-20 flex items-center justify-center gap-1 text-[10px] font-semibold"
                    aria-label={`Mover treino ${type} para virar treino ${nextType || type}`}
                  >
                    {nextType || type}
                    <MaterialIcon name="arrow_forward" className="text-base" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {activeTypes.length < 5 && (
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => {
              const slot = addSlot();
              if (slot) {
                if (editing) setDraftSlots((slots) => [...slots, slot]);
                toast(`Treino ${slot} adicionado!`, 'success');
                selectWorkoutDay(slot);
              }
            }}
            className="min-w-[52px] h-12 rounded-xl border-2 border-dashed border-white/15 text-white/30 font-bold text-lg flex items-center justify-center"
          >
            +
          </motion.button>
        )}
      </div>

      {/* Workout Detail */}
      <div className="space-y-3">
          <div className="mb-4">
            <h2 className="text-lg font-bold">Treino {selected}</h2>
            <p className="text-primary-400 text-sm">{workoutFocus}</p>
            <p className="text-white/30 text-xs mt-1">
              {exercises.reduce((acc, e) => acc + e.sets, 0)} séries • {exercises.length} exercícios
            </p>
          </div>

          {/* Top Actions */}
          {editing && (
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => { setCatalogFilter(''); setShowCatalog(true); }}
                className="flex-1 py-2.5 rounded-xl border-2 border-dashed border-primary-500/30 text-primary-300 text-xs font-medium"
              >
                + Adicionar
              </button>
              {aiEnabled && (
                <button
                  onClick={handleAIBuild}
                  className="flex-1 py-2.5 rounded-xl bg-primary-500/10 border border-primary-500/20 text-primary-300 text-xs font-medium"
                >
                  <MaterialIcon name="smart_toy" /> {aiPlan === 'ultimate' ? 'IA Inteligente' : 'Montar com IA (Free: 1 uso)'}
                </button>
              )}
            </div>
          )}

          {aiPlan === 'free' && (
            <div className="card border-amber-300/25 bg-amber-500/10">
              <p className="text-xs text-amber-100/90 leading-relaxed">
                No Free, você tem 1 montagem de treino com IA. Depois desse uso, os recursos de IA ficam exclusivos do Ultimate.
              </p>
            </div>
          )}

          {exercises.map((exercise, i) => (
            <motion.div
              key={exercise.id}
              layout
              onClick={() => {
                if (!editing) return;
                openExerciseConfig({
                  name: exercise.name,
                  muscleGroup: exercise.muscleGroup,
                  image: exercise.image || '',
                }, exercise.id);
              }}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
              className={`card ${editing ? 'active:border-primary-400/40' : ''}`}
            >
              <div className="flex items-center gap-3">
                {editing && (
                  <div className="grid grid-rows-2 gap-1 shrink-0">
                    <button
                      onClick={(event) => { event.stopPropagation(); handleMoveUp(i); }}
                      disabled={i === 0}
                      className="w-11 h-10 rounded-xl bg-white/5 border border-white/10 text-lg font-bold text-white/60 disabled:opacity-20"
                      aria-label={`Mover ${exercise.name} para cima`}
                    >
                      ↑
                    </button>
                    <button
                      onClick={(event) => { event.stopPropagation(); handleMoveDown(i); }}
                      disabled={i === exercises.length - 1}
                      className="w-11 h-10 rounded-xl bg-white/5 border border-white/10 text-lg font-bold text-white/60 disabled:opacity-20"
                      aria-label={`Mover ${exercise.name} para baixo`}
                    >
                      ↓
                    </button>
                  </div>
                )}
                {exercise.image ? (
                  <img src={exercise.image} alt={exercise.name} className="w-10 h-10 rounded-lg object-cover bg-dark-200" loading="lazy" />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-primary-500/15 flex items-center justify-center text-xs font-bold text-primary-300">{i + 1}</div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{exercise.name}</p>
                  <p className="text-white/30 text-xs">{formatExerciseConfig(exercise)} - {exercise.muscleGroup}</p>
                </div>
                {editing && (
                  <button
                    onClick={(event) => { event.stopPropagation(); handleDelete(exercise.id); }}
                    className="w-10 h-10 rounded-xl bg-red-500/10 text-red-300 flex items-center justify-center"
                    aria-label={`Remover ${exercise.name}`}
                  >
                    <MaterialIcon name="delete" className="text-lg" />
                  </button>
                )}
              </div>

              {/* Per-exercise swap actions */}
              {editing && (
                <div className="flex gap-2 mt-2 ml-[52px]">
                  {aiEnabled && (
                    <button
                      onClick={(event) => { event.stopPropagation(); handleExerciseAISwap(exercise.id); }}
                      className="px-2.5 py-1 rounded-lg bg-primary-500/10 text-primary-300 text-[10px] font-medium inline-flex items-center gap-1.5"
                    >
                      <MaterialIcon name="smart_toy" /> Substituir com IA
                    </button>
                  )}
                  <button
                    onClick={(event) => { event.stopPropagation(); handleManualSwap(exercise.id, exercise.muscleGroup); }}
                    className="px-2.5 py-1 rounded-lg bg-white/10 border border-white/10 text-white/70 text-[10px] font-medium"
                  >
                    <MaterialIcon name="autorenew" /> Trocar manual
                  </button>
                </div>
              )}
            </motion.div>
          ))}

          {editing && (
            <div className="pt-4 space-y-2">
              <button onClick={() => resetWorkout(selected)} className="w-full py-2 text-white/30 text-xs">
                Restaurar treino padrão
              </button>
              {activeTypes.length > 2 && (
                <button onClick={() => setRemoveTarget(selected)} className="w-full py-2 text-red-400/50 text-xs">
                  Remover treino {selected}
                </button>
              )}
            </div>
          )}

          {!editing && (
            <div className="card mt-4 border-primary-500/20">
              <p className="text-xs text-white/40 leading-relaxed">
 <strong>RIR 2-3</strong> — Termine cada série sentindo que poderia fazer mais 2-3 reps.
                Progressão dupla: quando atingir o topo da faixa de reps, aumente a carga ~5%.
              </p>
            </div>
          )}
      </div>

      {/* Exercise Catalog Modal */}
      <AnimatePresence>
        {showCatalog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-dark-400 flex flex-col"
          >
            <div className="flex items-center justify-between px-5 pt-12 pb-4">
              <h2 className="text-lg font-bold">{manualSwapTargetId ? 'Escolha o substituto' : 'Catálogo de Exercícios'}</h2>
 <button onClick={() => { setShowCatalog(false); setCatalogFilter(''); setCatalogSearch(''); setManualSwapTargetId(null); }} className="w-10 h-10 rounded-full bg-white/5 text-white/55 flex items-center justify-center" aria-label="Cancelar">
                <MaterialIcon name="close" className="text-xl" />
              </button>
            </div>

            <div className="px-5 pb-3">
              <input
                type="search"
                value={catalogSearch}
                onChange={(event) => setCatalogSearch(event.target.value)}
                placeholder="Pesquisar exercicio pelo nome"
                className="input-field w-full text-sm"
              />
            </div>

            <div className="px-5 pb-4 overflow-x-auto no-scrollbar">
              <div className="flex gap-2 min-w-max">
                <button
                  onClick={() => setCatalogFilter('')}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                    !catalogFilter ? 'bg-primary-500 text-white' : 'bg-dark-100 text-white/50'
                  }`}
                >
                  Todos
                </button>
                {MUSCLE_GROUPS.map((mg) => (
                  <button
                    key={mg}
                    onClick={() => setCatalogFilter(mg)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                      catalogFilter === mg ? 'bg-primary-500 text-white' : 'bg-dark-100 text-white/50'
                    }`}
                  >
                    {mg}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-8">
              <div className="grid grid-cols-2 gap-3">
                {filteredCatalog.map((item) => (
                  <button
                    key={item.name}
                    onClick={() => handleAddFromCatalog(item)}
                    className="bg-dark-100 rounded-xl overflow-hidden text-left border border-white/5 active:border-primary-500/50 transition-colors"
                  >
                    <img src={item.image} alt={item.name} className="w-full h-20 object-cover bg-dark-200" loading="lazy" />
                    <div className="p-2">
                      <p className="text-[11px] font-medium leading-tight">{item.name}</p>
                      <p className="text-[10px] text-white/40 mt-0.5">{item.muscleGroup}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Exercise Configuration Modal */}
      <AnimatePresence>
        {configureItem && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75"
            onClick={() => { setConfigureItem(null); setEditingExerciseId(null); }}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="bg-[rgb(var(--color-bg-card-rgb))] rounded-t-[28px] p-5 space-y-4 w-full max-w-md max-h-[86vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-10 h-1 bg-white/10 rounded-full mx-auto" />
              <div className="flex items-center gap-3">
                <img src={configureItem.image} alt={configureItem.name} className="w-14 h-14 rounded-xl object-cover bg-dark-200" />
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold truncate">{editingExerciseId ? 'Editar ' : ''}{configureItem.name}</h3>
                  <p className="text-xs text-white/40">{configureItem.muscleGroup}</p>
                </div>
                <button onClick={() => { setConfigureItem(null); setEditingExerciseId(null); }} className="text-white/35 text-xl">×</button>
              </div>

              {configureItem.muscleGroup === 'Cardio' ? (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    {[
                      { label: 'Leve', blocks: [{ minutes: '20', intensity: 'Leve' }] },
                      { label: 'Moderado', blocks: [{ minutes: '20', intensity: 'Moderado' }] },
                      { label: 'HIIT', blocks: [{ minutes: '5', intensity: 'Aquecimento' }, { minutes: '1', intensity: 'Forte' }, { minutes: '1', intensity: 'Leve' }, { minutes: '1', intensity: 'Forte' }, { minutes: '1', intensity: 'Leve' }, { minutes: '5', intensity: 'Desacelerar' }] },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        onClick={() => {
                          setActiveCardioPreset(preset.label);
                          setCardioBlocks(preset.blocks);
                        }}
                        className={`flex-1 py-2.5 rounded-xl border text-xs font-medium transition-colors ${
                          activeCardioPreset === preset.label
                            ? 'bg-primary-500/15 border-primary-500/30 text-primary-200'
                            : 'bg-white/5 border-white/10 text-white/60'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  {cardioBlocks.map((block, index) => (
                    <div key={index} className="grid grid-cols-[72px_1fr_36px] gap-2 items-center">
                      <input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        max="240"
                        value={block.minutes}
                        onChange={(e) => {
                          const next = [...cardioBlocks];
                          next[index] = { ...block, minutes: e.target.value };
                          setActiveCardioPreset('custom');
                          setCardioBlocks(next);
                        }}
                        className="input-field text-sm text-center px-2"
                      />
                      <div className="flex gap-1 overflow-x-auto no-scrollbar">
                        {['Aquecimento', 'Leve', 'Moderado', 'Forte', 'Muito forte', 'Desacelerar'].map((level) => (
                          <button
                            key={level}
                            onClick={() => {
                              const next = [...cardioBlocks];
                              next[index] = { ...block, intensity: level };
                              setActiveCardioPreset('custom');
                              setCardioBlocks(next);
                            }}
                            className={`px-2.5 py-2 rounded-lg text-[10px] font-semibold whitespace-nowrap border ${
                              block.intensity === level
                                ? 'bg-primary-500/20 border-primary-500/40 text-primary-100'
                                : 'bg-white/5 border-white/10 text-white/45'
                            }`}
                          >
                            {level}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => setCardioBlocks(cardioBlocks.filter((_, i) => i !== index))}
                        disabled={cardioBlocks.length === 1}
                        className="h-10 rounded-xl bg-red-500/10 text-red-300 disabled:opacity-20"
                      >
                        ×
                      </button>
                    </div>
                  ))}

                  <button onClick={addCardioBlock} className="w-full py-2.5 rounded-xl border border-dashed border-white/15 text-white/45 text-sm">
                    + Adicionar bloco de intensidade
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    {[
                      { label: '3x10', id: '3x10', sets: 3, min: 10, max: 10 },
                      { label: '3x12', id: '3x12', sets: 3, min: 12, max: 12 },
                      { label: '4x8-10', id: '4x8-10', sets: 4, min: 8, max: 10 },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        onClick={() => {
                          setCustomSets(false);
                          setActiveStrengthPreset(preset.id);
                          setSimpleRepsMin(preset.min);
                          setSimpleRepsMax(preset.max);
                          setSetRows(Array.from({ length: preset.sets }, () => ({ reps: preset.max })));
                        }}
                        className={`flex-1 py-2.5 rounded-xl border text-xs font-medium transition-colors ${
                          !customSets && activeStrengthPreset === preset.id
                            ? 'bg-primary-500/15 border-primary-500/30 text-primary-200'
                            : 'bg-white/5 border-white/10 text-white/60'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => {
                      setCustomSets(true);
                      setActiveStrengthPreset('custom');
                    }}
                    className={`w-full py-3 rounded-xl border text-sm font-semibold ${customSets ? 'bg-primary-500/15 border-primary-500/30 text-primary-200' : 'bg-white/5 border-white/10 text-white/50'}`}
                  >
                    Personalizar cada série
                  </button>

                  {customSets ? (
                    <div className="space-y-2">
                      {setRows.map((row, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <span className="w-14 text-xs text-white/40">{index + 1}ª série</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            min="1"
                            max="50"
                            value={row.reps}
                            onChange={(e) => {
                              const next = [...setRows];
                              next[index] = { reps: Math.max(1, Number(e.target.value) || 1) };
                              setSetRows(next);
                            }}
                            className="input-field text-sm text-center flex-1"
                          />
                          <span className="text-xs text-white/35">reps</span>
                          <button
                            onClick={() => setSetRows(setRows.filter((_, i) => i !== index))}
                            disabled={setRows.length === 1}
                            className="w-9 h-9 rounded-xl bg-red-500/10 text-red-300 disabled:opacity-20"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button onClick={addSetRow} className="w-full py-2.5 rounded-xl border border-dashed border-white/15 text-white/45 text-sm">
                        + Adicionar série
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <p className="text-[10px] text-white/35 mb-1">Séries</p>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          max="20"
                          value={setRows.length}
                          onChange={(e) => setSetRows(Array.from({ length: Math.max(1, Number(e.target.value) || 1) }, () => ({ reps: simpleRepsMax })))}
                          className="input-field text-sm text-center"
                        />
                      </div>
                      <div>
                        <p className="text-[10px] text-white/35 mb-1">Rep min</p>
                        <input type="number" inputMode="numeric" min="1" max="50" value={simpleRepsMin} onChange={(e) => setSimpleRepsMin(Math.max(1, Number(e.target.value) || 1))} className="input-field text-sm text-center" />
                      </div>
                      <div>
                        <p className="text-[10px] text-white/35 mb-1">Rep max</p>
                        <input type="number" inputMode="numeric" min="1" max="50" value={simpleRepsMax} onChange={(e) => setSimpleRepsMax(Math.max(1, Number(e.target.value) || 1))} className="input-field text-sm text-center" />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={handleConfirmConfiguredExercise}
                disabled={hasInvalidConfig}
                className="btn-primary text-sm py-3 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {editingExerciseId ? 'Salvar alterações' : manualSwapTargetId ? 'Trocar exercício' : 'Adicionar ao treino'}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI Builder Modal */}
      <AnimatePresence>
        {showAIBuilder && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center px-6"
          >
              <button
                onClick={() => {
                  setShowAIBuilder(false);
                  setAILoading(false);
                  setAISwapList([]);
                  setAIAddSuggestion(null);
                }}
                className="absolute top-12 right-5 w-10 h-10 rounded-full bg-white/5 border border-white/10 text-white/50 flex items-center justify-center"
                aria-label="Fechar análise da IA"
              >
                <MaterialIcon name="close" className="text-xl" />
              </button>
 <p className="text-sm text-primary-300 font-semibold mb-6"> IA analisando seu treino</p>

            {/* Loading */}
            {aiLoading && (
              <div className="w-72 h-40 rounded-2xl bg-dark-100 border border-white/10 flex flex-col items-center justify-center gap-3">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 2, ease: 'linear' }}
                  className="text-4xl text-primary-300"
                >
                  <MaterialIcon name="smart_toy" />
                </motion.div>
                <span className="text-white/30 animate-pulse text-sm">Analisando distribuição muscular...</span>
              </div>
            )}

            {/* ADD mode */}
            {!aiLoading && aiMode === 'add' && aiAddSuggestion && (
              <>
                <p className="text-xs text-white/50 mb-4 text-center max-w-[280px]">
                  Falta este grupo muscular no seu treino:
                </p>
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="w-64 rounded-2xl overflow-hidden bg-dark-100 border border-white/10 shadow-2xl"
                >
                  <img src={aiAddSuggestion.image} alt={aiAddSuggestion.name} className="w-full h-44 object-cover" />
                  <div className="p-4 text-center">
                    <p className="font-bold text-base">{aiAddSuggestion.name}</p>
                    <p className="text-primary-400 text-sm mt-1">{aiAddSuggestion.muscleGroup}</p>
                    {aiMessage && <p className="text-white/40 text-xs mt-2">{aiMessage}</p>}
                  </div>
                </motion.div>
                <div className="flex gap-8 mt-8">
                  <motion.button whileTap={{ scale: 0.85 }} onClick={() => setShowAIBuilder(false)}
 className="w-14 h-14 rounded-full bg-red-500/20 border-2 border-red-500/50 flex items-center justify-center text-xl text-red-400"></motion.button>
                  <motion.button whileTap={{ scale: 0.85 }} onClick={handleAcceptAdd}
 className="w-14 h-14 rounded-full bg-green-500/20 border-2 border-green-500/50 flex items-center justify-center text-xl text-green-400"></motion.button>
                </div>
              </>
            )}

            {/* SWAP mode - Tinder carousel */}
            {!aiLoading && aiMode === 'swap' && aiSwapList.length > 0 && (
              <>
                <p className="text-xs text-white/50 mb-2 text-center max-w-[280px]">{aiMessage}</p>
                <p className="text-[10px] text-white/30 mb-4">{aiSwapIndex + 1} de {aiSwapList.length}</p>

                <motion.div
                  key={aiSwapIndex}
                  initial={{ scale: 0.8, opacity: 0, x: 50 }}
                  animate={{ scale: 1, opacity: 1, x: 0 }}
                  className="w-72 rounded-2xl overflow-hidden bg-dark-100 border border-white/10"
                >
                  {/* Current exercise */}
                  <div className="p-3 bg-red-500/5 border-b border-white/5">
                    <p className="text-[10px] text-red-400 font-medium uppercase tracking-wide">Atual</p>
                    <p className="text-sm font-semibold mt-1">{aiSwapList[aiSwapIndex].currentName}</p>
                  </div>

                  {/* Arrow */}
                  <div className="flex justify-center py-1.5">
                    <span className="text-primary-400 text-lg">↓</span>
                  </div>

                  {/* Suggested replacement */}
                  <div className="border-t border-white/5">
                    <img src={aiSwapList[aiSwapIndex].suggestion.image} alt="" className="w-full h-32 object-cover" />
                    <div className="p-3 bg-green-500/5">
                      <p className="text-[10px] text-green-400 font-medium uppercase tracking-wide">Sugestão</p>
                      <p className="text-sm font-semibold mt-1">{aiSwapList[aiSwapIndex].suggestion.name}</p>
                      <p className="text-primary-400 text-xs">{aiSwapList[aiSwapIndex].suggestion.muscleGroup}</p>
                      <p className="text-white/40 text-[11px] mt-1">{aiSwapList[aiSwapIndex].reason}</p>
                    </div>
                  </div>
                </motion.div>

                <div className="flex gap-8 mt-6">
                  <motion.button whileTap={{ scale: 0.85 }} onClick={handleRejectSwap}
 className="w-14 h-14 rounded-full bg-red-500/20 border-2 border-red-500/50 flex items-center justify-center text-xl text-red-400"></motion.button>
                  <motion.button whileTap={{ scale: 0.85 }} onClick={handleAcceptSwap}
 className="w-14 h-14 rounded-full bg-green-500/20 border-2 border-green-500/50 flex items-center justify-center text-xl text-green-400"></motion.button>
                </div>
 <p className="text-[10px] text-white/20 mt-3">Manter = • Trocar = </p>
              </>
            )}

            {/* Done message */}
            {!aiLoading && aiSwapList.length === 0 && !aiAddSuggestion && aiMessage && (
              <div className="text-center px-8">
                <p className="text-white/60 text-sm leading-relaxed">{aiMessage}</p>
                <button onClick={() => setShowAIBuilder(false)} className="mt-6 px-6 py-2.5 rounded-xl bg-primary-500/20 text-primary-300 text-sm font-medium">
                  Fechar
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Per-exercise AI Swap Modal */}
      <AnimatePresence>
        {swapTargetId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center px-6"
          >
 <button onClick={() => { setSwapTargetId(null); setSwapTargetSuggestion(null); }} className="absolute top-12 right-5 text-white/40 text-xl"></button>

            {swapTargetLoading && (
              <div className="w-64 h-32 rounded-2xl bg-dark-100 border border-white/10 flex items-center justify-center">
                <span className="text-white/30 animate-pulse text-sm">Buscando substituto...</span>
              </div>
            )}

            {!swapTargetLoading && swapTargetSuggestion && (
              <>
                <p className="text-xs text-white/50 mb-4">Substituir por:</p>
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="w-64 rounded-2xl overflow-hidden bg-dark-100 border border-white/10"
                >
                  <img src={swapTargetSuggestion.image} alt="" className="w-full h-44 object-cover" />
                  <div className="p-4 text-center">
                    <p className="font-bold text-base">{swapTargetSuggestion.name}</p>
                    <p className="text-primary-400 text-sm mt-1">{swapTargetSuggestion.muscleGroup}</p>
                  </div>
                </motion.div>
                <div className="flex gap-8 mt-6">
                  <motion.button whileTap={{ scale: 0.85 }} onClick={() => { setSwapTargetId(null); setSwapTargetSuggestion(null); }}
 className="w-14 h-14 rounded-full bg-red-500/20 border-2 border-red-500/50 flex items-center justify-center text-xl text-red-400"></motion.button>
                  <motion.button whileTap={{ scale: 0.85 }} onClick={confirmExerciseSwap}
 className="w-14 h-14 rounded-full bg-green-500/20 border-2 border-green-500/50 flex items-center justify-center text-xl text-green-400"></motion.button>
                </div>
              </>
            )}

            {!swapTargetLoading && !swapTargetSuggestion && (
              <p className="text-white/40 text-sm">Nenhum substituto encontrado para esse grupo.</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation */}
      <ConfirmModal
        open={!!deleteTarget}
        title="Remover exercício?"
        message="Tem certeza que quer tirar esse exercício do treino?"
        confirmText="Remover"
        cancelText="Cancelar"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Remove Day Confirmation */}
      <ConfirmModal
        open={!!removeTarget}
        title={`Remover Treino ${removeTarget}?`}
        message="Você pode adicionar de volta depois. Os exercícios serão resetados."
        confirmText="Remover"
        cancelText="Cancelar"
        danger
        onConfirm={() => {
          if (removeTarget) {
            const remaining = activeTypes.filter((t) => t !== removeTarget);
            removeSlot(removeTarget);
            if (editing) setDraftSlots((slots) => slots.filter((type) => type !== removeTarget));
            toast(`Treino ${removeTarget} removido`, 'info');
            if (selected === removeTarget) selectWorkoutDay(remaining[0] || 'A');
          }
          setRemoveTarget(null);
        }}
        onCancel={() => setRemoveTarget(null)}
      />

      {/* Share/Export Modal */}
      <AnimatePresence>
        {showShareMenu && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70"
            onClick={() => setShowShareMenu(false)}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="bg-[rgb(var(--color-bg-card-rgb))] rounded-t-[28px] p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] space-y-4 w-full max-w-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-10 h-1 bg-white/10 rounded-full mx-auto mb-2" />
              <h3 className="text-lg font-bold">Exportar treinos</h3>
              <p className="text-xs text-white/40">Escolha se quer exportar só o treino aberto ou todos os treinos ativos.</p>

              <div className="rounded-xl border border-primary-500/20 bg-primary-500/5 p-3 space-y-2">
                <p className="text-sm font-semibold text-primary-300 flex items-center gap-1.5">
                  <MaterialIcon name="calendar_month" className="text-base" />
                  Calendário de treino
                </p>
                <p className="text-[11px] text-white/45">Escolha o horário e baixe os próximos treinos no calendário.</p>
                <div className="grid grid-cols-2 gap-2">
                  <label>
                    <span className="text-[11px] text-white/45 block mb-1">Hora</span>
                    <CustomSelect value={calendarHour} onChange={setCalendarHour} options={HOUR_OPTIONS} />
                  </label>
                  <label>
                    <span className="text-[11px] text-white/45 block mb-1">Minuto</span>
                    <CustomSelect value={calendarMinute} onChange={setCalendarMinute} options={MINUTE_OPTIONS} />
                  </label>
                </div>
                <div className="flex gap-2">
                  {[
                    { label: 'Manhã 07:00', hour: '07', minute: '00' },
                    { label: 'Almoço 12:00', hour: '12', minute: '00' },
                    { label: 'Noite 19:00', hour: '19', minute: '00' },
                  ].map((preset) => {
                    const active = calendarHour === preset.hour && calendarMinute === preset.minute;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setCalendarHour(preset.hour);
                          setCalendarMinute(preset.minute);
                        }}
                        className={`flex-1 rounded-lg border px-2 py-2 text-[11px] font-semibold transition-colors ${
                          active
                            ? 'bg-primary-500/20 border-primary-500/40 text-primary-200'
                            : 'bg-white/5 border-white/10 text-white/55'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-end gap-2">
                  <p className="flex-1 text-[11px] text-white/45">Horário escolhido: {calendarHour}:{calendarMinute}</p>
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    onClick={downloadTrainingCalendar}
                    className="px-4 py-3 rounded-xl bg-primary-500 text-white text-sm font-semibold"
                  >
                    Baixar .ics
                  </motion.button>
                </div>
              </div>

              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={() => {
                  const code = exportWorkout(selected);
                  navigator.clipboard.writeText(code);
                  toast(`Treino ${selected} exportado!`, 'success');
                  setShowShareMenu(false);
                }}
                className="w-full py-3 rounded-xl bg-primary-500/10 border border-primary-500/20 text-primary-300 text-sm font-semibold"
              >
                Exportar treino {selected}
              </motion.button>

              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={() => {
                  const code = exportAll();
                  navigator.clipboard.writeText(code);
                  toast('Todos os treinos exportados!', 'success');
                  setShowShareMenu(false);
                }}
                className="w-full py-3 rounded-xl bg-white/5 border border-white/10 text-white/60 text-sm font-medium"
              >
                Exportar todos ({activeTypes.join('')})
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Import Modal */}
      <AnimatePresence>
        {showImport && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70"
            onClick={closeImportModal}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="bg-[rgb(var(--color-bg-card-rgb))] rounded-t-[28px] p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] space-y-4 w-full max-w-md max-h-[82vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-10 h-1 bg-white/10 rounded-full mx-auto mb-2" />
              <h3 className="text-lg font-bold">Importar treino</h3>

              {!importPreview ? (
                <>
                  <p className="text-xs text-white/40">Cole o código exportado. Eu vou identificar se ele tem um treino ou vários antes de alterar qualquer coisa.</p>
                  <textarea
                    value={importInput}
                    onChange={(e) => setImportInput(e.target.value)}
                    placeholder="Cole o código aqui..."
                    className="input-field text-sm min-h-[110px] resize-none"
                    autoFocus
                  />
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    disabled={!importInput.trim()}
                    onClick={handlePreviewImport}
                    className="btn-primary"
                  >
                    Analisar importação
                  </motion.button>
                </>
              ) : importPreview.kind === 'multiple' ? (
                <>
                  <p className="text-xs text-white/40">Esse código tem {importPreview.workouts.length} treinos. Importar todos vai substituir sua divisão atual.</p>
                  <div className="space-y-2">
                    <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3">
                      <p className="text-[10px] text-red-300 font-semibold uppercase tracking-wider">Seu treino atual</p>
                      {activeTypes.map((type) => (
                        <p key={type} className="text-xs text-white/70 mt-1">
                          Treino {type}: {summarizeWorkout(type)}
                        </p>
                      ))}
                    </div>
                    <div className="rounded-xl bg-green-500/10 border border-green-500/20 p-3">
                      <p className="text-[10px] text-green-300 font-semibold uppercase tracking-wider">Treinos importados</p>
                      {importPreview.workouts.map((workout, index) => (
                        <p key={index} className="text-xs text-white/70 mt-1">
                          Treino {String.fromCharCode(65 + index)}: {summarizeWorkout(workout)}
                        </p>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => setImportPreview(null)} className="flex-1 py-3 rounded-xl bg-white/5 text-white/50 text-sm font-medium">Voltar</button>
                    <button onClick={handleImportAll} className="flex-1 py-3 rounded-xl bg-primary-500 text-white text-sm font-semibold">Confirmar substituição</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-xl bg-green-500/10 border border-green-500/20 p-3">
                    <p className="text-[10px] text-green-300 font-semibold uppercase tracking-wider">Treino que será importado</p>
                    <p className="text-sm text-white/80 mt-1">{summarizeWorkout(importPreview.workouts[selectedImportIndex])}</p>
                    <p className="text-xs text-white/35 mt-1">{listWorkoutNames(importPreview.workouts[selectedImportIndex])}</p>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs text-white/40 font-semibold">Substituir qual treino?</p>
                    {activeTypes.map((type) => (
                      <button
                        key={type}
                        onClick={() => handleImportSingle(type)}
                        className="w-full rounded-xl bg-white/5 border border-white/10 p-3 text-left active:border-primary-400/50"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-semibold">Treino {type}</span>
                          <span className="text-[10px] text-white/30">{summarizeWorkout(type)}</span>
                        </div>
                        <p className="text-[11px] text-white/30 mt-1 truncate">{listWorkoutNames(type)}</p>
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => handleImportSingle('new')}
                    disabled={activeTypes.length >= 5}
                    className="w-full py-3 rounded-xl border-2 border-dashed border-primary-500/30 text-primary-300 text-sm font-semibold disabled:opacity-30"
                  >
                    Adicionar como treino novo {activeTypes.length < 5 ? '(Treino ' + String.fromCharCode(65 + activeTypes.length) + ')' : '(limite atingido)'}
                  </button>

                  <button onClick={() => setImportPreview(null)} className="w-full py-2 text-white/35 text-xs">Voltar</button>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
