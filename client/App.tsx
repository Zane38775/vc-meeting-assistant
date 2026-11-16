import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, AudioLines, Check, ChevronDown, ChevronRight, CircleHelp, FolderClosed, Layers3, Link2, LogOut, Plus, Radio, Settings2, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { Capabilities, Project, User } from '../shared/types';
import { api, json } from './api';
import { Empty, Modal, ModalErrorContext, Spinner, type Run } from './ui';
import { ProjectWorkspace } from './ProjectWorkspace';
import { MeetingWorkspace } from './MeetingWorkspace';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [create, setCreate] = useState(false);
  const [invite, setInvite] = useState(() => new URLSearchParams(location.search).has('invite'));
  const [token, setToken] = useState(() => new URLSearchParams(location.search).get('invite') || '');
  const [help, setHelp] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<{canManageSettings:boolean;deepseekConfigured:boolean;asrProvider:string;modelReady:boolean}|null>(null);
  const report = useCallback((message: string) => setError(message), []);
  const run: Run = useCallback(async (key, task) => {
    setBusy(old => new Set([...old, key])); setError('');
    try { await task(); } catch (err) { setError(err instanceof Error ? err.message : '操作未完成，请重试。'); }
    finally { setBusy(old => { const next = new Set(old); next.delete(key); return next; }); }
  }, []);
  const refreshProjects = useCallback(async () => { const result = await api<{ projects: Project[] }>('/projects'); setProjects(result.projects); }, []);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([api<{ user: User | null }>('/session'), api<Capabilities>('/health')]).then(results => {
      if (!active) return;
      if (results[0].status === 'fulfilled') setUser(results[0].value.user); else setError('暂时无法连接本地服务，请确认服务已经启动。');
      if (results[1].status === 'fulfilled') setCapabilities(results[1].value);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (user) void run('projects', refreshProjects); }, [user, refreshProjects, run]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  const selected = projects.find(p => p.id === projectId) || null;
  const selectProject = (id: string | null) => { setMeetingId(null); setProjectId(id); };
  const openSettings = () => { setSettingsOpen(true); setSettings(null); void run('settings-read', async () => setSettings(await api('/settings'))); };

  if (loading) return <div className="boot"><div className="brand-icon"><AudioLines /></div><Spinner text="正在连接工作台" /></div>;
  if (!user) return <Auth error={error} busy={busy.has('auth')} run={run} onAuth={setUser} />;
  return <ModalErrorContext.Provider value={error}><div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => selectProject(null)}><span className="brand-icon"><AudioLines size={25} /></span><span>知投<small>投资会议工作台</small></span></button>
      <div className="workspace-label"><span className="workspace-avatar">{user.name.slice(0, 1)}</span><div>{user.name}的工作空间<small>项目协作与投研</small></div><ChevronDown size={14} /></div>
      <nav aria-label="主导航"><button className={`nav-item ${!selected ? 'active' : ''}`} onClick={() => selectProject(null)}><Layers3 size={18} />项目总览<span className="nav-count">{projects.length}</span></button><button className="nav-item" onClick={() => setInvite(true)}><Link2 size={18} />接受协作邀请</button></nav>
      <div className="sidebar-section"><span>我的项目</span><button className="icon-button" onClick={() => setCreate(true)} aria-label="新建项目"><Plus size={17} /></button></div>
      <div className="project-nav">{projects.map(project => <button key={project.id} className={`nav-item project-link ${projectId === project.id ? 'active' : ''}`} onClick={() => selectProject(project.id)}><FolderClosed size={17} /><span>{project.name}</span></button>)}{!projects.length && <p className="sidebar-hint">从一个新项目开始</p>}</div>
      <div className="sidebar-bottom"><div className="connection-box"><span className={`status-dot ${capabilities?.asr && capabilities?.deepseek ? '' : 'amber'}`} /><div>{capabilities?.asr && capabilities?.deepseek ? '实时服务已就绪' : '服务准备待完善'}<small>语音模型 {capabilities?.asr ? '就绪' : '未就绪'} · AI {capabilities?.deepseek ? '已配置' : '未配置'}</small></div></div><button className="nav-item" onClick={openSettings}><Settings2 size={18} />服务设置</button><button className="nav-item" onClick={() => setHelp(true)}><CircleHelp size={18} />使用指南</button><button className="user-block" onClick={() => void run('logout', async () => { await api('/auth/logout', json('POST')); setUser(null); setProjects([]); selectProject(null); })}><span className="user-avatar">{user.name.slice(0, 1)}</span><div>{user.name}<small>退出登录</small></div><LogOut size={17} /></button></div>
    </aside>
    <main className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><span>工作空间</span><ChevronRight size={14} /><button onClick={() => selectProject(null)}>项目</button>{selected && <><ChevronRight size={14} /><button onClick={() => setMeetingId(null)}>{selected.name}</button></>}{meetingId && <><ChevronRight size={14} /><strong>会议工作台</strong></>}</div><div className="topbar-right"><span className="subtle-tag"><ShieldCheck size={13} />权限隔离</span><button className="icon-button" aria-label="打开服务设置" onClick={openSettings}><Settings2 size={18} /></button><span className="small-avatar">{user.name.slice(0, 1)}</span></div></header>
      {error && <div className="banner error" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={16} /></button></div>}
      {notice && <div className="banner success" role="status"><Check size={16} /><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}
      {selected ? meetingId ? <MeetingWorkspace key={meetingId} id={meetingId} project={selected} user={user} capabilities={capabilities} run={run} busy={busy} report={report} notify={setNotice} back={() => setMeetingId(null)} /> : <ProjectWorkspace key={selected.id} project={selected} user={user} run={run} busy={busy} notify={setNotice} onMeeting={setMeetingId} /> : <div className="page overview-page">
        <div className="page-title"><div><div className="eyebrow">投资工作空间</div><h1>每一场对话，<span>更接近判断。</span></h1><p>会前读懂项目，会中追问关键，会后沉淀共识。</p></div><button className="button primary" onClick={() => setCreate(true)}><Plus size={17} />新建项目</button></div>
        <div className="hero-band"><div><span className="hero-label"><Radio size={14} />专注对话，让线索自然浮现</span><h2>把会议，变成可追溯的投资洞察。</h2><p>商业计划书、实时转写、追问建议与事实来源，在同一个工作台汇合。</p><div className="hero-steps"><span><i>01</i>上传项目资料</span><span><i>02</i>开启实时会议</span><span><i>03</i>共同推进判断</span></div></div><div className="hero-art" aria-hidden="true"><div className="orb orb-one" /><div className="orb orb-two" /><AudioLines size={100} strokeWidth={0.65} /><div className="art-caption">聆听 · 理解 · 追问</div></div></div>
        <div className="section-heading"><h2>项目库 <span>{projects.length}</span></h2><span className="muted">按项目沉淀完整的讨论上下文</span></div>
        {busy.has('projects') && !projects.length ? <Spinner /> : projects.length ? <div className="project-grid">{projects.map((project, i) => <button className="project-card" key={project.id} onClick={() => selectProject(project.id)}><div className="project-card-top"><span className={`project-mark mark-${i % 3}`}><FolderClosed size={22} /></span><ChevronRight size={18} /><span className="project-role">{project.role === 'admin' ? '管理员' : project.role === 'editor' ? '协作者' : '观察者'}</span></div><h3>{project.name}</h3><p>{project.description || '准备项目资料，开启第一次投资对话。'}</p><div className="project-card-foot"><span>{new Date(project.createdAt).toLocaleDateString('zh-CN')} 创建</span><ArrowRight size={17} /></div></button>)}<button className="project-card new-card" onClick={() => setCreate(true)}><Plus size={26} /><h3>开始一个新项目</h3><p>资料、会议和团队，一处管理</p></button></div> : <Empty title="准备好开启第一场投资对话" detail="创建项目后，上传商业计划书，或直接体验明确标记的模拟会议。"><button className="button primary" onClick={() => setCreate(true)}><Plus size={16} />创建第一个项目</button></Empty>}
        <div className="bottom-note"><ShieldCheck size={15} />项目资料仅向已加入的成员开放。私密笔记仅自己可见。</div>
      </div>}
    </main>
    {create && <Modal title="新建投资项目" description="给这一轮研究和对话一个独立的空间。" close={() => setCreate(false)}><form className="form-stack" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void run('create', async () => { const result = await api<{ project: Project }>('/projects', json('POST', { name: data.get('name'), description: data.get('description') })); await refreshProjects(); selectProject(result.project.id); setCreate(false); }); }}><label>项目名称<input name="name" placeholder="例如：星海机器人 · Pre-A 轮" required maxLength={120} autoFocus /></label><label>项目简介 <span className="optional">选填</span><textarea name="description" placeholder="赛道、融资阶段，或这次希望了解的问题" rows={3} maxLength={2000} /></label><button className="button primary full" disabled={busy.has('create')}>{busy.has('create') ? <Spinner text="正在创建" /> : '创建项目'}</button></form></Modal>}
    {invite && <Modal title="加入协作项目" description="粘贴邀请链接或邀请令牌。邀请只能使用一次。" close={() => setInvite(false)}><form className="form-stack" onSubmit={event => { event.preventDefault(); void run('accept', async () => { let invitation = token.trim(); try { invitation = new URL(invitation).searchParams.get('invite') || invitation; } catch { /* Raw tokens are supported. */ } await api('/invites/accept', json('POST', { token: invitation })); await refreshProjects(); setInvite(false); setToken(''); history.replaceState({}, '', location.pathname); setNotice('已加入项目，项目库已更新。'); }); }}><label>邀请链接或令牌<textarea value={token} onChange={event => setToken(event.target.value)} required rows={3} autoFocus /></label><button className="button primary full" disabled={busy.has('accept')}>接受邀请并加入</button></form></Modal>}
    {help && <Modal title="从准备，到判断" description="知投的三步工作方式" close={() => setHelp(false)}><div className="guide-list"><div><span>01</span><section><h3>准备项目上下文</h3><p>上传 PDF、PPTX 或文本资料，检查逐页提取结果，并编辑摘要。扫描页面需要人工补录。</p></section></div><div><span>02</span><section><h3>让转写跟上对话</h3><p>线下会议采集麦克风；线上会议还需共享系统声音。Mac 需要允许麦克风与系统音频录制。语音识别在本地运行，仅会议发起人可采集，其他成员可同步查看并评论。</p></section></div><div><span>03</span><section><h3>带着来源做判断</h3><p>在「服务设置」中输入 DeepSeek API 密钥即可开启智能分析。追问建议与事实来源分开展示。会后生成、编辑并发布纪要；私密笔记仅自己可见。</p></section></div></div><div className="info-box">演示会议使用预设文本，始终标记为演示，不会调用麦克风。AI 分析会将相关转写与项目材料发送至 DeepSeek。</div></Modal>}
    {settingsOpen && <Modal title="服务设置" description="本地语音识别 + DeepSeek 智能分析" close={() => setSettingsOpen(false)}>{!settings ? <Spinner text="正在读取服务状态" /> : <form className="form-stack" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const form = event.currentTarget; void run('settings-save', async () => { setSettings(await api('/settings', json('POST', { deepseekApiKey: String(data.get('key')).trim() }))); setCapabilities(await api('/health')); form.reset(); setNotice('DeepSeek 密钥已保存，服务状态已更新。'); setSettingsOpen(false); }); }}><div className="settings-status"><div><AudioLines size={19} /><section><strong>本地语音模型</strong><small>{settings.modelReady ? '模型已就绪 · 无需语音 API 密钥' : '模型尚未就绪 · 请检查应用内的模型文件'}</small></section><span className={`pill ${settings.modelReady ? 'green' : 'amber'}`}>{settings.modelReady ? '可用' : '待准备'}</span></div><div><Sparkles size={19} /><section><strong>DeepSeek</strong><small>追问建议、资料摘要与会议纪要</small></section><span className={`pill ${settings.deepseekConfigured ? 'green' : 'amber'}`}>{settings.deepseekConfigured ? '已配置' : '未配置'}</span></div></div>{settings.canManageSettings ? <><label>DeepSeek API 密钥<input type="password" name="key" autoComplete="off" spellCheck={false} placeholder={settings.deepseekConfigured ? '输入新密钥以更新现有配置' : '输入你的 DeepSeek API 密钥'} required minLength={8} maxLength={300} /></label><div className="info-box">密钥仅保存在本地服务端，不会回显。分析时，相关会议转写和项目材料会发送至 DeepSeek；原始音频保留在本地识别流程中且不存档。</div><button className="button primary full" disabled={busy.has('settings-save')}>{busy.has('settings-save') ? <Spinner text="正在保存配置" /> : <><SaveIcon />保存服务配置</>}</button></> : <div className="info-box">仅本机服务的首位注册用户可以更新密钥。请由该用户在本机打开服务设置。</div>}</form>}</Modal>}
  </div></ModalErrorContext.Provider>;
}

