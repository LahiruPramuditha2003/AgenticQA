import { Link, useParams } from 'react-router-dom';
import { projectById, tasksForProject } from '../services/mockData';

export default function ProjectDetail() {
  const { projectId } = useParams();
  const project = projectId ? projectById(projectId) : undefined;

  if (!project) {
    return (
      <section>
        <h1>Project not found</h1>
        <p className="lede">That project does not exist in this workspace.</p>
        <Link className="button" to="/projects">
          Back to Projects
        </Link>
      </section>
    );
  }

  const tasks = tasksForProject(project.id);

  return (
    <section>
      <h1>{project.name}</h1>
      <p className="lede">
        Owned by {project.owner} · {project.status} · updated {project.updated}
      </p>

      <h2>Tasks</h2>
      {tasks.length === 0 ? (
        <p className="empty">This project has no tasks yet</p>
      ) : (
        <table>
          <caption>Tasks in {project.name}</caption>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Assignee</th>
              <th scope="col">Status</th>
              <th scope="col">Priority</th>
              <th scope="col">Due</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td>{t.assignee}</td>
                <td>{t.status}</td>
                <td>{t.priority}</td>
                <td>{t.dueDate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row-actions">
        <Link className="button" to="/tasks/new">
          Add Task
        </Link>
        <Link className="button secondary" to="/projects">
          Back to Projects
        </Link>
      </div>
    </section>
  );
}
