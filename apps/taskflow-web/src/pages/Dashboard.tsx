import { Link } from 'react-router-dom';
import { countByStatus, PROJECTS, TASKS } from '../services/mockData';
import { useAuth } from '../contexts/AuthContext';

export default function Dashboard() {
  const { user } = useAuth();
  const dueSoon = TASKS.filter((t) => t.status !== 'Done').slice(0, 3);

  return (
    <section>
      <h1>Your Work</h1>
      <p className="lede">
        {user
          ? `Signed in as ${user.displayName}. Here is what needs attention.`
          : 'A snapshot of everything in flight across your workspace.'}
      </p>

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Open</span>
          <span className="tile-value">{countByStatus('Open')}</span>
        </div>
        <div className="tile">
          <span className="tile-label">In Progress</span>
          <span className="tile-value">{countByStatus('In Progress')}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Done</span>
          <span className="tile-value">{countByStatus('Done')}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Active Projects</span>
          <span className="tile-value">{PROJECTS.filter((p) => p.status === 'Active').length}</span>
        </div>
      </div>

      <h2>Due soon</h2>
      <ul className="due-list">
        {dueSoon.map((t) => (
          <li key={t.id}>
            <span className="task-title">{t.title}</span>
            <span className="muted">
              {t.assignee} · due {t.dueDate}
            </span>
          </li>
        ))}
      </ul>

      <div className="row-actions">
        <Link className="button" to="/tasks/new">
          Add Task
        </Link>
        <Link className="button secondary" to="/projects">
          Browse Projects
        </Link>
      </div>
    </section>
  );
}
