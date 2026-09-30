import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import type { TrainingLocation } from '@/types';

const DURATION_OPTIONS = ['30', '45', '60', '75', '90'];
const EQUIPMENT_OPTIONS = [
  'Máquinas', 'Halteres', 'Barra e anilhas', 'Cabos e polias', 'Banco', 'Smith',
  'Leg press', 'Elásticos', 'Peso corporal', 'Esteira', 'Bicicleta', 'Elíptico',
];
const EXERCISE_OPTIONS = [
  'Supino', 'Agachamento', 'Leg press', 'Remada', 'Puxada', 'Elevação pélvica',
  'Stiff', 'Desenvolvimento', 'Rosca', 'Tríceps', 'Abdominal', 'Corrida',
];
const LIMITATION_OPTIONS = ['Nenhuma', 'Joelho', 'Lombar', 'Ombro', 'Punho', 'Quadril', 'Tornozelo', 'Cotovelo'];

interface TagSelectorProps {
  label: string;
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  exclusiveOption?: string;
}

function TagSelector({ label, options, value, onChange, placeholder, exclusiveOption }: TagSelectorProps) {
  const [addingCustom, setAddingCustom] = useState(false);
  const [customValue, setCustomValue] = useState('');

  const toggle = (option: string) => {
    if (value.includes(option)) {
      onChange(value.filter((item) => item !== option));
      return;
    }
    if (exclusiveOption && option === exclusiveOption) {
      onChange([option]);
      return;
    }
    onChange([...value.filter((item) => item !== exclusiveOption), option]);
  };

  const addCustom = () => {
    const next = customValue.trim().replace(/\s+/g, ' ');
    if (!next || value.some((item) => item.toLocaleLowerCase('pt-BR') === next.toLocaleLowerCase('pt-BR'))) return;
    onChange([...value.filter((item) => item !== exclusiveOption), next]);
    setCustomValue('');
    setAddingCustom(false);
  };

  const customOptions = value.filter((item) => !options.includes(item));

  return (
    <div className="space-y-2">
      <label className="text-sm text-white/55 block">{label}</label>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const selected = value.includes(option);
          return (
            <button
              type="button"
              key={option}
              aria-pressed={selected}
              onClick={() => toggle(option)}
              className={`min-h-10 px-3 rounded-lg border text-sm font-medium transition-colors ${
                selected
                  ? 'border-primary-500 bg-primary-500 text-dark-500'
                  : 'border-white/10 bg-dark-200 text-white/65 hover:border-primary-500/60'
              }`}
            >
              {option}
            </button>
          );
        })}
        {customOptions.map((option) => (
          <button
            type="button"
            key={option}
            onClick={() => toggle(option)}
            className="min-h-10 px-3 rounded-lg border border-primary-500 bg-primary-500 text-dark-500 text-sm font-medium flex items-center gap-1"
            aria-label={`Remover ${option}`}
          >
            {option}<MaterialIcon name="close" className="text-base" />
          </button>
        ))}
        {!addingCustom && (
          <button
            type="button"
            onClick={() => setAddingCustom(true)}
            className="min-h-10 px-3 rounded-lg border border-dashed border-white/20 text-sm text-white/55 flex items-center gap-1 hover:border-primary-500/60 hover:text-primary-300"
          >
            <MaterialIcon name="add" className="text-lg" /> Outro
          </button>
        )}
      </div>
      {addingCustom && (
        <div className="flex gap-2">
          <input
            autoFocus
            value={customValue}
            maxLength={40}
            onChange={(event) => setCustomValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); addCustom(); }
              if (event.key === 'Escape') setAddingCustom(false);
            }}
            placeholder={placeholder}
            className="input-field flex-1"
          />
          <button type="button" onClick={addCustom} disabled={!customValue.trim()} className="w-12 rounded-lg bg-primary-500 text-dark-500 disabled:opacity-40" aria-label="Adicionar opção">
            <MaterialIcon name="check" />
          </button>
          <button type="button" onClick={() => { setAddingCustom(false); setCustomValue(''); }} className="w-12 rounded-lg bg-dark-200 text-white/60" aria-label="Cancelar">
            <MaterialIcon name="close" />
          </button>
        </div>
      )}
    </div>
  );
}

