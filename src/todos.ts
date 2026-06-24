import { invoke } from "@tauri-apps/api/core";

export interface Todo {
  id: number;
  projectId: string;
  text: string;
  done: boolean;
  position: number;
  priority: number | null;
  dueDate: string | null;
  note: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface TodoPatch {
  text?: string;
  priority?: number | null;
  dueDate?: string | null;
  note?: string | null;
}

export const todoList = (projectId: string) =>
  invoke<Todo[]>("todo_list", { projectId });
export const todoAdd = (projectId: string, text: string) =>
  invoke<Todo>("todo_add", { projectId, text });
export const todoToggle = (id: number) => invoke<Todo>("todo_toggle", { id });
export const todoDelete = (id: number) => invoke<void>("todo_delete", { id });
export const todoReorder = (id: number, position: number) =>
  invoke<void>("todo_reorder", { id, position });
export const todoUpdate = (id: number, patch: TodoPatch) =>
  invoke<Todo>("todo_update", { id, patch });
