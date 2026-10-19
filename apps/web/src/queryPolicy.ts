import { QueryClient } from '@tanstack/react-query';

export const TASK_BOARD_REFRESH_INTERVAL_MS = 10_000;

export function createWebQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}
