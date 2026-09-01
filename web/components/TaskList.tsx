"use client";

import { useCallback, useEffect, useState } from "react";
import { getTask, listTasks, type Task } from "../lib/api";

type TaskListProps = {
  userId: string;
};

export function TaskList({ userId }: TaskListProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Task | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadTasks() {
      setLoading(true);
      try {
        const items = await listTasks(userId);
        if (!cancelled) {
          setTasks(items);
          setListError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setTasks([]);
          setListError(error instanceof Error ? error.message : "unknown error");
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
  }, [userId]);

  const selectTask = useCallback(async (taskId: string) => {
    setSelectedId(taskId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const loaded = await getTask(taskId);
      setDetail(loaded);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "unknown error");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  return (
    <section className="task-panel panel" aria-labelledby="task-list-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Household record</p>
          <h2 id="task-list-heading">Open work</h2>
        </div>
        <span className="count-badge">{tasks.length}</span>
      </div>
      {loading ? (
        <p className="status">Loading tasks...</p>
      ) : listError ? (
        <p className="status error">Could not load tasks: {listError}</p>
      ) : tasks.length === 0 ? (
        <p className="status">No tracked work yet. Ask a teammate to keep the thread.</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.task_id}>
              <button
                type="button"
                className={`task${selectedId === task.task_id ? " selected" : ""}`}
                onClick={() => void selectTask(task.task_id)}
              >
                <span className="task-title">{task.title}</span>
                <span className="task-meta">{task.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedId ? (
        <div className="task-detail">
          <h3>Evidence and status</h3>
          {detailLoading ? (
            <p className="status">Loading task...</p>
          ) : detailError ? (
            <p className="status error">Could not load task: {detailError}</p>
          ) : detail ? (
            <dl className="task-detail-fields">
              <div>
                <dt>Title</dt>
                <dd>{detail.title}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{detail.status}</dd>
              </div>
              {detail.evidence ? (
                <div>
                  <dt>Evidence</dt>
                  <dd>{detail.evidence}</dd>
                </div>
              ) : null}
              {detail.close_reason ? (
                <div>
                  <dt>Close reason</dt>
                  <dd>{detail.close_reason}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
