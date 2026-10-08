import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './visual-refresh.css';
import './mobile-navigation.css';
import './design-polish.css';
import './mobile-layout.css';
import './mobile-forms.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
