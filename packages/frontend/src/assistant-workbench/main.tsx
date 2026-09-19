import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantWorkbenchSample } from './AssistantWorkbenchSample';
import './sample.css';

if (!location.hash) location.hash = '#/agent/sample-conversation';

const root = document.getElementById('root');
if (!root) throw new Error('Assistant workbench sample root is missing');
createRoot(root).render(<StrictMode><AssistantWorkbenchSample /></StrictMode>);
