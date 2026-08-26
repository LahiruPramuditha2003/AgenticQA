import type { Member, Project, Task } from '../types';

/** Deterministic fixtures — no randomness, so generated tests are stable across runs. */

export const PROJECTS: Project[] = [
  { id: 'apollo', name: 'Apollo Redesign', owner: 'Ada Lovelace', status: 'Active', updated: '2026-08-04', openTasks: 6 },
  { id: 'beacon', name: 'Beacon Analytics', owner: 'Grace Hopper', status: 'Active', updated: '2026-08-01', openTasks: 3 },
  { id: 'cobalt', name: 'Cobalt Migration', owner: 'Alan Turing', status: 'Paused', updated: '2026-07-22', openTasks: 2 },
  { id: 'delta', name: 'Delta Onboarding', owner: 'Ada Lovelace', status: 'Archived', updated: '2026-06-30', openTasks: 0 },
];

export const MEMBERS: Member[] = [
  { id: 'ada', name: 'Ada Lovelace', email: 'ada@taskflow.test', role: 'Member', openTasks: 5 },
  { id: 'grace', name: 'Grace Hopper', email: 'grace@taskflow.test', role: 'Admin', openTasks: 4 },
  { id: 'alan', name: 'Alan Turing', email: 'alan@taskflow.test', role: 'Member', openTasks: 2 },
  { id: 'katherine', name: 'Katherine Johnson', email: 'katherine@taskflow.test', role: 'Viewer', openTasks: 0 },
];

export const TASKS: Task[] = [
  { id: 'T-101', projectId: 'apollo', title: 'Audit the navigation hierarchy', assignee: 'Ada Lovelace', status: 'In Progress', priority: 'High', dueDate: '2026-08-12' },
  { id: 'T-102', projectId: 'apollo', title: 'Rewrite the empty-state copy', assignee: 'Alan Turing', status: 'Open', priority: 'Low', dueDate: '2026-08-19' },
  { id: 'T-103', projectId: 'apollo', title: 'Ship the colour token refresh', assignee: 'Ada Lovelace', status: 'Done', priority: 'Medium', dueDate: '2026-07-29' },
  { id: 'T-201', projectId: 'beacon', title: 'Define the retention metric', assignee: 'Grace Hopper', status: 'Open', priority: 'Urgent', dueDate: '2026-08-11' },
  { id: 'T-202', projectId: 'beacon', title: 'Backfill last quarter events', assignee: 'Grace Hopper', status: 'In Progress', priority: 'Medium', dueDate: '2026-08-15' },
  { id: 'T-301', projectId: 'cobalt', title: 'Freeze the legacy schema', assignee: 'Alan Turing', status: 'Open', priority: 'High', dueDate: '2026-09-01' },
];

export const LABELS = ['Bug', 'Feature', 'Documentation', 'Research'];

export function tasksForProject(projectId: string): Task[] {
  return TASKS.filter((t) => t.projectId === projectId);
}

export function projectById(id: string): Project | undefined {
  return PROJECTS.find((p) => p.id === id);
}

export function countByStatus(status: Task['status']): number {
  return TASKS.filter((t) => t.status === status).length;
}
