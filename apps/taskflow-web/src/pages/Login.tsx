import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/** Route is `/login` — deliberately NOT `/auth/login`, so demo-web's hardcoded route hints miss. */
export default function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter both your email and password');
      return;
    }
    if (signIn(email, password)) {
      setError('');
      navigate('/');
      return;
    }
    setError('Those credentials were not recognised');
  }

  return (
    <section className="narrow">
      <h1>Sign in to TaskFlow</h1>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button type="submit">Sign in</button>
      </form>
    </section>
  );
}
