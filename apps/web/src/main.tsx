import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { createWebQueryClient } from './queryPolicy';
import './index.css';
import { initializeLocale } from './i18n.ts';

const disposeLocale = initializeLocale();
if (import.meta.hot) import.meta.hot.dispose(disposeLocale);

const queryClient = createWebQueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
