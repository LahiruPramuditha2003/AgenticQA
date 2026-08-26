import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Button } from '../../components/Button';
import { Rating } from '../../components/Rating';
import { useCart } from '../../contexts/CartContext';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../services/api';
import type { Product, Review } from '../../types';

const ProductDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { addToCart } = useCart();
  const { showToast } = useToast();
  const { isAuthenticated } = useAuth();

  const [product, setProduct] = useState<Product | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedImage, setSelectedImage] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [activeTab, setActiveTab] = useState<'description' | 'specs' | 'reviews'>('description');
  const [newReview, setNewReview] = useState({ rating: 0, title: '', comment: '' });
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  useEffect(() => {
    if (id) {
      loadProductDetails(id);
    }
  }, [id]);

  const loadProductDetails = async (productId: string) => {
    setIsLoading(true);
    try {
      const [productData, reviewsData] = await Promise.all([
        api.products.getById(productId),
        api.reviews.getByProduct(productId),
      ]);
      setProduct(productData);
      setReviews(reviewsData);
      if (productData?.images) {
        setSelectedImage(0);
      }
    } catch (error) {
      console.error('Failed to load product:', error);
      showToast('Failed to load product details', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddToCart = async () => {
    if (!product) return;
    
    try {
      await addToCart(
        {
          productId: product.id,
          name: product.name,
          price: product.price,
          image: product.images[0],
          stock: product.stock,
        },
        quantity
      );
      showToast(`${product.name} x${quantity} added to cart!`, 'success');
    } catch (error) {
      showToast('Failed to add to cart', 'error');
    }
  };

  const handleBuyNow = async () => {
    await handleAddToCart();
    navigate('/checkout');
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) {
      showToast('Please login to write a review', 'warning');
      navigate('/auth/login');
      return;
    }

    if (newReview.rating === 0) {
      showToast('Please select a rating', 'warning');
      return;
    }

    setIsSubmittingReview(true);
    try {
      await api.reviews.addReview({
        productId: id!,
        rating: newReview.rating,
        title: newReview.title,
        comment: newReview.comment,
      });
      showToast('Review submitted successfully!', 'success');
      setNewReview({ rating: 0, title: '', comment: '' });
      loadProductDetails(id!);
    } catch (error) {
      showToast('Failed to submit review', 'error');
    } finally {
      setIsSubmittingReview(false);
    }
  };

  if (isLoading) {
    return (
      <div className="product-detail-loading">
        <div className="skeleton-image"></div>
        <div className="skeleton-content">
          <div className="skeleton-title"></div>
          <div className="skeleton-price"></div>
          <div className="skeleton-text"></div>
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="product-not-found">
        <h2>Product Not Found</h2>
        <p>Sorry, we couldn't find the product you're looking for.</p>
        <Button onClick={() => navigate('/products')}>Browse Products</Button>
      </div>
    );
  }

  const discount = product.originalPrice
    ? Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100)
    : 0;

  return (
    <div className="product-detail-page">
      <div className="breadcrumb">
        <Link to="/">Home</Link> / <Link to="/products">Products</Link> /{' '}
        <span>{product.name}</span>
      </div>

      <div className="product-detail">
        {/* Image Gallery */}
        <div className="product-gallery">
          <div className="main-image">
            <img src={product.images[selectedImage]} alt={product.name} />
            {product.isNew && <span className="badge-new">New</span>}
            {discount > 0 && <span className="badge-sale">-{discount}%</span>}
          </div>
          {product.images.length > 1 && (
            <div className="thumbnail-images">
              {product.images.map((img: string, index: number) => (
                <button
                  key={index}
                  className={`thumbnail ${selectedImage === index ? 'active' : ''}`}
                  onClick={() => setSelectedImage(index)}
                >
                  <img src={img} alt={`${product.name} ${index + 1}`} />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Product Info */}
        <div className="product-info">
          <div className="product-meta">
            <span className="product-brand">{product.brand}</span>
            <span className="product-category">{product.category}</span>
          </div>

          <h1 className="product-name">{product.name}</h1>

          <div className="product-rating">
            <Rating value={product.rating} size="md" showValue />
            <span className="review-count">({product.reviewCount} reviews)</span>
          </div>

          <div className="product-price">
            <span className="current-price">${product.price.toLocaleString()}</span>
            {product.originalPrice && (
              <span className="original-price">${product.originalPrice.toLocaleString()}</span>
            )}
          </div>

          <p className="product-description">{product.description}</p>

          <div className="product-stock">
            {product.stock > 0 ? (
              product.stock < 10 ? (
                <span className="stock-low">Only {product.stock} left in stock</span>
              ) : (
                <span className="stock-available">✓ In Stock</span>
              )
            ) : (
              <span className="stock-out">Out of Stock</span>
            )}
          </div>

          <div className="product-actions">
            <div className="quantity-selector">
              <label>Quantity:</label>
              <div className="quantity-controls">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  disabled={quantity <= 1}
                >
                  -
                </button>
                <span className="quantity-value">{quantity}</span>
                <button
                  onClick={() => setQuantity(Math.min(product.stock, quantity + 1))}
                  disabled={quantity >= product.stock}
                >
                  +
                </button>
              </div>
            </div>

            <div className="action-buttons">
              <Button
                size="lg"
                onClick={handleAddToCart}
                disabled={product.stock === 0}
                fullWidth
              >
                Add to Cart
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={handleBuyNow}
                disabled={product.stock === 0}
                fullWidth
              >
                Buy Now
              </Button>
            </div>
          </div>

          <div className="product-tags">
            <span>Tags:</span>
            {product.tags.map((tag: string) => (
              <Link key={tag} to={`/products?tag=${tag}`} className="tag">
                {tag}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Tabs Section */}
      <div className="product-tabs">
        <div className="tab-buttons">
          <button
            className={`tab-btn ${activeTab === 'description' ? 'active' : ''}`}
            onClick={() => setActiveTab('description')}
          >
            Description
          </button>
          <button
            className={`tab-btn ${activeTab === 'specs' ? 'active' : ''}`}
            onClick={() => setActiveTab('specs')}
          >
            Specifications
          </button>
          <button
            className={`tab-btn ${activeTab === 'reviews' ? 'active' : ''}`}
            onClick={() => setActiveTab('reviews')}
          >
            Reviews ({reviews.length})
          </button>
        </div>

        <div className="tab-content">
          {activeTab === 'description' && (
            <div className="description-content">
              <h3>Product Overview</h3>
              <p>{product.description}</p>
              <h4>Key Features</h4>
              <ul>
                <li>Premium quality materials and construction</li>
                <li>Latest technology and features</li>
                <li>Manufacturer warranty included</li>
                <li>Free shipping on orders over $100</li>
              </ul>
            </div>
          )}

          {activeTab === 'specs' && (
            <div className="specs-content">
              <table className="specs-table">
                <tbody>
                  {Object.entries(product.specifications).map(([key, value]) => (
                    <tr key={key}>
                      <th>{key}</th>
                      <td>{String(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'reviews' && (
            <div className="reviews-content">
              {/* Review Form */}
              <form className="review-form" onSubmit={handleSubmitReview}>
                <h3>Write a Review</h3>
                <div className="form-group">
                  <label>Your Rating</label>
                  <Rating
                    value={newReview.rating}
                    interactive
                    onChange={(val) => setNewReview({ ...newReview, rating: val })}
                    size="lg"
                  />
                </div>
                <div className="form-group">
                  <label>Title</label>
                  <input
                    type="text"
                    value={newReview.title}
                    onChange={(e) => setNewReview({ ...newReview, title: e.target.value })}
                    placeholder="Summarize your experience"
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Review</label>
                  <textarea
                    value={newReview.comment}
                    onChange={(e) => setNewReview({ ...newReview, comment: e.target.value })}
                    placeholder="Share your thoughts about this product"
                    rows={4}
                    required
                  />
                </div>
                <Button type="submit" isLoading={isSubmittingReview}>
                  Submit Review
                </Button>
              </form>

              {/* Reviews List */}
              <div className="reviews-list">
                {reviews.length === 0 ? (
                  <p className="no-reviews">No reviews yet. Be the first to review!</p>
                ) : (
                  reviews.map((review: Review) => (
                    <div key={review.id} className="review-card">
                      <div className="review-header">
                        <div className="reviewer-info">
                          <span className="reviewer-name">{review.userName}</span>
                          <span className="review-date">{review.createdAt}</span>
                        </div>
                        <Rating value={review.rating} size="sm" />
                      </div>
                      <h4 className="review-title">{review.title}</h4>
                      <p className="review-comment">{review.comment}</p>
                      <div className="review-helpful">
                        <span>👍 Helpful ({review.helpful})</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Related Products */}
      <div className="related-products">
        <h3>Related Products</h3>
        <div className="products-grid">
          {/* This would be populated with related products in a real app */}
        </div>
      </div>
    </div>
  );
};

export default ProductDetail;
