import { useState } from 'react';
import Modal from '../components/Modal';
import { MEMBERS } from '../services/mockData';

export default function Team() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('Member');
  const [invited, setInvited] = useState('');
  const [error, setError] = useState('');

  function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes('@')) {
      setError('Enter a valid email address');
      return;
    }
    setError('');
    setInvited(`Invitation sent to ${email}`);
    setOpen(false);
    setEmail('');
  }

  return (
    <section>
      <h1>Team</h1>
      <p className="lede">Everyone with access to this workspace.</p>

      {invited && (
        <p className="success" role="status">
          {invited}
        </p>
      )}

      <table>
        <caption>Workspace members</caption>
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Open tasks</th>
          </tr>
        </thead>
        <tbody>
          {MEMBERS.map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td>
              <td>{m.email}</td>
              <td>{m.role}</td>
              <td>{m.openTasks}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row-actions">
        <button type="button" onClick={() => setOpen(true)}>
          Invite member
        </button>
      </div>

      {open && (
        <Modal title="Invite member" onClose={() => setOpen(false)}>
          <form onSubmit={sendInvite} noValidate>
            <label htmlFor="invite-email">Work email</label>
            <input
              id="invite-email"
              name="inviteEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <label htmlFor="invite-role">Role</label>
            <select
              id="invite-role"
              name="inviteRole"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option>Admin</option>
              <option>Member</option>
              <option>Viewer</option>
            </select>

            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}

            <div className="row-actions">
              <button type="submit">Send invite</button>
              <button type="button" className="secondary" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
