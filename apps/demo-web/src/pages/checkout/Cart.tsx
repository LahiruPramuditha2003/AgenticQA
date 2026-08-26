import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../../contexts/CartContext';
import { Button } from '../../components/Button';
import { useToast } from '../../contexts/ToastContext';

const Cart: React.FC = () => {
  const navigate = useNavigate();
  const { items, updateQuantity, removeFromCart, totalPrice, totalItems } = useCart();
  const { showToast } = useToast();

  const handleQuantityChange = async (productId: string, newQuantity: number) => {
    if (newQuantity < 1) return;
    try {
      await updateQuantity(productId, newQuantity);
    } catch (error) {
      showToast('Failed to update quantity', 'error');
    }
  };

  const handleRemove = async (productId: string, productName: string) => {
    try {
      await removeFromCart(productId);
      showToast(`${productName} removed from cart`, 'info');
    } catch (error) {
      showToast('Failed to remove item', 'error');
    }
  };

  const subtotal = totalPrice;
  const tax = subtotal * 0.08;
  const shipping = subtotal > 100 ? 0 : 9.99;
  const total = subtotal + tax + shipping;

  if (items.length === 0) {
    return (
      <div className="cart-page">
        <div className="cart-empty">
          <div className="empty-icon">🛒</div>
          <h2>Your cart is empty</h2>
          <p>Looks like you haven't added anything to your cart yet.</p>
          <Button onClick={() => navigate('/products')}>Start Shopping</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="cart-page">
      <div className="cart-container">
        <h1 className="page-title">Shopping Cart ({totalItems} items)</h1>

        <div className="cart-content">
          {/* Cart Items */}
          <div className="cart-items">
            {items.map((item) => (
              <div key={item.productId} className="cart-item">
                <div className="cart-item-image">
                  <img src={item.image} alt={item.name} />
                </div>

                <div className="cart-item-details">
                  <Link to={`/products/${item.productId}`} className="cart-item-name">
                    {item.name}
                  </Link>
                  <p className="cart-item-price">${item.price.toLocaleString()}</p>
                </div>

                <div className="cart-item-quantity">
                  <label>Quantity:</label>
                  <div className="quantity-controls">
                    <button
                      onClick={() => handleQuantityChange(item.productId, item.quantity - 1)}
                      disabled={item.quantity <= 1}
                    >
                      -
                    </button>
                    <span>{item.quantity}</span>
                    <button
                      onClick={() => handleQuantityChange(item.productId, item.quantity + 1)}
                      disabled={item.quantity >= item.stock}
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="cart-item-total">
                  ${(item.price * item.quantity).toLocaleString()}
                </div>

                <button
                  className="cart-item-remove"
                  onClick={() => handleRemove(item.productId, item.name)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {/* Cart Summary */}
          <div className="cart-summary">
            <h2>Cart Summary</h2>

            <div className="summary-row">
              <span>Subtotal ({totalItems} items)</span>
              <span>${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>

            <div className="summary-row">
              <span>Estimated Tax</span>
              <span>${tax.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>

            <div className="summary-row">
              <span>Shipping</span>
              <span>{shipping === 0 ? 'FREE' : `$${shipping.toLocaleString()}`}</span>
            </div>

            {shipping > 0 && (
              <p className="shipping-note">
                Add ${(100 - subtotal).toFixed(2)} more for FREE shipping
              </p>
            )}

            <hr className="summary-divider" />

            <div className="summary-row summary-total">
              <span>Total</span>
              <span>${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>

            <Button
              size="lg"
              fullWidth
              onClick={() => navigate('/checkout')}
              className="checkout-btn"
            >
              Proceed to Checkout
            </Button>

            <div className="trust-badges">
              <div className="badge">
                <span>🔒</span> Secure Checkout
              </div>
              <div className="badge">
                <span>↩️</span> Easy Returns
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Cart;
