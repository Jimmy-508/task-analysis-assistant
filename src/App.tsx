import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Backpack,
  Bell,
  Check,
  HelpCircle,
  Home,
  Play,
  RotateCcw,
  Shield,
  Trash2,
  AudioLines,
  Settings,
  X,
  Plus,
  ChevronLeft,
  ChevronRight,
  Pencil,
  ArrowUp,
  ArrowDown,
  ListChecks,
} from 'lucide-react';
import { STORAGE_KEY, DEFAULT_TASK_ID, migrateData, makeId, dailyReminder, sessionsForTask, splitDueReminders, validTime, type TaskSettings, type Step, type StepRecord, type SessionRecord, type ReminderState, type StoredState } from './data';

type View = 'home' | 'task' | 'complete' | 'teacher';

type SessionMetrics = {
  session: SessionRecord;
  completionRate: number;
  independentRate: number;
  averagePromptLevel: number;
  speechTotal: number;
  helpTotal: number;
  averageStepSeconds: number;
  totalSeconds: number;
};

function loadStore(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return migrateData(null);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if ((parsed as { version?: number } | null)?.version !== 2 && !localStorage.getItem(`${STORAGE_KEY}_backup_v1`)) {
      try { localStorage.setItem(`${STORAGE_KEY}_backup_v1`, raw); } catch { /* Keep readable records even when backup storage is full. */ }
    }
    return migrateData(parsed);
  } catch {
    return migrateData(null);
  }
}

function createStepRecord(step: Step): StepRecord {
  return {
    stepId: step.id,
    stepName: step.name,
    stepStartTime: new Date().toISOString(),
    stepEndTime: null,
    duration: 0,
    helpCount: 0,
    speechReplayCount: 0,
    completed: false,
    skipped: false,
    independenceLevel: 0,
  };
}

function getIndependenceLevel(step: StepRecord): 0 | 1 | 2 | 3 | 4 {
  if (step.skipped || step.helpCount > 1) return 4;
  if (step.helpCount === 1) return 3;
  if (step.speechReplayCount > 1) return 2;
  if (step.speechReplayCount === 1) return 1;
  return 0;
}

function secondsBetween(start: string, end: string) {
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
}

