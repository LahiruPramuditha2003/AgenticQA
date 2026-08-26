import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PROJECTS } from '../services/mockData';
import type { Project } from '../types';

type SortKey = 'name' | 'owner' | 'updated';

/**
 * Deliberate design note (G1.1): the filter box below is a genuine, ubiquitous UI element — and it is
 * exactly what trips AgenticQA's hardcoded `ensureProductsNavigation` rule, which injects `goto /products`
 * whenever it sees a search-like fill. `/products` does not exist here. That failure is the point: it is
 * limitation L1 made measurable, and G3 is what fixes it.
 */
export default function Projects() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('All');
  const [sortKey, setSortKey] = useState<SortKey>('name');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = PROJECTS.filter((p) => {
      const matchesQuery = !q || p.name.toLowerCase().includes(q) || p.owner.toLowerCase().includes(q);
      const matchesStatus = status === 'All' || p.status === status;
      return matchesQuery && matchesStatus;
    });
    const key: keyof Project = sortKey;
    return [...filtered].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  }, [query, status, sortKey]);

  return (
    <section>
      <h1>Projects</h1>

      <div className="toolbar">
        <div className="field">
          <label htmlFor="project-filter">Filter projects</label>
          <input
            id="project-filter"
            name="projectFilter"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter projects..."
          />
        </div>

        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option>All</option>
            <option>Active</option>
            <option>Paused</option>
            <option>Archived</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="sort">Sort by</label>
          <select
            id="sort"
            name="sort"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
          >
            <option value="name">Name</option>
            <option value="owner">Owner</option>
            <option value="updated">Last updated</option>
          </select>
        </div>

        <Link className="button" to="/tasks/new">
          New Project
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="empty">No projects match your filters</p>
      ) : (
        <table>
          <caption>Workspace projects</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Owner</th>
              <th scope="col">Status</th>
              <th scope="col">Open tasks</th>
              <th scope="col">Last updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/projects/${p.id}`}>{p.name}</Link>
                </td>
                <td>{p.owner}</td>
                <td>{p.status}</td>
                <td>{p.openTasks}</td>
                <td>{p.updated}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
