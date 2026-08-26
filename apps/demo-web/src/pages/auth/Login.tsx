import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';

const Login: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login } = useAuth();
  const { showToast } = useToast();

  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  const redirect = searchParams.get('redirect') || '/';

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await login(formData.email, formData.password);
      showToast('Login successful!', 'success');
      navigate(redirect);
    } catch (error) {
      if (error instanceof Error) {
        showToast(error.message, 'error');
      } else {
        showToast('Login failed. Please try again.', 'error');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleDemoLogin = async (type: 'customer' | 'admin') => {
    const credentials = type === 'customer'
      ? { email: 'customer@example.com', password: 'password123' }
      : { email: 'admin@techstore.com', password: 'admin123' };
    
    setIsLoading(true);
    try {
      await login(credentials.email, credentials.password);
      showToast(`Logged in as ${type}!`, 'success');
      navigate(type === 'admin' ? '/admin' : '/account');
    } catch (error) {
      showToast('Demo login failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-card">
          <h1 className="auth-title">Welcome Back</h1>
          <p className="auth-subtitle">Sign in to your TechStore account</p>

          <form onSubmit={handleSubmit} className="auth-form" data-testid="login-form">
            <Input
              label="Email"
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="you@example.com"
              required
              data-testid="login-email"
            />

            <Input
              label="Password"
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="••••••••"
              required
              data-testid="login-password"
            />

            <div className="form-row">
              <label className="checkbox-label">
                <input type="checkbox" data-testid="login-remember" />
                Remember me
              </label>
              <Link to="/auth/forgot-password" className="forgot-link" data-testid="login-forgot">
                Forgot password?
              </Link>
            </div>

            <Button type="submit" isLoading={isLoading} fullWidth size="lg" data-testid="login-submit">
              Sign In
            </Button>
          </form>

          <div className="auth-divider">
            <span>or</span>
          </div>

          <div className="demo-login" data-testid="demo-login">
            <p className="demo-label">Demo Accounts:</p>
            <div className="demo-buttons">
              <Button
                variant="outline"
                onClick={() => handleDemoLogin('customer')}
                disabled={isLoading}
                data-testid="demo-customer-login"
              >
                👤 Customer
              </Button>
              <Button
                variant="outline"
                onClick={() => handleDemoLogin('admin')}
                disabled={isLoading}
                data-testid="demo-admin-login"
              >
                🔐 Admin
              </Button>
            </div>
          </div>

          <p className="auth-footer">
            Don't have an account?{' '}
            <Link to="/auth/register" data-testid="login-signup">Sign up</Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;
