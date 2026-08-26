import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';

const Profile: React.FC = () => {
  const { user, updateProfile } = useAuth();
  const { showToast } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: user?.name || '',
    email: user?.email || '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSave = async () => {
    setIsLoading(true);
    try {
      await updateProfile({
        name: formData.name,
        email: formData.email,
      });
      showToast('Profile updated successfully!', 'success');
      setIsEditing(false);
    } catch (error) {
      showToast('Failed to update profile', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangePassword = async () => {
    if (formData.newPassword !== formData.confirmPassword) {
      showToast('New passwords do not match', 'error');
      return;
    }

    if (formData.newPassword.length < 6) {
      showToast('Password must be at least 6 characters', 'error');
      return;
    }

    setIsLoading(true);
    try {
      // In a real app, this would call an API to change password
      await new Promise((resolve) => setTimeout(resolve, 500));
      showToast('Password changed successfully!', 'success');
      setFormData((prev) => ({
        ...prev,
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      }));
    } catch (error) {
      showToast('Failed to change password', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="profile-page">
      <h1>Profile Settings</h1>

      <div className="profile-sections">
        {/* Personal Information */}
        <section className="profile-section">
          <div className="section-header">
            <h2>Personal Information</h2>
            {!isEditing ? (
              <Button variant="ghost" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
            ) : null}
          </div>

          <div className="profile-avatar">
            {user?.avatar ? (
              <img src={user.avatar} alt={user.name} />
            ) : (
              <div className="avatar-placeholder">
                {user?.name.charAt(0).toUpperCase()}
              </div>
            )}
            <button className="change-avatar-btn">Change Avatar</button>
          </div>

          <div className="form-grid">
            <Input
              label="Full Name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              disabled={!isEditing}
            />
            <Input
              label="Email"
              name="email"
              type="email"
              value={formData.email}
              onChange={handleChange}
              disabled={!isEditing}
            />
          </div>

          {isEditing && (
            <div className="form-actions">
              <Button onClick={handleSave} isLoading={isLoading}>
                Save Changes
              </Button>
              <Button variant="ghost" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
            </div>
          )}
        </section>

        {/* Change Password */}
        <section className="profile-section">
          <h2>Change Password</h2>
          <div className="form-grid">
            <Input
              label="Current Password"
              name="currentPassword"
              type="password"
              value={formData.currentPassword}
              onChange={handleChange}
              placeholder="••••••••"
            />
            <Input
              label="New Password"
              name="newPassword"
              type="password"
              value={formData.newPassword}
              onChange={handleChange}
              placeholder="••••••••"
              helperText="At least 6 characters"
            />
          </div>
          <Input
            label="Confirm New Password"
            name="confirmPassword"
            type="password"
            value={formData.confirmPassword}
            onChange={handleChange}
            placeholder="••••••••"
          />
          <div className="form-actions">
            <Button onClick={handleChangePassword} isLoading={isLoading}>
              Change Password
            </Button>
          </div>
        </section>

        {/* Account Preferences */}
        <section className="profile-section">
          <h2>Account Preferences</h2>
          <div className="preferences-list">
            <div className="preference-item">
              <div className="preference-info">
                <span className="preference-label">Email Notifications</span>
                <span className="preference-description">
                  Receive emails about order updates and promotions
                </span>
              </div>
              <label className="toggle-switch">
                <input type="checkbox" defaultChecked />
                <span className="toggle-slider"></span>
              </label>
            </div>
            <div className="preference-item">
              <div className="preference-info">
                <span className="preference-label">SMS Notifications</span>
                <span className="preference-description">
                  Receive SMS about order status changes
                </span>
              </div>
              <label className="toggle-switch">
                <input type="checkbox" />
                <span className="toggle-slider"></span>
              </label>
            </div>
            <div className="preference-item">
              <div className="preference-info">
                <span className="preference-label">Newsletter</span>
                <span className="preference-description">
                  Subscribe to our weekly newsletter
                </span>
              </div>
              <label className="toggle-switch">
                <input type="checkbox" defaultChecked />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>
        </section>

        {/* Danger Zone */}
        <section className="profile-section danger-zone">
          <h2>Danger Zone</h2>
          <p>
            Once you delete your account, there is no going back. Please be
            certain.
          </p>
          <Button variant="danger">Delete Account</Button>
        </section>
      </div>
    </div>
  );
};

export default Profile;
