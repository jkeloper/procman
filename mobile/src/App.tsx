import { useState } from 'react';
import { PairView } from './PairView';
import { MainView } from './MainView';
import { FeedbackProvider } from './feedback';
import { loadPair, tryAutoPairFromHash } from './pair';

export default function App() {
  const [paired, setPaired] = useState(() => {
    // Auto-pair from URL hash on first load (QR scan flow).
    // The desktop QR encodes a URL like https://procman/#token=xxx&fp=yyy,
    // and we read it before falling back to the saved pair.
    if (tryAutoPairFromHash()) return true;
    return !!loadPair();
  });

  return (
    <FeedbackProvider>
      {paired ? (
        <MainView onUnpair={() => setPaired(false)} />
      ) : (
        <PairView onPaired={() => setPaired(true)} />
      )}
    </FeedbackProvider>
  );
}
