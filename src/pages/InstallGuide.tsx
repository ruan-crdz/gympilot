import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface InstallGuideProps {
  installPrompt: BeforeInstallPromptEvent | null;
  onContinue: () => void;
}

function detectPlatform() {
  const userAgent = navigator.userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(userAgent);
  const isAndroid = /android/.test(userAgent);
  return { isIOS, isAndroid };
}

export function InstallGuide({ installPrompt, onContinue }: InstallGuideProps) {
  const [{ isIOS, isAndroid }] = useState(detectPlatform);
  const [installing, setInstalling] = useState(false);

  const handleInstall = async () => {
    if (!installPrompt) return;
    setInstalling(true);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') onContinue();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="min-h-[100dvh] px-5 pb-8 pt-10 flex flex-col">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
        <div className="flex items-center gap-3">
          <img src="/gympilot/icons/logo.png" alt="GymPilot" className="h-12 w-12 object-contain" />
          <div>
            <p className="gym-kicker">Antes de começar</p>
            <p className="text-sm font-black text-white">GymPilot</p>
          </div>
        </div>

        <div className="my-auto py-10">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-primary-500/25 bg-primary-500/10">
            <MaterialIcon name="install_mobile" className="text-4xl text-primary-300" />
          </div>
          <h1 className="max-w-sm text-3xl font-black leading-tight">Use como um app no seu celular</h1>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/50">
            O GymPilot funciona pelo navegador, mas instalado na tela inicial abre em tela cheia e fica muito mais fácil de usar durante o treino.
          </p>

          <div className="mt-8 space-y-3">
            {isIOS ? (
              <>
                <InstallStep number="1" icon="ios_share" title="Toque em Compartilhar" description="Use o botão de compartilhar do Safari." />
                <InstallStep number="2" icon="add_box" title="Adicionar à Tela de Início" description="Role as opções e escolha essa ação." />
                <InstallStep number="3" icon="check_circle" title="Confirme em Adicionar" description="O GymPilot aparecerá junto dos seus apps." />
              </>
            ) : installPrompt ? (
              <>
                <InstallStep number="1" icon="download" title="Instalação automática disponível" description="O navegador já confirmou que este aparelho aceita instalar o GymPilot." />
                <button onClick={() => void handleInstall()} disabled={installing} className="btn-primary mt-5 flex items-center justify-center gap-2">
                  <MaterialIcon name="download" />
                  {installing ? 'Abrindo instalação...' : 'Instalar GymPilot'}
                </button>
              </>
            ) : (
              <>
                <InstallStep number="1" icon="more_vert" title={isAndroid ? 'Abra os três pontinhos' : 'Abra o menu do navegador'} description="O menu fica no canto superior direito do navegador." />
                <InstallStep number="2" icon="install_mobile" title="Toque em Instalar app" description="Em alguns navegadores aparece como Adicionar à tela inicial." />
              </>
            )}
          </div>
        </div>

        {isIOS && (
          <button onClick={onContinue} className="btn-primary flex items-center justify-center gap-2">
            <MaterialIcon name="check" /> Já adicionei, continuar
          </button>
        )}
        <button onClick={onContinue} className="mt-3 w-full py-3 text-sm font-semibold text-white/40">
          Continuar no navegador
        </button>
      </div>
    </div>
  );
}

function InstallStep({ number, icon, title, description }: { number: string; icon: string; title: string; description: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-[rgb(var(--color-bg-card-rgb))] p-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-300">
        <MaterialIcon name={icon} className="text-xl" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-white/80"><span className="mr-1 text-primary-300">{number}.</span> {title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-white/35">{description}</span>
      </span>
    </div>
  );
}
