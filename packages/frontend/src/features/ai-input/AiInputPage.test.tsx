import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiInputPage } from './AiInputPage';
import * as aiInputApi from '../../api/ai-input';

vi.mock('../../api/ai-input');

beforeEach(() => {
  vi.mocked(aiInputApi.saveRawInput).mockResolvedValue({
    noteId: 'note-1',
    rawInput: '张三今天完成重点题型练习，错在解题步骤。',
    audioFileRef: null,
    savedNote: {
      intent: 'lesson_record',
      confidence: 0.86,
      pendingFields: ['studentId', 'lessonDate'],
    },
  });
});

describe('AiInputPage', () => {
  it('渲染 AI 输入页面基础控件', () => {
    render(<AiInputPage teacherId="demo-teacher" />);

    expect(screen.getByRole('heading', { name: 'AI 输入' })).toBeInTheDocument();
    expect(screen.getByLabelText('课堂记录或教学安排')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存并识别' })).toBeInTheDocument();
  });

  it('空输入不调用 saveRawInput 并显示提示', () => {
    render(<AiInputPage teacherId="demo-teacher" />);

    fireEvent.click(screen.getByRole('button', { name: '保存并识别' }));

    expect(aiInputApi.saveRawInput).not.toHaveBeenCalled();
    expect(screen.getByText('请输入要保存的文本。')).toBeInTheDocument();
  });

  it('合法输入调用 saveRawInput 并展示老师可读结果', async () => {
    render(<AiInputPage teacherId="demo-teacher" />);

    fireEvent.change(screen.getByLabelText('课堂记录或教学安排'), {
      target: { value: '  张三今天完成重点题型练习，错在解题步骤。  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并识别' }));

    expect(screen.getByRole('button', { name: '识别中' })).toBeDisabled();
    await waitFor(() => {
      expect(aiInputApi.saveRawInput).toHaveBeenCalledWith('demo-teacher', {
        inputType: 'text',
        text: '张三今天完成重点题型练习，错在解题步骤。',
      });
    });

    const result = await screen.findByRole('article', { name: 'AI 输入保存结果' });
    expect(within(result).getByText('note-1')).toBeInTheDocument();
    expect(within(result).getByText('张三今天完成重点题型练习，错在解题步骤。')).toBeInTheDocument();
    expect(within(result).getByText('课堂记录')).toBeInTheDocument();
    expect(within(result).getByText('86%')).toBeInTheDocument();
    expect(within(result).getByText('studentId, lessonDate')).toBeInTheDocument();
  });

  it('saveRawInput 失败展示错误状态', async () => {
    vi.mocked(aiInputApi.saveRawInput).mockRejectedValue(new Error('network down'));
    render(<AiInputPage teacherId="demo-teacher" />);

    fireEvent.change(screen.getByLabelText('课堂记录或教学安排'), { target: { value: '张三今天复习重点题型。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并识别' }));

    expect(await screen.findByText('AI 输入保存失败')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
  });
});
