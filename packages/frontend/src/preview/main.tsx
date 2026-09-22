import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewApp } from './PreviewApp';
import './preview.css';

const root = document.getElementById('root');
if (!root) throw new Error('Preview root element not found');
createRoot(root).render(<StrictMode><PreviewApp /></StrictMode>);