function formatSeconds(total: number) {
  if (!Number.isFinite(total) || total <= 0) return '0 秒';
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  if (minutes === 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds} 秒`;
}

function percent(value: number) {
  return `${Math.round(value)}%`;
}

function getMetrics(session: SessionRecord): SessionMetrics {
  const totalSteps = Math.max(session.totalSteps, 1);
  const completedSteps = session.steps.filter((step) => step.completed).length;
  const independentSteps = session.steps.filter((step) => step.completed && step.independenceLevel === 0).length;
  const promptSum = session.steps.reduce((sum, step) => sum + step.independenceLevel, 0);
  const speechTotal = session.steps.reduce((sum, step) => sum + step.speechReplayCount, 0);
  const helpTotal = session.steps.reduce((sum, step) => sum + step.helpCount, 0);
  const finishedSteps = session.steps.filter((step) => step.stepEndTime);
  const durationSum = finishedSteps.reduce((sum, step) => sum + step.duration, 0);
  const started = new Date(session.startedAt).getTime();
  const ended = session.completedAt ? new Date(session.completedAt).getTime() : Math.max(started, ...session.steps.map((step) => step.stepEndTime ? Date.parse(step.stepEndTime) : started));

  return {
    session,
    completionRate: (completedSteps / totalSteps) * 100,
    independentRate: (independentSteps / totalSteps) * 100,
    averagePromptLevel: promptSum / totalSteps,
    speechTotal,
    helpTotal,
    averageStepSeconds: durationSum / Math.max(finishedSteps.length, 1),
    totalSeconds: Math.max(0, Math.round((ended - started) / 1000)),
  };
}

let reminderAudioContext: AudioContext | null = null;

function prepareReminderAudio() {
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    reminderAudioContext ??= new AudioContextClass();
    void reminderAudioContext.resume().catch(() => undefined);
  } catch {
    // Visual reminders remain available when audio is unsupported.
  }
}

function playReminderSound() {
  try {
    const context = reminderAudioContext;
    if (!context || context.state !== 'running') return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.7);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.75);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  } catch {
    // Some mobile browsers block audio until direct user interaction.
  }
}

function speakText(text: string, onError: () => void) {
  try {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return false;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-TW';
    utterance.rate = 0.88;
    utterance.onerror = (event) => {
      if (event.error !== 'canceled' && event.error !== 'interrupted') onError();
    };
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

export function App() {
  const [initial] = useState(loadStore);
  const [view, setView] = useState<View>(initial.progress ? 'task' : 'home');
  const [tasks, setTasks] = useState(initial.tasks);
  const [selectedTaskId, setSelectedTaskId] = useState(initial.selectedTaskId);
  const [analysisTaskId, setAnalysisTaskId] = useState(initial.selectedTaskId);
  const [sessions, setSessions] = useState<SessionRecord[]>(initial.sessions);
  const [activeTask, setActiveTask] = useState<TaskSettings | null>(initial.progress?.task ?? null);
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(initial.progress?.session ?? null);
  const [stepIndex, setStepIndex] = useState(initial.progress?.stepIndex ?? 0);
  const [reminders, setReminders] = useState<ReminderState[]>(initial.reminders);
  const [reminderQueue, setReminderQueue] = useState<ReminderState[]>(initial.reminderQueue);
  const [toast, setToast] = useState('');
  const [helpFeedback, setHelpFeedback] = useState(0);
  const [pressProgress, setPressProgress] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskSettings | null>(null);
  const [deletingTask, setDeletingTask] = useState<TaskSettings | null>(null);
  const [settingsTaskId, setSettingsTaskId] = useState(initial.selectedTaskId);
  const [testValue, setTestValue] = useState('30');
  const [testUnit, setTestUnit] = useState<'seconds' | 'minutes'>('seconds');
  const holdCompleted = useRef(false);
  const holdStart = useRef<number | null>(null);
  const holdFrame = useRef<number | null>(null);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const settingsTask = tasks.find((task) => task.id === settingsTaskId) ?? selectedTask;
  const reminder = reminderQueue[0];
  const remindedTask = tasks.find((task) => task.id === reminder?.taskId);
  const filteredSessions = useMemo(() => sessionsForTask(sessions, analysisTaskId), [sessions, analysisTaskId]);

  useEffect(() => {
    try {
      const state: StoredState = { version: 2, tasks, sessions, selectedTaskId, reminders, reminderQueue, progress: activeSession && activeTask ? { session: activeSession, task: activeTask, stepIndex } : null };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      setToast('此瀏覽器目前無法儲存資料，請檢查儲存空間。');
    }
  }, [tasks, sessions, selectedTaskId, reminders, reminderQueue, activeSession, activeTask, stepIndex]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!helpFeedback) return;
    const timer = window.setTimeout(() => setHelpFeedback(0), 2200);
    return () => window.clearTimeout(timer);
  }, [helpFeedback]);

  useEffect(() => {
    const check = () => {
      const { due, pending } = splitDueReminders(reminders, Date.now());
      if (!due.length) return;
      setReminderQueue((queue) => [...queue, ...due]);
      setReminders([...pending, ...due.flatMap((item) => {
        const task = tasks.find((task) => task.id === item.taskId);
        return item.kind === 'daily' && task ? [dailyReminder(task)] : [];
      })]);
      playReminderSound();
    };
    const interval = window.setInterval(check, 500);
    return () => window.clearInterval(interval);
  }, [reminders, tasks]);

  const metrics = useMemo(() => filteredSessions.map(getMetrics), [filteredSessions]);
  const latestMetrics = metrics[metrics.length - 1];

  function beginTask(task: TaskSettings) {
    if (activeSession) {
      if (!window.confirm('目前工作尚未完成。要保留未完成紀錄並開始新的工作嗎？')) return;
      const now = new Date().toISOString();
      setSessions((current) => [...current, { ...activeSession, steps: activeSession.steps.map((step, index) => index === stepIndex ? { ...step, stepEndTime: now, duration: secondsBetween(step.stepStartTime, now) } : step) }]);
    }
    setHelpFeedback(0);
    const firstStep = task.steps[0];
    const session: SessionRecord = {
      id: makeId(),
      taskId: task.id,
      taskName: task.name,
      totalSteps: task.steps.length,
      startedAt: new Date().toISOString(),
      completedAt: null,
      steps: [createStepRecord(firstStep)],
    };
    setActiveSession(session);
    setActiveTask(task);
    setSelectedTaskId(task.id);
    setAnalysisTaskId(task.id);
    setStepIndex(0);
    setView('task');
    setReminderQueue((queue) => queue.slice(1));
    setSettingsOpen(false);
    setEditorOpen(false);
    setDeletingTask(null);
  }

  function updateCurrentStep(mutator: (step: StepRecord) => StepRecord) {
    setActiveSession((session) => {
      if (!session) return session;
      const nextSteps = [...session.steps];
      nextSteps[stepIndex] = mutator(nextSteps[stepIndex]);
      return { ...session, steps: nextSteps };
    });
  }

  function handleSpeech() {
    const step = activeTask?.steps[stepIndex];
    if (!step) return;
    const speechFallback = () => setToast('此裝置目前無法語音朗讀，已記錄提示次數。');
    const spoke = speakText(`${step.name.replace(/[。！？.!?]+$/, '')}。`, speechFallback);
    updateCurrentStep((record) => {
      const updated = { ...record, speechReplayCount: record.speechReplayCount + 1 };
      return { ...updated, independenceLevel: getIndependenceLevel(updated) };
    });
    if (!spoke) speechFallback();
  }

  function handleHelp() {
    const step = activeTask?.steps[stepIndex];
    if (!step) return;
    updateCurrentStep((record) => {
      const updated = { ...record, helpCount: record.helpCount + 1 };
      return { ...updated, independenceLevel: getIndependenceLevel(updated) };
    });
    setHelpFeedback((count) => count + 1);
    const speechFallback = () => setToast('目前無法播放求助語音，已記錄需要幫助。');
    const spoke = speakText(`不好意思，我需要幫忙。我現在正在做：${step.name.replace(/[。！？.!?]+$/, '')}。`, speechFallback);
    if (!spoke) speechFallback();
  }

  function completeStep() {
    if (!activeSession || !activeTask) return;
    setHelpFeedback(0);
    const now = new Date().toISOString();
    const finishedStep = {
      ...activeSession.steps[stepIndex],
      stepEndTime: now,
      duration: secondsBetween(activeSession.steps[stepIndex].stepStartTime, now),
      completed: true,
    };
    finishedStep.independenceLevel = getIndependenceLevel(finishedStep);

    const nextStep = activeTask.steps[stepIndex + 1];
    if (!nextStep) {
      const completedSession: SessionRecord = {
        ...activeSession,
        completedAt: now,
        steps: activeSession.steps.map((step, index) => (index === stepIndex ? finishedStep : step)),
      };
      setSessions((current) => [...current, completedSession]);
      setActiveSession(null);
      setView('complete');
      return;
    }

    setActiveSession({
      ...activeSession,
      steps: [...activeSession.steps.slice(0, stepIndex), finishedStep, createStepRecord(nextStep)],
    });
    setStepIndex((index) => index + 1);
  }

  function setDailyReminder() {
    prepareReminderAudio();
    setReminders((current) => [...current.filter((item) => item.taskId !== settingsTask.id || item.kind !== 'daily'), dailyReminder(settingsTask)]);
    setToast(`已設定「${settingsTask.name}」${settingsTask.reminderTime} 提醒。`);
  }

  function setTestReminder(seconds: number) {
    prepareReminderAudio();
    setReminders((current) => [...current.filter((item) => item.taskId !== settingsTask.id || item.kind !== 'test'), { id: makeId(), taskId: settingsTask.id, dueAt: Date.now() + seconds * 1000, kind: 'test', label: `${seconds} 秒測試提醒` }]);
    setToast(`已設定 ${seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分鐘`}後提醒。`);
  }

  function changeReminderTime(taskId: string, time: string) {
    if (!validTime(time)) return;
    setTasks((current) => current.map((task) => task.id === taskId ? { ...task, reminderTime: time, updatedAt: Date.now() } : task));
    const task = tasks.find((task) => task.id === taskId);
    if (task) setReminders((current) => [...current.filter((item) => item.taskId !== taskId || item.kind !== 'daily'), dailyReminder({ ...task, reminderTime: time })]);
  }

  function saveTask(task: TaskSettings) {
    setTasks((current) => current.some((item) => item.id === task.id) ? current.map((item) => item.id === task.id ? task : item) : [...current, task]);
    setSelectedTaskId(task.id);
    setSettingsTaskId(task.id);
    setAnalysisTaskId(task.id);
    setReminders((current) => [...current.filter((item) => item.taskId !== task.id || item.kind !== 'daily'), dailyReminder(task)]);
    setEditorOpen(false);
    setToast('工作已儲存。');
  }

  function deleteTask(task: TaskSettings) {
    if (activeSession?.taskId === task.id) { setToast('請先完成目前工作，再刪除。'); return; }
    const remaining = tasks.filter((item) => item.id !== task.id);
    setTasks(remaining);
    setSelectedTaskId(remaining[0]?.id ?? '');
    setSettingsTaskId(remaining[0]?.id ?? '');
    setReminders((current) => current.filter((item) => item.taskId !== task.id));
    setReminderQueue((queue) => queue.filter((item) => item.taskId !== task.id));
    setSettingsOpen(false);
    setDeletingTask(null);
  }

  function cancelHold() {
    holdStart.current = null;
    setPressProgress(0);
    if (holdFrame.current) window.cancelAnimationFrame(holdFrame.current);
  }

  function startHold() {
    cancelHold();
    holdCompleted.current = false;
    holdStart.current = Date.now();
    const tick = () => {
      if (!holdStart.current) return;
      const progress = Math.min(1, (Date.now() - holdStart.current) / 7000);
      setPressProgress(progress);
      if (progress >= 1) {
        holdCompleted.current = true;
        cancelHold();
        setSettingsOpen(false);
        setEditorOpen(false);
        setAnalysisTaskId((activeSession ? activeTask?.id : selectedTask?.id) ?? DEFAULT_TASK_ID);
        setView('teacher');
        return;
      }
      holdFrame.current = window.requestAnimationFrame(tick);
    };
    tick();
  }

  function clearRecords() {
    const confirmed = window.confirm('確定要清除目前分析工作的測試紀錄嗎？此動作無法復原。');
    if (!confirmed) return;
    setSessions((current) => current.filter((session) => session.taskId !== analysisTaskId));
    setToast('測試紀錄已清除。');
  }

  const currentStep = activeTask?.steps[stepIndex];
  const currentRecord = activeSession?.steps[stepIndex];

  return (
    <main className={`app app-${view}`} onPointerDown={prepareReminderAudio}>
      {view !== 'teacher' && (
        <button
          className="secret-entry"
          aria-label="設定"
          title="設定"
          onClick={() => {
            if (!holdCompleted.current) {
              if (selectedTask) { setSettingsTaskId(selectedTask.id); setSettingsOpen(true); }
              else { setEditingTask(null); setEditorOpen(true); }
            }
            holdCompleted.current = false;
          }}
          onPointerDown={startHold}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          onPointerCancel={cancelHold}
          onContextMenu={(event) => event.preventDefault()}
        >
          <Settings size={24} strokeWidth={1.6} />
          <svg className="secret-ring" viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="24" cy="24" r="21" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - pressProgress} />
          </svg>
        </button>
      )}

      {view === 'home' && <button className="add-task-entry" aria-label="新增工作" title="新增工作" onClick={() => { setEditingTask(null); setEditorOpen(true); }}><Plus size={26} strokeWidth={1.6} /></button>}

      {view === 'home' && (
        <section className="home-view">
          <p className="home-heading">我要做的事</p>
          {selectedTask ? <div className="hero-copy" key={selectedTask.id}>
            {selectedTask.id === DEFAULT_TASK_ID ? <Backpack className="task-symbol" size={44} strokeWidth={1.4} aria-hidden="true" /> : <ListChecks className="task-symbol" size={44} strokeWidth={1.4} aria-hidden="true" />}
            <h1>{selectedTask.name}</h1>
            <div className="time-pill">
              <span>提醒時間</span>
              <strong>{selectedTask.reminderTime}</strong>
            </div>
            <button className="primary-button" onClick={() => beginTask(selectedTask)}>
              <Play size={22} />
              開始任務
            </button>
          </div> : <div className="empty-home"><p>還沒有工作</p><button className="soft-button" onClick={() => { setEditingTask(null); setEditorOpen(true); }}><Plus size={20} />新增工作</button></div>}
          {tasks.length > 1 && <nav className="task-switcher" aria-label="切換工作">
            <button className="icon-button" aria-label="上一個工作" title="上一個工作" disabled={tasks.findIndex((task) => task.id === selectedTask.id) <= 0} onClick={() => { const index = tasks.findIndex((task) => task.id === selectedTask.id); setSelectedTaskId(tasks[index - 1].id); }}><ChevronLeft size={24} /></button>
            <span>{tasks.findIndex((task) => task.id === selectedTask.id) + 1} / {tasks.length}</span>
            <button className="icon-button" aria-label="下一個工作" title="下一個工作" disabled={tasks.findIndex((task) => task.id === selectedTask.id) === tasks.length - 1} onClick={() => { const index = tasks.findIndex((task) => task.id === selectedTask.id); setSelectedTaskId(tasks[index + 1].id); }}><ChevronRight size={24} /></button>
          </nav>}
          {reminders.filter((item) => item.taskId === selectedTask?.id && item.kind === 'test').map((item) => <p key={item.id} className="reminder-status" role="status"><Bell size={16} />{item.label}已設定</p>)}
        </section>
      )}

      {view === 'task' && activeTask && currentStep && currentRecord && (
        <section className="task-view">
          <div className="task-header">
            <span>步驟 {stepIndex + 1} / {activeTask.steps.length}</span>
            <div className="step-progress" role="progressbar" aria-label="工作進度" aria-valuemin={0} aria-valuemax={activeTask.steps.length} aria-valuenow={stepIndex}><i style={{ width: `${(stepIndex / activeTask.steps.length) * 100}%` }} /></div>
          </div>
          <div className="step-panel" key={currentStep.id}>
            {activeTask.id === DEFAULT_TASK_ID ? <Backpack className="task-symbol" size={56} strokeWidth={1.3} aria-hidden="true" /> : <ListChecks className="task-symbol" size={56} strokeWidth={1.3} aria-hidden="true" />}
            <h1>{currentStep.name}</h1>
          </div>
          <div className="student-actions">
            <button className="voice-button" onClick={handleSpeech}>
              <AudioLines size={24} />
              播放語音
            </button>
            <button className="help-button" onClick={handleHelp} aria-label="需要幫助">
              <HelpCircle size={22} />
              <span className="help-label" aria-live="polite">{helpFeedback ? '已發出求助' : '需要幫助'}</span>
            </button>
          </div>
          <div className="task-bottom-action">
            <button className="primary-button" onClick={completeStep}>
              <Check size={26} />
              完成
            </button>
          </div>
        </section>
      )}

      {view === 'complete' && (
        <section className="complete-view">
          <div className="complete-badge">
            <Check size={52} />
          </div>
          <h1>完成了</h1>
          <p>{activeTask?.id === DEFAULT_TASK_ID ? '今天的書包已經整理好了。' : `「${activeTask?.name ?? '工作'}」已經完成了。`}</p>
          <button className="primary-button" onClick={() => setView('home')}>
            <Home size={22} />
            回到首頁
          </button>
        </section>
      )}

      {view === 'teacher' && (
        <TeacherDashboard
          metrics={metrics}
          sessions={filteredSessions}
          allSessions={sessions}
          tasks={tasks}
          analysisTaskId={analysisTaskId}
          onTaskChange={setAnalysisTaskId}
          latestMetrics={latestMetrics}
          onBack={() => setView(activeSession ? 'task' : 'home')}
          onClear={clearRecords}
        />
      )}

      <footer className="designer-credit">Designed by Jimmy</footer>

      {settingsOpen && settingsTask && (
        <SettingsSheet onClose={() => setSettingsOpen(false)}>
          <label className="setting-field"><span>提醒工作</span><select aria-label="提醒工作" value={settingsTask.id} onChange={(event) => setSettingsTaskId(event.target.value)}>{tasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></label>
          <label className="setting-field">
            <span>提醒時間</span>
            <input type="time" value={settingsTask.reminderTime} onChange={(event) => changeReminderTime(settingsTask.id, event.target.value)} onBlur={(event) => changeReminderTime(settingsTask.id, event.target.value)} />
          </label>
          <button className="soft-button" onClick={() => { setDailyReminder(); setSettingsOpen(false); }}>
            <Bell size={20} />設定提醒
          </button>
          <div className="settings-divider" />
          <p className="test-task-label">測試工作：{settingsTask.name}</p>
          <label className="setting-field">
            <span>測試提醒數值</span>
            <input type="number" inputMode="numeric" min="1" max="3600" value={testValue} onChange={(event) => setTestValue(event.target.value)} onBlur={(event) => setTestValue(event.target.value)} />
          </label>
          <div className="unit-control" role="group" aria-label="測試提醒單位">
            <button aria-pressed={testUnit === 'seconds'} onClick={() => setTestUnit('seconds')}>秒</button>
            <button aria-pressed={testUnit === 'minutes'} onClick={() => setTestUnit('minutes')}>分</button>
          </div>
          <button className="primary-button" disabled={!Number.isInteger(Number(testValue)) || Number(testValue) < 1 || Number(testValue) > 3600} onClick={() => {
            setTestReminder(Number(testValue) * (testUnit === 'minutes' ? 60 : 1));
            setSettingsOpen(false);
          }}><Play size={20} />開始測試提醒</button>
          <p className="browser-note">請保持網頁開啟。手機背景執行可能限制提醒。</p>
          {view === 'home' && <div className="task-management"><button className="soft-button" onClick={() => { setEditingTask(settingsTask); setSettingsOpen(false); setEditorOpen(true); }}><Pencil size={18} />編輯工作</button><button className="text-button" onClick={() => { setSettingsOpen(false); setDeletingTask(settingsTask); }}><Trash2 size={18} />刪除工作</button></div>}
        </SettingsSheet>
      )}

      {editorOpen && <TaskEditor task={editingTask} onSave={saveTask} onClose={() => setEditorOpen(false)} />}

      {deletingTask && <SettingsSheet title="刪除工作" onClose={() => setDeletingTask(null)}>
        <p className="delete-confirmation">確定要刪除「{deletingTask.name}」嗎？</p>
        <p className="browser-note">歷史紀錄會保留。</p>
        <button className="soft-button" onClick={() => setDeletingTask(null)}>取消</button>
        <button className="primary-button" onClick={() => deleteTask(deletingTask)}><Trash2 size={20} />刪除工作</button>
      </SettingsSheet>}

      {reminder && remindedTask && (
        <div className="reminder-overlay" role="dialog" aria-modal="true">
          <div className="reminder-card">
            <Bell size={42} />
            <p>{reminder.label || '提醒時間到了'}</p>
            <h1>{remindedTask.name}</h1>
            <button className="primary-button" onClick={() => beginTask(remindedTask)}>
              開始任務
            </button>
            <button className="text-button" onClick={() => setReminderQueue((queue) => queue.slice(1))}>
              稍後
            </button>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

function SettingsSheet({ children, onClose, title = '設定' }: { children: React.ReactNode; onClose: () => void; title?: string }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sheetRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div ref={sheetRef} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
        if (event.key !== 'Tab') return;
        const controls = sheetRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select');
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header"><h2 id="settings-title">{title}</h2><button className="close-button" aria-label={title === '設定' ? '關閉設定' : '關閉工作編輯'} onClick={onClose}><X size={22} /></button></header>
        {children}
      </div>
    </div>
  );
}

function TaskEditor({ task, onSave, onClose }: { task: TaskSettings | null; onSave: (task: TaskSettings) => void; onClose: () => void }) {
  const [name, setName] = useState(task?.name ?? '');
  const [time, setTime] = useState(task?.reminderTime ?? '21:30');
  const [steps, setSteps] = useState<Step[]>(task?.steps.map((step) => ({ ...step })) ?? [{ id: makeId(), name: '' }]);
  const [error, setError] = useState('');
  function updateStep(id: Step['id'], name: string) { setSteps((current) => current.map((step) => step.id === id ? { ...step, name } : step)); }
  function moveStep(index: number, offset: number) {
    setSteps((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  }
  return <SettingsSheet title={task ? '編輯我要做的事' : '新增我要做的事'} onClose={onClose}>
    <form className="task-editor" onSubmit={(event) => {
      event.preventDefault();
      if (!name.trim() || !steps.length || steps.some((step) => !step.name.trim()) || !validTime(time)) { setError('請填寫工作名稱、提醒時間與每一步內容。'); return; }
      const now = Date.now();
      onSave({ id: task?.id ?? makeId(), name: name.trim(), reminderTime: time, steps: steps.map((step) => ({ ...step, name: step.name.trim() })), createdAt: task?.createdAt ?? now, updatedAt: now });
    }}>
      <label className="setting-field"><span>我要做的事</span><input required type="text" value={name} onChange={(event) => setName(event.target.value)} onBlur={(event) => setName(event.target.value)} aria-label="工作名稱" /></label>
      <label className="setting-field"><span>提醒時間</span><input required type="time" value={time} onChange={(event) => setTime(event.target.value)} onBlur={(event) => setTime(event.target.value)} /></label>
      <div className="editor-steps"><h3>我要怎麼完成</h3>{steps.map((step, index) => <div key={step.id} className="editor-step">
        <label className="setting-field"><span>步驟 {index + 1}</span><textarea rows={2} required value={step.name} onChange={(event) => updateStep(step.id, event.target.value)} onBlur={(event) => updateStep(step.id, event.target.value)} aria-label={`步驟 ${index + 1} 內容`} /></label>
        <div className="step-edit-actions">
          <button type="button" className="icon-button" aria-label={`上移步驟 ${index + 1}`} title="上移" disabled={index === 0} onClick={() => moveStep(index, -1)}><ArrowUp size={20} /></button>
          <button type="button" className="icon-button" aria-label={`下移步驟 ${index + 1}`} title="下移" disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown size={20} /></button>
          <button type="button" className="icon-button" aria-label={`刪除步驟 ${index + 1}`} title="刪除步驟" disabled={steps.length === 1} onClick={() => setSteps((current) => current.filter((item) => item.id !== step.id))}><Trash2 size={20} /></button>
        </div>
      </div>)}</div>
      <button type="button" className="soft-button" onClick={() => setSteps((current) => [...current, { id: makeId(), name: '' }])}><Plus size={20} />新增一步</button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="primary-button editor-save"><Check size={22} />儲存</button>
    </form>
  </SettingsSheet>;
}

function TeacherDashboard({
  metrics,
  sessions,
  latestMetrics,
  onBack,
  onClear,
  tasks,
  allSessions,
  analysisTaskId,
  onTaskChange,
}: {
  metrics: SessionMetrics[];
  sessions: SessionRecord[];
  latestMetrics?: SessionMetrics;
  onBack: () => void;
  onClear: () => void;
  tasks: TaskSettings[];
  allSessions: SessionRecord[];
  analysisTaskId: string;
  onTaskChange: (id: string) => void;
}) {
  const taskOptions = useMemo(() => {
    const options = new Map(tasks.map((task) => [task.id, task.name]));
    allSessions.forEach((session) => { if (!options.has(session.taskId)) options.set(session.taskId, `${session.taskName}（歷史工作）`); });
    return [...options].map(([id, name]) => ({ id, name }));
  }, [tasks, allSessions]);
  useEffect(() => {
    if (!taskOptions.some((task) => task.id === analysisTaskId) && taskOptions.length) onTaskChange(taskOptions[0].id);
  }, [taskOptions, analysisTaskId, onTaskChange]);
  const hardSteps = useMemo(() => getHardSteps(sessions), [sessions]);
  const progressText = useMemo(() => getProgressText(metrics), [metrics]);
  const maxDuration = Math.max(1, ...metrics.map((item) => item.totalSeconds));
  const maxPrompts = Math.max(1, ...metrics.map((item) => item.helpTotal + item.speechTotal));

  return (
    <section className="teacher-view">
      <header className="teacher-header">
        <div>
          <span className="teacher-kicker">
            <Shield size={16} />
            分析模式
          </span>
          <h1>教師分析</h1>
        </div>
        <button className="teacher-icon-button" onClick={onBack} aria-label="返回學生模式">
          <Home size={20} />
        </button>
      </header>

      <label className="analysis-filter setting-field"><span>分析工作</span><select aria-label="分析工作" value={analysisTaskId} disabled={!taskOptions.length} onChange={(event) => onTaskChange(event.target.value)}>{!taskOptions.length && <option value="">尚無工作</option>}{taskOptions.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></label>

      <section className="glass-section">
        <div className="section-title">
          <h2>今日表現</h2>
          <span>{sessions.length} 次紀錄</span>
        </div>
        <div className="metric-grid">
          <Metric label="完成率" value={latestMetrics ? percent(latestMetrics.completionRate) : '--'} />
          <Metric label="獨立完成率" value={latestMetrics ? percent(latestMetrics.independentRate) : '--'} />
          <Metric label="平均提示" value={latestMetrics ? latestMetrics.averagePromptLevel.toFixed(1) : '--'} />
          <Metric label="完成時間" value={latestMetrics ? formatSeconds(latestMetrics.totalSeconds) : '--'} />
        </div>
        {!latestMetrics && <p className="empty-text">尚無任務紀錄。</p>}
      </section>

      <section className="glass-section">
        <div className="section-title">
          <h2>歷次趨勢</h2>
          <BarChart3 size={18} />
        </div>
        {metrics.length ? (
          <div className="trend-list">
            {metrics.slice(-8).map((item, index) => (
              <div className="trend-row" key={item.session.id}>
                <span>第 {metrics.length - metrics.slice(-8).length + index + 1} 次</span>
                <div className="bars">
                  <Bar label="獨立" value={item.independentRate} max={100} />
                  <Bar label="時間" value={item.totalSeconds} max={maxDuration} />
                  <Bar label="提示" value={item.helpTotal + item.speechTotal} max={maxPrompts} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-text">還沒有可呈現的趨勢。</p>
        )}
        {progressText && <p className="progress-summary">{progressText}</p>}
      </section>

      <section className="glass-section">
        <div className="section-title">
          <h2>困難步驟</h2>
          <span>依歷史紀錄</span>
        </div>
        <div className="hard-step-list">
          <HardStep title="最常需要幫助" item={hardSteps.byHelp} suffix="次" />
          <HardStep title="語音重播最多" item={hardSteps.bySpeech} suffix="次" />
          <HardStep title="平均耗時最長" item={hardSteps.byDuration} suffix="秒" />
        </div>
      </section>

      <section className="glass-section">
        <div className="section-title">
          <h2>歷次任務紀錄</h2>
          <button className="danger-button" onClick={onClear}>
            <Trash2 size={16} />
            清除測試紀錄
          </button>
        </div>
        <div className="session-list">
          {metrics
            .slice()
            .reverse()
            .map((item) => (
              <details key={item.session.id} className="session-card">
                <summary>
                  <span>{new Date(item.session.startedAt).toLocaleString('zh-TW')}</span>
                  <strong>{percent(item.independentRate)}</strong>
                </summary>
                <div className="session-details">
                  <p>完成率：{percent(item.completionRate)}</p>
                  <p>{item.session.taskName}{!item.session.completedAt && ' · 未完成'}</p>
                  <p>語音重播：{item.speechTotal} 次，需要幫助：{item.helpTotal} 次</p>
                  <p>平均每步：{formatSeconds(item.averageStepSeconds)}，總時間：{formatSeconds(item.totalSeconds)}</p>
                  {item.session.steps.map((step, index) => (
                    <div className="step-record" key={`${item.session.id}-${step.stepId}`}>
                      <span>{index + 1}. {step.stepName}</span>
                      <small>
                        {formatSeconds(step.duration)} · 語音 {step.speechReplayCount} · 幫助 {step.helpCount} · 層級 {step.independenceLevel}
                      </small>
                    </div>
                  ))}
                </div>
              </details>
            ))}
        </div>
      </section>

      <div className="teacher-actions">
        <button className="teacher-button" onClick={onBack}>
          <RotateCcw size={18} />
          返回學生模式
        </button>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="bar-line">
      <span>{label}</span>
      <i style={{ width: `${Math.max(4, Math.min(100, (value / max) * 100))}%` }} />
    </div>
  );
}

function HardStep({ title, item, suffix }: { title: string; item?: { name: string; value: number }; suffix: string }) {
  return (
    <div className="hard-step">
      <span>{title}</span>
      {item ? (
        <>
          <strong>{item.name}</strong>
          <small>{Math.round(item.value)} {suffix}</small>
        </>
      ) : (
        <strong>尚無資料</strong>
      )}
    </div>
  );
}

function getHardSteps(sessions: SessionRecord[]) {
  const map = new Map<string | number, { name: string; help: number; speech: number; duration: number; count: number }>();
  sessions.forEach((session) => {
    session.steps.forEach((step) => {
      const entry = map.get(step.stepId) ?? { name: step.stepName, help: 0, speech: 0, duration: 0, count: 0 };
      entry.help += step.helpCount;
      entry.speech += step.speechReplayCount;
      entry.duration += step.duration;
      entry.count += 1;
      map.set(step.stepId, entry);
    });
  });
  const values = [...map.values()];
  const pick = (selector: (item: (typeof values)[number]) => number) => {
    const sorted = values.slice().sort((a, b) => selector(b) - selector(a));
    const first = sorted[0];
    if (!first || selector(first) <= 0) return undefined;
    return { name: first.name, value: selector(first) };
  };

  return {
    byHelp: pick((item) => item.help),
    bySpeech: pick((item) => item.speech),
    byDuration: pick((item) => item.duration / Math.max(item.count, 1)),
  };
}

function getProgressText(metrics: SessionMetrics[]) {
  if (metrics.length < 2) return '';
  const recent = metrics.slice(-5);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const promptDrop = first.averagePromptLevel - last.averagePromptLevel;
  const timeDrop = first.totalSeconds - last.totalSeconds;
  return `近 ${recent.length} 次任務中：獨立完成率由 ${percent(first.independentRate)} 到 ${percent(last.independentRate)}，平均提示需求${promptDrop >= 0 ? '下降' : '增加'} ${Math.abs(promptDrop).toFixed(1)} 個層級，完成時間${timeDrop >= 0 ? '減少' : '增加'} ${formatSeconds(Math.abs(timeDrop))}。`;
}
