import React from 'react';
import { Routes, Route, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../../components/Button';
import Orders from './Orders';
import Profile from './Profile';

const Account: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  if (!user) {
    return (
      <div className="account-page">
        <div className="account-login-prompt">
          <h2>Please Login</h2>
          <p>You need to be logged in to view your account.</p>
          <div className="account-actions">
            <Button onClick={() => navigate('/auth/login')}>Login</Button>
            <Button variant="outline" onClick={() => navigate('/auth/register')}>
              Sign Up
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="account-page">
      <div className="account-container">
        {/* Sidebar */}
        <aside className="account-sidebar">
          <div className="account-user-info">
            <div className="user-avatar">
              {user.avatar ? (
                <img src={user.avatar} alt={user.name} />
              ) : (
                <span>{user.name.charAt(0).toUpperCase()}</span>
              )}
            </div>
            <h3>{user.name}</h3>
            <p>{user.email}</p>
          </div>

          <nav className="account-nav">
            <Link to="/account" className="nav-item">
              📊 Dashboard
            </Link>
            <Link to="/account/orders" className="nav-item">
              📦 Orders
            </Link>
            <Link to="/account/profile" className="nav-item">
              👤 Profile
            </Link>
            <Link to="/account/addresses" className="nav-item">
              📍 Addresses
            </Link>
            <button onClick={handleLogout} className="nav-item nav-logout">
              🚪 Logout
            </button>
          </nav>
        </aside>

        {/* Main Content */}
        <main className="account-main">
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="orders" element={<Orders />} />
            <Route path="profile" element={<Profile />} />
            <Route path="*" element={<Dashboard />} />
          </Routes>
        </main>
      </div>
    </div>
  );
};

const Dashboard: React.FC = () => {
  const { user } = useAuth();

  return (
    <div className="account-dashboard">
      <h1>Welcome back, {user?.name}!</h1>

      <div className="dashboard-stats">
        <div className="stat-card">
          <div className="stat-icon">📦</div>
          <div className="stat-info">
            <span className="stat-value">2</span>
            <span className="stat-label">Total Orders</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">🚚</div>
          <div className="stat-info">
            <span className="stat-value">1</span>
            <span className="stat-label">In Transit</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">⭐</div>
          <div className="stat-info">
            <span className="stat-value">5</span>
            <span className="stat-label">Reviews Written</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">🎁</div>
          <div className="stat-info">
            <span className="stat-value">$0</span>
            <span className="stat-label">Reward Points</span>
          </div>
        </div>
      </div>

      <div className="dashboard-sections">
        <section className="dashboard-section">
          <div className="section-header">
            <h2>Recent Orders</h2>
            <Link to="/account/orders" className="view-all">
              View All →
            </Link>
          </div>
          <div className="recent-orders">
            <div className="order-summary">
              <div className="order-info">
                <span className="order-id">Order #ORD-001</span>
                <span className="order-date">January 10, 2024</span>
              </div>
              <span className="order-status status-delivered">Delivered</span>
              <span className="order-total">$4,047.84</span>
            </div>
            <div className="order-summary">
              <div className="order-info">
                <span className="order-id">Order #ORD-002</span>
                <span className="order-date">January 18, 2024</span>
              </div>
              <span className="order-status status-shipped">Shipped</span>
              <span className="order-total">$386.91</span>
            </div>
          </div>
        </section>

        <section className="dashboard-section">
          <div className="section-header">
            <h2>Account Information</h2>
            <Link to="/account/profile" className="view-all">
              Edit →
            </Link>
          </div>
          <div className="account-info-preview">
            <div className="info-row">
              <span className="info-label">Name:</span>
              <span className="info-value">{user?.name}</span>
            </div>
            <div className="info-row">
              <span className="info-label">Email:</span>
              <span className="info-value">{user?.email}</span>
            </div>
            <div className="info-row">
              <span className="info-label">Member Since:</span>
              <span className="info-value">{user?.createdAt}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default Account;
