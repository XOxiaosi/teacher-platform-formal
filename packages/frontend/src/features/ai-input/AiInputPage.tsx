import { useState } from 'react';
import { saveRawInput } from '../../api/ai-input';
import type { AiRawInputResult } from '../../api/types';
import { aiIntentLabel } from '../../shared/display-labels';
import './ai-input.css';

interface AiInputPageProps {
  teacherId: string;
}

export function AiInputPage({ teacherId }: AiInputPageProps) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<AiRawInputResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    const normalizedText = text.trim();
    setResult(null);
    setError(null);

    if (!normalizedText) {
      setValidationMessage('请输入要保存的文本。');
      return;
    }

    setValidationMessage(null);
    setSubmitting(true);
    try {
      const saved = await saveRawInput(teacherId, { inputType: 'text', text: normalizedText });
      setResult(saved);
    } catch (submitError) {
      setError(messageOf(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="ai-input-page">
      <div className="page-card ai-input-panel">
        <p className="eyebrow">记录助手</p>
        <h2>AI 输入</h2>
        <p className="muted">把课堂记录、排课线索或缴费备注先记下来，系统会帮你识别类型和待补信息。</p>

        <div className="ai-input-form">
          <label htmlFor="ai-raw-input">课堂记录或教学安排</label>
          <textarea
            id="ai-raw-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="例如：张三今天完成重点题型练习，错在解题步骤。"
            rows={7}
          />
          {validationMessage ? <p className="form-error" role="alert">{validationMessage}</p> : null}
          <button className="primary-action" type="button" disabled={submitting} onClick={handleSubmit}>
            {submitting ? '识别中' : '保存并识别'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="page-card danger-card" role="alert">
          <p className="eyebrow">Error</p>
          <h3>AI 输入保存失败</h3>
          <p>{error}</p>
        </div>
      ) : null}

      {result ? <AiInputResult result={result} /> : null}
    </section>
  );
}

function AiInputResult({ result }: { result: AiRawInputResult }) {
  const intent = displayIntent(result.savedNote.intent);
  const confidence = displayConfidence(result.savedNote.confidence);
  const pendingFields = displayPendingFields(result.savedNote.pendingFields);

  return (
    <article className="page-card ai-input-result" aria-label="AI 输入保存结果">
      <h3>保存结果</h3>
      <dl>
        <div>
          <dt>记录编号</dt>
          <dd>{result.noteId}</dd>
        </div>
        <div>
          <dt>原文</dt>
          <dd>{result.rawInput}</dd>
        </div>
        <div>
          <dt>识别类型</dt>
          <dd>{intent}</dd>
        </div>
        <div>
          <dt>可信度</dt>
          <dd>{confidence}</dd>
        </div>
        <div>
          <dt>待补信息</dt>
          <dd>{pendingFields}</dd>
        </div>
      </dl>
    </article>
  );
}

function displayIntent(value: unknown): string {
  if (typeof value === 'string') return aiIntentLabel(value);
  return displayValue(value);
}

function displayConfidence(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${Math.round(value * 100)}%`;
  return displayValue(value);
}

function displayPendingFields(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(displayValue).join(', ') : '无';
  }
  return displayValue(value);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '无';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
