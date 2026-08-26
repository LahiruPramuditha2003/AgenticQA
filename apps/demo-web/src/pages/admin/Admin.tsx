import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../../components/Button';

const Admin: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('overview');

  // Redirect if not admin
  if (user?.role !== 'admin') {
    return (
      <div className="admin-unauthorized">
        <h2>Unauthorized</h2>
        <p>You don't have permission to access the admin panel.</p>
        <Button onClick={() => navigate('/')}>Go Home</Button>
      </div>
    );
  }

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="admin-page">
      {/* Admin Sidebar */}
      <aside className="admin-sidebar">
        <div className="admin-logo">
          <span className="logo-icon">⚡</span>
          <span className="logo-text">TechStore Admin</span>
        </div>

        <nav className="admin-nav">
          <button
            className={`nav-item ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            📊 Overview
          </button>
          <button
            className={`nav-item ${activeTab === 'products' ? 'active' : ''}`}
            onClick={() => setActiveTab('products')}
          >
            📦 Products
          </button>
          <button
            className={`nav-item ${activeTab === 'orders' ? 'active' : ''}`}
            onClick={() => setActiveTab('orders')}
          >
            🛒 Orders
          </button>
          <button
            className={`nav-item ${activeTab === 'customers' ? 'active' : ''}`}
            onClick={() => setActiveTab('customers')}
          >
            👥 Customers
          </button>
          <button
            className={`nav-item ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            📈 Analytics
          </button>
          <button
            className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            ⚙️ Settings
          </button>
        </nav>

        <div className="admin-user">
          <div className="user-info">
            <span className="user-name">{user.name}</span>
            <span className="user-role">Administrator</span>
          </div>
          <button onClick={handleLogout} className="logout-btn">
            Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="admin-main">
        {activeTab === 'overview' && <OverviewTab />}
        {activeTab === 'products' && <ProductsTab />}
        {activeTab === 'orders' && <OrdersTab />}
        {activeTab === 'customers' && <CustomersTab />}
        {activeTab === 'analytics' && <AnalyticsTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </main>
    </div>
  );
};

