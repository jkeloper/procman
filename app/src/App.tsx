import { useCallback, useEffect, useState } from 'react';
import { MainLayout } from '@/layouts/MainLayout';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/Toast';
import { OnboardingOverlay } from '@/components/onboarding/OnboardingOverlay';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useSettings } from '@/hooks/useSettings';

export default function App() {
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
      <MainLayout />
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
