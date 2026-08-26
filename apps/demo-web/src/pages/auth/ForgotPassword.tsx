import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';

const ForgotPassword: React.FC = () => {
  const { showToast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1000));
      setSubmitted(true);
      showToast('Password reset link sent to your email', 'success');
    } catch (error) {
      showToast('Failed to request password reset', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-card">
          <h1 className="auth-title">Reset Password</h1>
          <p className="auth-subtitle">Enter your email and we will send you a reset link</p>

          {submitted ? (
            <div className="auth-success-message">
              <p>We've sent an email to <strong>{email}</strong> with instructions to reset your password.</p>
              <Button onClick={() => setSubmitted(false)} variant="outline" fullWidth style={{ marginTop: '20px' }}>
                Resend Email
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="auth-form" data-testid="forgot-password-form">
              <Input
                label="Email"
                type="email"
                name="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                data-testid="forgot-password-email"
              />

              <Button type="submit" isLoading={isLoading} fullWidth size="lg" data-testid="forgot-password-submit">
                Send Reset Link
              </Button>
            </form>
          )}

          <p className="auth-footer" style={{ marginTop: '30px' }}>
            Remember your password?{' '}
            <Link to="/auth/login" data-testid="back-to-login">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default ForgotPassword;
