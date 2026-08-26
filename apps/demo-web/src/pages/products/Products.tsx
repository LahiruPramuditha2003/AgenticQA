import React from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ProductCard } from '../../components/Card';
import { Button } from '../../components/Button';
import { useCart } from '../../contexts/CartContext';
import { useToast } from '../../contexts/ToastContext';
import api from '../../services/api';
import type { Product } from '../../types';

const Products: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { addToCart } = useCart();
  const { showToast } = useToast();

  const [products, setProducts] = React.useState<Product[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);

  // Filter states
  const [selectedCategory, setSelectedCategory] = React.useState('');
  const [selectedBrand, setSelectedBrand] = React.useState('');
  const [priceRange, setPriceRange] = React.useState<[number, number]>([0, 5000]);
  const [minRating, setMinRating] = React.useState(0);
  const [inStockOnly, setInStockOnly] = React.useState(false);
  const [sortBy, setSortBy] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');

  // Pagination
  const [currentPage, setCurrentPage] = React.useState(1);
  const itemsPerPage = 12;

  // Categories and brands
  const [categories, setCategories] = React.useState<string[]>([]);
  const [brands, setBrands] = React.useState<string[]>([]);

  React.useEffect(() => {
    // Read params from URL
    const category = searchParams.get('category') || '';
    const search = searchParams.get('search') || '';
    const sort = searchParams.get('sort') || '';

    setSelectedCategory(category);
    setSearchQuery(search);
    setSortBy(sort);
  }, [searchParams]);

  React.useEffect(() => {
    loadProducts();
    loadFilters();
  }, [selectedCategory, selectedBrand, priceRange, minRating, inStockOnly, sortBy, searchQuery, currentPage]);

  const loadProducts = async () => {
    setIsLoading(true);
    setError(false);
    try {
      const response = await api.products.getAll({
        category: selectedCategory || undefined,
        brand: selectedBrand || undefined,
        minPrice: priceRange[0],
        maxPrice: priceRange[1],
        rating: minRating || undefined,
        inStock: inStockOnly || undefined,
        sort: sortBy || undefined,
        search: searchQuery || undefined,
        page: currentPage,
        limit: itemsPerPage,
      });
      setProducts(response.products);
      setTotal(response.total);
      setTotalPages(response.totalPages);
    } catch (error) {
      console.error('Failed to load products:', error);
      showToast('Failed to load products', 'error');
      setError(true);
    } finally {
      setIsLoading(false);
    }
  };

  const loadFilters = async () => {
    try {
      const allProducts = await api.products.getAll({ limit: 100 });
      const uniqueCategories = [...new Set(allProducts.products.map((p: Product) => p.category))];
      const uniqueBrands = [...new Set(allProducts.products.map((p: Product) => p.brand))];
      setCategories(uniqueCategories as string[]);
      setBrands(uniqueBrands as string[]);
    } catch (error) {
      console.error('Failed to load filters:', error);
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

  const clearFilters = () => {
    setSelectedCategory('');
    setSelectedBrand('');
    setPriceRange([0, 5000]);
    setMinRating(0);
    setInStockOnly(false);
    setSortBy('');
    setSearchQuery('');
    setSearchParams({});
    setCurrentPage(1);
  };

  const updateSearchParams = (key: string, value: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    setSearchParams(newParams);
  };

  return (
    <div className="products-page" data-testid="products-page">
      <div className="products-container">
        {/* Sidebar Filters */}
        <aside className="filters-sidebar" data-testid="filters-sidebar">
          <div className="filters-header">
            <h3>Filters</h3>
            <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="clear-filters">
              Clear All
            </Button>
          </div>

          {/* Search */}
          <div className="filter-group" data-testid="filter-search">
            <label className="filter-label">Search</label>
            <input
              type="text"
              className="filter-input"
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              data-testid="filter-search-input"
            />
          </div>

          {/* Category */}
          <div className="filter-group" data-testid="filter-category">
            <label className="filter-label" htmlFor="category-select">Category</label>
            <select
              id="category-select"
              className="filter-select"
              value={selectedCategory}
              onChange={(e) => {
                setSelectedCategory(e.target.value);
                setCurrentPage(1);
                updateSearchParams('category', e.target.value);
              }}
              data-testid="filter-category-select"
              aria-label="Category"
            >
              <option value="">All Categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          {/* Brand */}
          <div className="filter-group" data-testid="filter-brand">
            <label className="filter-label" htmlFor="brand-select">Brand</label>
            <select
              id="brand-select"
              className="filter-select"
              value={selectedBrand}
              onChange={(e) => {
                setSelectedBrand(e.target.value);
                setCurrentPage(1);
              }}
              data-testid="filter-brand-select"
              aria-label="Brand"
            >
              <option value="">All Brands</option>
              {brands.map(brand => (
                <option key={brand} value={brand}>{brand}</option>
              ))}
            </select>
          </div>

          {/* Price Range */}
          <div className="filter-group" data-testid="filter-price">
            <label className="filter-label" data-testid="filter-price-label">
              Price Range: ${priceRange[0]} - ${priceRange[1]}
            </label>
            <input
              type="range"
              min="0"
              max="5000"
              step="100"
              value={priceRange[1]}
              onChange={(e) => {
                setPriceRange([0, parseInt(e.target.value)]);
                setCurrentPage(1);
              }}
              className="filter-range"
              data-testid="filter-price-range"
              aria-label="Price Range"
            />
          </div>

          {/* Rating */}
          <div className="filter-group" data-testid="filter-rating">
            <label className="filter-label">Minimum Rating</label>
            <div className="rating-filters">
              {[4, 3, 2, 1].map((rating) => (
                <button
                  key={rating}
                  className={`rating-filter-btn ${minRating === rating ? 'active' : ''}`}
                  onClick={() => {
                    setMinRating(minRating === rating ? 0 : rating);
                    setCurrentPage(1);
                  }}
                  data-testid={`filter-rating-${rating}`}
                >
                  {'★'.repeat(rating)}{'☆'.repeat(5 - rating)} & Up
                </button>
              ))}
            </div>
          </div>

          {/* In Stock */}
          <div className="filter-group" data-testid="filter-in-stock">
            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={inStockOnly}
                onChange={(e) => {
                  setInStockOnly(e.target.checked);
                  setCurrentPage(1);
                }}
                data-testid="filter-in-stock-checkbox"
              />
              In Stock Only
            </label>
          </div>
        </aside>

        {/* Products Grid */}
        <main className="products-main">
          <div className="products-header">
            <div className="products-info">
              <h1 className="products-title" data-testid="products-title">
                {selectedCategory || 'All Products'}
                {searchQuery && ` - "${searchQuery}"`}
              </h1>
              <span className="products-count" data-testid="products-count">{total} products found</span>
            </div>
            <div className="products-sort">
              <label htmlFor="sort-select">Sort by:</label>
              <select
                id="sort-select"
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value);
                  setCurrentPage(1);
                  updateSearchParams('sort', e.target.value);
                }}
                className="sort-select"
                data-testid="products-sort"
                aria-label="Sort by"
              >
                <option value="">Featured</option>
                <option value="price-asc">Price: Low to High</option>
                <option value="price-desc">Price: High to Low</option>
                <option value="rating">Highest Rated</option>
                <option value="newest">Newest</option>
                <option value="popular">Most Popular</option>
              </select>
            </div>
          </div>

          {isLoading ? (
            <div className="loading-grid" data-testid="products-loading">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="product-card-loading"></div>
              ))}
            </div>
          ) : error ? (
            <div className="error-state" data-testid="products-error" style={{ textAlign: 'center', padding: '4rem 1rem' }}>
               <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem', color: 'var(--color-danger, #ef4444)' }}>Connection Error</h2>
               <p style={{ marginBottom: '2rem' }}>Failed to load products. Please check your connection and try again.</p>
               <Button onClick={loadProducts} data-testid="retry-button">Retry Connection</Button>
            </div>
          ) : products.length === 0 ? (
            <div className="no-products" data-testid="no-products">
              <h2>No products found</h2>
              <p>Try adjusting your filters or search query</p>
              <Button onClick={clearFilters}>Clear Filters</Button>
            </div>
          ) : (
            <>
              <div className="products-grid" data-testid="products-grid">
                {products.map((product) => (
                  <ProductCard
                    key={product.id}
                    {...product}
                    image={product.images[0]}
                    onClick={() => navigate(`/products/${product.id}`)}
                    onAddToCart={() => handleAddToCart(product)}
                    testId={`product-card-${product.id}`}
                  />
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="pagination">
                  <button
                    className="pagination-btn"
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage(currentPage - 1)}
                  >
                    Previous
                  </button>
                  {[...Array(totalPages)].map((_, i) => (
                    <button
                      key={i}
                      className={`pagination-btn ${currentPage === i + 1 ? 'active' : ''}`}
                      onClick={() => setCurrentPage(i + 1)}
                    >
                      {i + 1}
                    </button>
                  ))}
                  <button
                    className="pagination-btn"
                    disabled={currentPage === totalPages}
                    onClick={() => setCurrentPage(currentPage + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
};

export default Products;
