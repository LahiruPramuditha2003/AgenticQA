import React, { type ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
}

export const Card: React.FC<CardProps> = ({ children, className = '', onClick, hoverable = false }) => {
  return (
    <div
      className={`card ${hoverable ? 'card-hoverable' : ''} ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
};

interface ProductCardProps {
  id: string;
  name: string;
  price: number;
  originalPrice?: number;
  image: string;
  rating: number;
  reviewCount: number;
  category: string;
  brand: string;
  stock: number;
  isNew?: boolean;
  featured?: boolean;
  onAddToCart?: () => void;
  onClick?: () => void;
  testId?: string;
}

export const ProductCard: React.FC<ProductCardProps> = ({
  name,
  price,
  originalPrice,
  image,
  rating,
  reviewCount,
  category,
  stock,
  isNew,
  onAddToCart,
  onClick,
  testId,
}) => {
  const discount = originalPrice ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0;
  const outOfStock = stock === 0;
  const lowStock = stock > 0 && stock < 10;

  return (
    <div className="product-card" onClick={onClick} data-testid={testId || `product-card-${name.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="product-card-image-wrapper">
        <img src={image} alt={`Product image of ${name}`} className="product-card-image" loading="lazy" />
        {isNew && <span className="product-badge product-badge-new">New</span>}
        {discount > 0 && <span className="product-badge product-badge-sale">-{discount}%</span>}
        {outOfStock && <span className="product-badge product-badge-out">Out of Stock</span>}
      </div>

      <div className="product-card-content">
        <span className="product-card-category">{category}</span>
        <h3 className="product-card-name">{name}</h3>

        <div className="product-card-rating">
          <span className="stars">
            {'★'.repeat(Math.floor(rating))}
            {'☆'.repeat(5 - Math.floor(rating))}
          </span>
          <span className="rating-count">({reviewCount})</span>
        </div>

        <div className="product-card-price">
          <span className="price-current">${price.toLocaleString()}</span>
          {originalPrice && <span className="price-original">${originalPrice.toLocaleString()}</span>}
        </div>

        {lowStock && !outOfStock && (
          <span className="low-stock-warning">Only {stock} left in stock</span>
        )}

        <button
          className="product-card-add-to-cart"
          onClick={(e) => {
            e.stopPropagation();
            onAddToCart?.();
          }}
          disabled={outOfStock}
          data-testid={`add-to-cart-${name.toLowerCase().replace(/\s+/g, '-')}`}
        >
          {outOfStock ? 'Out of Stock' : 'Add to Cart'}
        </button>
      </div>
    </div>
  );
};

interface CategoryCardProps {
  name: string;
  productCount: number;
  onClick?: () => void;
}

export const CategoryCard: React.FC<CategoryCardProps> = ({
  name,
  productCount,
  onClick,
}) => {
  return (
    <div className="category-card" onClick={onClick}>
      <div className="category-card-image-wrapper">
        <img src={`https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=400`} alt={`Category image for ${name}`} className="category-card-image" loading="lazy" />
        <div className="category-card-overlay">
          <h3 className="category-card-name">{name}</h3>
          <p className="category-card-count">{productCount} products</p>
        </div>
      </div>
    </div>
  );
};
