"use client";

import { useEffect, useState } from "react";

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
      <h2>Tasks</h2>
      {loading ? <p className="status">Loading tasks…</p> : null}
      {error ? <p className="status error">{error}</p> : null}
      {!loading && tasks.length === 0 ? (
        <p className="status">No tasks yet.</p>
      ) : null}
      {!loading && tasks.length > 0 ? (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.task_id}>
              <strong>{task.title}</strong>
              <span className="task-status">{task.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
