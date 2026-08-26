import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../contexts/CartContext';
import { useAuth } from '../contexts/AuthContext';

export const Navbar: React.FC = () => {
  const { totalItems } = useCart();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = React.useState('');
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/products?search=${encodeURIComponent(searchQuery)}`);
      setSearchQuery('');
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <nav className="navbar">
      <div className="navbar-container">
        <div className="navbar-left">
          <Link to="/" className="navbar-logo" data-testid="navbar-logo">
            <span className="logo-icon">⚡</span>
            <span className="logo-text">TechStore</span>
          </Link>

          <form className="navbar-search" onSubmit={handleSearch} data-testid="navbar-search">
            <input
              type="text"
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
              data-testid="search-input"
            />
            <button type="submit" className="search-button" aria-label="Search" data-testid="search-button">
              🔍
            </button>
          </form>
        </div>

        <div className="navbar-right">
          <Link to="/products" className="nav-link" data-testid="nav-products">
            Products
          </Link>

          <Link to="/cart" className="nav-link nav-cart" data-testid="nav-cart">
            <span className="cart-icon" aria-label="Shopping Cart">🛒</span>
            {totalItems > 0 && (
              <span className="cart-badge" data-testid="cart-badge">{totalItems}</span>
            )}
          </Link>

          {user ? (
            <div className="user-menu" data-testid="user-menu">
              <button
                className="user-avatar-btn"
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                aria-label="User menu"
                data-testid="user-avatar-btn"
              >
                {user.avatar ? (
                  <img src={user.avatar} alt={user.name} />
                ) : (
                  <span className="avatar-placeholder">
                    {user.name.charAt(0).toUpperCase()}
                  </span>
                )}
              </button>

              {isMenuOpen && (
                <div className="user-dropdown" data-testid="user-dropdown">
                  <div className="dropdown-header">
                    <span className="dropdown-name">{user.name}</span>
                    <span className="dropdown-email">{user.email}</span>
                  </div>
                  <hr className="dropdown-divider" />
                  <Link to="/account" className="dropdown-item" onClick={() => setIsMenuOpen(false)} data-testid="dropdown-account">
                    My Account
                  </Link>
                  <Link to="/account/orders" className="dropdown-item" onClick={() => setIsMenuOpen(false)} data-testid="dropdown-orders">
                    Orders
                  </Link>
                  {user.role === 'admin' && (
                    <Link to="/admin" className="dropdown-item" onClick={() => setIsMenuOpen(false)} data-testid="dropdown-admin">
                      Admin Panel
                    </Link>
                  )}
                  <hr className="dropdown-divider" />
                  <button className="dropdown-item dropdown-logout" onClick={handleLogout} data-testid="dropdown-logout">
                    Logout
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="auth-links" data-testid="auth-links">
              <Link to="/auth/login" className="nav-link" data-testid="nav-login">
                Login
              </Link>
              <Link to="/auth/register" className="nav-link nav-btn" data-testid="nav-register">
                Sign Up
              </Link>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
};
