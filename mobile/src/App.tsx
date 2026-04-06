import { useState } from 'react';
import { PairView } from './PairView';
import { MainView } from './MainView';
import { loadPair } from './pair';

export default function App() {
  const [paired, setPaired] = useState(() => !!loadPair());

  if (!paired) {
    return <PairView onPaired={() => setPaired(true)} />;
  }
  return <MainView onUnpair={() => setPaired(false)} />;
}
