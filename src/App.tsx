import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Bell,
  Check,
  Clock,
  HelpCircle,
  Home,
  Play,
  RotateCcw,
  Shield,
  Trash2,
  Volume2,
} from 'lucide-react';

type Step = {
  id: number;
  name: string;
  imageHint?: string;
};

type TaskSettings = {
  id: string;
  name: string;
  reminderTime: string;
  steps: Step[];
};

type StepRecord = {
  stepId: number;
  stepName: string;
  stepStartTime: string;
  stepEndTime: string | null;
  duration: number;
  helpCount: number;
  speechReplayCount: number;
  completed: boolean;
  skipped: boolean;
  independenceLevel: 0 | 1 | 2 | 3 | 4;
};

type SessionRecord = {
  id: string;
  taskId: string;
  taskName: string;
  startedAt: string;
  completedAt: string | null;
  steps: StepRecord[];
};

type ReminderState = {
  active: boolean;
  dueAt: number | null;
  label: string;
};

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

const STORAGE_KEY = 'seta_mvp_state';

const defaultTask: TaskSettings = {
  id: 'pack-schoolbag',
  name: '整理明天的書包',
  reminderTime: '21:30',
  steps: [
    { id: 1, name: '查看明天的課表' },
    { id: 2, name: '準備明天需要的課本' },
    { id: 3, name: '把課本放進書包' },
    { id: 4, name: '放入聯絡簿' },
    { id: 5, name: '檢查鉛筆盒' },
    { id: 6, name: '準備水壺' },
    { id: 7, name: '最後檢查一次書包' },
    { id: 8, name: '完成整理' },
  ],
};

const defaultReminder: ReminderState = {
  active: false,
  dueAt: null,
  label: '',
};

