import { useState } from 'react';
import Modal from '../components/Modal';

export default function Settings() {
  const [displayName, setDisplayName] = useState('Ada Lovelace');
  const [timezone, setTimezone] = useState('UTC');
  const [notify, setNotify] = useState(true);
  const [saved, setSaved] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState('');

  function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaved('Settings saved');
  }

  return (
    <section className="narrow">
      <h1>Settings</h1>

      <form onSubmit={onSave} noValidate>
        <label htmlFor="display-name">Display name</label>
        <input
          id="display-name"
          name="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />

        <label htmlFor="timezone">Timezone</label>
        <select
          id="timezone"
          name="timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        >
          <option>UTC</option>
          <option>Europe/London</option>
          <option>America/New_York</option>
          <option>Asia/Colombo</option>
        </select>

        <label className="check">
          <input
            type="checkbox"
            name="notify"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
          />
          Email notifications
        </label>

        {saved && (
          <p className="success" role="status">
            {saved}
          </p>
        )}

        <button type="submit">Save changes</button>
      </form>

      <div className="danger-zone">
        <h2>Danger zone</h2>
        <p className="muted">Deleting a workspace removes every project and task in it.</p>
        {deleted && (
          <p className="error" role="status">
            {deleted}
          </p>
        )}
        <button type="button" className="danger" onClick={() => setConfirming(true)}>
          Delete workspace
        </button>
      </div>

      {confirming && (
        <Modal title="Delete workspace" onClose={() => setConfirming(false)}>
          <p>This cannot be undone. Are you sure you want to delete this workspace?</p>
          <div className="row-actions">
            <button
              type="button"
              className="danger"
              onClick={() => {
                setDeleted('Workspace deletion scheduled');
                setConfirming(false);
              }}
            >
              Yes, delete it
            </button>
            <button type="button" className="secondary" onClick={() => setConfirming(false)}>
              Keep workspace
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
