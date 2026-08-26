import { useState } from 'react';
import { LABELS, MEMBERS, PROJECTS } from '../services/mockData';

/**
 * The richest form in the app, on purpose: textarea, two selects, a date input and a checkbox group —
 * widget kinds demo-web never exercises.
 */
export default function TaskNew() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState(PROJECTS[0].name);
  const [assignee, setAssignee] = useState(MEMBERS[0].name);
  const [priority, setPriority] = useState('Medium');
  const [dueDate, setDueDate] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [created, setCreated] = useState('');

  function toggleLabel(label: string) {
    setLabels((prev) => (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setCreated('');
      setError('Task title is required');
      return;
    }
    setError('');
    setCreated(`Task created in ${project}`);
  }

  return (
    <section className="narrow">
      <h1>Create Task</h1>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="title">Task title</label>
        <input id="title" name="title" value={title} onChange={(e) => setTitle(e.target.value)} />

        <label htmlFor="description">Description</label>
        <textarea
          id="description"
          name="description"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <label htmlFor="project">Project</label>
        <select id="project" name="project" value={project} onChange={(e) => setProject(e.target.value)}>
          {PROJECTS.map((p) => (
            <option key={p.id}>{p.name}</option>
          ))}
        </select>

        <label htmlFor="assignee">Assignee</label>
        <select
          id="assignee"
          name="assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        >
          {MEMBERS.map((m) => (
            <option key={m.id}>{m.name}</option>
          ))}
        </select>

        <label htmlFor="priority">Priority</label>
        <select
          id="priority"
          name="priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        >
          <option>Low</option>
          <option>Medium</option>
          <option>High</option>
          <option>Urgent</option>
        </select>

        <label htmlFor="due-date">Due date</label>
        <input
          id="due-date"
          name="dueDate"
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />

        <fieldset>
          <legend>Labels</legend>
          {LABELS.map((label) => (
            <label key={label} className="check">
              <input
                type="checkbox"
                name="labels"
                value={label}
                checked={labels.includes(label)}
                onChange={() => toggleLabel(label)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {created && (
          <p className="success" role="status">
            {created}
          </p>
        )}

        <button type="submit">Create task</button>
      </form>
    </section>
  );
}
