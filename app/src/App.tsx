import { MainLayout } from '@/layouts/MainLayout';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export default function App() {
  return (
    <ErrorBoundary>
      <ConfirmProvider>
        <MainLayout />
      </ConfirmProvider>
    </ErrorBoundary>
  );
}