interface TrainingContextFieldsProps {
  sessionDurationMin: string;
  onSessionDurationChange: (value: string) => void;
  trainingLocation: TrainingLocation;
  onTrainingLocationChange: (value: TrainingLocation) => void;
  equipmentAccess: string[];
  onEquipmentAccessChange: (value: string[]) => void;
  preferredExercises: string[];
  onPreferredExercisesChange: (value: string[]) => void;
  dislikedExercises: string[];
  onDislikedExercisesChange: (value: string[]) => void;
  limitations: string[];
  onLimitationsChange: (value: string[]) => void;
}

export function TrainingContextFields(props: TrainingContextFieldsProps) {
  const [customDuration, setCustomDuration] = useState(!DURATION_OPTIONS.includes(props.sessionDurationMin));
  const [showPreferences, setShowPreferences] = useState(
    props.preferredExercises.length > 0 || props.dislikedExercises.length > 0,
  );

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label className="text-sm text-white/55 block">Quanto tempo você costuma ter?</label>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {DURATION_OPTIONS.map((duration) => (
            <button
              type="button"
              key={duration}
              onClick={() => { props.onSessionDurationChange(duration); setCustomDuration(false); }}
              className={`min-h-11 rounded-lg border text-sm font-semibold ${
                props.sessionDurationMin === duration && !customDuration
                  ? 'border-primary-500 bg-primary-500 text-dark-500'
                  : 'border-white/10 bg-dark-200 text-white/60'
              }`}
            >
              {duration} min
            </button>
          ))}
          <button type="button" onClick={() => setCustomDuration(true)} className={`min-h-11 rounded-lg border text-sm flex items-center justify-center gap-1 ${customDuration ? 'border-primary-500 text-primary-300' : 'border-dashed border-white/20 text-white/50'}`}>
            <MaterialIcon name="add" className="text-lg" /> Outro
          </button>
        </div>
        {customDuration && (
          <div className="relative">
            <input type="number" inputMode="numeric" min="10" max="240" value={props.sessionDurationMin} onChange={(event) => props.onSessionDurationChange(event.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="Minutos" className="input-field pr-16" />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-white/35">min</span>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-sm text-white/55 block">Onde você treina?</label>
        <div className="grid grid-cols-3 gap-2">
          {(['academia', 'casa', 'hibrido'] as TrainingLocation[]).map((location) => (
            <button type="button" key={location} onClick={() => props.onTrainingLocationChange(location)} className={`min-h-11 rounded-lg border text-sm font-semibold capitalize ${props.trainingLocation === location ? 'border-primary-500 bg-primary-500 text-dark-500' : 'border-white/10 bg-dark-200 text-white/60'}`}>
              {location === 'hibrido' ? 'Híbrido' : location}
            </button>
          ))}
        </div>
      </div>

      <TagSelector label="O que você tem disponível?" options={EQUIPMENT_OPTIONS} value={props.equipmentAccess} onChange={props.onEquipmentAccessChange} placeholder="Ex.: kettlebell" />
      <TagSelector label="Alguma dor ou limitação?" options={LIMITATION_OPTIONS} value={props.limitations} onChange={props.onLimitationsChange} placeholder="Ex.: cervical" exclusiveOption="Nenhuma" />

      {!showPreferences ? (
        <button type="button" onClick={() => setShowPreferences(true)} className="w-full min-h-11 rounded-lg border border-dashed border-white/15 text-sm text-white/55 flex items-center justify-center gap-2 hover:border-primary-500/60 hover:text-primary-300">
          <MaterialIcon name="add" /> Adicionar preferências de exercícios
        </button>
      ) : (
        <div className="space-y-5 border-t border-white/5 pt-5">
          <TagSelector label="Exercícios que você gosta (opcional)" options={EXERCISE_OPTIONS} value={props.preferredExercises} onChange={props.onPreferredExercisesChange} placeholder="Digite um exercício" />
          <TagSelector label="Exercícios que você evita (opcional)" options={EXERCISE_OPTIONS} value={props.dislikedExercises} onChange={props.onDislikedExercisesChange} placeholder="Digite um exercício" />
        </div>
      )}
    </div>
  );
}
