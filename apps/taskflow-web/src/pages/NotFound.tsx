import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <section className="narrow">
      <h1>Page not found</h1>
      <p className="lede">The page you asked for does not exist in this workspace.</p>
      <Link className="button" to="/">
        Back to Dashboard
      </Link>
    </section>
  );
}
