import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { unlockAudio } from './lib/sound';
import './styles.css';

// 音は「最初の操作」の中でしか有効化できないので、どこを触っても解錠されるようにしておく
const unlock = () => unlockAudio();
window.addEventListener('pointerdown', unlock, { once: true, passive: true });
window.addEventListener('keydown', unlock, { once: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
