import { MainLayout } from '@/layouts/MainLayout';
import { ConfirmProvider } from '@/components/ConfirmDialog';

export default function App() {
  return (
    <ConfirmProvider>
      <MainLayout />
    </ConfirmProvider>
  );
}
