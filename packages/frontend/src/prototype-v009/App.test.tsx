import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App, FeedbackPage, ReviewPage } from './App';
import { createStudio, type Studio } from './model';
import { formatDate } from '../shared/date-format';

function setup(page:'review'|'feedback', initial=createStudio()) {
  let latest=initial;
  function Harness(){const [data,setData]=useState(initial);latest=data;const Page=page==='review'?ReviewPage:FeedbackPage;return <Page data={data} setData={setData} notify={vi.fn()}/>;}
  render(<Harness/>);return ()=>latest;
}

describe('V009 候选与反馈的连续工作',()=>{
  it('教师可见日期使用统一中文格式，表单数据仍保留 ISO 值',()=>{
    location.hash='/desk';
    render(<App/>);
    expect(screen.getByText(`${formatDate('2026-09-14')} · 北京时间`)).toBeInTheDocument();
    expect(screen.getByText(`林小雨 · ${formatDate('2026-09-14')}课后记录`)).toBeInTheDocument();
  });

  it('家长反馈课程范围使用统一中文日期，表单值仍保留课程 ID',()=>{
    setup('feedback');
    expect(screen.getByRole('option',{name:/2026年9月14日 14:00–16:00/})).toBeInTheDocument();
    expect(screen.getByLabelText('课程与记录范围')).toHaveValue('c1');
  });

  it('离开反馈页再返回仍保留未保存正文，直到教师明确保存', async()=>{
    location.hash='/feedback';
    render(<App/>);
    const text='离开页面后仍应保留的反馈草稿';
    fireEvent.change(await screen.findByRole('textbox',{name:'课后反馈正文'}),{target:{value:text}});
    const nav=within(screen.getByRole('navigation',{name:'主要导航'}));
    fireEvent.click(nav.getByRole('link',{name:/学生/}));
    await waitFor(()=>expect(screen.getByRole('heading',{name:'每个学生，持续了解'})).toBeInTheDocument());
    fireEvent.click(nav.getByRole('link',{name:/家长反馈/}));
    expect(await screen.findByRole('textbox',{name:'课后反馈正文'})).toHaveValue(text);
  });

  it('切换候选保留修改，修改本身不将候选确认',()=>{
    const data=setup('review');
    fireEvent.change(screen.getByLabelText('记录内容'),{target:{value:'核对后的教师观察，但尚未确认'}});
    fireEvent.click(screen.getByRole('button',{name:/02.*家长反馈/}));
    fireEvent.click(screen.getByRole('button',{name:/01.*教师观察/}));
    expect(screen.getByLabelText('记录内容')).toHaveValue('核对后的教师观察，但尚未确认');
    expect(data().candidates[0].status).toBe('pending');
    fireEvent.click(screen.getByRole('button',{name:'确认这一条'}));
    expect(data().candidates.filter(c=>c.status==='confirmed')).toHaveLength(1);
  });

  it('拒绝候选不写成正式记录，不影响其他候选',()=>{
    const data=setup('review');fireEvent.click(screen.getByRole('button',{name:'拒绝'}));
    expect(data().candidates[0].status).toBe('rejected');
    expect(data().candidates.filter(c=>c.status==='pending')).toHaveLength(3);
    expect(data().candidates.filter(c=>c.status==='confirmed')).toHaveLength(0);
  });

  it('反馈只使用本课程已确认且允许分享的依据',()=>{
    const initial=createStudio();initial.candidates=initial.candidates.map(c=>({...c,status:'confirmed'}));
    initial.candidates.push({...initial.candidates[0],id:'other',courseId:'c3',text:'另一课次的内容不能进入本次正文'});
    const data=setup('feedback',initial);
    fireEvent.click(screen.getByRole('button',{name:'根据记录准备反馈'}));
    const text=(screen.getByRole('textbox',{name:'课后反馈正文'}) as HTMLTextAreaElement).value;
    expect(text).toContain('独立完成 3 道错题中的 2 道');
    expect(text).toContain('尚未实施');
    expect(text).not.toContain('睡觉较晚');
    expect(text).not.toContain('另一课次');
    expect(data().feedbacks['s1:c1']).toBeUndefined();
    fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
    expect(data().feedbacks['s1:c1'].sourceIds).toEqual(['r1','r3','r4']);
  });

  it('不同学生及课次的草稿不互相覆盖，修改后须重新核对',()=>{
    const data=setup('feedback');
    fireEvent.change(screen.getByRole('textbox',{name:'课后反馈正文'}),{target:{value:'小雨这节课的手工反馈'}});
    fireEvent.click(screen.getByRole('button',{name:'确认已核对'}));
    expect(data().feedbacks['s1:c1'].status).toBe('reviewed');
    fireEvent.change(screen.getByLabelText('学生'),{target:{value:'s2'}});
    fireEvent.change(screen.getByRole('textbox',{name:'课后反馈正文'}),{target:{value:'一诺的手工反馈'}});
    fireEvent.change(screen.getByLabelText('学生'),{target:{value:'s1'}});
    expect(screen.getByRole('textbox',{name:'课后反馈正文'})).toHaveValue('小雨这节课的手工反馈');
    fireEvent.change(screen.getByLabelText('课程与记录范围'),{target:{value:'c3'}});
    fireEvent.change(screen.getByRole('textbox',{name:'课后反馈正文'}),{target:{value:'小雨另一节课的反馈'}});
    fireEvent.change(screen.getByLabelText('课程与记录范围'),{target:{value:'c1'}});
    expect(screen.getByRole('textbox',{name:'课后反馈正文'})).toHaveValue('小雨这节课的手工反馈');
    fireEvent.change(screen.getByRole('textbox',{name:'课后反馈正文'}),{target:{value:'修改后的反馈'}});
    expect(data().feedbacks['s1:c1'].status).toBe('reviewed');
    expect(data().feedbacks['s2:c2']).toBeUndefined();
    expect(data().feedbacks['s1:c3']).toBeUndefined();
    fireEvent.change(screen.getByLabelText('学生'),{target:{value:'s2'}});
    expect(screen.getByRole('textbox',{name:'课后反馈正文'})).toHaveValue('一诺的手工反馈');
    fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
    expect(data().feedbacks['s2:c2'].text).toBe('一诺的手工反馈');
    fireEvent.change(screen.getByLabelText('学生'),{target:{value:'s1'}});
    fireEvent.change(screen.getByLabelText('课程与记录范围'),{target:{value:'c3'}});
    fireEvent.change(screen.getByRole('textbox',{name:'课后反馈正文'}),{target:{value:'小雨另一节课的反馈'}});
    expect(data().feedbacks['s1:c3']).toBeUndefined();
    fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
    expect(data().feedbacks['s1:c3'].text).toBe('小雨另一节课的反馈');
  });

  it('重新准备正文之前可保留现有手工修改',()=>{
    const initial:Studio=createStudio();initial.candidates[0].status='confirmed';setup('feedback',initial);
    fireEvent.change(screen.getByRole('textbox',{name:'课后反馈正文'}),{target:{value:'我要保留的修改'}});
    fireEvent.click(screen.getByRole('button',{name:'根据记录准备反馈'}));
    expect(screen.getByRole('dialog',{name:'重新准备反馈'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'保留现有正文'}));
    expect(screen.getByRole('textbox',{name:'课后反馈正文'})).toHaveValue('我要保留的修改');
  });

  it('指定小雨的入口不能打开最近处理的一诺草稿',()=>{
    const initial=createStudio();
    initial.feedback={studentId:'s2',courseId:'c2',occurredOn:'2026-09-14',text:'一诺的草稿',sourceIds:[],status:'draft'};
    initial.feedbacks['s2:c2']=initial.feedback;
    function Harness(){const [data,setData]=useState(initial);return <FeedbackPage data={data} setData={setData} notify={vi.fn()} target={{studentId:'s1',courseId:'c1'}}/>;}
    render(<Harness/>);
    expect(screen.getByLabelText('学生')).toHaveValue('s1');
    expect(screen.getByLabelText('课程与记录范围')).toHaveValue('c1');
    expect(screen.getByRole('textbox',{name:'课后反馈正文'})).toHaveValue('');
    fireEvent.change(screen.getByLabelText('学生'),{target:{value:'s2'}});
    expect(screen.getByRole('textbox',{name:'课后反馈正文'})).toHaveValue('一诺的草稿');
  });
});
