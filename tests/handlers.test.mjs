import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { migrateData, STORAGE_KEY } from '../src/data.ts';

const source = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
// Exercise actual UI handlers with browser services and React setters isolated.
function functionCode(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing handler boundary: ${start}`);
  return stripTypeScriptTypes(source.slice(first, last));
}
const voiceCode = [
  functionCode('function speakText(', 'export function App()'),
  functionCode('function getIndependenceLevel(', 'function secondsBetween('),
  functionCode('function handleSpeech()', 'function completeStep()'),
].join('\n');

for (const mode of ['success', 'unsupported', 'throw', 'async-error']) {
  test(`custom step speech/help remain separate when speech is ${mode}`, () => {
    let record = { helpCount: 0, speechReplayCount: 0, skipped: false };
    let spoken;
    let toast = '';
    class Utterance { constructor(text) { this.text = text; } }
    const window = mode === 'unsupported' ? {} : {
      SpeechSynthesisUtterance: Utterance,
      speechSynthesis: { cancel() {}, speak(value) { if (mode === 'throw') throw Error('blocked'); spoken = value; } },
    };
    const context = vm.createContext({ window, SpeechSynthesisUtterance: Utterance,
      activeTask: { steps: [{ name: '把髒衣服放進洗衣機' }, { name: '加入洗衣精' }] }, stepIndex: 1,
      updateCurrentStep: (mutator) => { record = mutator(record); },
      setHelpFeedback() {}, setToast(message) { toast = message; },
    });
    vm.runInContext(`${voiceCode}\nhandleHelp();`, context);
    assert.equal(record.helpCount, 1);
    assert.equal(record.speechReplayCount, 0);
    assert.equal(record.independenceLevel, 3);
    if (spoken) assert.equal(spoken.text, '不好意思，我需要幫忙。我現在正在做：加入洗衣精。');
    if (mode === 'async-error') spoken.onerror({ error: 'synthesis-failed' });
    assert.equal(Boolean(toast), mode !== 'success');
    vm.runInContext('handleSpeech();', context);
    assert.equal(record.helpCount, 1);
    assert.equal(record.speechReplayCount, 1);
    if (spoken) assert.equal(spoken.text, '加入洗衣精。');
  });
}

test('legacy raw JSON is backed up before migration, including malformed JSON', () => {
  const code = functionCode('function loadStore()', 'function createStepRecord(');
  for (const raw of ['{broken json', JSON.stringify({ reminderTime: '20:30', sessions: [] })]) {
    const values = new Map([[STORAGE_KEY, raw]]);
    const context = vm.createContext({ STORAGE_KEY, migrateData, localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
    const store = vm.runInContext(`${code}\nloadStore();`, context);
    assert.equal(values.get(`${STORAGE_KEY}_backup_v1`), raw);
    assert.equal(store.version, 2);
    assert.equal(store.tasks.length, 1);
  }
});

test('deleting a task removes its scheduled/queued reminders but keeps other tasks and all history', () => {
  const code = functionCode('function deleteTask(', 'function cancelHold()');
  const removed = { id: 'laundry', name: '洗衣服' };
  const kept = { id: 'schoolbag', name: '書包' };
  const history = [{ taskId: 'laundry' }];
  let tasks = [removed, kept];
  let reminders = [{ taskId: 'laundry' }, { taskId: 'schoolbag' }];
  let queue = [...reminders];
  let deletingTask = removed;
  const context = vm.createContext({ tasks, sessions: history, activeSession: null,
    setTasks: (value) => { tasks = value; }, setSelectedTaskId() {}, setSettingsTaskId() {}, setSettingsOpen() {},
    setReminders: (mutator) => { reminders = mutator(reminders); }, setReminderQueue: (mutator) => { queue = mutator(queue); },
    setDeletingTask: (value) => { deletingTask = value; }, setToast() {}, task: removed,
  });
  vm.runInContext(`${code}\ndeleteTask(task);`, context);
  assert.deepEqual(tasks, [kept]);
  assert.deepEqual(reminders, [{ taskId: 'schoolbag' }]);
  assert.deepEqual(queue, [{ taskId: 'schoolbag' }]);
  assert.equal(history.length, 1);
  assert.equal(deletingTask, null);
});

test('task flow completes twelve custom steps and records the task snapshot', () => {
  const code = [
    functionCode('function createStepRecord(', 'function getIndependenceLevel('),
    functionCode('function getIndependenceLevel(', 'function secondsBetween('),
    functionCode('function secondsBetween(', 'function formatSeconds('),
    functionCode('function completeStep()', 'function setDailyReminder()'),
  ].join('\n');
  const task = { id: 'long-task', name: '十二步工作', steps: Array.from({ length: 12 }, (_, index) => ({ id: `step-${index}`, name: `步驟 ${index + 1}` })) };
  let saved = [];
  let view = 'task';
  const context = vm.createContext({ activeTask: task, stepIndex: 0,
    activeSession: { id: 'session', taskId: task.id, taskName: task.name, totalSteps: 12, startedAt: new Date().toISOString(), completedAt: null, steps: [] },
    setHelpFeedback() {}, setActiveSession(value) { context.activeSession = value; },
    setStepIndex(mutator) { context.stepIndex = mutator(context.stepIndex); },
    setSessions(mutator) { saved = mutator(saved); }, setView(value) { view = value; },
  });
  vm.runInContext(`${code}\nactiveSession.steps = [createStepRecord(activeTask.steps[0])];`, context);
  for (let index = 0; index < 12; index++) vm.runInContext('completeStep();', context);
  assert.equal(view, 'complete');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].taskId, task.id);
  assert.equal(saved[0].totalSteps, 12);
  assert.equal(saved[0].steps.length, 12);
  assert.ok(saved[0].steps.every((step) => step.completed && step.stepEndTime));
  assert.equal(saved[0].steps[11].stepName, '步驟 12');
});
