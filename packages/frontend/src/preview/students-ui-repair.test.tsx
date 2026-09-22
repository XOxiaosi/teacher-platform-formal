import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewApp } from './PreviewApp';
import { today } from './data';

function route(path: string) { window.history.replaceState(null, '', path); window.dispatchEvent(new HashChangeEvent('hashchange')); }
afterEach(() => window.history.replaceState(null, '', '/'));

describe('学生页面交互修复', () => {
  it('跨页保留未保存记录草稿', () => { route('#/students/s2'); render(<PreviewApp />); const input = screen.getByRole('textbox', { name: '新增记录' }); fireEvent.change(input, { target: { value: '待核对的记录' } }); fireEvent.click(screen.getByRole('link', { name: '我的学生' })); route('#/students/s2'); expect(screen.getByRole('textbox', { name: '新增记录' })).toHaveValue('待核对的记录'); });
  it('空白记录保存有反馈且不写入', () => { route('#/students/s2'); render(<PreviewApp />); fireEvent.click(screen.getByRole('button', { name: '保存记录' })); expect(screen.getByRole('alert')).toHaveTextContent('请输入记录内容'); expect(screen.getByText('课时余额较低，请留意')).toBeInTheDocument(); });
  it('未来排期默认收起并可展开、收起', () => { route('#/students/s2'); render(<PreviewApp />); const expand = screen.getByRole('button', { name: /展开全部/ }); expect(screen.getAllByRole('button', { name: '查看详情' })).toHaveLength(3); fireEvent.click(expand); expect(screen.getAllByRole('button', { name: '查看详情' }).length).toBeGreaterThan(3); fireEvent.click(screen.getByRole('button', { name: '收起排期' })); expect(screen.getAllByRole('button', { name: '查看详情' })).toHaveLength(3); });
  it('记录、未来排期、历史完成和已取消按状态分组', () => { route('#/students/s2'); render(<PreviewApp />); expect(screen.getByRole('heading', { name: '已保存记录' })).toBeInTheDocument(); expect(screen.getByRole('heading', { name: '未来排期' })).toBeInTheDocument(); expect(screen.getByRole('heading', { name: '历史完成' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: /已取消课程/ })).toBeInTheDocument(); });
  it('从学生详情打开排期时预选当前学生和当天', () => { route('#/students/s2'); render(<PreviewApp />); fireEvent.click(screen.getByRole('button', { name: '安排排期' })); expect(screen.getByRole('dialog', { name: '新增排期' })).toBeInTheDocument(); expect(screen.getByRole('option', { name: '王浩然' })).toHaveProperty('selected', true); expect(screen.getByLabelText('日期')).toHaveValue(today); });
});
