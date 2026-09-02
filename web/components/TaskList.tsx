"use client";

import { useEffect, useState } from "react";

import { authErrorClassName, authStatusClassName } from "./AuthCard";
import { listTasks, type Task } from "../lib/api";
import type { ActiveOrg } from "../lib/membership-state";

type TaskListProps = {
  activeOrg: ActiveOrg;
};

export function TaskList({ activeOrg }: TaskListProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadTasks() {
      setLoading(true);
      try {
        const items = await listTasks(activeOrg);
        if (!cancelled) {
          setTasks(items);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setTasks([]);
          setError(caught instanceof Error ? caught.message : "unknown error");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void loadTasks();
    return () => {
      cancelled = true;
    };
  }, [activeOrg]);

  return (
    <>
      <h2 className="font-body text-sm font-extrabold">Tasks</h2>
      {loading ? <p className={authStatusClassName}>Loading tasks…</p> : null}
      {error ? <p className={authErrorClassName}>{error}</p> : null}
      {!loading && tasks.length === 0 ? (
        <p className={authStatusClassName}>No tasks yet.</p>
      ) : null}
      {!loading && tasks.length > 0 ? (
        <ul className="mt-2 grid gap-1.5">
          {tasks.map((task) => (
            <li
              key={task.task_id}
              className="flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2"
            >
              <strong className="font-body text-sm font-semibold">{task.title}</strong>
              <span className="font-mono text-[0.6rem] uppercase tracking-[0.08em] text-surface-foreground/60">
                {task.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
