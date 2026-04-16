import { useState } from 'react';
import { PairView } from './PairView';
import { MainView } from './MainView';
import { loadPair, tryAutoPairFromHash } from './pair';

export default function App() {
  const [paired, setPaired] = useState(() => {
    // Auto-pair from URL hash on first load (QR scan flow).
    // The desktop QR encodes a URL like https://procman/#token=xxx,
    // and we read it before falling back to the saved pair.
    if (tryAutoPairFromHash()) return true;
    return !!loadPair();
  });

  if (!paired) {
    return <PairView onPaired={() => setPaired(true)} />;
  }
  return <MainView onUnpair={() => setPaired(false)} />;
}
