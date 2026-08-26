export type TaskStatus = 'Open' | 'In Progress' | 'Done';
export type TaskPriority = 'Low' | 'Medium' | 'High' | 'Urgent';
export type ProjectStatus = 'Active' | 'Paused' | 'Archived';
export type MemberRole = 'Admin' | 'Member' | 'Viewer';

export interface User {
  email: string;
  displayName: string;
  role: MemberRole;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: MemberRole;
  openTasks: number;
}

export interface Project {
  id: string;
  name: string;
  owner: string;
  status: ProjectStatus;
  updated: string;
  openTasks: number;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  assignee: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string;
}
