import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * Nav labels are deliberately unlike demo-web's (no Products/Cart/Login nouns), so codegen's
 * hardcoded nav-link keyword list cannot recognise them.
 */
export default function Navbar() {
  const { user, signOut } = useAuth();

  return (
    <header className="navbar">
      <Link to="/" className="brand">
        TaskFlow
      </Link>

      <nav aria-label="Main">
        <NavLink to="/">Dashboard</NavLink>
        <NavLink to="/projects">Projects</NavLink>
        <NavLink to="/team">Team</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>

      <div className="nav-account">
        {user ? (
          <>
            <span className="who">{user.displayName}</span>
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          </>
        ) : (
          <Link to="/login" className="nav-signin">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
