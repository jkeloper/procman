import { useCallback, useEffect, useState } from 'react';
import { MainLayout } from '@/layouts/MainLayout';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/Toast';
import { OnboardingOverlay } from '@/components/onboarding/OnboardingOverlay';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useSettings } from '@/hooks/useSettings';
import { RuntimeProvider } from '@/context/RuntimeProvider';
import { LogPanel } from '@/components/log/LogPanel';
import { getDetachedLogRoute } from '@/components/log/logWindow';

export default function App() {
  const detachedLog = getDetachedLogRoute();
  if (detachedLog) {
    return (
      <ErrorBoundary>
        <div className="h-screen w-screen overflow-hidden bg-log-bg">
          <LogPanel
            scriptId={detachedLog.scriptId}
            scriptName={detachedLog.scriptName}
          />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
        <ConfirmProvider>
          <Shell />
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}

function Shell() {
  const { settings, save } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [forcedOnboarding, setForcedOnboarding] = useState(false);

  // Show the overlay as soon as we know the user hasn't been onboarded.
  useEffect(() => {
    if (settings && !settings.onboarded && !onboardingOpen) {
      setOnboardingOpen(true);
    }
  }, [settings, onboardingOpen]);

  // Open Settings via window-level event (command palette / hotkey).
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener('procman:open-settings', handler);
    return () => window.removeEventListener('procman:open-settings', handler);
  }, []);

  const finishOnboarding = useCallback(() => {
    setOnboardingOpen(false);
    if (settings && (!settings.onboarded || forcedOnboarding)) {
      save({ onboarded: true }, 0);
    }
    setForcedOnboarding(false);
  }, [settings, save, forcedOnboarding]);

  return (
    <>
      <RuntimeProvider>
        <MainLayout />
      </RuntimeProvider>
      <OnboardingOverlay open={onboardingOpen} onFinish={finishOnboarding} />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onShowOnboarding={() => {
          setForcedOnboarding(true);
          setOnboardingOpen(true);
        }}
      />
    </>
  );
}
