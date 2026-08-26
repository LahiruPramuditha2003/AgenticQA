import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ProductCard, CategoryCard } from '../components/Card';
import { Button } from '../components/Button';
import { useCart } from '../contexts/CartContext';
import { useToast } from '../contexts/ToastContext';
import api from '../services/api';
import type { Product, Category } from '../types';

const Home: React.FC = () => {
  const navigate = useNavigate();
  const { addToCart } = useCart();
  const { showToast } = useToast();
  const [featuredProducts, setFeaturedProducts] = React.useState<Product[]>([]);
  const [newProducts, setNewProducts] = React.useState<Product[]>([]);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    loadHomeData();
  }, []);

  const loadHomeData = async () => {
    setIsLoading(true);
    try {
      const [featured, newItems, cats] = await Promise.all([
        api.products.getFeatured(),
        api.products.getNew(),
        api.categories.getAll(),
      ]);
      setFeaturedProducts(featured);
      setNewProducts(newItems);
      setCategories(cats);
    } catch (error) {
      console.error('Failed to load home data:', error);
      showToast('Failed to load products', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddToCart = async (product: Product) => {
    try {
      await addToCart({
        productId: product.id,
        name: product.name,
        price: product.price,
        image: product.images[0],
        stock: product.stock,
      });
      showToast(`${product.name} added to cart!`, 'success');
    } catch (error) {
      showToast('Failed to add to cart', 'error');
    }
  };

  return (
    <div className="home">
      {/* Hero Section */}
      <section className="hero" data-testid="hero-section">
        <div className="hero-content">
          <h1 className="hero-title" data-testid="hero-title">
            Welcome to <span className="highlight">TechStore</span>
          </h1>
          <p className="hero-subtitle" data-testid="hero-subtitle">
            Discover the latest in cutting-edge technology. From premium laptops to
            professional cameras, find everything you need to stay ahead.
          </p>
          <div className="hero-actions">
            <Button
              size="lg"
              onClick={() => navigate('/products')}
              data-testid="hero-shop-now"
            >
              Shop Now
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() => navigate('/products?sort=newest')}
              data-testid="hero-new-arrivals"
            >
              View New Arrivals
            </Button>
          </div>
        </div>
        <div className="hero-image">
          <img
            src="https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=800"
            alt="Technology"
          />
        </div>
      </section>

      {/* Categories Section */}
      <section className="section categories-section" data-testid="categories-section">
        <div className="section-header">
          <h2 className="section-title">Shop by Category</h2>
          <Link to="/products" className="section-link" data-testid="categories-view-all">
            View All →
          </Link>
        </div>
        <div className="categories-grid">
          {categories.slice(0, 6).map((category) => (
            <CategoryCard
              key={category.id}
              {...category}
              onClick={() => navigate(`/products?category=${encodeURIComponent(category.name)}`)}
            />
          ))}
        </div>
      </section>

      {/* Featured Products Section */}
      <section className="section featured-section" data-testid="featured-section">
        <div className="section-header">
          <h2 className="section-title">Featured Products</h2>
          <Link to="/products?sort=popular" className="section-link" data-testid="featured-view-all">
            View All →
          </Link>
        </div>
        {isLoading ? (
          <div className="loading-grid">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="product-card-loading"></div>
            ))}
          </div>
        ) : (
          <div className="products-grid">
            {featuredProducts.map((product) => (
              <ProductCard
                key={product.id}
                {...product}
                image={product.images[0]}
                onClick={() => navigate(`/products/${product.id}`)}
                onAddToCart={() => handleAddToCart(product)}
              />
            ))}
          </div>
        )}
      </section>

      {/* New Arrivals Section */}
      <section className="section new-section" data-testid="new-arrivals-section">
        <div className="section-header">
          <h2 className="section-title">New Arrivals</h2>
          <Link to="/products?sort=newest" className="section-link" data-testid="new-arrivals-view-all">
            View All →
          </Link>
        </div>
        {isLoading ? (
          <div className="loading-grid">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="product-card-loading"></div>
            ))}
          </div>
        ) : (
          <div className="products-grid">
            {newProducts.map((product) => (
              <ProductCard
                key={product.id}
                {...product}
                image={product.images[0]}
                onClick={() => navigate(`/products/${product.id}`)}
                onAddToCart={() => handleAddToCart(product)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Promo Banner */}
      <section className="promo-banner">
        <div className="promo-content">
          <h2>Free Shipping on Orders Over $100</h2>
          <p>Get your favorite tech delivered to your doorstep at no extra cost</p>
          <Button variant="outline" onClick={() => navigate('/products')}>
            Start Shopping
          </Button>
        </div>
      </section>

      {/* Features Section */}
      <section className="features-section">
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">🚚</div>
            <h3>Free Shipping</h3>
            <p>On all orders over $100</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🔒</div>
            <h3>Secure Payment</h3>
            <p>100% secure transactions</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">↩️</div>
            <h3>Easy Returns</h3>
            <p>30-day return policy</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">💬</div>
            <h3>24/7 Support</h3>
            <p>Dedicated customer support</p>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Home;
