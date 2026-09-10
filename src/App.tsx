import { useState, useEffect, lazy, Suspense } from 'react';
import type { Session } from '@supabase/supabase-js';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useProfileStore } from '@/stores/useProfileStore';
import { AppShell } from '@/components/layout/AppShell';
import { ThemeProvider } from '@/components/ThemeProvider';
import { SplashScreen } from '@/components/ui/SplashScreen';
import { syncActiveWorkoutFromBackend } from '@/lib/workoutEngine';
import { Auth } from '@/pages/Auth';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { pushLocalStateToCloud, replaceLocalStateFromCloud } from '@/lib/accountState';
import { syncPlanFromBackend } from '@/lib/billing';

function hasPendingRecoveryAction() {
  const url = new URL(window.location.href);
  const hash = window.location.hash || '';
  const hashParams = new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash.startsWith('#') ? hash.slice(1) : '');
  const action = url.searchParams.get('action') ?? hashParams.get('action');
  const type = url.searchParams.get('type') ?? hashParams.get('type');
  return action === 'recovery' || type === 'recovery';
}

const Onboarding = lazy(() => import('@/pages/Onboarding').then((module) => ({ default: module.Onboarding })));
const Dashboard = lazy(() => import('@/pages/Dashboard').then((module) => ({ default: module.Dashboard })));
const Workout = lazy(() => import('@/pages/Workout').then((module) => ({ default: module.Workout })));
const WorkoutComplete = lazy(() => import('@/pages/WorkoutComplete').then((module) => ({ default: module.WorkoutComplete })));
const Profile = lazy(() => import('@/pages/Profile').then((module) => ({ default: module.Profile })));
const WorkoutPlans = lazy(() => import('@/pages/WorkoutPlans').then((module) => ({ default: module.WorkoutPlans })));
const AIIntro = lazy(() => import('@/pages/AIIntro').then((module) => ({ default: module.AIIntro })));
const AIChat = lazy(() => import('@/pages/AIChat').then((module) => ({ default: module.AIChat })));
const AISetup = lazy(() => import('@/pages/AISetup').then((module) => ({ default: module.AISetup })));
const AIReeval = lazy(() => import('@/pages/AIReeval').then((module) => ({ default: module.AIReeval })));
const Health = lazy(() => import('@/pages/Health').then((module) => ({ default: module.Health })));
const Social = lazy(() => import('@/pages/Social').then((module) => ({ default: module.Social })));

function RouteFallback() {
  return (
    <div className="gym-page">
      <div className="card space-y-3">
        <div className="h-5 w-40 rounded-full bg-white/10 animate-pulse" />
        <div className="h-20 rounded-2xl bg-white/5 animate-pulse" />
      </div>
    </div>
  );
}

function AppStatusBadge() {
  return null;
}