function loadSessions(): SessionRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { sessions?: SessionRecord[] };
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionRecord[]) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      taskSettings: defaultTask,
      reminderTime: defaultTask.reminderTime,
      sessions,
      updatedAt: new Date().toISOString(),
    }),
  );
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
  const totalSteps = Math.max(session.steps.length, 1);
  const completedSteps = session.steps.filter((step) => step.completed).length;
  const independentSteps = session.steps.filter((step) => step.completed && step.independenceLevel === 0).length;
  const promptSum = session.steps.reduce((sum, step) => sum + step.independenceLevel, 0);
  const speechTotal = session.steps.reduce((sum, step) => sum + step.speechReplayCount, 0);
  const helpTotal = session.steps.reduce((sum, step) => sum + step.helpCount, 0);
  const finishedSteps = session.steps.filter((step) => step.stepEndTime);
  const durationSum = finishedSteps.reduce((sum, step) => sum + step.duration, 0);
  const started = new Date(session.startedAt).getTime();
  const ended = session.completedAt ? new Date(session.completedAt).getTime() : started;

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

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function scheduleTodayAt(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  const now = new Date();
  const due = new Date(now);
  due.setHours(hours, minutes, 0, 0);
  if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
  return due.getTime();
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

function speakStep(step: Step, onError: () => void) {
  try {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return false;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(`第 ${step.id} 步，${step.name}。`);
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
  const [view, setView] = useState<View>('home');
  const [sessions, setSessions] = useState<SessionRecord[]>(() => loadSessions());
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [reminder, setReminder] = useState<ReminderState>(defaultReminder);
  const [reminderVisible, setReminderVisible] = useState(false);
  const [toast, setToast] = useState('');
  const [pressProgress, setPressProgress] = useState(0);
  const holdStart = useRef<number | null>(null);
  const holdFrame = useRef<number | null>(null);

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!reminder.active || !reminder.dueAt) return;
    const dueAt = reminder.dueAt;
    const interval = window.setInterval(() => {
      if (Date.now() >= dueAt) {
        setReminderVisible(true);
        playReminderSound();
        setReminder(defaultReminder);
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [reminder]);

  const metrics = useMemo(() => sessions.map(getMetrics), [sessions]);
  const latestMetrics = metrics[metrics.length - 1];

  function beginTask() {
    const firstStep = defaultTask.steps[0];
    const session: SessionRecord = {
      id: makeId(),
      taskId: defaultTask.id,
      taskName: defaultTask.name,
      startedAt: new Date().toISOString(),
      completedAt: null,
      steps: [createStepRecord(firstStep)],
    };
    setActiveSession(session);
    setStepIndex(0);
    setView('task');
    setReminderVisible(false);
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
    const step = defaultTask.steps[stepIndex];
    const speechFallback = () => setToast('此裝置目前無法語音朗讀，已記錄提示次數。');
    const spoke = speakStep(step, speechFallback);
    updateCurrentStep((record) => {
      const updated = { ...record, speechReplayCount: record.speechReplayCount + 1 };
      return { ...updated, independenceLevel: getIndependenceLevel(updated) };
    });
    if (!spoke) speechFallback();
  }

  function handleHelp() {
    updateCurrentStep((record) => {
      const updated = { ...record, helpCount: record.helpCount + 1 };
      return { ...updated, independenceLevel: getIndependenceLevel(updated) };
    });
    setToast('已記錄需要幫助。可以休息一下，再按完成繼續。');
  }

  function completeStep() {
    if (!activeSession) return;
    const now = new Date().toISOString();
    const finishedStep = {
      ...activeSession.steps[stepIndex],
      stepEndTime: now,
      duration: secondsBetween(activeSession.steps[stepIndex].stepStartTime, now),
      completed: true,
    };
    finishedStep.independenceLevel = getIndependenceLevel(finishedStep);

    const nextStep = defaultTask.steps[stepIndex + 1];
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
    const dueAt = scheduleTodayAt(defaultTask.reminderTime);
    setReminder({ active: true, dueAt, label: '預定提醒' });
    setToast(`已設定 ${defaultTask.reminderTime} 提醒。網頁開啟期間會顯示全畫面提醒。`);
  }

  function setTestReminder(seconds: number) {
    prepareReminderAudio();
    setReminder({ active: true, dueAt: Date.now() + seconds * 1000, label: `${seconds} 秒測試提醒` });
    setToast(`已設定 ${seconds === 30 ? '30 秒' : '1 分鐘'}後提醒。`);
  }

  function cancelHold() {
    holdStart.current = null;
    setPressProgress(0);
    if (holdFrame.current) window.cancelAnimationFrame(holdFrame.current);
  }

  function startHold() {
    holdStart.current = Date.now();
    const tick = () => {
      if (!holdStart.current) return;
      const progress = Math.min(1, (Date.now() - holdStart.current) / 7000);
      setPressProgress(progress);
      if (progress >= 1) {
        cancelHold();
        setView('teacher');
        return;
      }
      holdFrame.current = window.requestAnimationFrame(tick);
    };
    tick();
  }

  function clearRecords() {
    const confirmed = window.confirm('確定要清除所有測試紀錄嗎？此動作無法復原。');
    if (!confirmed) return;
    setSessions([]);
    setToast('測試紀錄已清除。');
  }

  const currentStep = defaultTask.steps[stepIndex];
  const currentRecord = activeSession?.steps[stepIndex];

  return (
    <main className={`app app-${view}`}>
      {view !== 'teacher' && (
        <button
          className="secret-entry"
          aria-label="隱藏入口"
          onPointerDown={startHold}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          onPointerCancel={cancelHold}
          onContextMenu={(event) => event.preventDefault()}
        >
          <span
            className="secret-ring"
            style={{ background: `conic-gradient(#5e6b76 ${pressProgress * 360}deg, rgba(94,107,118,.16) 0deg)` }}
          />
        </button>
      )}

      {view === 'home' && (
        <section className="home-view">
          <div className="top-mark">
            <Bell size={18} />
            <span>網頁開啟期間提醒</span>
          </div>
          <div className="hero-copy">
            <p>今晚的任務</p>
            <h1>{defaultTask.name}</h1>
            <div className="time-pill">
              <Clock size={22} />
              <span>{defaultTask.reminderTime}</span>
            </div>
          </div>
          <div className="home-actions">
            <button className="primary-button" onClick={beginTask}>
              <Play size={22} />
              開始任務
            </button>
            <button className="soft-button" onClick={() => setTestReminder(30)}>
              30 秒測試提醒
            </button>
            <button className="soft-button" onClick={() => setTestReminder(60)}>
              1 分鐘測試提醒
            </button>
            <button className="text-button" onClick={setDailyReminder}>
              設定今晚 {defaultTask.reminderTime} 提醒
            </button>
          </div>
          <p className="browser-note">提醒功能適合示範網頁開啟期間的定時提示，手機背景執行會受到瀏覽器限制。</p>
        </section>
      )}

      {view === 'task' && currentStep && currentRecord && (
        <section className="task-view">
          <div className="task-header">
            <span>第 {currentStep.id} 步 / 共 {defaultTask.steps.length} 步</span>
            <div className="step-dots" aria-hidden="true">
              {defaultTask.steps.map((step, index) => (
                <i key={step.id} className={index <= stepIndex ? 'done' : ''} />
              ))}
            </div>
          </div>
          <div className="step-panel">
            <div className="image-placeholder">
              <span>{currentStep.imageHint || '圖片區塊'}</span>
            </div>
            <h1>{currentStep.name}</h1>
          </div>
          <div className="student-actions">
            <button className="voice-button" onClick={handleSpeech}>
              <Volume2 size={24} />
              播放語音
            </button>
            <button className="primary-button" onClick={completeStep}>
              <Check size={26} />
              完成
            </button>
            <button className="help-button" onClick={handleHelp}>
              <HelpCircle size={22} />
              需要幫助
            </button>
          </div>
        </section>
      )}

      {view === 'complete' && (
        <section className="complete-view">
          <div className="complete-badge">
            <Check size={52} />
          </div>
          <h1>完成了！</h1>
          <p>今天的書包已經整理好了。</p>
          <button className="primary-button" onClick={() => setView('home')}>
            <Home size={22} />
            回到首頁
          </button>
        </section>
      )}

      {view === 'teacher' && (
        <TeacherDashboard
          metrics={metrics}
          sessions={sessions}
          latestMetrics={latestMetrics}
          onBack={() => setView('home')}
          onClear={clearRecords}
        />
      )}

      {reminderVisible && (
        <div className="reminder-overlay" role="dialog" aria-modal="true">
          <div className="reminder-card">
            <Bell size={42} />
            <p>{reminder.label || '提醒時間到了'}</p>
            <h1>{defaultTask.name}</h1>
            <button className="primary-button" onClick={beginTask}>
              開始任務
            </button>
            <button className="text-button" onClick={() => setReminderVisible(false)}>
              稍後
            </button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function TeacherDashboard({
  metrics,
  sessions,
  latestMetrics,
  onBack,
  onClear,
}: {
  metrics: SessionMetrics[];
  sessions: SessionRecord[];
  latestMetrics?: SessionMetrics;
  onBack: () => void;
  onClear: () => void;
}) {
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

      <section className="glass-section">
        <div className="section-title">
          <h2>今日表現</h2>
          <span>{sessions.length} 次紀錄</span>
        </div>
        {latestMetrics ? (
          <div className="metric-grid">
            <Metric label="完成率" value={percent(latestMetrics.completionRate)} />
            <Metric label="獨立完成率" value={percent(latestMetrics.independentRate)} />
            <Metric label="平均提示" value={latestMetrics.averagePromptLevel.toFixed(1)} />
            <Metric label="完成時間" value={formatSeconds(latestMetrics.totalSeconds)} />
          </div>
        ) : (
          <p className="empty-text">尚無任務紀錄。完成一次任務後，這裡會顯示分析資料。</p>
        )}
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
                  <p>語音重播：{item.speechTotal} 次，需要幫助：{item.helpTotal} 次</p>
                  <p>平均每步：{formatSeconds(item.averageStepSeconds)}，總時間：{formatSeconds(item.totalSeconds)}</p>
                  {item.session.steps.map((step) => (
                    <div className="step-record" key={`${item.session.id}-${step.stepId}`}>
                      <span>{step.stepId}. {step.stepName}</span>
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
  const map = new Map<number, { name: string; help: number; speech: number; duration: number; count: number }>();
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
  const first = metrics[0];
  const last = metrics[metrics.length - 1];
  const recent = metrics.slice(-5);
  const promptDrop = first.averagePromptLevel - last.averagePromptLevel;
  const timeDrop = first.totalSeconds - last.totalSeconds;
  return `近 ${recent.length} 次任務中：獨立完成率由 ${percent(first.independentRate)} 到 ${percent(last.independentRate)}，平均提示需求${promptDrop >= 0 ? '下降' : '增加'} ${Math.abs(promptDrop).toFixed(1)} 個層級，平均完成時間${timeDrop >= 0 ? '減少' : '增加'} ${formatSeconds(Math.abs(timeDrop))}。`;
}
