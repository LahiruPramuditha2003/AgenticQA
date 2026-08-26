import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { CartProvider } from './contexts/CartContext';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { Navbar } from './components/Navbar';
import Home from './pages/Home';
import Products from './pages/products/Products';
import ProductDetail from './pages/products/ProductDetail';
import Cart from './pages/checkout/Cart';
import Checkout from './pages/checkout/Checkout';
import Login from './pages/auth/Login';
import Register from './pages/auth/Register';
import Account from './pages/user/Account';
import Admin from './pages/admin/Admin';
import ForgotPassword from './pages/auth/ForgotPassword';
import Error404 from './pages/Error404';
import './App.css';

// Simple placeholder component for missing pages
const PlaceholderPage: React.FC<{ title: string }> = ({ title }) => (
  <div style={{ padding: '4rem 2rem', maxWidth: '800px', margin: '0 auto' }}>
    <h1>{title}</h1>
    <p>This page is under construction.</p>
    <a href="/" style={{ color: '#3b82f6', textDecoration: 'underline' }}>
      Return to Home
    </a>
  </div>
);

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <CartProvider>
          <ToastProvider>
            <div className="app">
              <Navbar />
              <main className="main-content">
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/products" element={<Products />} />
                  <Route path="/products/:id" element={<ProductDetail />} />
                  <Route path="/cart" element={<Cart />} />
                  <Route path="/checkout" element={<Checkout />} />
                  <Route path="/auth/login" element={<Login />} />
                  <Route path="/auth/register" element={<Register />} />
                  <Route path="/auth/forgot-password" element={<ForgotPassword />} />
                  <Route path="/account/*" element={<Account />} />
                  <Route path="/admin/*" element={<Admin />} />
                  {/* Footer links */}
                  <Route path="/contact" element={<PlaceholderPage title="Contact Us" />} />
                  <Route path="/faq" element={<PlaceholderPage title="Frequently Asked Questions" />} />
                  <Route path="/shipping" element={<PlaceholderPage title="Shipping Information" />} />
                  <Route path="/privacy" element={<PlaceholderPage title="Privacy Policy" />} />
                  <Route path="/terms" element={<PlaceholderPage title="Terms of Service" />} />
                  <Route path="/returns" element={<PlaceholderPage title="Return Policy" />} />
                  {/* Catch-all 404 */}
                  <Route path="*" element={<Error404 />} />
                </Routes>
              </main>
              <footer className="footer">
                <div className="footer-container">
                  <div className="footer-section">
                    <h4>TechStore</h4>
                    <p>Your destination for the latest technology and electronics.</p>
                  </div>
                  <div className="footer-section">
                    <h4>Shop</h4>
                    <Link to="/products">All Products</Link>
                    <Link to="/products?sort=newest">New Arrivals</Link>
                    <Link to="/products?sort=popular">Featured</Link>
                  </div>
                  <div className="footer-section">
                    <h4>Support</h4>
                    <Link to="/contact">Contact Us</Link>
                    <Link to="/faq">FAQ</Link>
                    <Link to="/shipping">Shipping Info</Link>
                  </div>
                  <div className="footer-section">
                    <h4>Legal</h4>
                    <Link to="/privacy">Privacy Policy</Link>
                    <Link to="/terms">Terms of Service</Link>
                    <Link to="/returns">Return Policy</Link>
                  </div>
                </div>
                <div className="footer-bottom">
                  <p>&copy; 2024 TechStore. All rights reserved.</p>
                </div>
              </footer>
            </div>
          </ToastProvider>
        </CartProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
