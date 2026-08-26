import React from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/Button';

const Error404: React.FC = () => {
  return (
    <div className="page-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', textAlign: 'center' }}>
      <h1 style={{ fontSize: '4rem', marginBottom: '1rem', color: 'var(--color-primary)' }}>404</h1>
      <h2 style={{ fontSize: '2rem', marginBottom: '2rem' }}>Page Not Found</h2>
      <p style={{ marginBottom: '2rem', color: 'var(--color-text-light)', maxWidth: '400px' }}>
        The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.
      </p>
      <Link to="/">
        <Button size="lg" data-testid="home-button">Return to Home</Button>
      </Link>
    </div>
  );
};

export default Error404;
