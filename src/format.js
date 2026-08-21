import { formatDue, isOverdue } from './parse.js';
import { formatBigTimer } from './timer.js';

export function statusMark(task) {
  if (task.status === 'COMPLETE') return '[x]';
  if (task.status === 'ACTIVE') return '[▶]';
  if (task.status === 'HOLD') return '[⏸]';
  return '[ ]';
}

export function taskParts(task) {
  const done = task.status === 'COMPLETE';
  const active = task.status === 'ACTIVE';
  const hold = task.status === 'HOLD';
  const parts = {
    mark: statusMark(task),
    code: task.code || `#${task.id}`,
    text: task.text,
    priority: task.priority ? '!'.repeat(task.priority) : null,
    project: task.project ? `+${task.project}` : null,
    due: task.due ? `@${formatDue(task.due)}` : null,
    dueOverdue: task.due && isOverdue(task.due) && !done,
    holdLabel: hold && task.timeSpent > 0 ? `hold: ${formatBigTimer(task.timeSpent)}` : null,
    state: { done, active, hold },
  };
  return parts;
}
