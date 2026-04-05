import { useState } from 'react';
import { PairView } from './PairView';
import { HomeView } from './HomeView';
import { LogView } from './LogView';
import { loadPair } from './pair';

type Screen =
  | { name: 'pair' }
  | { name: 'home' }
  | { name: 'logs'; scriptId: string; scriptName: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>(() =>
    loadPair() ? { name: 'home' } : { name: 'pair' },
  );

  if (screen.name === 'pair') {
    return <PairView onPaired={() => setScreen({ name: 'home' })} />;
  }
  if (screen.name === 'logs') {
    return (
      <LogView
        scriptId={screen.scriptId}
        scriptName={screen.scriptName}
        onBack={() => setScreen({ name: 'home' })}
      />
    );
  }
  return (
    <HomeView
      onUnpair={() => setScreen({ name: 'pair' })}
      onOpenLogs={(scriptId, scriptName) =>
        setScreen({ name: 'logs', scriptId, scriptName })
      }
    />
  );
}
