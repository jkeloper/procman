import { useContext } from 'react';
import { RuntimeStatusContext, EMPTY_PROCESS_STATUS } from '@/context/runtimeStatus';

export function useProcessStatus() {
  return useContext(RuntimeStatusContext) ?? EMPTY_PROCESS_STATUS;
}
