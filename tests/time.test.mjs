import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime12Hour, getTime12Parts, to24Hour, formatSessionDateTime, migrateData, scheduleTodayAt } from '../src/data.ts';

test('all requested examples including midnight and noon display correctly', () => {
  const examples = {
    '07:00': '上午 7:00', '09:30': '上午 9:30',
    '12:00': '下午 12:00', '13:30': '下午 1:30', '21:30': '下午 9:30',
    '00:00': '上午 12:00', '00:30': '上午 12:30', '12:30': '下午 12:30',
  };
  for (const [stored, display] of Object.entries(examples)) assert.equal(formatTime12Hour(stored), display);
});

test('every minute of the day round-trips through the 12-hour picker', () => {
  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute < 60; minute++) {
      const stored = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const parts = getTime12Parts(stored);
      assert.equal(to24Hour(parts.period, parts.hour, parts.minute), stored);
      assert.ok(parts.hour >= 1 && parts.hour <= 12);
    }
  }
});

test('invalid picker values cannot silently change reminder time', () => {
  assert.throws(() => to24Hour('下午', 0, 30), RangeError);
  assert.throws(() => to24Hour('上午', 13, 30), RangeError);
  assert.throws(() => to24Hour('上午', 9, 60), RangeError);
  assert.equal(formatTime12Hour('invalid'), '--');
});

test('legacy 21:30 remains unchanged internally and schedules the same instant', () => {
  const state = migrateData({ reminderTime: '21:30', sessions: [] });
  const time = state.tasks[0].reminderTime;
  assert.equal(time, '21:30');
  assert.equal(formatTime12Hour(time), '下午 9:30');
  const now = new Date(2026, 9, 13, 8, 0);
  assert.equal(scheduleTodayAt(to24Hour('下午', 9, 30), now), scheduleTodayAt(time, now));
});

test('analysis timestamps use explicit 12-hour time in the device timezone', () => {
  assert.ok(formatSessionDateTime(new Date(2026, 9, 13, 21, 32).toISOString()).endsWith('下午 9:32'));
  assert.ok(formatSessionDateTime(new Date(2026, 9, 13, 0, 30).toISOString()).endsWith('上午 12:30'));
});
