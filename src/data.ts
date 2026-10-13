export type Step = { id: string | number; name: string };
export type TaskSettings = {
  id: string;
  name: string;
  reminderTime: string;
  steps: Step[];
  createdAt: number;
  updatedAt: number;
};
export type StepRecord = {
  stepId: string | number;
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
export type SessionRecord = {
  id: string;
  taskId: string;
  taskName: string;
  startedAt: string;
  completedAt: string | null;
  totalSteps: number;
  steps: StepRecord[];
};
export type ReminderState = {
  id: string;
  taskId: string;
  dueAt: number;
  label: string;
  kind: 'daily' | 'test';
};
export type Progress = { task: TaskSettings; session: SessionRecord; stepIndex: number };
export type StoredState = {
  version: 2;
  tasks: TaskSettings[];
  sessions: SessionRecord[];
  selectedTaskId: string;
  reminders: ReminderState[];
  reminderQueue: ReminderState[];
  progress: Progress | null;
};

export const STORAGE_KEY = 'seta_mvp_state';
export const DEFAULT_TASK_ID = 'pack-schoolbag';
export const defaultTask: TaskSettings = {
  id: DEFAULT_TASK_ID,
  name: '整理明天的書包',
  reminderTime: '21:30',
  createdAt: 0,
  updatedAt: 0,
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

export function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export type TimePeriod = '上午' | '下午';

export function getTime12Parts(value: string) {
  const [hours, minutes] = (validTime(value) ? value : '00:00').split(':').map(Number);
  return { period: (hours < 12 ? '上午' : '下午') as TimePeriod, hour: hours % 12 || 12, minute: minutes };
}

export function formatTime12Hour(value: string) {
  if (!validTime(value)) return '--';
  const { period, hour, minute } = getTime12Parts(value);
  return `${period} ${hour}:${String(minute).padStart(2, '0')}`;
}

export function to24Hour(period: TimePeriod, hour: number, minute: number) {
  if ((period !== '上午' && period !== '下午') || !Number.isInteger(hour) || hour < 1 || hour > 12 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RangeError('Invalid 12-hour time');
  }
  const hours = hour % 12 + (period === '下午' ? 12 : 0);
  return `${String(hours).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function formatSessionDateTime(value: string) {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return '--';
  const clock = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  return `${time.toLocaleDateString('zh-TW')} ${formatTime12Hour(clock)}`;
}

export function scheduleTodayAt(time: string, now = new Date()) {
  const [hours, minutes] = time.split(':').map(Number);
  const due = new Date(now);
  due.setHours(hours, minutes, 0, 0);
  if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
  return due.getTime();
}

export function dailyReminder(task: TaskSettings): ReminderState {
  return { id: `daily-${task.id}`, taskId: task.id, dueAt: scheduleTodayAt(task.reminderTime), kind: 'daily', label: '預定提醒' };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function finite(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function date(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function readTask(value: unknown): TaskSettings | null {
  const item = object(value);
  if (typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name.trim()) return null;
  const steps = (Array.isArray(item.steps) ? item.steps : []).flatMap((value, index) => {
    const step = object(value);
    if (typeof step.name !== 'string' || !step.name.trim()) return [];
    return [{ id: typeof step.id === 'string' || typeof step.id === 'number' ? step.id : index + 1, name: step.name }];
  });
  if (!steps.length) return null;
  return { id: item.id, name: item.name, steps, reminderTime: validTime(item.reminderTime) ? item.reminderTime : '21:30', createdAt: finite(item.createdAt), updatedAt: finite(item.updatedAt) };
}

function readSession(value: unknown): SessionRecord | null {
  const item = object(value);
  if (!date(item.startedAt) || !Array.isArray(item.steps)) return null;
  const steps = item.steps.flatMap((value, index): StepRecord[] => {
    const step = object(value);
    if (typeof step.stepName !== 'string' || !date(step.stepStartTime)) return [];
    const helpCount = finite(step.helpCount);
    const speechReplayCount = finite(step.speechReplayCount);
    const skipped = step.skipped === true;
    const level = skipped || helpCount > 1 ? 4 : helpCount === 1 ? 3 : speechReplayCount > 1 ? 2 : speechReplayCount === 1 ? 1 : 0;
    return [{
      stepId: typeof step.stepId === 'string' || typeof step.stepId === 'number' ? step.stepId : index + 1,
      stepName: step.stepName, stepStartTime: step.stepStartTime,
      stepEndTime: date(step.stepEndTime) ? step.stepEndTime : null,
      duration: finite(step.duration), helpCount, speechReplayCount,
      completed: step.completed === true, skipped, independenceLevel: level,
    }];
  });
  return {
    id: typeof item.id === 'string' ? item.id : makeId(),
    taskId: typeof item.taskId === 'string' && item.taskId ? item.taskId : DEFAULT_TASK_ID,
    taskName: typeof item.taskName === 'string' ? item.taskName : typeof item.taskTitle === 'string' ? item.taskTitle : defaultTask.name,
    startedAt: item.startedAt, completedAt: date(item.completedAt) ? item.completedAt : null,
    totalSteps: Math.max(steps.length, finite(item.totalSteps, steps.length || defaultTask.steps.length)), steps,
  };
}

// Upgrade the single-task store without changing valid historical records.
export function migrateData(value: unknown): StoredState {
  const raw = object(value);
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.map(readTask).filter((task): task is TaskSettings => task !== null) : [];
  if (!tasks.length && !(raw.version === 2 && Array.isArray(raw.tasks) && raw.tasks.length === 0)) tasks.push({ ...defaultTask, createdAt: Date.now(), updatedAt: Date.now(), reminderTime: validTime(raw.reminderTime) ? raw.reminderTime : defaultTask.reminderTime });
  const sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).map(readSession).filter((session): session is SessionRecord => session !== null);
  const readReminders = (values: unknown) => (Array.isArray(values) ? values : []).flatMap((value): ReminderState[] => {
    const item = object(value);
    if (typeof item.taskId !== 'string' || !tasks.some((task) => task.id === item.taskId) || !finite(item.dueAt)) return [];
    return [{ id: typeof item.id === 'string' ? item.id : makeId(), taskId: item.taskId, dueAt: item.dueAt as number, kind: item.kind === 'test' ? 'test' : 'daily', label: typeof item.label === 'string' ? item.label : '預定提醒' }];
  });
  const reminders = readReminders(raw.reminders);
  const reminderQueue = readReminders(raw.reminderQueue);
  tasks.forEach((task) => { if (!reminders.some((reminder) => reminder.taskId === task.id && reminder.kind === 'daily')) reminders.push(dailyReminder(task)); });
  const savedProgress = object(raw.progress);
  const task = readTask(savedProgress.task);
  const session = readSession(savedProgress.session);
  const stepIndex = finite(savedProgress.stepIndex);
  const progress = task && session && session.taskId === task.id && !session.completedAt && Number.isInteger(stepIndex) && task.steps[stepIndex] && session.steps[stepIndex] ? { task, session, stepIndex } : null;
  return { version: 2, tasks, sessions, selectedTaskId: tasks.some((task) => task.id === raw.selectedTaskId) ? raw.selectedTaskId as string : tasks[0]?.id ?? '', reminders, reminderQueue, progress };
}

export function sessionsForTask(sessions: SessionRecord[], taskId: string) {
  return sessions.filter((session) => session.taskId === taskId);
}

export function splitDueReminders(reminders: ReminderState[], now: number) {
  return {
    due: reminders.filter((reminder) => reminder.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt),
    pending: reminders.filter((reminder) => reminder.dueAt > now),
  };
}
