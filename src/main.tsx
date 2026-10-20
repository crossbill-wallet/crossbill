import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css';
import '@fontsource-variable/ibm-plex-sans/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/700.css';
import './ui/styles.css';
import { app } from './app/model';
import { applyCachedLook } from './app/look';
import { Root } from './ui/Root';

// Light or dark before the first paint, from last time, so a dark iPhone never flashes a light screen
applyCachedLook();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

void app.init();

// Development only, for checking screens from a browser's console. Not in the iPhone build
if (import.meta.env.DEV) (window as unknown as { __shrike: typeof app }).__shrike = app;
