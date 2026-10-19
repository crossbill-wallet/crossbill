import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css';
import './ui/styles.css';
import { app } from './app/model';
import { Root } from './ui/Root';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

void app.init();
