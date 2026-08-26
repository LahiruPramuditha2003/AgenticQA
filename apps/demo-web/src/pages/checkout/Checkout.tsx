import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../../contexts/CartContext';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import api from '../../services/api';
import type { Address } from '../../types';

type CheckoutStep = 'shipping' | 'payment' | 'review' | 'confirmation';

const Checkout: React.FC = () => {
  const navigate = useNavigate();
  const { items, totalPrice } = useCart();
  const { isAuthenticated, user } = useAuth();
  const { showToast } = useToast();

  const [currentStep, setCurrentStep] = useState<CheckoutStep>('shipping');
  const [isProcessing, setIsProcessing] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);

  const [shippingAddress, setShippingAddress] = useState<Address>({
    id: '',
    fullName: user?.name || '',
    street: '',
    city: '',
    state: '',
    zipCode: '',
    country: 'USA',
    phone: '',
  });

  const [paymentMethod, setPaymentMethod] = useState('card');
  const [cardDetails, setCardDetails] = useState({
    number: '',
    name: '',
    expiry: '',
    cvv: '',
  });

  const subtotal = totalPrice;
  const tax = subtotal * 0.08;
  const shipping = subtotal > 100 ? 0 : 9.99;
  const total = subtotal + tax + shipping;

  const handleShippingChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setShippingAddress((prev) => ({ ...prev, [name]: value }));
  };

  const handleCardChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCardDetails((prev) => ({ ...prev, [name]: value }));
  };

  const validateShipping = () => {
    const required = ['fullName', 'street', 'city', 'state', 'zipCode', 'country', 'phone'];
    for (const field of required) {
      if (!shippingAddress[field as keyof Address]) {
        showToast(`Please enter ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}`, 'warning');
        return false;
      }
    }
    return true;
  };

  const validatePayment = () => {
    if (paymentMethod === 'card') {
      if (!cardDetails.number || !cardDetails.name || !cardDetails.expiry || !cardDetails.cvv) {
        showToast('Please fill in all card details', 'warning');
        return false;
      }
    }
    return true;
  };

  const handleContinueToPayment = () => {
    if (validateShipping()) {
      setCurrentStep('payment');
    }
  };

  const handleContinueToReview = () => {
    if (validatePayment()) {
      setCurrentStep('review');
    }
  };

  const handlePlaceOrder = async () => {
    if (!isAuthenticated) {
      showToast('Please login to place an order', 'warning');
      navigate('/auth/login');
      return;
    }

    setIsProcessing(true);
    try {
      const order = await api.orders.create({
        items,
        shippingAddress,
        paymentMethod: paymentMethod === 'card' ? 'Credit Card' : paymentMethod,
      });
      setOrderId(order.id);
      setCurrentStep('confirmation');
      showToast('Order placed successfully!', 'success');
    } catch (error) {
      showToast('Failed to place order. Please try again.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  useEffect(() => {
    if (items.length === 0 && currentStep !== 'confirmation') {
      navigate('/cart');
    }
  }, [items.length, currentStep, navigate]);

  if (items.length === 0 && currentStep !== 'confirmation') {
    return null;
  }

  if (currentStep === 'confirmation' && orderId) {
    return (
      <div className="checkout-page">
        <div className="order-confirmation">
          <div className="confirmation-icon">✓</div>
          <h1>Order Confirmed!</h1>
          <p className="order-number">Order ID: {orderId}</p>
          <p className="confirmation-message">
            Thank you for your purchase! We've sent a confirmation email to your inbox.
          </p>
          <div className="confirmation-actions">
            <Button onClick={() => navigate('/account/orders')}>View Order</Button>
            <Button variant="outline" onClick={() => navigate('/products')}>
              Continue Shopping
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="checkout-page">
      <div className="checkout-container">
        {/* Progress Steps */}
        <div className="checkout-progress">
          <div className={`progress-step ${currentStep === 'shipping' ? 'active' : ''} ${['payment', 'review', 'confirmation'].includes(currentStep) ? 'completed' : ''}`}>
            <span className="step-number">1</span>
            <span className="step-label">Shipping</span>
          </div>
          <div className="progress-line"></div>
          <div className={`progress-step ${currentStep === 'payment' ? 'active' : ''} ${['review', 'confirmation'].includes(currentStep) ? 'completed' : ''}`}>
            <span className="step-number">2</span>
            <span className="step-label">Payment</span>
          </div>
          <div className="progress-line"></div>
          <div className={`progress-step ${currentStep === 'review' ? 'active' : ''} ${['confirmation'].includes(currentStep) ? 'completed' : ''}`}>
            <span className="step-number">3</span>
            <span className="step-label">Review</span>
          </div>
        </div>

        <div className="checkout-content">
          {/* Main Form */}
          <div className="checkout-form">
            {currentStep === 'shipping' && (
              <div className="checkout-section">
                <h2>Shipping Address</h2>
                <div className="form-grid">
                  <Input
                    label="Full Name"
                    name="fullName"
                    value={shippingAddress.fullName}
                    onChange={handleShippingChange}
                    placeholder="John Doe"
                  />
                  <Input
                    label="Phone"
                    name="phone"
                    value={shippingAddress.phone}
                    onChange={handleShippingChange}
                    placeholder="+1 (555) 123-4567"
                  />
                </div>
                <Input
                  label="Street Address"
                  name="street"
                  value={shippingAddress.street}
                  onChange={handleShippingChange}
                  placeholder="123 Main Street"
                />
                <div className="form-grid">
                  <Input
                    label="City"
                    name="city"
                    value={shippingAddress.city}
                    onChange={handleShippingChange}
                    placeholder="San Francisco"
                  />
                  <Input
                    label="State"
                    name="state"
                    value={shippingAddress.state}
                    onChange={handleShippingChange}
                    placeholder="CA"
                  />
                </div>
                <div className="form-grid">
                  <Input
                    label="ZIP Code"
                    name="zipCode"
                    value={shippingAddress.zipCode}
                    onChange={handleShippingChange}
                    placeholder="94102"
                  />
                  <div className="input-group">
                    <label className="input-label">Country</label>
                    <select
                      name="country"
                      value={shippingAddress.country}
                      onChange={handleShippingChange}
                      className="input"
                    >
                      <option value="USA">United States</option>
                      <option value="Canada">Canada</option>
                      <option value="UK">United Kingdom</option>
                    </select>
                  </div>
                </div>
                <Button size="lg" onClick={handleContinueToPayment} className="continue-btn">
                  Continue to Payment
                </Button>
              </div>
            )}

            {currentStep === 'payment' && (
              <div className="checkout-section">
                <h2>Payment Method</h2>
                <div className="payment-methods">
                  <label className={`payment-option ${paymentMethod === 'card' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="payment"
                      value="card"
                      checked={paymentMethod === 'card'}
                      onChange={() => setPaymentMethod('card')}
                    />
                    <span>💳 Credit/Debit Card</span>
                  </label>
                  <label className={`payment-option ${paymentMethod === 'paypal' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="payment"
                      value="paypal"
                      checked={paymentMethod === 'paypal'}
                      onChange={() => setPaymentMethod('paypal')}
                    />
                    <span>🅿️ PayPal</span>
                  </label>
                </div>

                {paymentMethod === 'card' && (
                  <div className="card-details">
                    <Input
                      label="Card Number"
                      name="number"
                      value={cardDetails.number}
                      onChange={handleCardChange}
                      placeholder="1234 5678 9012 3456"
                      maxLength={19}
                    />
                    <Input
                      label="Cardholder Name"
                      name="name"
                      value={cardDetails.name}
                      onChange={handleCardChange}
                      placeholder="John Doe"
                    />
                    <div className="form-grid">
                      <Input
                        label="Expiry Date"
                        name="expiry"
                        value={cardDetails.expiry}
                        onChange={handleCardChange}
                        placeholder="MM/YY"
                        maxLength={5}
                      />
                      <Input
                        label="CVV"
                        name="cvv"
                        value={cardDetails.cvv}
                        onChange={handleCardChange}
                        placeholder="123"
                        maxLength={4}
                      />
                    </div>
                  </div>
                )}

                <div className="checkout-actions">
                  <Button variant="ghost" onClick={() => setCurrentStep('shipping')}>
                    Back
                  </Button>
                  <Button size="lg" onClick={handleContinueToReview}>
                    Review Order
                  </Button>
                </div>
              </div>
            )}

            {currentStep === 'review' && (
              <div className="checkout-section">
                <h2>Review Your Order</h2>

                <div className="review-section">
                  <h3>Shipping Address</h3>
                  <div className="review-info">
                    <p>{shippingAddress.fullName}</p>
                    <p>{shippingAddress.street}</p>
                    <p>{shippingAddress.city}, {shippingAddress.state} {shippingAddress.zipCode}</p>
                    <p>{shippingAddress.country}</p>
                    <p>{shippingAddress.phone}</p>
                  </div>
                  <button
                    className="edit-link"
                    onClick={() => setCurrentStep('shipping')}
                  >
                    Edit
                  </button>
                </div>

                <div className="review-section">
                  <h3>Payment Method</h3>
                  <div className="review-info">
                    {paymentMethod === 'card' ? (
                      <p>💳 Credit Card ending in {cardDetails.number.slice(-4) || '****'}</p>
                    ) : (
                      <p>🅿️ PayPal</p>
                    )}
                  </div>
                  <button
                    className="edit-link"
                    onClick={() => setCurrentStep('payment')}
                  >
                    Edit
                  </button>
                </div>

                <div className="review-section">
                  <h3>Order Items</h3>
                  <div className="review-items">
                    {items.map((item) => (
                      <div key={item.productId} className="review-item">
                        <img src={item.image} alt={item.name} />
                        <div className="review-item-info">
                          <p className="item-name">{item.name}</p>
                          <p className="item-quantity">Qty: {item.quantity}</p>
                        </div>
                        <p className="item-price">${(item.price * item.quantity).toLocaleString()}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="checkout-actions">
                  <Button variant="ghost" onClick={() => setCurrentStep('payment')}>
                    Back
                  </Button>
                  <Button
                    size="lg"
                    onClick={handlePlaceOrder}
                    isLoading={isProcessing}
                    disabled={!isAuthenticated}
                  >
                    {isAuthenticated ? 'Place Order' : 'Login to Place Order'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Order Summary Sidebar */}
          <div className="checkout-summary">
            <h3>Order Summary</h3>
            <div className="summary-items">
              {items.map((item) => (
                <div key={item.productId} className="summary-item">
                  <img src={item.image} alt={item.name} />
                  <div className="summary-item-info">
                    <p className="item-name">{item.name}</p>
                    <p className="item-quantity">Qty: {item.quantity}</p>
                  </div>
                  <p className="item-price">${(item.price * item.quantity).toLocaleString()}</p>
                </div>
              ))}
            </div>

            <hr />

            <div className="summary-row">
              <span>Subtotal</span>
              <span>${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="summary-row">
              <span>Shipping</span>
              <span>{shipping === 0 ? 'FREE' : `$${shipping.toLocaleString()}`}</span>
            </div>
            <div className="summary-row">
              <span>Tax</span>
              <span>${tax.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
            <hr />
            <div className="summary-row summary-total">
              <span>Total</span>
              <span>${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Checkout;
