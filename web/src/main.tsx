import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initTheme } from './ui/theme';
import { notifyUpdateAvailable } from './ui/updateAvailable';
import './styles/app.css';

// Apply the stored theme before the first paint (no inline script, per CSP).
initTheme();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the service worker in production builds. With registerType
// 'prompt', a new version waits until the user accepts the update from the
// "Update available" toast (UpdateAvailableToast).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void import('virtual:pwa-register').then(({ registerSW }) => {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        notifyUpdateAvailable(() => updateSW(true));
      },
    });
  });
}
