import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateData, defaultTask, sessionsForTask, splitDueReminders, scheduleTodayAt } from '../src/data.ts';

const step = { stepId: 1, stepName: '查看明天的課表', stepStartTime: '2026-10-13T10:00:00Z', stepEndTime: '2026-10-13T10:00:20Z', duration: 20, helpCount: 1, speechReplayCount: 2, completed: true, skipped: false, independenceLevel: 3 };
const oldSession = { id: 'old-session', startedAt: step.stepStartTime, completedAt: step.stepEndTime, steps: [step] };
const laundry = { id: 'laundry', name: '洗衣服', reminderTime: '09:15', steps: [{ id: 'soap', name: '加入洗衣精' }, { id: 'start', name: '按下開始' }], createdAt: 10, updatedAt: 20 };

test('first use creates the eight-step demonstration task', () => {
  const state = migrateData(null);
  assert.equal(state.version, 2);
  assert.equal(state.tasks[0].id, defaultTask.id);
  assert.equal(state.tasks[0].steps.length, 8);
});

test('legacy records without taskId migrate without losing counts, timestamps or reminder time', () => {
  const state = migrateData({ reminderTime: '20:45', sessions: [oldSession] });
  assert.equal(state.tasks[0].reminderTime, '20:45');
  assert.equal(state.sessions[0].taskId, defaultTask.id);
  assert.equal(state.sessions[0].taskName, defaultTask.name);
  assert.deepEqual(state.sessions[0].steps, [step]);
  assert.equal(state.sessions[0].id, oldSession.id);
});

test('custom task order, stable step IDs and separate times survive JSON reload', () => {
  const state = migrateData({ version: 2, tasks: [defaultTask, laundry], selectedTaskId: 'laundry', sessions: [] });
  const reloaded = migrateData(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(reloaded.tasks[1], laundry);
  assert.equal(reloaded.tasks[0].reminderTime, '21:30');
  assert.equal(reloaded.selectedTaskId, 'laundry');
});

test('more than eight custom steps are retained without a fixed step limit', () => {
  const task = { ...laundry, steps: Array.from({ length: 12 }, (_, index) => ({ id: `step-${index}`, name: `自訂步驟 ${index + 1}` })) };
  assert.equal(migrateData({ tasks: [task] }).tasks[0].steps.length, 12);
});

test('malformed records cannot crash migration or discard other valid records', () => {
  const state = migrateData({ tasks: [null, { steps: null }], sessions: [null, { steps: [{}] }, oldSession], reminders: [null] });
  assert.equal(state.tasks[0].steps.length, 8);
  assert.equal(state.sessions.length, 1);
  assert.doesNotThrow(() => migrateData('invalid shape'));
});

test('task filters never mix histories and retain deleted task history', () => {
  const state = migrateData({ tasks: [defaultTask, laundry], sessions: [oldSession, { ...oldSession, id: 'laundry-session', taskId: 'laundry', taskName: '洗衣服' }] });
  assert.equal(sessionsForTask(state.sessions, defaultTask.id).length, 1);
  assert.equal(sessionsForTask(state.sessions, 'laundry')[0].id, 'laundry-session');
  const deleted = migrateData({ ...state, tasks: [defaultTask] });
  assert.equal(sessionsForTask(deleted.sessions, 'laundry').length, 1);
});

test('same-time reminders are queued together in deterministic order', () => {
  const reminders = [{ id: 'a', dueAt: 100, taskId: 'a' }, { id: 'b', dueAt: 100, taskId: 'b' }, { id: 'c', dueAt: 200, taskId: 'c' }];
  const split = splitDueReminders(reminders, 100);
  assert.deepEqual(split.due.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(split.pending.map((item) => item.id), ['c']);
});

test('in-progress task snapshot and full step denominator survive reload and task edits', () => {
  const session = { ...oldSession, completedAt: null, taskId: 'laundry', taskName: '洗衣服', totalSteps: 2 };
  const state = migrateData({ version: 2, tasks: [{ ...laundry, name: '新版洗衣服', steps: [laundry.steps[1]] }], sessions: [], progress: { task: laundry, session, stepIndex: 0 } });
  assert.equal(state.progress.task.name, '洗衣服');
  assert.equal(state.progress.task.steps.length, 2);
  assert.equal(state.progress.session.totalSteps, 2);
});

test('explicitly deleted last task stays empty and old history is still readable', () => {
  const state = migrateData({ version: 2, tasks: [], sessions: [oldSession] });
  assert.equal(state.tasks.length, 0);
  assert.equal(state.selectedTaskId, '');
  assert.equal(state.sessions.length, 1);
});

test('invalid active progress is discarded and daily scheduling uses device date', () => {
  assert.equal(migrateData({ progress: { task: laundry, session: oldSession, stepIndex: 100 } }).progress, null);
  const now = new Date(2026, 9, 13, 22, 0);
  const due = new Date(scheduleTodayAt('21:30', now));
  assert.equal(due.getDate(), 14);
  assert.equal(due.getHours(), 21);
  assert.equal(due.getMinutes(), 30);
});
