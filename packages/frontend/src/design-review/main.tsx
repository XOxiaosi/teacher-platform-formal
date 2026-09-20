import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewApp } from '../preview/PreviewApp';
import { AssistantWorkspace } from '../connected/assistant';
import { createReviewTransport } from './sample-transport';
import '../preview/preview.css';
import './review.css';

if (!location.hash) location.hash = '#/agent';

function DesignReview() {
  const [transport] = useState(createReviewTransport);
  return <div className="design-review"><div className="design-review-note"><span><strong>新设计审阅</strong>合成资料 · 操作仅在本页内存生效，刷新后重置</span><a href="/" target="_blank" rel="noreferrer">查看登录页 ↗</a></div><PreviewApp assistantContent={<AssistantWorkspace teacherId="review-teacher" transport={transport} />} /></div>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Design review root is missing');
const reactRoot = createRoot(root);
reactRoot.render(<StrictMode><DesignReview /></StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => reactRoot.unmount());