export function App() {
  const isOnboarded = useProfileStore((s) => s.isOnboarded);
  const syncMarkerKey = 'gympilot-auth-sync-marker';
  const [showSplash, setShowSplash] = useState(true);
  const [authReady, setAuthReady] = useState(!isSupabaseConfigured || !supabase);
  const [session, setSession] = useState<Session | null>(null);
  const [syncingAccount, setSyncingAccount] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [recoveryActionActive, setRecoveryActionActive] = useState(hasPendingRecoveryAction());

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 1800);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setAuthReady(true);
      return;
    }

    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setAuthReady(true);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_, next) => {
      setSession(next);
      setSyncError('');
      if (hasPendingRecoveryAction()) {
        setRecoveryActionActive(true);
      }
      if (!next) {
        sessionStorage.removeItem(syncMarkerKey);
      }
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabase || !session?.user?.id || !session.access_token) return;

    const markerValue = session.user.id;
    if (sessionStorage.getItem(syncMarkerKey) === markerValue) return;

    let active = true;
    setSyncingAccount(true);
    setSyncError('');

    void replaceLocalStateFromCloud(session.user.id)
      .then(() => {
        if (!active) return;
        sessionStorage.setItem(syncMarkerKey, markerValue);
        window.location.reload();
      })
      .catch((error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : 'Falha ao sincronizar conta.';
        setSyncError(message);
        setSyncingAccount(false);
      });

    return () => {
      active = false;
    };
  }, [session?.access_token, session?.user?.id]);

  useEffect(() => {
    if (!session || !isOnboarded) return;
    const browserWindow = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const prefetch = () => {
      void import('@/pages/Workout');
      void import('@/pages/Health');
      void import('@/pages/Social');
      void import('@/pages/Profile');
      void import('@/pages/AIChat');
    };

    if (browserWindow.requestIdleCallback) {
      const handle = browserWindow.requestIdleCallback(prefetch);
      return () => {
        if (browserWindow.cancelIdleCallback) {
          browserWindow.cancelIdleCallback(handle);
        }
      };
    }

    const timeout = globalThis.setTimeout(prefetch, 1500);
    return () => globalThis.clearTimeout(timeout);
  }, [isOnboarded, session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id || !isOnboarded) return;
    void syncPlanFromBackend().catch(() => undefined);
  }, [isOnboarded, session?.user?.id]);

  useEffect(() => {
    if (!session || !isOnboarded) return;
    void syncActiveWorkoutFromBackend().catch(() => undefined);
  }, [isOnboarded, session?.user?.id]);

  useEffect(() => {
    if (!session || !isOnboarded) return;

    let cancelled = false;
    const save = async () => {
      if (cancelled) return;
      try {
        await pushLocalStateToCloud(session.user.id);
      } catch {
        // Silent sync fail; local-first UX continues.
      }
    };

    const interval = window.setInterval(() => {
      void save();
    }, 20000);

    const handleVisibility = () => {
      if (document.hidden) void save();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isOnboarded, session?.user?.id]);

  if (showSplash) {
    return (
      <ThemeProvider>
        <AnimatePresence>
          <SplashScreen />
        </AnimatePresence>
        <AppStatusBadge />
      </ThemeProvider>
    );
  }

  if (!isSupabaseConfigured || !supabase) {
    return (
      <ThemeProvider>
        <div className="min-h-[100dvh] flex items-center justify-center px-6">
          <div className="card max-w-md w-full space-y-3">
            <h1 className="text-2xl font-bold">Supabase não configurado</h1>
            <p className="text-sm text-white/55">
              Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY para habilitar login obrigatório.
            </p>
          </div>
        </div>
        <AppStatusBadge />
      </ThemeProvider>
    );
  }

  if (!authReady || syncingAccount) {
    return (
      <ThemeProvider>
        <AnimatePresence>
          <SplashScreen />
        </AnimatePresence>
        <AppStatusBadge />
      </ThemeProvider>
    );
  }

  if (syncError) {
    return (
      <ThemeProvider>
        <div className="min-h-[100dvh] flex items-center justify-center px-6">
          <div className="card max-w-md w-full space-y-3">
            <h1 className="text-2xl font-bold">Falha ao sincronizar conta</h1>
            <p className="text-sm text-white/55">{syncError}</p>
            <button
              onClick={() => window.location.reload()}
              className="btn-primary py-3 text-sm"
            >
              Tentar novamente
            </button>
          </div>
        </div>
        <AppStatusBadge />
      </ThemeProvider>
    );
  }

  if (!session) {
    return (
      <ThemeProvider>
        <Auth onResetFlowComplete={() => setRecoveryActionActive(false)} />
        <AppStatusBadge />
      </ThemeProvider>
    );
  }

  if (recoveryActionActive) {
    return (
      <ThemeProvider>
        <Auth onResetFlowComplete={() => setRecoveryActionActive(false)} />
        <AppStatusBadge />
      </ThemeProvider>
    );
  }

  if (!isOnboarded) {
    return (
      <ThemeProvider>
        <HashRouter>
          <Routes>
            <Route
              path="*"
              element={(
                <Suspense fallback={<RouteFallback />}>
                  <Onboarding />
                </Suspense>
              )}
            />
          </Routes>
        </HashRouter>
        <AppStatusBadge />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <HashRouter>
        <Suspense fallback={<RouteFallback />}>
          <AppShell>
            <Routes>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/workout" element={<Workout />} />
              <Route path="/workout/complete" element={<WorkoutComplete />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/plans" element={<WorkoutPlans />} />
              <Route path="/plans/reeval" element={<AIReeval />} />
              <Route path="/health" element={<Health />} />
              <Route path="/social" element={<Social />} />
              <Route path="/setup-ai" element={<AISetup />} />
              <Route path="/onboarding" element={<Onboarding />} />
              <Route path="/ai/intro" element={<AIIntro />} />
              <Route path="/ai" element={<AIChat />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </AppShell>
        </Suspense>
      </HashRouter>
      <AppStatusBadge />
    </ThemeProvider>
  );
}