// Overview Tab
const OverviewTab: React.FC = () => {
  const stats = [
    { label: 'Total Revenue', value: '$48,295', change: '+12.5%', icon: '💰' },
    { label: 'Total Orders', value: '1,234', change: '+8.2%', icon: '📦' },
    { label: 'Total Customers', value: '892', change: '+15.3%', icon: '👥' },
    { label: 'Products Sold', value: '3,456', change: '+5.7%', icon: '🛍️' },
  ];

  return (
    <div className="admin-overview">
      <h1>Dashboard Overview</h1>

      <div className="stats-grid">
        {stats.map((stat) => (
          <div key={stat.label} className="stat-card">
            <div className="stat-header">
              <span className="stat-icon">{stat.icon}</span>
              <span className={`stat-change ${stat.change.startsWith('+') ? 'positive' : 'negative'}`}>
                {stat.change}
              </span>
            </div>
            <div className="stat-value">{stat.value}</div>
            <div className="stat-label">{stat.label}</div>
          </div>
        ))}
      </div>

      <div className="overview-sections">
        <div className="overview-section">
          <h2>Recent Orders</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Customer</th>
                <th>Total</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>#ORD-001</td>
                <td>John Customer</td>
                <td>$4,047.84</td>
                <td><span className="status-badge status-delivered">Delivered</span></td>
                <td>Jan 10, 2024</td>
              </tr>
              <tr>
                <td>#ORD-002</td>
                <td>Jane Smith</td>
                <td>$386.91</td>
                <td><span className="status-badge status-shipped">Shipped</span></td>
                <td>Jan 18, 2024</td>
              </tr>
              <tr>
                <td>#ORD-003</td>
                <td>Bob Wilson</td>
                <td>$1,299.00</td>
                <td><span className="status-badge status-processing">Processing</span></td>
                <td>Jan 20, 2024</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="overview-section">
          <h2>Top Products</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Sold</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>MacBook Pro 16" M3 Max</td>
                <td>Laptops</td>
                <td>124</td>
                <td>$433,876</td>
              </tr>
              <tr>
                <td>iPhone 15 Pro Max</td>
                <td>Smartphones</td>
                <td>256</td>
                <td>$307,144</td>
              </tr>
              <tr>
                <td>Sony WH-1000XM5</td>
                <td>Audio</td>
                <td>432</td>
                <td>$151,128</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// Products Tab
const ProductsTab: React.FC = () => {
  return (
    <div className="admin-products">
      <div className="admin-header">
        <h1>Products Management</h1>
        <Button>+ Add New Product</Button>
      </div>

      <div className="admin-filters">
        <input type="text" placeholder="Search products..." className="admin-search" />
        <select className="admin-select">
          <option value="">All Categories</option>
          <option value="laptops">Laptops</option>
          <option value="smartphones">Smartphones</option>
          <option value="audio">Audio</option>
        </select>
        <select className="admin-select">
          <option value="">All Status</option>
          <option value="in-stock">In Stock</option>
          <option value="low-stock">Low Stock</option>
          <option value="out-of-stock">Out of Stock</option>
        </select>
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Category</th>
            <th>Price</th>
            <th>Stock</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <div className="product-cell">
                <img src="https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=100" alt="" />
                <span>MacBook Pro 16" M3 Max</span>
              </div>
            </td>
            <td>Laptops</td>
            <td>$3,499</td>
            <td>24</td>
            <td><span className="status-badge status-in-stock">In Stock</span></td>
            <td>
              <button className="action-btn">Edit</button>
              <button className="action-btn action-delete">Delete</button>
            </td>
          </tr>
          <tr>
            <td>
              <div className="product-cell">
                <img src="https://images.unsplash.com/photo-1695048133142-1a20484d2069?w=100" alt="" />
                <span>iPhone 15 Pro Max</span>
              </div>
            </td>
            <td>Smartphones</td>
            <td>$1,199</td>
            <td>56</td>
            <td><span className="status-badge status-in-stock">In Stock</span></td>
            <td>
              <button className="action-btn">Edit</button>
              <button className="action-btn action-delete">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

// Orders Tab
const OrdersTab: React.FC = () => {
  return (
    <div className="admin-orders">
      <div className="admin-header">
        <h1>Orders Management</h1>
      </div>

      <div className="admin-filters">
        <input type="text" placeholder="Search orders..." className="admin-search" />
        <select className="admin-select">
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
        </select>
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Order ID</th>
            <th>Customer</th>
            <th>Items</th>
            <th>Total</th>
            <th>Status</th>
            <th>Date</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>#ORD-001</td>
            <td>John Customer</td>
            <td>2</td>
            <td>$4,047.84</td>
            <td><span className="status-badge status-delivered">Delivered</span></td>
            <td>Jan 10, 2024</td>
            <td>
              <button className="action-btn">View</button>
            </td>
          </tr>
          <tr>
            <td>#ORD-002</td>
            <td>Jane Smith</td>
            <td>1</td>
            <td>$386.91</td>
            <td><span className="status-badge status-shipped">Shipped</span></td>
            <td>Jan 18, 2024</td>
            <td>
              <button className="action-btn">View</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

// Customers Tab
const CustomersTab: React.FC = () => {
  return (
    <div className="admin-customers">
      <div className="admin-header">
        <h1>Customers Management</h1>
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Email</th>
            <th>Orders</th>
            <th>Total Spent</th>
            <th>Joined</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>John Customer</td>
            <td>customer@example.com</td>
            <td>2</td>
            <td>$4,434.75</td>
            <td>Jan 1, 2024</td>
            <td>
              <button className="action-btn">View</button>
            </td>
          </tr>
          <tr>
            <td>Jane Smith</td>
            <td>jane@example.com</td>
            <td>5</td>
            <td>$2,156.00</td>
            <td>Dec 15, 2023</td>
            <td>
              <button className="action-btn">View</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

// Analytics Tab
const AnalyticsTab: React.FC = () => {
  return (
    <div className="admin-analytics">
      <h1>Analytics</h1>
      <div className="analytics-placeholder">
        <p>📈 Analytics charts and graphs would appear here</p>
        <p>In a production app, this would show sales trends, customer behavior, and more.</p>
      </div>
    </div>
  );
};

// Settings Tab
const SettingsTab: React.FC = () => {
  return (
    <div className="admin-settings">
      <h1>Settings</h1>
      <div className="settings-sections">
        <div className="settings-section">
          <h2>Store Settings</h2>
          <div className="form-grid">
            <div className="input-group">
              <label className="input-label">Store Name</label>
              <input type="text" className="input" defaultValue="TechStore" />
            </div>
            <div className="input-group">
              <label className="input-label">Support Email</label>
              <input type="email" className="input" defaultValue="support@techstore.com" />
            </div>
          </div>
          <Button>Save Settings</Button>
        </div>
      </div>
    </div>
  );
};

export default Admin;