function SaveIcon() { return <Check size={16} />; }

function Auth({ error, busy, run, onAuth }: { error: string; busy: boolean; run: Run; onAuth: (user: User) => void }) {
  const [register, setRegister] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void run('auth', async () => { const result = await api<{ user: User }>(`/auth/${register ? 'register' : 'login'}`, json('POST', Object.fromEntries(data))); onAuth(result.user); });
  };
  return <div className="auth-shell"><div className="auth-story"><div className="brand"><span className="brand-icon"><AudioLines size={25} /></span><span>知投<small>投资会议工作台</small></span></div><div className="auth-copy"><div className="eyebrow">为有深度的投资对话而生</div><h1>认真听见。<br />精准追问。<br /><em>共同判断。</em></h1><p>让信息留在上下文里，让注意力回到对话中。<br />从第一份 BP，到最后一个关键问题。</p><div className="auth-proof"><span><AudioLines size={16} />实时转写</span><span><Sparkles size={16} />智能追问</span><span><ShieldCheck size={16} />团队协作</span></div></div><div className="auth-footer">每一个判断，都有迹可循。</div><div className="auth-circle" aria-hidden="true" /></div><div className="auth-form-side"><div className="auth-form-wrap"><span className="pill neutral">你的投资研究空间</span><h2>{register ? '创建你的工作台' : '欢迎回来'}</h2><p>{register ? '一个账号，连接项目、对话和团队。' : '登录后，继续你的下一场关键对话。'}</p><form className="form-stack" onSubmit={submit}>{register && <label>姓名<input name="name" required autoComplete="name" placeholder="你的称呼" maxLength={80} /></label>}<label>邮箱<input name="email" type="email" required autoComplete="email" placeholder="name@company.com" /></label><label>密码<input name="password" type="password" required minLength={register ? 10 : undefined} autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? '至少 10 个字符' : '输入密码'} /></label>{error && <p className="inline-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy}>{busy ? <Spinner text="正在连接" /> : <>{register ? '创建账号' : '登录工作台'}<ArrowRight size={17} /></>}</button></form><div className="auth-switch">{register ? '已有账号？' : '还没有账号？'}<button className="text-button" onClick={() => setRegister(!register)}>{register ? '登录' : '创建账号'}</button></div><div className="auth-privacy"><ShieldCheck size={15} /><span>会议信息按项目隔离，服务密钥保留在服务端。</span></div></div></div></div>;
}
